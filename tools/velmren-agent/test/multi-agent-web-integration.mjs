// Run only against a native build with popup support:
// node test/multi-agent-web-integration.mjs BROWSER_EXE NEW_OUTPUT_DIR [--agent-directory=DIR]
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { AGENTS, ROUNDS, multiAgentFixture } from './multi-agent-web-fixture.mjs'

const positional = process.argv.slice(2).filter(arg => !arg.startsWith('--'))
const [executable, outputArgument] = positional
const directoryOption = process.argv.slice(2).find(arg => arg.startsWith('--agent-directory='))
if (positional.length !== 2 || !executable || !outputArgument || process.argv.slice(2).some(arg => arg.startsWith('--') && arg !== directoryOption)) {
  throw new Error('Usage: multi-agent-web-integration.mjs BROWSER_EXE NEW_OUTPUT_DIR [--agent-directory=DIR]')
}
const agentDirectory = path.resolve(directoryOption?.slice('--agent-directory='.length) ?? fileURLToPath(new URL('../', import.meta.url)))
const output = path.resolve(outputArgument)
await mkdir(path.dirname(output), { recursive: true })
await mkdir(output) // Refuse an existing directory or profile; retain all evidence.

const report = {
  passed: false,
  scope: 'Five independent MCP stdio clients; headless native browser; owned synthetic fixtures only',
  agentDirectory,
  startedAt: new Date().toISOString(),
  checks: [], clients: [], calls: [], cleanup: {}
}
const peers = [], tasks = [], pending = new Set(), protocolEvents = []
let fixture, app, failure
const pass = (name, evidence = {}) => {
  report.checks.push({ name, passed: true, ...evidence })
  console.log(`PASS ${name}`)
}
const bounded = async (promise, description, timeoutMs = 12000) => {
  let timer
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timeout: ${description}`)), timeoutMs)
    })])
  } finally { clearTimeout(timer) }
}
const eventually = async (read, predicate, description) => {
  const deadline = Date.now() + 10000
  let value
  do {
    value = await read()
    if (predicate(value)) return value
    await delay(100)
  } while (Date.now() < deadline)
  throw new Error(`Timeout: ${description}; last result: ${JSON.stringify(value)}`)
}
const processAlive = pid => {
  if (!Number.isInteger(pid)) return false
  try { process.kill(pid, 0); return true } catch (error) {
    if (error.code === 'ESRCH') return false
    throw error
  }
}
const admin = async (method, args = {}) => {
  const response = await fetch(`${app.descriptor.endpoint}/rpc`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${app.descriptor.adminToken}` },
    body: JSON.stringify({ method, args }), signal: AbortSignal.timeout(30000)
  })
  const result = await response.json()
  assert.ok(response.ok && result.ok === true, `Admin ${method}: ${result.error}`)
  return result.result
}
const tool = (peer, name, args = {}) => {
  const call = { agent: peer.agent, tool: name, taskId: args.taskId, startedAt: Date.now() }
  report.calls.push(call)
  const promise = (async () => {
    try {
      const result = await peer.client.callTool({ name, arguments: args }, undefined, { timeout: 40000 })
      const text = result.content?.find(item => item.type === 'text')?.text
      assert.equal(typeof text, 'string', `${name} must return JSON text`)
      const value = JSON.parse(text)
      if (result.isError) {
        const error = new Error(`${name}: ${value.error}`)
        error.code = value.code
        throw error
      }
      call.ok = true
      return value
    } catch (error) {
      call.ok = false; call.error = error.message; call.code = error.code
      throw error
    } finally { call.completedAt = Date.now() }
  })()
  pending.add(promise)
  promise.then(() => pending.delete(promise), () => pending.delete(promise))
  return promise
}
const call = (index, name, args = {}) => tool(peers[index], name, { taskId: tasks[index].taskId, ...args })
const observe = index => call(index, 'velmren_observe')
const act = async (index, actions) => {
  const observation = await observe(index)
  const resolved = actions.map(({ name, ...action }) => {
    const element = observation.elements.find(element => element.name === name)
    assert.ok(element, `${AGENTS[index]} missing control ${name}: ${JSON.stringify(observation.elements)}`)
    assert.equal(element.disabled, false, `${name} is disabled`)
    return { ...action, ref: element.ref }
  })
  return call(index, 'velmren_act', { observationId: observation.observationId, actions: resolved })
}
const click = (index, name) => act(index, [{ type: 'click', name }])
const wait = async (index, text, timeoutMs = 15000) => {
  const value = await call(index, 'velmren_wait', { text, timeoutMs })
  assert.equal(value.matched, true, `${AGENTS[index]} never showed ${text}`)
  return value
}
const pageList = async index => {
  const value = await call(index, 'velmren_list_pages')
  assert.ok(Array.isArray(value.pages), 'list_pages must return {pages}')
  assert.ok(value.pages.every(page => typeof page.pageId === 'string'), 'Every page must have pageId')
  return value.pages
}
const popupFor = async index => {
  const pages = await eventually(() => pageList(index), pages => pages.length === 2 && pages.some(page => page.url?.startsWith(`${fixture.origins[1]}/oauth?`)), `${AGENTS[index]} popup attachment`)
  return pages.find(page => page.pageId !== tasks[index].mainPageId)
}
const assertOverlap = (entries, expected, name) => {
  assert.equal(entries.length, expected.length, `${name} entry count`)
  assert.deepEqual(entries.map(entry => entry.agent).sort(), [...expected].sort(), `${name} participants`)
  assert.ok(entries.every(entry => Number.isFinite(entry.completedAt)), `${name} did not complete its barrier`)
  const lastStartedAt = Math.max(...entries.map(entry => entry.startedAt))
  const firstCompletedAt = Math.min(...entries.map(entry => entry.completedAt))
  assert.ok(lastStartedAt <= firstCompletedAt, `${name} requests did not overlap`)
  assert.equal(fixture.evidence.barriers.find(barrier => barrier.name === name)?.concurrentRequests, expected.length)
  return { participants: entries.length, lastStartedAt, firstCompletedAt }
}
const conversation = async round => {
  const indexes = ROUNDS[round].map(agent => AGENTS.indexOf(agent))
  await Promise.all(indexes.map(async index => {
    await act(index, [
      { type: 'select', name: 'Conversation round', value: round },
      { type: 'fill', name: 'Local message', value: `${round}: synthetic message from ${AGENTS[index]}` },
      { type: 'click', name: 'Send local message' }
    ])
    await wait(index, `Conversation completed: ${round} / ${AGENTS[index]}`)
  }))
  const entries = fixture.evidence.messages.filter(entry => entry.round === round)
  const overlap = assertOverlap(entries, ROUNDS[round], round)
  for (const entry of entries) {
    assert.equal(entry.cookieOwner, entry.agent)
    assert.equal(entry.localOwner, entry.agent)
    assert.equal(entry.message, `${round}: synthetic message from ${entry.agent}`)
    assert.equal(entry.sessionMarker, tasks[AGENTS.indexOf(entry.agent)].sessionMarker)
  }
  return overlap
}

try {
  fixture = await multiAgentFixture()
  const { startBroker } = await import(pathToFileURL(path.join(agentDirectory, 'broker.mjs')))
  const policy = { webCompatibility: true, allowedOrigins: fixture.origins, maxTasks: 16, maxActiveActions: 5 }
  app = await startBroker({ executable: path.resolve(executable), stateDir: path.join(output, 'state'), policy, browserArgs: ['--headless=new'] })
  app.broker.onEvent = event => protocolEvents.push(event)
  report.browser = app.broker.browser.version
  report.browserPid = app.broker.browser.process.pid
  report.policy = policy
  const initialContexts = (await app.broker.browser.send('Target.getBrowserContexts')).browserContextIds

  const registrations = await Promise.all(AGENTS.map(agent => admin('client_register', { label: `Acceptance ${agent}` })))
  assert.equal(new Set(registrations.map(item => item.clientId)).size, 5)
  assert.equal(new Set(registrations.map(item => item.token)).size, 5)
  await Promise.all(registrations.map(async (registration, index) => {
    assert.equal(typeof registration.clientId, 'string')
    assert.equal(typeof registration.token, 'string')
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [fileURLToPath(new URL('./multi-agent-mcp-entry.mjs', import.meta.url)), agentDirectory],
      env: { VELMREN_ACCEPTANCE_CONNECTION: JSON.stringify({ endpoint: app.descriptor.endpoint, token: registration.token, client: registration.clientId }) },
      stderr: 'pipe'
    })
    const peer = { agent: AGENTS[index], owner: registration.clientId, transport, client: new Client({ name: `acceptance-${AGENTS[index]}`, version: '1.0.0' }), stderr: '' }
    peers[index] = peer
    transport.stderr.on('data', chunk => { peer.stderr = (peer.stderr + chunk).slice(-16000) })
    await peer.client.connect(transport)
    peer.pid = transport.pid
    const listed = await peer.client.listTools()
    for (const name of ['velmren_create_task', 'velmren_observe', 'velmren_act', 'velmren_wait', 'velmren_finish', 'velmren_list_pages', 'velmren_select_page', 'velmren_close_page', 'velmren_handle_dialog']) {
      assert.ok(listed.tools.some(tool => tool.name === name), `${peer.agent} missing MCP tool ${name}`)
    }
  }))
  assert.equal(new Set(peers.map(peer => peer.pid)).size, 5)
  assert.ok(peers.every(peer => Number.isInteger(peer.pid) && peer.pid !== process.pid))
  report.clients = peers.map(({ agent, owner, pid }) => ({ agent, owner, pid }))
  pass('five distinct MCP stdio subprocesses and broker owner credentials')

  tasks.push(...await Promise.all(peers.map(peer => tool(peer, 'velmren_create_task', { url: `${fixture.url}/signup/${peer.agent}`, label: `Synthetic signup ${peer.agent}` }))))
  assert.equal(new Set(tasks.map(task => task.taskId)).size, 5)
  await Promise.all(tasks.map(async (task, index) => {
    assert.equal(task.owner, peers[index].owner)
    const observation = await observe(index)
    assert.equal(observation.url, `${fixture.url}/signup/${AGENTS[index]}`)
    assert.equal(typeof observation.pageId, 'string')
    task.mainPageId = observation.pageId
    task.sessionMarker = /Session marker: ([0-9a-f-]{36})/.exec(observation.text)?.[1]
    assert.ok(task.sessionMarker)
    const listed = await tool(peers[index], 'velmren_list_tasks')
    assert.deepEqual(listed.tasks.map(item => item.taskId), [task.taskId])
  }))
  assert.equal(new Set(tasks.map(task => task.sessionMarker)).size, 5)
  const ownedContextIds = (await app.broker.browser.send('Target.getBrowserContexts')).browserContextIds.filter(id => !initialContexts.includes(id))
  assert.equal(ownedContextIds.length, 5, 'Each task must have its own BrowserContext')
  pass('five different signup pages with owner-specific task lists and session storage')

  await Promise.all(AGENTS.map((_, index) => click(index, 'Begin local sign-in')))
  const popups = await Promise.all(AGENTS.map((_, index) => popupFor(index)))
  await assert.rejects(tool(peers[0], 'velmren_observe', { taskId: tasks[1].taskId }), /not found|owned|forbidden/i)
  await assert.rejects(tool(peers[0], 'velmren_list_pages', { taskId: tasks[1].taskId }), /not found|owned|forbidden/i)
  await assert.rejects(call(0, 'velmren_select_page', { pageId: popups[1].pageId }), /not found|owned|forbidden/i)
  await assert.rejects(call(0, 'velmren_close_page', { pageId: popups[1].pageId }), /not found|owned|forbidden/i)
  assert.equal((await pageList(1)).length, 2)
  pass('cross-owner task reads and foreign page selection/closure are denied without side effects')

  await Promise.all(popups.map(async (popup, index) => {
    const selected = await call(index, 'velmren_select_page', { pageId: popup.pageId })
    const observation = selected.observation ?? selected
    assert.equal(observation.pageId, popup.pageId)
    assert.match(observation.text, /Opener available: yes/)
    await click(index, 'Authorize synthetic identity')
    await wait(index, `Authorization acknowledged: ${AGENTS[index]}`)
    await call(index, 'velmren_close_page', { pageId: popup.pageId })
    const returned = await observe(index)
    assert.equal(returned.pageId, tasks[index].mainPageId, 'Closing popup must select its opener')
    assert.match(returned.text, new RegExp(`OAuth connected: ${AGENTS[index]} / PostMessage state: verified`))
    assert.equal((await pageList(index)).length, 1)
  }))
  assert.equal(fixture.evidence.authorizations.length, 5)
  assert.ok(fixture.evidence.authorizations.every(item => item.hasOpener && item.previousOwner === ''))
  pass('five OAuth-like popup roundtrips preserve opener, cross-origin postMessage, cookies and opener selection')

  await Promise.all(AGENTS.map((_, index) => click(index, 'Open synthetic prompt')))
  await Promise.all(AGENTS.map(async (_, index) => {
    const observation = await observe(index)
    assert.equal(observation.dialog?.type, 'prompt')
    assert.match(observation.dialog.message, new RegExp(AGENTS[index]))
  }))
  await Promise.all(AGENTS.slice(1).map(async (_, offset) => {
    const index = offset + 1
    await call(index, 'velmren_handle_dialog', { accept: true, promptText: `code-${AGENTS[index]}` })
    await wait(index, `Dialog result: code-${AGENTS[index]}`)
  }))
  assert.equal((await observe(0)).dialog?.type, 'prompt')
  await call(0, 'velmren_handle_dialog', { accept: true, promptText: `code-${AGENTS[0]}` })
  await wait(0, `Dialog result: code-${AGENTS[0]}`)
  pass('five prompt dialogs are observable and handled independently while one remains open')

  await Promise.all(AGENTS.map(async (agent, index) => {
    await act(index, [
      { type: 'fill', name: 'Display name', value: `Synthetic ${agent}` },
      { type: 'fill', name: 'Synthetic email', value: `${agent}@example.invalid` },
      { type: 'select', name: 'Role', value: 'builder' },
      { type: 'click', name: 'Create synthetic account' }
    ])
    await wait(index, `Signup complete: ${agent}`)
  }))
  const signupOverlap = assertOverlap(fixture.evidence.signups, AGENTS, 'signup')
  for (const entry of fixture.evidence.signups) {
    assert.equal(entry.displayName, `Synthetic ${entry.agent}`)
    assert.equal(entry.email, `${entry.agent}@example.invalid`)
    assert.equal(entry.role, 'builder')
    assert.equal(entry.dialogResult, `code-${entry.agent}`)
    assert.equal(entry.cookieOwner, entry.agent)
    assert.equal(entry.oauthOwner, entry.agent)
    assert.equal(entry.localOwner, entry.agent)
    assert.equal(entry.sessionMarker, tasks[AGENTS.indexOf(entry.agent)].sessionMarker)
  }
  pass('five signup submissions overlap and retain independent cookie/local/session storage', signupOverlap)

  await Promise.all(AGENTS.map((_, index) => click(index, 'Wait for independent gate')))
  await fixture.waitFor(evidence => evidence.gates.length === 5, 'five independent gate requests')
  const waitSettled = AGENTS.map(() => false)
  const waits = AGENTS.map((agent, index) => wait(index, `Independent gate opened: ${agent}`).finally(() => { waitSettled[index] = true }))
  waits.forEach(promise => promise.catch(() => {}))
  await Promise.all(peers.map(peer => tool(peer, 'velmren_list_tasks')))
  for (const agent of AGENTS.slice(1)) fixture.releaseGate(agent)
  await bounded(Promise.all(waits.slice(1)), 'four waits complete while the first gate remains held')
  const waitingOverlap = await bounded(conversation('during-wait'), 'four conversations complete while agent-1 waits')
  assert.equal(waitSettled[0], false, 'The first wait must still be pending during other agents work')
  fixture.releaseGate(AGENTS[0])
  await waits[0]
  pass('independent waits and four conversations progress while one agent waits', waitingOverlap)

  const paused = await call(0, 'velmren_request_human', { reason: 'Synthetic pause isolation acceptance check' })
  assert.equal(paused.state, 'needs-human')
  await assert.rejects(observe(0), /paused|needs-human/i)
  const pausedOverlap = await conversation('during-pause')
  assert.equal((await tool(peers[0], 'velmren_list_tasks')).tasks[0].state, 'needs-human')
  assert.equal((await admin('task_control', { taskId: tasks[0].taskId, action: 'resume' })).state, 'agent-active')
  assert.match((await observe(0)).text, new RegExp(tasks[0].sessionMarker))
  pass('a paused task does not stop the other four conversations and resumes with its session', pausedOverlap)

  for (const round of ['conversation-1', 'conversation-2']) {
    pass(`five parallel conversations complete ${round}`, await conversation(round))
  }
  await assert.rejects(call(0, 'velmren_navigate', { url: 'http://127.0.0.1:1/forbidden' }), /not permitted|denied/i)
  assert.equal((await observe(0)).url, `${fixture.url}/signup/${AGENTS[0]}`)
  pass('explicit allowedOrigins still denies an off-policy navigation without changing the task')

  await click(0, 'Begin local sign-in')
  await popupFor(0)
  assert.equal((await call(0, 'velmren_finish')).state, 'completed')
  await assert.rejects(observe(0), /already ended|completed/i)
  pass('finishing one task with an open popup leaves four conversations operational', await conversation('after-finish'))
  await Promise.all(AGENTS.slice(1).map((_, offset) => call(offset + 1, 'velmren_finish')))
  const status = await admin('broker_status')
  assert.equal(status.maxActiveActions, 5)
  assert.ok(tasks.every(task => status.tasks.some(item => item.taskId === task.taskId && item.state === 'completed')))
  const { targetInfos } = await app.broker.browser.send('Target.getTargets')
  assert.ok(!targetInfos.some(target => ownedContextIds.includes(target.browserContextId)), 'No task page may survive context cleanup')
  const remainingContexts = (await app.broker.browser.send('Target.getBrowserContexts')).browserContextIds
  assert.deepEqual([...remainingContexts].sort(), [...initialContexts].sort(), 'All task BrowserContexts must be disposed')
  report.cleanup.tasksCompleted = 5
  report.cleanup.remainingTaskContexts = 0
  assert.deepEqual(fixture.evidence.errors, [])
  assert.ok(!protocolEvents.some(event => event.type === 'protocol-error'), `Protocol errors: ${JSON.stringify(protocolEvents.filter(event => event.type === 'protocol-error'))}`)
  pass('all task pages and contexts are disposed without protocol errors')
} catch (error) {
  failure = error
  report.error = error.stack
} finally {
  const activePeers = peers.filter(Boolean)
  const results = await Promise.allSettled(activePeers.map(async peer => {
    await peer.client.close()
    assert.equal(peer.transport.pid, null, `${peer.agent} MCP process still attached`)
    await eventually(async () => processAlive(peer.pid), alive => !alive, `${peer.agent} MCP process exit`)
    assert.equal(peer.stderr, '', `${peer.agent} MCP stderr: ${peer.stderr}`)
  }))
  report.cleanup.mcp = results.map((result, index) => ({ agent: activePeers[index].agent, closed: result.status === 'fulfilled', ...(result.status === 'rejected' ? { error: String(result.reason) } : {}) }))
  for (const result of results) if (result.status === 'rejected' && !failure) failure = result.reason
  try {
    await app?.close()
    if (app) await eventually(async () => processAlive(report.browserPid), alive => !alive, 'browser process exit')
  } catch (error) { if (!failure) failure = error; report.cleanup.browserError = error.stack }
  try { await fixture?.close() } catch (error) { if (!failure) failure = error; report.cleanup.fixtureError = error.stack }
  await Promise.allSettled([...pending])
  report.cleanup.browserClosed = app ? app.broker.browser.closed : true
  report.fixture = fixture?.evidence
  report.protocolEvents = protocolEvents
  report.finishedAt = new Date().toISOString()
  report.passed = !failure
  if (failure && !report.error) report.error = failure.stack ?? String(failure)
  await writeFile(path.join(output, 'result.json'), JSON.stringify(report, null, 2))
  if (app) await writeFile(path.join(output, 'browser-stderr.txt'), app.broker.browser.stderr)
}
if (failure) throw failure
console.log(`PASS acceptance complete; evidence: ${path.join(output, 'result.json')}`)

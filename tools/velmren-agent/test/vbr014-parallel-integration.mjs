// node test/vbr014-parallel-integration.mjs BROWSER_EXE NEW_OUTPUT_DIR [--agent-directory=DIR]
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { parallelFixture } from './vbr014-parallel-fixture.mjs'

const args = process.argv.slice(2), positional = args.filter(arg => !arg.startsWith('--'))
assert.equal(positional.length, 2, 'Usage: BROWSER_EXE NEW_OUTPUT_DIR [--agent-directory=DIR]')
assert.ok(args.every(arg => !arg.startsWith('--') || arg.startsWith('--agent-directory=')))
const directory = path.resolve(args.find(arg => arg.startsWith('--agent-directory='))?.slice('--agent-directory='.length) ?? fileURLToPath(new URL('../', import.meta.url)))
const output = path.resolve(positional[1])
await mkdir(path.dirname(output), { recursive: true })
await mkdir(output)
const report = { passed: false, scope: 'Two independent MCP processes, same native headless browser, new persistent synthetic profile; no focus overrides in test', directory, startedAt: new Date().toISOString(), clients: [], cases: [], calls: [], cleanup: {} }
const peers = [], owned = []
let app, fixture, failure
const alive = pid => { try { process.kill(pid, 0); return true } catch (error) { if (error.code === 'ESRCH') return false; throw error } }
const exited = async pid => {
  for (let count = 0; count < 80; count++) { if (!alive(pid)) return; await delay(100) }
  throw new Error(`Owned process ${pid} did not exit`)
}
const tool = async (index, name, values = {}, allowError = false) => {
  const entry = { peer: index, name, startedAt: Date.now() }
  report.calls.push(entry)
  try {
    const response = await peers[index].client.callTool({ name: `velmren_${name}`, arguments: values }, undefined, { timeout: 40000 })
    const result = response.structuredContent ?? JSON.parse(response.content.find(item => item.type === 'text').text)
    entry.error = !!response.isError
    if (response.isError && !allowError) throw Object.assign(new Error(result.error), { code: result.code })
    return result
  } finally { entry.completedAt = Date.now() }
}
const observe = (index, task) => tool(index, 'observe', { taskId: task.taskId })
const act = async (index, task, name, values = {}, allowMissing = false) => {
  const observation = await observe(index, task)
  const element = observation.elements.find(item => item.name === name)
  if (!element && allowMissing) return { missing: name }
  assert.ok(element, `Missing synthetic control ${name}`)
  return tool(index, 'act', { taskId: task.taskId, observationId: observation.observationId, actions: [{ type: 'click', ref: element.ref, ...values }] }, allowMissing)
}
const snapshot = task => app.broker.tasks.get(task.taskId).page.evaluate(() => ({
  state: JSON.parse(document.documentElement.dataset.fixtureState),
  events: JSON.parse(document.documentElement.dataset.fixtureEvents)
}))
const create = async (peer, origin, kind) => {
  const task = await tool(peer, 'create_task', { url: `${origin}/?kind=${kind}`, label: `VBR014 synthetic ${kind}` })
  owned.push({ peer, task })
  return task
}
const finish = async (peer, task) => {
  await tool(peer, 'finish', { taskId: task.taskId })
  owned.splice(owned.findIndex(item => item.task === task), 1)
}
async function runCase(kind, mode, repeat) {
  const row = { kind, mode, repeat, snapshots: {}, expectedOpen: kind !== 'shared-storage' || mode !== 'same-origin' }
  report.cases.push(row)
  const a = await create(0, fixture.origins[0], kind)
  const b = mode === 'isolated' ? null : await create(1, fixture.origins[mode === 'different-origin' ? 1 : 0], 'native')
  row.snapshots.beforeOpen = await snapshot(a)
  row.openResult = (await act(0, a, 'Country menu')).actionResult
  row.snapshots.afterOpen = await snapshot(a)
  const observedOpen = await observe(0, a)
  row.optionObservedAfterOpen = observedOpen.elements.some(item => item.name === 'Belgium')
  row.snapshots.afterObserve = await snapshot(a)
  if (b) {
    const callsStart = report.calls.length
    // The MCP clients overlap work; all input remains scoped to B's task.
    await Promise.all([observe(0, a), act(1, b, 'Peer text', { type: 'fill', value: 'synthetic peer input' })])
    row.callsOverlapped = report.calls.slice(callsStart).some(left => report.calls.slice(callsStart).some(right => left.peer !== right.peer && Math.max(left.startedAt, right.startedAt) < Math.min(left.completedAt, right.completedAt)))
    row.snapshots.afterPeerFill = await snapshot(a)
    await act(1, b, 'Outside action')
    row.snapshots.afterPeerClick = await snapshot(a)
    await act(1, b, 'Country menu')
    row.snapshots.afterPeerMenu = await snapshot(a)
    await act(1, b, 'Belgium', {}, true)
    if (kind === 'shared-storage') await act(1, b, 'Write shared state')
  }
  // Allow queued native toggle/storage events to be delivered before comparison.
  await delay(120)
  row.snapshots.beforeSelect = await snapshot(a)
  const observation = await observe(0, a)
  row.optionObservedBeforeSelect = observation.elements.some(item => item.name === 'Belgium')
  row.selectResult = await act(0, a, 'Belgium', {}, true)
  row.snapshots.afterSelect = await snapshot(a)
  row.openMatches = row.snapshots.beforeSelect.state.open === row.expectedOpen
  row.selectionMatches = !row.expectedOpen || row.snapshots.afterSelect.state.chosen === 'belgium'
  row.passed = row.openMatches && row.selectionMatches
  console.log(`${row.passed ? 'PASS' : 'FAIL'} ${kind} ${mode} ${repeat}: open=${row.snapshots.beforeSelect.state.open}, reason=${row.snapshots.beforeSelect.state.closedReason}`)
  if (b) await finish(1, b)
  await finish(0, a)
}

try {
  fixture = await parallelFixture()
  const { startBroker } = await import(pathToFileURL(path.join(directory, 'broker.mjs')))
  app = await startBroker({ executable: path.resolve(positional[0]), stateDir: path.join(output, 'state'), policy: { profileMode: 'persistent', webCompatibility: true, allowedOrigins: fixture.origins, maxTasks: 8, maxActiveActions: 2 }, browserArgs: ['--headless=new'] })
  report.browser = app.broker.browser.version
  report.browserPid = app.broker.browser.process.pid
  for (let index = 0; index < 2; index++) {
    const registration = await app.broker.rpc('admin', 'client_register', { label: `VBR014 parallel peer ${index}` })
    const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('./multi-agent-mcp-entry.mjs', import.meta.url)), directory], env: { VELMREN_ACCEPTANCE_CONNECTION: JSON.stringify({ endpoint: app.descriptor.endpoint, token: registration.token, client: registration.clientId }) }, stderr: 'pipe' })
    const peer = { transport, client: new Client({ name: `vbr014-peer-${index}`, version: '1' }), stderr: '' }
    peers.push(peer)
    transport.stderr?.on('data', value => { peer.stderr = (peer.stderr + value).slice(-4000) })
    await peer.client.connect(transport)
    peer.pid = transport.pid
    report.clients.push({ index, pid: peer.pid, owner: registration.clientId, tools: (await peer.client.listTools()).tools.length })
  }
  assert.notEqual(peers[0].pid, peers[1].pid)
  for (const repeat of [1, 2]) for (const kind of ['window-blur', 'focusout', 'outside', 'native']) for (const mode of ['isolated', 'same-origin', 'different-origin']) await runCase(kind, mode, repeat)
  for (const mode of ['isolated', 'same-origin', 'different-origin']) await runCase('shared-storage', mode, 1)
  assert.ok(report.cases.filter(row => row.mode !== 'isolated').every(row => row.callsOverlapped), 'Independent client calls must overlap')
  assert.ok(report.cases.every(row => row.passed), `${report.cases.filter(row => !row.passed).length} menu persistence/selection cases failed`)
} catch (error) { failure = error; report.error = error.stack }
finally {
  for (const { peer, task } of [...owned]) await tool(peer, 'cancel', { taskId: task.taskId }).catch(() => {})
  const closed = await Promise.allSettled(peers.map(async peer => { await peer.client.close(); await exited(peer.pid) }))
  report.cleanup.clients = closed.map((item, index) => ({ pid: peers[index].pid, exited: item.status === 'fulfilled', stderr: peers[index].stderr }))
  if (closed.some(item => item.status === 'rejected') && !failure) failure = new Error('MCP process cleanup failed')
  try { await app?.close(); if (app) await exited(report.browserPid); report.cleanup.browserExited = true } catch (error) { report.cleanup.browserError = error.message; failure ??= error }
  await fixture?.close()
  report.cleanup.fixtureClosed = true
  report.passed = !failure
  report.finishedAt = new Date().toISOString()
  await writeFile(path.join(output, 'result.json'), JSON.stringify(report, null, 2))
  if (app) await writeFile(path.join(output, 'browser-stderr.txt'), app.broker.browser.stderr)
}
if (failure) throw failure
console.log(`PASS VBR014 parallel acceptance; ${path.join(output, 'result.json')}`)

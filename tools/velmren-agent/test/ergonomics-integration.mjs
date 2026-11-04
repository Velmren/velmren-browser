// node test/ergonomics-integration.mjs BROWSER_EXE NEW_OUTPUT_DIR [--agent-directory=DIR]
// Only owned local fixtures, synthetic values and a fresh headless profile.
import assert from 'node:assert/strict'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { ergonomicsFixture, SENTINELS } from './ergonomics-fixture.mjs'

const positional = process.argv.slice(2).filter(arg => !arg.startsWith('--'))
const option = process.argv.slice(2).find(arg => arg.startsWith('--agent-directory='))
if (positional.length !== 2 || process.argv.slice(2).some(arg => arg.startsWith('--') && arg !== option)) throw new Error('Usage: ergonomics-integration.mjs BROWSER_EXE NEW_OUTPUT_DIR [--agent-directory=DIR]')
const [executable, outputArgument] = positional
const directory = path.resolve(option?.slice('--agent-directory='.length) ?? fileURLToPath(new URL('../', import.meta.url)))
const output = path.resolve(outputArgument), stateDir = path.join(output, 'state')
await mkdir(path.dirname(output), { recursive: true }); await mkdir(output)
const report = { passed: false, startedAt: new Date().toISOString(), scope: 'Actual MCP/browser action contracts, synthetic local forms only', checks: [], calls: [], protocol: [], cleanup: {} }
let fixture, app, client, transport, task, failure, originalSend
const pass = name => { report.checks.push(name); console.log(`PASS ${name}`) }
const tool = async (name, args = {}) => {
  const call = { tool: name, startedAt: Date.now() }; report.calls.push(call)
  try {
  const result = await client.callTool({ name, arguments: { ...(task ? { taskId: task.taskId } : {}), ...args } }, undefined, { timeout: 40000 })
  const value = JSON.parse(result.content.find(item => item.type === 'text').text)
  if (result.isError) { const error = new Error(value.error); Object.assign(error, { code: value.code, actionResult: value.actionResult }); throw error }
  call.passed = true; return value
  } catch (error) { call.passed = false; throw error }
  finally { call.durationMs = Date.now() - call.startedAt }
}
const admin = async (method, args = {}) => {
  const response = await fetch(`${app.descriptor.endpoint}/rpc`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${app.descriptor.adminToken}` }, body: JSON.stringify({ method, args }), signal: AbortSignal.timeout(30000) })
  const result = await response.json(); assert.equal(result.ok, true, result.error); return result.result
}
const observe = () => tool('velmren_observe')
const element = (observation, name) => {
  const found = observation.elements.find(item => item.name === name)
  assert.ok(found, `Missing control ${name}`); return found
}
const act = async (name, action) => {
  const observation = await observe()
  return tool('velmren_act', { observationId: observation.observationId, actions: [{ ...action, ref: element(observation, name).ref }] })
}
const eventually = async condition => {
  const end = Date.now() + 5000
  while (!condition()) { if (Date.now() >= end) throw new Error('Fixture effect was not observed'); await delay(25) }
}
const captureError = async call => {
  try { await call; assert.fail('Expected structured action refusal') } catch (error) { if (error.code === 'ERR_ASSERTION') throw error; return error }
}
try {
  fixture = await ergonomicsFixture()
  const { startBroker } = await import(pathToFileURL(path.join(directory, 'broker.mjs')))
  app = await startBroker({ executable: path.resolve(executable), stateDir, policy: { allowedOrigins: [fixture.origin], webCompatibility: true }, browserArgs: ['--headless=new'] })
  const send = app.broker.browser.send.bind(app.broker.browser)
  app.broker.browser.send = async (...args) => {
    const entry = { method: args[0], startedAt: Date.now() }; report.protocol.push(entry)
    try { const value = await send(...args); entry.passed = true; return value }
    catch (error) { entry.passed = false; throw error }
    finally { entry.durationMs = Date.now() - entry.startedAt }
  }
  report.browser = app.broker.browser.version
  const registration = await admin('client_register', { label: 'Contract acceptance' })
  transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('./multi-agent-mcp-entry.mjs', import.meta.url)), directory], env: { VELMREN_ACCEPTANCE_CONNECTION: JSON.stringify({ endpoint: app.descriptor.endpoint, token: registration.token, client: registration.clientId }) }, stderr: 'pipe' })
  client = new Client({ name: 'ergonomics-acceptance', version: '1' }); transport.stderr?.resume()
  await client.connect(transport)
  task = await tool('velmren_create_task', { url: `${fixture.origin}/`, label: 'Synthetic action contracts' })
  let observation = await observe()
  assert.equal(observation.complete, true)
  assert.ok(element(observation, 'Full name').availableActions.includes('fill'))
  assert.ok(!element(observation, 'Read only').availableActions.includes('fill'))
  assert.ok(!element(observation, 'Submit once').availableActions.includes('fill'))
  assert.ok(element(observation, 'Hidden upload').availableActions.includes('uploadFiles'))
  assert.deepEqual(element(observation, 'Disabled upload').availableActions, [])
  pass('Observations advertise only supported capabilities, including hidden and disabled file controls')

  for (const [name, action] of [['Full name', { type: 'fill', value: SENTINELS.field }], ['Choice', { type: 'select', value: 'two' }]]) {
    const result = await act(name, action)
    assert.equal(result.actionResult.results[0].delivery, 'delivered_verified')
    assert.deepEqual(result.actionResult.results[0].verification, { scope: 'element', status: 'matched' })
    assert.ok(!JSON.stringify(result.actionResult).includes(action.value))
  }
  pass('Fill and select are read back at element scope; values are absent from action metadata')
  const rewritten = await act('Rewritten value', { type: 'fill', value: 'requested-value' })
  assert.equal(rewritten.actionResult.results[0].verification.status, 'mismatch')
  assert.notEqual(rewritten.actionResult.results[0].delivery, 'delivered_verified')
  pass('Application rewriting a field is reported as a mismatch without replaying input')

  await act('Start property changes', { type: 'click' })
  observation = await observe()
  const delayedRef = element(observation, 'Delayed value').ref
  const waited = await tool('velmren_wait', { predicate: { observationId: observation.observationId, ref: delayedRef, state: 'value', value: SENTINELS.wait }, timeoutMs: 5000 })
  assert.equal(waited.matched, true); assert.equal(waited.lastObserved.valueMatches, true)
  assert.ok(Number.isFinite(waited.elapsedMs)); assert.ok(!JSON.stringify(waited.lastObserved).includes(SENTINELS.wait))
  pass('Predicate wait detects a property-only value update and returns bounded diagnostics')

  observation = await observe()
  const beforeBatch = fixture.evidence.submissions
  const partial = await captureError(tool('velmren_act', { observationId: observation.observationId, actions: [{ type: 'click', ref: element(observation, 'Submit once').ref }, { type: 'click', ref: 'e999999' }] }))
  assert.equal(partial.actionResult.completed, 1); assert.equal(partial.actionResult.failedIndex, 1)
  assert.equal(partial.actionResult.delivery, 'not_delivered')
  assert.equal(partial.actionResult.recovery.retry, 'failed_action_only')
  await eventually(() => fixture.evidence.submissions === beforeBatch + 1)
  pass('A failed second action preserves the first submission and permits no whole-batch replay')

  observation = await observe()
  const stale = await captureError(tool('velmren_act', { observationId: observation.observationId, actions: [
    { type: 'click', ref: element(observation, 'Replace field').ref },
    { type: 'fill', ref: element(observation, 'Full name').ref, value: 'must-not-fill-replacement' }
  ] }))
  assert.equal(stale.actionResult.completed, 1); assert.equal(stale.actionResult.failedIndex, 1)
  assert.equal(stale.actionResult.delivery, 'not_delivered')
  assert.notEqual(element(await observe(), 'Full name').value, 'must-not-fill-replacement')
  pass('An identical replacement never receives input through a stale observation')

  observation = await observe()
  const beforeLostReply = fixture.evidence.submissions
  originalSend = app.broker.browser.send
  let injected = false
  app.broker.browser.send = async function (method, params, ...rest) {
    const result = await originalSend.call(this, method, params, ...rest)
    if (!injected && method === 'Input.dispatchMouseEvent' && params.type === 'mouseReleased') { injected = true; throw new Error('Synthetic lost response after dispatch') }
    return result
  }
  const uncertain = await captureError(tool('velmren_act', { observationId: observation.observationId, actions: [{ type: 'click', ref: element(observation, 'Submit once').ref }] }))
  app.broker.browser.send = originalSend; originalSend = null
  assert.equal(injected, true); assert.equal(uncertain.actionResult.delivery, 'delivery_uncertain')
  assert.equal(uncertain.actionResult.recovery.retry, 'none')
  await eventually(() => fixture.evidence.submissions === beforeLostReply + 1)
  await delay(100); assert.equal(fixture.evidence.submissions, beforeLostReply + 1)
  pass('A lost response after an actual submission remains uncertain and never automatically retries')

  const waiting = tool('velmren_wait', { text: 'never-present-queue-test', timeoutMs: 350 })
  await delay(75)
  const queuedObservation = observe()
  assert.equal((await waiting).matched, false); await queuedObservation
  const interruptedWait = tool('velmren_wait', { text: 'never-present-pause-test', timeoutMs: 10000 }).catch(error => error)
  await delay(75)
  const pauseStarted = Date.now()
  await admin('task_control', { taskId: task.taskId, action: 'pause' })
  const stopped = await interruptedWait
  assert.ok(stopped instanceof Error); assert.ok(Date.now() - pauseStarted < 2500)
  await admin('task_control', { taskId: task.taskId, action: 'resume' })
  pass('Waits release promptly on pause and serialize same-task observations')

  await tool('velmren_navigate', { url: `${fixture.origin}/large` })
  const large = await observe()
  assert.equal(large.complete, false); assert.ok(large.truncated)
  assert.equal(large.elements.length, 150); assert.equal(large.text.length, 10000)
  report.largeObservation = { complete: large.complete, truncated: large.truncated, limits: large.limits, counts: large.counts }
  pass('Large pages explicitly report truncated controls, text, options and field summaries')
  await tool('velmren_navigate', { url: `${fixture.origin}/` })
  const password = await act('Password', { type: 'fill', value: SENTINELS.password })
  assert.equal(password.actionResult.results[0].delivery, 'delivered_verified')
  assert.deepEqual(password.actionResult.results[0].verification, { scope: 'element', status: 'matched' })
  assert.equal(password.observation.privacy.active, true)
  assert.ok(!JSON.stringify(password).includes(SENTINELS.password))
  assert.equal(await app.broker.page(app.broker.tasks.get(task.taskId)).evaluate(value => document.querySelector('#password').value === value, SENTINELS.password), true)
  pass('Password fill retains element verification while protecting all task output')
  await tool('velmren_finish')
  assert.equal((await app.broker.browser.send('Target.getBrowserContexts')).browserContextIds.length, 0)
  report.cleanup.contextsRestored = true
} catch (error) { failure = error; report.error = error.message }
finally {
  if (originalSend && app) app.broker.browser.send = originalSend
  if (failure && task) await tool('velmren_cancel').catch(() => {})
  await client?.close(); await transport?.close()
  try { await app?.close(); report.cleanup.brokerClosed = true } catch (error) { failure ??= error; report.cleanup.error = error.message }
  await fixture?.close()
  report.evidence = fixture?.evidence
}
if (!failure) {
  try {
    const files = (await readdir(stateDir)).filter(name => /^requests(?:\.1)?\.jsonl$/.test(name))
    assert.ok(files.length > 0)
    const traces = []
    for (const file of files) {
      const contents = await readFile(path.join(stateDir, file), 'utf8')
      assert.ok(Buffer.byteLength(contents) <= 1024 * 1024)
      for (const sentinel of [...Object.values(SENTINELS), fixture.origin, app.descriptor.adminToken]) assert.ok(!contents.includes(sentinel))
      traces.push(...contents.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)))
    }
    assert.ok(traces.some(record => record.method === 'task_act'))
    report.traceRecords = traces.length
    pass('Bounded request traces omit form values, passwords, URLs and credentials')
  } catch (error) { failure = error; report.error = error.message }
}
report.passed = !failure; report.finishedAt = new Date().toISOString()
await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2))
if (failure) throw failure
console.log('Agent ergonomics acceptance passed.')

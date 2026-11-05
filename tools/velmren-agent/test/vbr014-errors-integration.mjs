// Actual native browser + MCP error transport; synthetic localhost data only.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const argv = process.argv.slice(2), positional = argv.filter(x => !x.startsWith('--'))
const [executable, output] = positional
assert.equal(positional.length, 2)
const directory = path.resolve(argv.find(x => x.startsWith('--agent-directory='))?.slice(18) ?? fileURLToPath(new URL('../', import.meta.url)))
await mkdir(path.dirname(output), { recursive: true }); await mkdir(output)
const report = { passed: false, cases: [], cleanup: {}, agentDirectory: directory, syntheticOnly: true }
const fixture = createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html' })
  res.end(`<!doctype html><title>Operation fixture</title><style>body{padding:25px}#covered{position:relative;width:200px;height:60px}#cover{position:absolute;inset:0;background:#ddd;z-index:2}</style>
    <label>Name<input id="name"></label><button disabled>Disabled button</button>
    <div id="covered"><button id="obscured" onclick="document.body.dataset.clicked='yes'">Obscured button</button><div id="cover">Overlay</div></div>
    <button id="ordinary" onclick="document.body.dataset.once='yes'">Ordinary button</button>`)
})
await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${fixture.address().port}`
const refused = createServer(); await new Promise(resolve => refused.listen(0, '127.0.0.1', resolve))
const refusedOrigin = `http://127.0.0.1:${refused.address().port}`
await new Promise(resolve => refused.close(resolve))
let app, client, transport, task
const call = async (name, args = {}) => {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 45000 })
  const value = JSON.parse(result.content.find(x => x.type === 'text').text)
  assert.equal(JSON.stringify(value).includes('VBR014_PRIVATE_MARKER'), false)
  if (result.isError) throw Object.assign(new Error(value.code), value)
  return value
}
const capture = async operation => { try { await operation(); assert.fail('Expected safe failure') } catch (error) { if (error.code === 'ERR_ASSERTION') throw error; return error } }
const scenario = async (name, operation) => { await operation(); report.cases.push({ name, passed: true }); console.log(`PASS ${name}`) }
const observe = () => call('velmren_observe', { taskId: task.taskId })
const element = (o, name) => { const e = o.elements.find(x => x.name === name); assert.ok(e, name); return e }
try {
  const { startBroker } = await import(pathToFileURL(path.join(directory, 'broker.mjs')))
  app = await startBroker({ executable, stateDir: path.join(output, 'state'), policy: { allowedOrigins: [origin, refusedOrigin] }, browserArgs: ['--headless=new'] })
  const registration = await app.broker.rpc('admin', 'client_register', { label: 'VBR014 error contracts' })
  transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('./multi-agent-mcp-entry.mjs', import.meta.url)), directory], env: { VELMREN_ACCEPTANCE_CONNECTION: JSON.stringify({ endpoint: app.descriptor.endpoint, token: registration.token, client: registration.clientId }) }, stderr: 'pipe' })
  transport.stderr?.resume(); client = new Client({ name: 'vbr014-errors', version: '1' }); await client.connect(transport)
  task = await call('velmren_create_task', { url: origin })
  await scenario('disabled_control_has_safe_reason_phase_and_zero_delivery', async () => {
    const o = await observe(), e = element(o, 'Disabled button')
    const error = await capture(() => call('velmren_act', { taskId: task.taskId, observationId: o.observationId, actions: [{ type: 'click', ref: e.ref }] }))
    assert.equal(error.code, 'ELEMENT_DISABLED'); assert.deepEqual(error.diagnostic, { reason: 'disabled', phase: 'prepare' })
    assert.equal(error.taskId, task.taskId); assert.equal(error.actionResult.delivery, 'not_delivered')
  })
  await scenario('overlay_is_preserved_with_specific_obscured_reason', async () => {
    const o = await observe(), e = element(o, 'Obscured button')
    const error = await capture(() => call('velmren_act', { taskId: task.taskId, observationId: o.observationId, actions: [{ type: 'click', ref: e.ref }] }))
    assert.equal(error.code, 'ELEMENT_OBSCURED'); assert.deepEqual(error.diagnostic, { reason: 'obscured', phase: 'prepare', obstruction: 'hit-test' })
    assert.equal(error.actionResult.completed, 0)
  })
  await scenario('stale_observation_is_identified_before_input', async () => {
    const previous = await observe(), o = await observe()
    const error = await capture(() => call('velmren_act', { taskId: task.taskId, observationId: previous.observationId, actions: [{ type: 'click', ref: element(o, 'Ordinary button').ref }] }))
    assert.equal(error.code, 'STALE_OBSERVATION'); assert.deepEqual(error.diagnostic, { reason: 'stale', phase: 'validation' })
    assert.equal(error.actionResult.delivery, 'not_delivered')
  })
  await scenario('global_keyboard_action_delivers_from_fresh_observation', async () => {
    const o = await observe()
    const result = await call('velmren_act', { taskId: task.taskId, observationId: o.observationId, actions: [{ type: 'press', key: 'Tab' }] })
    assert.equal(result.actionResult.completed, 1)
  })
  await scenario('partial_batch_keeps_completed_input_and_specific_failed_action', async () => {
    const o = await observe()
    const error = await capture(() => call('velmren_act', { taskId: task.taskId, observationId: o.observationId, actions: [{ type: 'fill', ref: element(o, 'Name').ref, value: 'Synthetic name' }, { type: 'click', ref: element(o, 'Obscured button').ref }] }))
    assert.equal(error.diagnostic.reason, 'obscured'); assert.equal(error.actionResult.completed, 1); assert.equal(error.actionResult.failedIndex, 1)
    assert.equal(error.actionResult.recovery.retry, 'failed_action_only')
    assert.equal(element(await observe(), 'Name').value, 'Synthetic name')
  })
  await scenario('input_transport_failure_remains_uncertain_and_never_suggests_replay', async () => {
    const o = await observe(), browser = app.broker.browser, original = browser.send
    browser.send = function(method, ...args) {
      if (method === 'Input.insertText') throw Object.assign(new Error('Browser connection closed https://example.test/?secret=VBR014_PRIVATE_MARKER'), { code: 'CONNECTION_ERROR' })
      return original.call(this, method, ...args)
    }
    try {
      const error = await capture(() => call('velmren_act', { taskId: task.taskId, observationId: o.observationId, actions: [{ type: 'fill', ref: element(o, 'Name').ref, value: 'Not delivered' }] }))
      assert.deepEqual(error.diagnostic, { reason: 'transport', phase: 'input' }); assert.equal(error.actionResult.delivery, 'delivery_uncertain'); assert.equal(error.actionResult.recovery.retry, 'none')
    } finally { browser.send = original }
  })
  await scenario('failed_navigation_returns_owned_task_context_and_network_enum', async () => {
    const error = await capture(() => call('velmren_navigate', { taskId: task.taskId, url: refusedOrigin }))
    assert.equal(error.code, 'NAVIGATION_FAILED'); assert.equal(error.diagnostic.phase, 'navigate'); assert.equal(error.diagnostic.networkError, 'ERR_CONNECTION_REFUSED'); assert.equal(error.taskId, task.taskId)
    assert.equal(error.actionResult.recovery.retry, 'none')
  })
  await scenario('failed_create_returns_cancelled_owned_task_id', async () => {
    const error = await capture(() => call('velmren_create_task', { url: refusedOrigin }))
    assert.equal(error.code, 'NAVIGATION_FAILED'); assert.ok(error.taskId); assert.notEqual(error.taskId, task.taskId)
    const tasks = await call('velmren_list_tasks')
    assert.equal(tasks.tasks.find(t => t.taskId === error.taskId).state, 'cancelled')
    assert.equal(error.diagnostic.networkError, 'ERR_CONNECTION_REFUSED')
  })
  report.passed = true
} catch (error) { report.failure = { code: error.code ?? error.name, message: error.code === 'ERR_ASSERTION' ? error.message : 'Acceptance failed' }; process.exitCode = 1 }
finally {
  if (task) await call('velmren_cancel', { taskId: task.taskId }).catch(() => {})
  await client?.close().catch(() => {}); report.cleanup.clientClosed = true
  await app?.close(); report.cleanup.browserClosed = true
  fixture.closeAllConnections(); await new Promise(resolve => fixture.close(resolve)); report.cleanup.fixtureClosed = true
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ passed: report.passed, cases: report.cases.length, failure: report.failure }))
}

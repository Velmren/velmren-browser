// node test/popup-close-integration.mjs BROWSER_EXE NEW_OUTPUT_DIR [--agent-directory=DIR]
// Actual MCP/browser regression, isolated headless profile and local fixture only.
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const args = process.argv.slice(2), positional = args.filter(arg => !arg.startsWith('--'))
const option = args.find(arg => arg.startsWith('--agent-directory='))
if (positional.length !== 2 || args.some(arg => arg.startsWith('--') && arg !== option)) throw new Error('Usage: popup-close-integration.mjs BROWSER_EXE NEW_OUTPUT_DIR [--agent-directory=DIR]')
const [executable, outputArgument] = positional
const directory = path.resolve(option?.slice('--agent-directory='.length) ?? fileURLToPath(new URL('../', import.meta.url)))
const output = path.resolve(outputArgument), stateDir = path.join(output, 'state')
await mkdir(path.dirname(output), { recursive: true }); await mkdir(output)
const report = { passed: false, startedAt: new Date().toISOString(), directory, cases: [], cleanup: {} }
let app, client, transport, server, task, originalSend, failure
const evidence = { messages: 0 }
const until = async condition => {
  const deadline = Date.now() + 5000
  while (true) {
    const value = await condition()
    if (value) return value
    if (Date.now() >= deadline) throw new Error('Fixture condition timed out')
    await delay(25)
  }
}
const tool = async (name, args = {}) => {
  const result = await client.callTool({ name, arguments: { ...(task ? { taskId: task.taskId } : {}), ...args } }, undefined, { timeout: 40000 })
  return { isError: !!result.isError, value: JSON.parse(result.content.find(item => item.type === 'text').text) }
}
const ok = async (name, args) => {
  const result = await tool(name, args)
  assert.equal(result.isError, false, JSON.stringify(result.value))
  return result.value
}
const element = (observation, name) => {
  const control = observation.elements.find(item => item.name === name)
  assert.ok(control, `Missing control ${name}`)
  return control.ref
}
try {
  const parent = `<!doctype html><meta charset="utf-8"><title>Popup result fixture</title>
    <button onclick="window.open('/popup','_blank','width=400,height=300')">Open popup</button>
    <p id="status">Messages: 0</p><script>let count=0;addEventListener('message',event=>{
      if(event.origin===location.origin&&event.data==='continued'){
        document.querySelector('#status').textContent='Messages: '+(++count);
        fetch('/message',{method:'POST'});
      }
    });</script>`
  const popup = `<!doctype html><meta charset="utf-8"><title>Closing popup</title>
    <button onclick="if(opener&&!opener.closed)opener.postMessage('continued',location.origin);window.close()">Continue and close</button>`
  server = http.createServer((request, response) => {
    if (request.method === 'POST' && request.url === '/message') {
      evidence.messages++; request.resume(); response.writeHead(200); response.end('ok'); return
    }
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
    response.end(request.url === '/popup' ? popup : parent)
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const origin = `http://127.0.0.1:${server.address().port}`
  const { startBroker } = await import(pathToFileURL(path.join(directory, 'broker.mjs')))
  app = await startBroker({ executable: path.resolve(executable), stateDir, policy: { allowedOrigins: [origin], webCompatibility: true }, browserArgs: ['--headless=new'] })
  report.browser = app.broker.browser.version; report.browserPid = app.broker.browser.process.pid
  const registration = await app.broker.rpc('admin', 'client_register', { label: 'Popup close regression' })
  transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('./multi-agent-mcp-entry.mjs', import.meta.url)), directory], env: { VELMREN_ACCEPTANCE_CONNECTION: JSON.stringify({ endpoint: app.descriptor.endpoint, token: registration.token, client: registration.clientId }) }, stderr: 'pipe' })
  client = new Client({ name: 'popup-close-regression', version: '1' }); transport.stderr?.resume()
  await client.connect(transport)
  for (const mode of ['acknowledged', 'lost-response', 'last-page']) {
    task = await ok('velmren_create_task', { url: `${origin}/`, label: `Popup ${mode}` })
    const parentId = task.selectedPageId
    let observation = await ok('velmren_observe')
    await ok('velmren_act', { observationId: observation.observationId, actions: [{ type: 'click', ref: element(observation, 'Open popup') }] })
    const page = await until(async () => (await ok('velmren_list_pages')).pages.find(page => page.openerId === parentId))
    observation = await ok('velmren_select_page', { pageId: page.pageId })
    if (mode === 'last-page') await ok('velmren_close_page', { pageId: parentId })
    const sessionId = app.broker.tasks.get(task.taskId).pages.get(page.pageId).sessionId
    const entry = { mode, protocol: [], closed: false }; report.cases.push(entry)
    const destroyed = message => { if (message.method === 'Target.targetDestroyed' && message.params.targetId === page.pageId) entry.closed = true }
    app.broker.browser.on('protocol', destroyed)
    originalSend = app.broker.browser.send
    app.broker.browser.send = async function (method, params, targetSessionId, ...rest) {
      const trace = targetSessionId === sessionId ? { method, ...(method === 'Input.dispatchMouseEvent' ? { type: params.type } : {}) } : null
      if (trace) entry.protocol.push(trace)
      let result
      try { result = await originalSend.call(this, method, params, targetSessionId, ...rest); if (trace) trace.acknowledged = true }
      catch (error) { if (trace) trace.error = error.message; throw error }
      if (mode === 'lost-response' && targetSessionId === sessionId && method === 'Input.dispatchMouseEvent' && params.type === 'mouseReleased') {
        trace.responseDropped = true
        throw new Error('Synthetic lost input response')
      }
      return result
    }
    const before = evidence.messages
    entry.response = await tool('velmren_act', { pageId: page.pageId, observationId: observation.observationId, actions: [{ type: 'click', ref: element(observation, 'Continue and close') }] })
    app.broker.browser.send = originalSend; originalSend = null
    await until(() => entry.closed)
    app.broker.browser.off('protocol', destroyed)
    entry.pages = await ok('velmren_list_pages')
    if (mode !== 'last-page') {
      await until(() => evidence.messages === before + 1)
      entry.parent = await ok('velmren_observe', { pageId: parentId })
      assert.match(entry.parent.text, /Messages: 1/)
      assert.equal(entry.pages.selectedPageId, parentId)
    } else {
      assert.equal(entry.pages.pages.length, 0)
      assert.equal(app.broker.tasks.get(task.taskId).state, 'cancelled')
    }
    const releases = entry.protocol.filter(item => item.method === 'Input.dispatchMouseEvent' && item.type === 'mouseReleased')
    assert.equal(releases.length, 1); assert.equal(releases[0].acknowledged, true)
    const result = entry.response.value.actionResult
    assert.equal(result.recovery.retry, 'none'); assert.equal(result.recovery.observe, true)
    if (mode === 'lost-response') {
      assert.equal(entry.response.isError, true)
      assert.equal(result.delivery, 'delivery_uncertain'); assert.equal(result.completed, 0)
    } else {
      assert.equal(entry.response.isError, false, JSON.stringify(entry.response.value))
      assert.equal(result.delivery, 'delivered_unverified'); assert.equal(result.completed, 1)
      assert.equal(result.failedIndex, null)
      assert.equal(entry.response.value.stopped, 'observation_unavailable')
      assert.equal(result.recovery.reason, 'observation_unavailable')
      assert.equal(entry.response.value.observation.complete, false)
      assert.equal(entry.response.value.observation.text, '')
      assert.deepEqual(entry.response.value.observation.elements, [])
      assert.equal(entry.response.value.observation.observationId, undefined)
    }
    entry.passed = true
    if (mode !== 'last-page') await ok('velmren_finish')
    task = null
    console.log(`PASS popup ${mode}`)
  }
  assert.equal((await app.broker.browser.send('Target.getBrowserContexts')).browserContextIds.length, 0)
  report.cleanup.contextsRestored = true
} catch (error) { failure = error; report.error = error.message }
finally {
  if (originalSend && app) app.broker.browser.send = originalSend
  if (task) await tool('velmren_cancel').catch(() => {})
  await client?.close(); await transport?.close()
  try { await app?.close(); report.cleanup.brokerClosed = true; report.cleanup.browserClosed = app?.broker.browser.closed ?? true }
  catch (error) { failure ??= error; report.cleanup.error = error.message }
  if (server) await new Promise(resolve => { server.close(resolve); server.closeAllConnections() })
  report.cleanup.fixtureClosed = true
}
report.evidence = evidence; report.passed = !failure; report.finishedAt = new Date().toISOString()
await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2))
if (failure) throw failure
console.log('Popup close regression passed.')

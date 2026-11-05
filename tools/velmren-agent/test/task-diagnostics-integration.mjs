// Native localhost file-import/network diagnostics, no external services.
// node test/task-diagnostics-integration.mjs BROWSER_EXE NEW_OUTPUT_DIR [--agent-directory=DIR]
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'

const argv = process.argv.slice(2), [executable, destination] = argv.filter(arg => !arg.startsWith('--'))
assert.ok(executable && destination)
const agent = path.resolve(argv.find(arg => arg.startsWith('--agent-directory='))?.slice(18) ?? fileURLToPath(new URL('../', import.meta.url)))
const { startBroker } = await import(pathToFileURL(path.join(agent, 'broker.mjs')))
const { createClient, readConnection } = await import(pathToFileURL(path.join(agent, 'client.mjs')))
const { createMcpServer } = await import(pathToFileURL(path.join(agent, 'mcp.mjs')))
const output = path.resolve(destination), stateDir = path.join(output, 'state')
await mkdir(path.dirname(output), { recursive: true }); await mkdir(output)
const marker = 'PRIVATE_NETWORK_DIAGNOSTICS_CANARY', report = { passed: false, checks: [], cleanup: {} }
const pass = name => { report.checks.push(name); console.log(`PASS ${name}`) }
let uploads = 0, uploadBytes = 0, app, client, taskId, failure
const fixture = createServer(async (request, response) => {
  response.setHeader('Content-Type', 'text/html; charset=utf-8')
  if (request.url.startsWith('/upload')) {
    uploads++; for await (const part of request) uploadBytes += part.length
    response.writeHead(201); response.end('accepted'); return
  }
  if (request.url.startsWith('/missing')) { response.writeHead(404); response.end(marker); return }
  if (request.url.startsWith('/cors')) { response.end(marker); return }
  response.end(`<!doctype html><title>Network diagnostics fixture</title><label>Upload document<input id="upload" type="file"></label><p id="status">Ready</p>
  <script>
  document.querySelector('#upload').addEventListener('change', async event => { const data = new FormData(); data.append('file', event.target.files[0]); await fetch('/upload?code=${marker}', {method:'POST',body:data}); document.querySelector('#status').textContent='Uploaded'; });
  fetch('/missing?code=${marker}').then(()=>{});
  fetch('http://127.0.0.2:${fixture.address().port}/cors?code=${marker}').catch(()=>{});
  setTimeout(()=>{ throw new Error('FedCM fixture ${marker}') }, 0);
  setTimeout(()=>console.error('InvalidPDFException fixture ${marker}'), 0);
  </script>`)
})
await new Promise(resolve => fixture.listen(0, '0.0.0.0', resolve))
const origin = `http://127.0.0.1:${fixture.address().port}`
const clean = value => { assert.ok(!JSON.stringify(value).includes(marker)); return value }
const call = async (name, args) => {
  const raw = await client.callTool({ name, arguments: args })
  const result = clean(JSON.parse(raw.content.find(item => item.type === 'text').text))
  if (raw.isError) throw Object.assign(Error(result.code), result)
  return result
}
try {
  app = await startBroker({ executable, stateDir, policy: { allowedOrigins: [origin, origin.replace('127.0.0.1', '127.0.0.2')], webCompatibility: true } })
  const native = createClient(await readConnection(stateDir, 'scripts'))
  const server = createMcpServer(native), [left, right] = InMemoryTransport.createLinkedPair()
  client = new Client({ name: 'diagnostic-native-acceptance', version: '1' })
  await Promise.all([server.connect(right), client.connect(left)])
  const tools = await client.listTools(), tool = tools.tools.find(item => item.name === 'velmren_diagnostics')
  assert.equal(tool.annotations.readOnlyHint, true); assert.equal(tools.tools.length, 24)
  const task = await call('velmren_create_task', { url: origin, sensitive: true }); taskId = task.taskId
  let observation = task.observation
  if (!observation.elements.some(item => item.type === 'file')) observation = await call('velmren_observe', { taskId })
  const file = path.join(output, 'synthetic.pdf')
  await writeFile(file, '%PDF-1.7\n' + marker)
  await call('velmren_upload_files', { taskId, observationId: observation.observationId, ref: observation.elements.find(item => item.type === 'file').ref, files: [file] })
  await call('velmren_wait', { taskId, text: 'Uploaded', timeoutMs: 5000 })
  const value = await call('velmren_diagnostics', { taskId }), data = value.diagnostics
  assert.equal(data.available, true)
  assert.ok(data.network.some(item => item.origin === origin && item.status === 404))
  pass('Scoped MCP diagnostics report HTTP failure origins without URL tails or response content')
  assert.ok(data.network.some(item => item.method === 'POST' && item.multipartUpload && item.status === 201))
  assert.equal(uploads, 1); assert.ok(uploadBytes > 0)
  pass('Native file attachment fires one upload; diagnostics distinguish verified selection from HTTP acceptance')
  assert.ok(data.network.some(item => item.corsFailure)); assert.ok(data.errors.cors > 0)
  assert.ok(data.errors.fedcm > 0)
  assert.ok(data.errors['file-import'] > 0)
  pass('Cross-origin and script failures expose categories, never exception strings')
  const internal = app.broker.tasks.get(taskId).diagnostics
  clean([...internal.network.values()]); clean(internal.errors)
  pass('Sensitive diagnostic canaries are absent before public projection and persistence')
  const peer = createClient(await readConnection(stateDir, 'claude'))
  await assert.rejects(peer.call('task_diagnostics', { taskId }), { code: 'NOT_FOUND' })
  pass('Another owner cannot read task diagnostics')
  await call('velmren_cancel', { taskId })
  const ended = await call('velmren_diagnostics', { taskId })
  assert.ok(ended.diagnostics.network.length > 0); assert.equal(uploads, 1)
  pass('Cancelled tasks retain diagnostic metadata without replaying navigation or upload')
  const trace = await readFile(path.join(stateDir, 'requests.jsonl'), 'utf8')
  assert.ok(!trace.includes(marker)); report.passed = true
} catch (error) { failure = error; report.failure = { code: error.code ?? error.name, message: String(error.message).replaceAll(marker, '[private]') } }
finally {
  if (client && taskId) await call('velmren_cancel', { taskId }).catch(() => {})
  await client?.close(); await app?.close(); await new Promise(resolve => fixture.close(resolve))
  report.cleanup = { clientsClosed: true, brokerClosed: !app || app.broker.browser.closed, fixtureClosed: !fixture.listening }
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2))
}
if (failure) { console.error(report.failure); process.exitCode = 1 }

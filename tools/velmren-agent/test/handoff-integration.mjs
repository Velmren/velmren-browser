// node test/handoff-integration.mjs BROWSER_EXE NEW_OUTPUT_DIR [--agent-directory=DIR]
// Hidden native test; the manual input is simulated only on this owned fixture.
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const args = process.argv.slice(2), positions = args.filter(x => !x.startsWith('--'))
const option = args.find(x => x.startsWith('--agent-directory='))
assert.equal(positions.length, 2)
assert.ok(args.every(x => !x.startsWith('--') || x === option))
const [executable, outputArgument] = positions
const directory = path.resolve(option?.slice('--agent-directory='.length) ?? fileURLToPath(new URL('../', import.meta.url)))
const output = path.resolve(outputArgument), stateDir = path.join(output, 'state')
await mkdir(path.dirname(output), { recursive: true }); await mkdir(output)
const report = { passed: false, checks: [], manualInput: 'Simulated only on owned fixture; no OS keyboard or personal login', cleanup: {} }
const peers = []
let app, server, failure, signIns = 0
const check = name => { report.checks.push(name); console.log(`PASS ${name}`) }
async function until(predicate) {
  const deadline = Date.now() + 5000
  while (!(await predicate())) { assert.ok(Date.now() < deadline, 'Fixture condition timed out'); await delay(25) }
}
async function client(label) {
  const connection = await app.broker.rpc('admin', 'client_register', { label })
  const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('./multi-agent-mcp-entry.mjs', import.meta.url)), directory], env: { VELMREN_ACCEPTANCE_CONNECTION: JSON.stringify({ endpoint: app.descriptor.endpoint, token: connection.token, client: connection.clientId }) }, stderr: 'pipe' })
  transport.stderr?.resume()
  const peer = new Client({ name: label, version: '1' }); await peer.connect(transport)
  peers.push(peer)
  return { peer, owner: connection.clientId }
}
async function call(peer, name, args, expectedError = false) {
  const result = await peer.callTool({ name, arguments: args }, undefined, { timeout: 40000 })
  const value = JSON.parse(result.content.find(x => x.type === 'text').text)
  assert.equal(!!result.isError, expectedError, JSON.stringify(value))
  return value
}
try {
  server = http.createServer((req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    if (req.url === '/complete') {
      signIns++; res.setHeader('Set-Cookie', 'handoff_session=verified; HttpOnly; SameSite=Lax; Path=/')
      res.end('ok'); return
    }
    const signedIn = req.headers.cookie?.includes('handoff_session=verified')
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    res.end(`<!doctype html><title>Manual handoff fixture</title><h1>${signedIn ? 'AUTHENTICATED' : 'SIGN IN REQUIRED'}</h1><button id="complete" onclick="fetch('/complete').then(()=>document.querySelector('#status').textContent='Manual step complete')">Finish manual sign-in</button><button id="count" onclick="this.textContent='Peer remains active'">Peer action</button><p id="status">Ready</p><script>sessionStorage.setItem('same-page','retained')</script>`)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  const policy = { profileMode: 'persistent', allowedOrigins: [origin], webCompatibility: true }
  const { startBroker } = await import(pathToFileURL(path.join(directory, 'broker.mjs')))
  const launch = () => startBroker({ executable: path.resolve(executable), stateDir, policy, browserArgs: ['--headless=new'] })
  app = await launch()
  const { peer: a, owner } = await client('Manual handoff owner')
  const { peer: b } = await client('Independent peer')
  const task = await call(a, 'velmren_create_task', { url: origin, label: 'Manual sign-in' })
  const peerTask = await call(b, 'velmren_create_task', { url: origin, label: 'Peer remains active' })
  assert.equal(task.profileMode, 'persistent'); assert.equal(task.sharedProfile, true)
  const pageId = task.selectedPageId
  const observation = await call(a, 'velmren_observe', { taskId: task.taskId })
  const shown = await call(a, 'velmren_request_human', { taskId: task.taskId, pageId, reason: 'Complete the synthetic sign-in step', showWindow: true })
  assert.equal(shown.state, 'human'); assert.equal(shown.handoff.pageId, pageId); assert.equal(shown.handoff.shown, true)
  const page = app.broker.tasks.get(task.taskId).pages.get(pageId)
  assert.equal(page.interceptFileChooser, false)
  await call(a, 'velmren_act', { taskId: task.taskId, observationId: observation.observationId, actions: [{ type: 'click', ref: observation.elements.find(x => x.name === 'Finish manual sign-in').ref }] }, true)
  await call(b, 'velmren_resume', { taskId: task.taskId, handoffId: shown.handoff.id, userConfirmed: true }, true)
  await call(a, 'velmren_resume', { taskId: task.taskId, handoffId: shown.handoff.id, userConfirmed: false }, true)
  let other = await call(b, 'velmren_observe', { taskId: peerTask.taskId })
  await call(b, 'velmren_act', { taskId: peerTask.taskId, observationId: other.observationId, actions: [{ type: 'click', ref: other.elements.find(x => x.name === 'Peer action').ref }] })
  other = await call(b, 'velmren_observe', { taskId: peerTask.taskId })
  assert.match(other.text, /Peer remains active/)
  check('Show keeps the same page, pauses owner actions, rejects foreign/unconfirmed resume and leaves peer work active')

  await page.send('Runtime.evaluate', { expression: "document.querySelector('#complete').click(); void 0" })
  await until(() => signIns === 1)
  const resumed = await call(a, 'velmren_resume', { taskId: task.taskId, handoffId: shown.handoff.id, userConfirmed: true })
  assert.equal(resumed.state, 'agent-active'); assert.equal(resumed.selectedPageId, pageId); assert.ok(!resumed.handoff)
  assert.equal(app.broker.tasks.get(task.taskId).pages.get(pageId), page)
  assert.equal(page.interceptFileChooser, true)
  const marker = await page.send('Runtime.evaluate', { expression: "sessionStorage.getItem('same-page')", returnByValue: true })
  assert.equal(marker.result.value, 'retained')
  await call(a, 'velmren_resume', { taskId: task.taskId, handoffId: shown.handoff.id, userConfirmed: true }, true)
  check('Confirmed resume hides the same page, preserves its session state and consumes the handoff ID')

  const first = await call(a, 'velmren_request_human', { taskId: task.taskId, reason: 'First follow-up' })
  const second = await call(a, 'velmren_request_human', { taskId: task.taskId, reason: 'Current follow-up' })
  await call(a, 'velmren_resume', { taskId: task.taskId, handoffId: first.handoff.id, userConfirmed: true }, true)
  assert.equal((await call(a, 'velmren_resume', { taskId: task.taskId, handoffId: second.handoff.id, userConfirmed: true })).state, 'agent-active')
  check('A newer manual step invalidates the previous confirmation')

  await call(a, 'velmren_finish', { taskId: task.taskId })
  other = await call(b, 'velmren_navigate', { taskId: peerTask.taskId, url: `${origin}/status` })
  assert.match(other.text, /AUTHENTICATED/)
  await app.broker.rpc('admin', 'client_register', { label: 'Unrelated connection' })
  await app.broker.rpc(owner, 'client_release', {})
  await call(b, 'velmren_finish', { taskId: peerTask.taskId })
  for (const peer of peers.splice(0)) await peer.close()
  await app.close(); app = await launch()
  const { peer: restarted } = await client('After clean restart')
  const next = await call(restarted, 'velmren_create_task', { url: `${origin}/status`, label: 'Reused authentication' })
  assert.match(next.observation.text, /AUTHENTICATED/)
  await call(restarted, 'velmren_finish', { taskId: next.taskId })
  report.samePageId = pageId
  check('Authentication from the manual step survives task finish, peer usage and a clean browser restart')
  report.passed = true
} catch (error) { failure = error; report.error = error.message; report.stack = error.stack }
finally {
  for (const peer of peers) await peer.close().catch(() => {})
  if (app) { await app.close(); report.cleanup.browserClosed = app.broker.browser.closed }
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); report.cleanup.fixtureClosed = true }
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2))
}
if (failure) throw failure

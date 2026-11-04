// Opens one self-closing, loopback-only ordinary browser window. No real account.
// node profile-login-integration.mjs BROWSER NEW_OUTPUT --allow-visible-fixture [--agent-directory=PATH]
import assert from 'node:assert/strict'
import http from 'node:http'
import path from 'node:path'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const args = process.argv.slice(2)
const option = args.find(arg => arg.startsWith('--agent-directory='))
assert.ok(args.includes('--allow-visible-fixture'), 'Explicit visible fixture opt-in required')
assert.ok(args.every(arg => !arg.startsWith('--') || arg === option || arg === '--allow-visible-fixture'))
const [executable, outputArg] = args.filter(arg => !arg.startsWith('--'))
assert.ok(executable && outputArg)
const directory = path.resolve(option?.slice('--agent-directory='.length) ?? fileURLToPath(new URL('../', import.meta.url)))
const { startBroker } = await import(pathToFileURL(path.join(directory, 'broker.mjs')))
const { connectManaged, releaseManagedConnection } = await import(pathToFileURL(path.join(directory, 'managed-runtime.mjs')))
const output = path.resolve(outputArg), stateDir = path.join(output, 'state')
await mkdir(path.dirname(output), { recursive: true }); await mkdir(output)
const report = { passed: false, cases: [], manualRequest: null, brokerPid: process.pid, errors: [], cleanup: {} }
const clients = new Set()
let app, fixture, permitClose = false, origin, manualEvent, managedPeer, policyFile
const until = async (condition, timeoutMs = 20000) => {
  const deadline = Date.now() + timeoutMs
  do { const result = await condition(); if (result) return result; await delay(100) } while (Date.now() < deadline)
  throw new Error('Profile login fixture condition timed out')
}
const connect = async (owner, managed = false) => {
  const transport = new StdioClientTransport({ command: process.execPath,
    args: managed ? [path.join(directory, 'managed-mcp.mjs'), '--browser', path.resolve(executable), '--state-dir', stateDir, '--policy', policyFile, '--label', owner]
      : [path.join(directory, 'mcp.mjs'), '--state-dir', stateDir, '--client', owner], stderr: 'pipe' })
  transport.stderr?.resume()
  const client = new Client({ name: `profile-login-${owner}`, version: '1' })
  await client.connect(transport); clients.add(client); return client
}
const call = async (client, name, args = {}, errorCode) => {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 60000 })
  const data = JSON.parse(result.content.find(item => item.type === 'text').text)
  if (errorCode) { assert.equal(result.isError, true); assert.equal(data.code, errorCode) }
  else assert.ok(!result.isError, JSON.stringify(data))
  return data
}
try {
  fixture = http.createServer(async (req, res) => {
    const route = new URL(req.url, origin).pathname
    const cookie = req.headers.cookie ?? ''
    const seeded = cookie.includes('before_manual=seeded'), manual = cookie.includes('manual_session=signed')
    res.setHeader('Cache-Control', 'no-store')
    if (route === '/manual-result' && req.method === 'POST') {
      let body = ''; for await (const part of req) { body += part; if (body.length > 2048) break }
      const value = JSON.parse(body)
      manualEvent = { webdriver: value.webdriver, priorCookiePresent: seeded, storagePresent: value.storagePresent }
      res.end('ok'); return
    }
    if (route === '/permit-close') { res.end(permitClose ? 'yes' : 'no'); return }
    if (route === '/seed') res.setHeader('Set-Cookie', 'before_manual=seeded; Path=/; HttpOnly; SameSite=Lax')
    if (route === '/manual') res.setHeader('Set-Cookie', 'manual_session=signed; Path=/; HttpOnly; SameSite=Lax')
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    res.end(`<!doctype html><meta charset="utf-8"><title>Velmren manual profile acceptance</title>
      <h1>Local manual sign-in lifecycle test</h1><p>${seeded && manual ? 'BOTH AUTH COOKIES PRESENT' : seeded ? 'PREVIOUS COOKIE PRESENT' : 'INITIAL TEST'}</p>
      ${route === '/seed' ? '<script>localStorage.setItem("profile_login_fixture", "preserved")</script>' : ''}
      ${route === '/manual' ? `<p>This test window closes automatically.</p><script>
        fetch('/manual-result', {method:'POST',body:JSON.stringify({webdriver:navigator.webdriver,storagePresent:localStorage.getItem('profile_login_fixture')==='preserved'})});
        const timer=setInterval(async()=>{if(await(await fetch('/permit-close')).text()==='yes'){clearInterval(timer);window.close()}},200);
      </script>` : ''}`)
  })
  await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${fixture.address().port}`
  const policy = { profileMode: 'persistent', allowWeb: true, webCompatibility: true }
  policyFile = path.join(output, 'policy.json')
  await writeFile(policyFile, JSON.stringify(policy))
  app = await startBroker({ executable: path.resolve(executable), stateDir, policy, browserArgs: ['--headless=new'] })
  const firstBrowserPid = app.broker.browser.process.pid
  const owner = await connect('scripts'), peer = await connect('claude')
  const catalog = await owner.listTools()
  assert.equal(catalog.tools.length, 21)
  for (const name of ['velmren_profile_login_start', 'velmren_profile_login_status', 'velmren_profile_login_finish']) assert.ok(catalog.tools.some(tool => tool.name === name))
  report.cases.push('actual MCP exposes 21 tools including the three profile login controls')

  const task = await call(owner, 'velmren_create_task', { url: `${origin}/seed` })
  await call(owner, 'velmren_profile_login_start', { url: `${origin}/manual`, userConfirmed: true }, 'PROFILE_LOGIN_BUSY')
  assert.equal(app.broker.browser.process.pid, firstBrowserPid)
  const before = await call(owner, 'velmren_observe', { taskId: task.taskId })
  assert.ok(before.title.includes('acceptance'))
  await call(owner, 'velmren_finish', { taskId: task.taskId })
  report.cases.push('manual transition refuses unfinished work and preserves its browser and page')

  const login = await call(owner, 'velmren_profile_login_start', { url: `${origin}/manual`, userConfirmed: true })
  assert.equal(login.phase, 'manual'); assert.equal(login.automationConnected, false)
  report.loginId = login.loginId
  await until(() => manualEvent)
  assert.deepEqual(manualEvent, { webdriver: false, priorCookiePresent: true, storagePresent: true })
  report.manualRequest = manualEvent
  const receipt = JSON.parse(await readFile(path.join(stateDir, 'manual-profile.json'), 'utf8'))
  report.manualPid = receipt.browserPid
  assert.notEqual(receipt.browserPid, firstBrowserPid)
  assert.equal(app.broker.browser.closed, true)
  report.cases.push('ordinary browser has webdriver=false, no CDP, and retains the same profile session cookie and storage')

  await call(peer, 'velmren_create_task', { url: `${origin}/check` }, 'PROFILE_LOGIN_ACTIVE')
  await call(peer, 'velmren_profile_login_finish', { loginId: login.loginId, userConfirmed: true }, 'UNAUTHORIZED')
  await call(owner, 'velmren_profile_login_start', { url: `${origin}/manual`, userConfirmed: true }, 'PROFILE_LOGIN_ACTIVE')
  await call(owner, 'velmren_profile_login_finish', { loginId: login.loginId, userConfirmed: true }, 'MANUAL_PROFILE_OPEN')
  report.cases.push('all automated work stays blocked, peer finish is denied, and an open manual browser cannot be resumed')

  managedPeer = await connectManaged({ executable: path.resolve(executable), stateDir, policyFile, startupTimeoutMs: 5000 },
    { spawnDaemon: () => { throw new Error('must reuse the live manual controller') } })
  await releaseManagedConnection(managedPeer); managedPeer = null
  assert.equal((await call(owner, 'velmren_profile_login_status')).phase, 'manual')
  report.cases.push('new managed connection reuses the suspended controller and its release does not close the manual window')

  permitClose = true
  await until(async () => (await call(owner, 'velmren_profile_login_status')).phase === 'awaiting-confirmation')
  assert.equal(app.broker.browser.process.pid, firstBrowserPid)
  assert.equal(app.broker.browser.closed, true)
  await call(owner, 'velmren_profile_login_finish', { loginId: 'stale-login', userConfirmed: true }, 'NOT_FOUND')
  const resumed = await call(owner, 'velmren_profile_login_finish', { loginId: login.loginId, userConfirmed: true })
  assert.equal(resumed.phase, 'automated'); assert.equal(resumed.automationConnected, true)
  assert.notEqual(app.broker.browser.process.pid, firstBrowserPid)
  assert.notEqual(app.broker.browser.process.pid, receipt.browserPid)
  report.cases.push('native close alone never resumes; explicit matching finish restarts automation in a new process')

  const after = await call(owner, 'velmren_create_task', { url: `${origin}/check` })
  const observed = await call(owner, 'velmren_observe', { taskId: after.taskId })
  assert.ok(observed.text.includes('BOTH AUTH COOKIES PRESENT'))
  await call(owner, 'velmren_finish', { taskId: after.taskId })
  await assert.rejects(readFile(path.join(stateDir, 'manual-profile.json')), { code: 'ENOENT' })
  report.cases.push('fresh automated task retains both synthetic session cookies and the completed guard is removed')

  permitClose = false; manualEvent = null
  const disconnecting = await connect('manual-EOF-owner', true)
  const eofLogin = await call(disconnecting, 'velmren_profile_login_start', { url: `${origin}/manual`, userConfirmed: true })
  await until(() => manualEvent)
  await disconnecting.close(); clients.delete(disconnecting)
  await until(async () => [...app.broker.clients.values()].every(client => !client.leaseMs || client.released))
  const afterEof = await call(owner, 'velmren_profile_login_status')
  assert.equal(afterEof.phase, 'manual'); assert.equal(afterEof.windowOpen, true)
  assert.equal(afterEof.automationConnected, false)
  permitClose = true
  await until(async () => (await call(owner, 'velmren_profile_login_status')).phase === 'awaiting-confirmation')
  await app.broker.rpc('admin', 'profile_login_finish', { loginId: eofLogin.loginId, userConfirmed: true })
  report.cases.push('initiating managed MCP EOF preserves the ordinary window and explicit administrator recovery resumes only after closure')
  report.passed = true
} catch (error) { report.errors.push({ name: error.name, message: error.message }); process.exitCode = 1 }
finally {
  permitClose = true
  if (managedPeer) await releaseManagedConnection(managedPeer).catch(() => {})
  for (const client of clients) await client.close().catch(() => {})
  if (app) {
    const status = await app.broker.profileLoginStatus().catch(() => null)
    if (status && status.phase !== 'automated' && ['manual', 'awaiting-confirmation'].includes(status.phase)) {
      try {
        await until(async () => (await app.broker.profileLoginStatus()).windowOpen === false)
        await app.broker.rpc('admin', 'profile_login_finish', { loginId: status.loginId, userConfirmed: true })
      } catch (error) { report.cleanup.manualError = error.message; report.passed = false; process.exitCode = 1 }
    }
    try { await app.close(); report.cleanup.brokerClosed = true }
    catch (error) { report.cleanup.brokerError = error.message; report.passed = false; process.exitCode = 1 }
  }
  if (fixture?.listening) { fixture.closeAllConnections(); await new Promise(resolve => fixture.close(resolve)) }
  report.cleanup.fixtureClosed = true
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2))
}
console.log(JSON.stringify({ passed: report.passed, cases: report.cases.length, errors: report.errors, cleanup: report.cleanup }))

// Own loopback fixture only; its one ordinary window closes itself.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import http from 'node:http'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const args = process.argv.slice(2)
const directoryOption = args.find(arg => arg.startsWith('--agent-directory='))
assert.ok(args.includes('--allow-visible-fixture'))
assert.ok(args.every(arg => !arg.startsWith('--') || arg === directoryOption || arg === '--allow-visible-fixture'))
const [browser, outputArg] = args.filter(arg => !arg.startsWith('--'))
assert.ok(browser && outputArg)
const directory = path.resolve(directoryOption?.slice('--agent-directory='.length) ?? fileURLToPath(new URL('../', import.meta.url)))
const output = path.resolve(outputArg), stateDir = path.join(output, 'state'), policyFile = path.join(output, 'policy.json')
await mkdir(path.dirname(output), { recursive: true }); await mkdir(output)
const policy = { profileMode: 'persistent', allowWeb: true, webCompatibility: true }
await writeFile(policyFile, JSON.stringify(policy))
const report = { passed: false, cases: [], cleanup: {}, errors: [] }
const read = async file => JSON.parse(await readFile(file, 'utf8'))
const until = async (fn, budget = 25000) => {
  const deadline = Date.now() + budget
  do { const result = await fn(); if (result) return result; await delay(100) } while (Date.now() < deadline)
  throw new Error('Recovery fixture condition timed out')
}
const children = new Set(), clients = new Set()
const launch = (script, extra = []) => {
  const child = spawn(process.execPath, [path.join(directory, script), '--browser', path.resolve(browser), '--state-dir', stateDir, '--policy', policyFile, ...extra], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
  child.stderr.resume(); children.add(child)
  child.exited = new Promise(resolve => child.once('exit', code => { child.code = code; resolve(code) }))
  return child
}
const descriptorFor = child => until(async () => {
  assert.equal(child.exitCode, null, 'Owned broker exited during startup')
  try { const descriptor = await read(path.join(stateDir, 'connection.json')); return descriptor.pid === child.pid ? descriptor : null } catch (error) { if (error.code !== 'ENOENT') throw error }
}, 60000)
const connect = async managed => {
  const transport = new StdioClientTransport({ command: process.execPath,
    args: managed ? [path.join(directory, 'managed-mcp.mjs'), '--browser', path.resolve(browser), '--state-dir', stateDir, '--policy', policyFile, '--label', 'Recovery acceptance']
      : [path.join(directory, 'mcp.mjs'), '--state-dir', stateDir, '--client', 'scripts'], stderr: 'pipe' })
  transport.stderr?.resume()
  const client = new Client({ name: 'profile-recovery-acceptance', version: '1' })
  await client.connect(transport); clients.add(client); return client
}
const call = async (client, name, arguments_ = {}) => {
  const response = await client.callTool({ name, arguments: arguments_ }, undefined, { timeout: 60000 })
  const value = JSON.parse(response.content.find(part => part.type === 'text').text)
  assert.ok(!response.isError, [value.code, value.message ?? value.error].filter(Boolean).join(': ')); return value
}
let permitClose = false, manualEvent, fixture, origin, controlledDescriptor
try {
  fixture = http.createServer(async (req, res) => {
    const route = new URL(req.url, origin).pathname
    res.setHeader('Cache-Control', 'no-store')
    if (route === '/permit-close') { res.end(permitClose ? 'yes' : 'no'); return }
    if (route === '/manual-event') { let body = ''; for await (const part of req) body += part; manualEvent = JSON.parse(body); res.end('ok'); return }
    if (route === '/manual') res.setHeader('Set-Cookie', 'recovered_session=signed; Path=/; HttpOnly; SameSite=Lax')
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    res.end(`<!doctype html><title>Velmren recovery acceptance</title><h1>${(req.headers.cookie ?? '').includes('recovered_session=signed') ? 'SIGNED IN AFTER RECOVERY' : 'RECOVERY FIXTURE'}</h1>${route === '/manual' ? `<p>This local test window closes automatically.</p><script>fetch('/manual-event',{method:'POST',body:JSON.stringify({webdriver:navigator.webdriver})});const timer=setInterval(async()=>{if(await(await fetch('/permit-close')).text()==='yes'){clearInterval(timer);window.close()}},150)</script>` : ''}`)
  })
  await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${fixture.address().port}`
  const original = launch('managed-broker.mjs')
  controlledDescriptor = await descriptorFor(original)
  const owner = await connect(false)
  const login = await call(owner, 'velmren_profile_login_start', { url: `${origin}/manual`, userConfirmed: true })
  await until(() => manualEvent)
  assert.equal(manualEvent.webdriver, false)
  permitClose = true
  await until(async () => (await call(owner, 'velmren_profile_login_status')).phase === 'awaiting-confirmation')
  await owner.close(); clients.delete(owner)
  const receiptPath = path.join(stateDir, 'manual-profile.json')
  const before = await read(receiptPath)
  assert.equal(before.brokerPid, original.pid)
  assert.ok(before.browserStartTime)
  report.cases.push('Ordinary local sign-in closes with a durable receipt and real process identity')
  // Simulate only an owned controller crash after its ordinary browser has exited.
  original.kill(); await original.exited
  const normal = launch('managed-broker.mjs')
  assert.notEqual(await normal.exited, 0)
  assert.deepEqual(await read(receiptPath), before)
  report.cases.push('Ordinary managed startup rejects the preserved manual receipt after controller exit')
  const recovered = launch('profile-recovery.mjs', ['--login-id', login.loginId, '--user-confirmed', 'true'])
  controlledDescriptor = await descriptorFor(recovered)
  const peer = await connect(true)
  assert.equal((await peer.listTools()).tools.length, 21)
  const status = await until(async () => {
    const status = await call(peer, 'velmren_profile_login_status')
    return status.phase === 'automated' ? status : null
  })
  assert.equal(status.phase, 'automated'); assert.equal(status.automationConnected, true)
  await assert.rejects(readFile(receiptPath), { code: 'ENOENT' })
  report.cases.push('Explicit recovery rebinds automation and normal managed MCP reuses the recovered broker')
  const task = await call(peer, 'velmren_create_task', { url: `${origin}/check` })
  const observed = await call(peer, 'velmren_observe', { taskId: task.taskId })
  assert.ok(observed.text.includes('SIGNED IN AFTER RECOVERY'))
  await call(peer, 'velmren_finish', { taskId: task.taskId })
  await peer.close(); clients.delete(peer)
  report.cases.push('A fresh task retains the ordinary sign-in session after explicit recovery')
  report.passed = true
} catch (error) { report.errors.push({ name: error.name, message: error.message }); process.exitCode = 1 }
finally {
  permitClose = true
  for (const client of clients) await client.close().catch(() => {})
  const liveController = controlledDescriptor && [...children].find(child => child.pid === controlledDescriptor.pid && child.exitCode === null && child.signalCode === null)
  if (liveController) {
    const rpc = async (method, args = {}) => {
      const response = await fetch(`${controlledDescriptor.endpoint}/rpc`, { method: 'POST', headers: { Authorization: `Bearer ${controlledDescriptor.adminToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ method, args }) }).then(r => r.json())
      assert.equal(response.ok, true, response.code); return response.result
    }
    try {
      const status = await rpc('profile_login_status')
      if (status.phase !== 'automated') {
        await until(async () => (await rpc('profile_login_status')).windowOpen === false)
        await rpc('profile_login_finish', { loginId: status.loginId, userConfirmed: true })
      }
      await rpc('shutdown')
    } catch (error) { report.passed = false; report.cleanup.shutdownFailed = true; report.cleanup.error = error.message; process.exitCode = 1 }
  }
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      try {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('Owned child remains')), 15000)
          child.exited.then(() => { clearTimeout(timer); resolve() })
        })
      }
      catch { report.passed = false; report.cleanup.ownedChildRemains = true; process.exitCode = 1 }
    }
  }
  report.cleanup.ownedChildrenExited = [...children].every(child => child.exitCode !== null || child.signalCode !== null)
  if (fixture?.listening) { fixture.closeAllConnections(); await new Promise(resolve => fixture.close(resolve)) }
  report.cleanup.fixtureClosed = true
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2))
}
console.log(JSON.stringify({ passed: report.passed, cases: report.cases.length, errors: report.errors, cleanup: report.cleanup }))

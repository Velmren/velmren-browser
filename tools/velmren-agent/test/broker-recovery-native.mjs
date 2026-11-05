// Native acceptance: fresh output only; localhost forms and injected mock solver.
// node test/broker-recovery-native.mjs BROWSER_EXE NEW_OUTPUT_DIR
import assert from 'node:assert/strict'
import http from 'node:http'
import { once } from 'node:events'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const [executable, outputArgument, agentArgument] = process.argv.slice(2)
const directory = agentArgument?.replace(/^--agent-directory=/, '') ?? fileURLToPath(new URL('../', import.meta.url))
process.env.VELMREN_TEST_AGENT_DIRECTORY = path.resolve(directory)
const { createClient } = await import(pathToFileURL(path.join(directory, 'client.mjs')))
const { adminRpc, connectManaged, maintainManagedLease, readManagedDescriptor, releaseManagedConnection, resolveManagedOptions } = await import(pathToFileURL(path.join(directory, 'managed-runtime.mjs')))
if (!executable || !outputArgument) throw new Error('Expected browser and fresh output directory')
const output = path.resolve(outputArgument), stateDir = path.join(output, 'state')
await mkdir(path.dirname(output), { recursive: true }); await mkdir(output); await mkdir(stateDir)
const report = { passed: false, syntheticProviderOnly: true, checks: [], cleanup: {}, limits: ['No native window, monitor, or foreground visibility claim'] }
const pass = name => { report.checks.push(name); console.log(`PASS ${name}`) }
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(read, accept, label, timeout = 15000) {
  const deadline = Date.now() + timeout
  do { const value = await read(); if (accept(value)) return value; await pause(80) } while (Date.now() < deadline)
  throw new Error(`Timed out: ${label}`)
}
let callbacks = 0, submits = 0, stage = 'fixture', descriptor, oldPid, newPid
const connections = [], leases = []
const server = http.createServer((req, res) => {
  if (req.url === '/callback') { callbacks++; res.end('ok'); return }
  if (req.url === '/submitted') { submits++; res.end('ok'); return }
  res.setHeader('content-type', 'text/html; charset=utf-8')
  const kind = req.url === '/terminal' ? 'terminal' : 'pending'
  res.end(`<!doctype html><title>Recovery fixture</title><h1>Local recovery test</h1>
    <label>Password<input id="secret" type="password" autocomplete="off"></label>
    <button id="submit" onclick="fetch('/submitted',{method:'POST'});document.querySelector('#result').textContent='Submitted'">Submit</button>
    <button id="popup" onclick="window.open('/popup','fixturePopup')">Open popup</button><p id="result"></p>
    <form><div class="g-recaptcha" data-sitekey="synthetic-${kind}" data-callback="fixtureCallback"><textarea name="g-recaptcha-response"></textarea></div></form>
    <script>globalThis.fixtureCallback=()=>{fetch('/callback');document.querySelector('#result').textContent='Accepted'}</script>`)
})
server.listen(0, '127.0.0.1'); await once(server, 'listening')
const origin = `http://127.0.0.1:${server.address().port}`
const policyFile = path.join(output, 'policy.json')
await writeFile(policyFile, JSON.stringify({ profileMode: 'persistent', allowedOrigins: [origin], webCompatibility: true, maxTasks: 8 }))
const options = await resolveManagedOptions({ executable, stateDir, policyFile, startupTimeoutMs: 30000,
  daemonScript: fileURLToPath(new URL('./fixtures/recovery-native-broker.mjs', import.meta.url)) })
const peers = []
const connect = async label => {
  const connection = await connectManaged({ ...options, label })
  connections.push(connection)
  const lease = maintainManagedLease(connection, error => { report.leaseFailure = error.code }, { heartbeatMs: 1000 })
  leases.push(lease)
  return { connection, client: createClient(connection) }
}
const call = (peer, method, args) => peer.client.call(method, args)
try {
  stage = 'connect'; peers.push(...await Promise.all(['solve', 'popup', 'private'].map(connect)))
  descriptor = await readManagedDescriptor(stateDir); oldPid = descriptor.pid
  stage = 'create'; const tasks = await Promise.all(peers.map((peer, i) => call(peer, 'task_create', { url: origin + (i === 0 ? '/terminal' : '/pending') })))
  pass('three scoped clients share one native broker')
  const terminalTask = tasks[0]
  const terminalChallenges = await call(peers[0], 'task_captcha', { taskId: terminalTask.taskId, action: 'inspect' })
  const terminalJob = await call(peers[0], 'task_captcha', { taskId: terminalTask.taskId, action: 'solve', challengeId: terminalChallenges.challenges[0].challengeId })
  const terminalReceipt = await until(() => call(peers[0], 'task_captcha', { taskId: terminalTask.taskId, action: 'status', jobId: terminalJob.jobId }), result => result.status !== 'pending', 'terminal mock solve')
  assert.equal(terminalReceipt.status, 'delivered'); assert.equal(terminalReceipt.outcomeEvidence, 'direct')
  pass('direct terminal mock receipt persisted before broker death')
  const pendingTask = await call(peers[0], 'task_create', { url: origin + '/pending' })
  const pendingChallenges = await call(peers[0], 'task_captcha', { taskId: pendingTask.taskId, action: 'inspect' })
  const pendingJob = await call(peers[0], 'task_captcha', { taskId: pendingTask.taskId, action: 'solve', challengeId: pendingChallenges.challenges[0].challengeId })
  await until(async () => (await readFile(path.join(stateDir, 'synthetic-provider.jsonl'), 'utf8')).trim().split('\n').length, count => count === 2, 'two mock dispatches')
  stage = 'popup'; let observation = await call(peers[1], 'task_observe', { taskId: tasks[1].taskId })
  const popup = observation.elements.find(item => item.name === 'Open popup')
  assert.ok(popup)
  await call(peers[1], 'task_act', { taskId: tasks[1].taskId, observationId: observation.observationId, actions: [{ type: 'click', ref: popup.ref }] })
  await until(() => call(peers[1], 'task_list_pages', { taskId: tasks[1].taskId }), result => result.pages.length === 2, 'native popup')
  pass('native popup stays within its scoped owner during pending solve')
  stage = 'private-input'; observation = await call(peers[2], 'task_observe', { taskId: tasks[2].taskId })
  const input = observation.elements.find(item => item.name === 'Password')
  assert.ok(input)
  const prepared = await call(peers[2], 'task_private_input', { taskId: tasks[2].taskId, action: 'prepare', observationId: observation.observationId, ref: input.ref, origin, topOrigin: origin })
  await call(peers[2], 'task_private_input', { taskId: tasks[2].taskId, action: 'provide', secretRef: prepared.secretRef, value: 'SyntheticPrivateRecoveryValue' })
  await call(peers[2], 'task_act', { taskId: tasks[2].taskId, observationId: observation.observationId, actions: [{ type: 'fill', ref: input.ref, secretRef: prepared.secretRef }] })
  pass('private input delivered once alongside pending solve and popup')
  stage = 'handoff'; const handoff = await call(peers[2], 'task_request_human', { taskId: tasks[2].taskId, reason: 'Synthetic manual step', showWindow: false })
  assert.equal(handoff.state, 'needs-human')
  const oldConnection = { ...peers[2].connection }
  peers[2].connection.endpoint = 'http://127.0.0.1:1'
  await until(async () => peers[2].connection.endpoint, endpoint => endpoint === oldConnection.endpoint, 'automatic transient heartbeat repair')
  const liveTasks = (await call(peers[2], 'task_list')).tasks
  assert.equal(liveTasks[0].handoff.id, handoff.handoff.id)
  assert.equal(liveTasks[0].state, 'needs-human')
  await assert.rejects(createClient(oldConnection).call('task_list'), { code: 'UNAUTHORIZED' })
  pass('automatic heartbeat repair preserves handoff and revokes old bearer')
  stage = 'kill'; process.kill(oldPid, 'SIGKILL')
  await until(async () => { try { process.kill(oldPid, 0); return false } catch { return true } }, Boolean, 'owned broker death')
  await until(async () => peers.every(peer => peer.connection.endpoint !== descriptor.endpoint), Boolean, 'automatic owner recovery after broker death')
  descriptor = await readManagedDescriptor(stateDir); newPid = descriptor.pid
  assert.notEqual(newPid, oldPid)
  stage = 'recover-receipts'
  const terminalRecovered = await call(peers[0], 'task_captcha', { taskId: terminalTask.taskId, action: 'status', jobId: terminalJob.jobId })
  const pendingRecovered = await call(peers[0], 'task_captcha', { taskId: pendingTask.taskId, action: 'status', jobId: pendingJob.jobId })
  assert.equal(terminalRecovered.status, 'delivered'); assert.equal(terminalRecovered.recovered, true)
  assert.equal(pendingRecovered.status, 'uncertain'); assert.equal(pendingRecovered.recovered, true)
  assert.equal(pendingRecovered.replayAllowed, false)
  pass('same owner recovers terminal receipt and interrupted pending outcome without redispatch')
  const recoveredTasks = (await call(peers[2], 'task_list')).tasks
  assert.equal(recoveredTasks.length, 1); assert.equal(recoveredTasks[0].state, 'recovery-needed'); assert.equal(recoveredTasks[0].domRestored, false)
  await assert.rejects(call(peers[2], 'task_resume', { taskId: tasks[2].taskId, handoffId: handoff.handoff.id, userConfirmed: true }), { code: 'RECOVERY_NEEDED' })
  await assert.rejects(call(peers[1], 'task_captcha', { taskId: terminalTask.taskId, action: 'status', jobId: terminalJob.jobId }), { code: 'NOT_FOUND' })
  const fresh = await connect('fresh')
  assert.deepEqual((await call(fresh, 'task_list')).tasks, [])
  await assert.rejects(call(fresh, 'task_observe', { taskId: tasks[2].taskId }), { code: 'NOT_FOUND' })
  pass('lost DOM explicitly requires recovery; peers and fresh clients cannot claim old tasks')
  const dispatches = (await readFile(path.join(stateDir, 'synthetic-provider.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse)
  assert.equal(dispatches.length, 2); assert.equal(callbacks, 1); assert.equal(submits, 0)
  const lifecycle = await readFile(path.join(stateDir, 'lifecycle.jsonl'), 'utf8')
  assert.ok(lifecycle.includes('child-process-exit') && lifecycle.includes('previous-process-unavailable'))
  for (const secret of ['SyntheticPrivateRecoveryValue', 'SyntheticRecoveryKey', 'SyntheticRecoveryToken', prepared.secretRef]) assert.ok(!lifecycle.includes(secret))
  report.dispatches = dispatches.length; report.callbacks = callbacks; report.submits = submits
  pass('lifecycle records process exit and no duplicate solve, submit, or secret leakage')
  report.passed = true
} catch (error) {
  report.failure = { stage, code: error.code ?? 'ASSERTION_FAILED', message: error.message, location: error.stack?.split('\n').find(line => line.includes('broker-recovery-native.mjs:'))?.trim() }
  console.log(`FAIL ${stage}: ${error.code ?? 'ASSERTION_FAILED'}`)
  process.exitCode = 1
} finally {
  await Promise.all(leases.map(lease => lease.release()))
  try { descriptor = await readManagedDescriptor(stateDir); if (descriptor) await adminRpc(descriptor, 'shutdown') } catch {}
  if (descriptor) await until(async () => { try { process.kill(descriptor.pid, 0); return false } catch { return true } }, Boolean, 'owned broker cleanup')
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve))
  report.oldPid = oldPid; report.newPid = newPid
  report.cleanup.clientsReleased = connections.length
  report.cleanup.brokerExited = true
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2))
}

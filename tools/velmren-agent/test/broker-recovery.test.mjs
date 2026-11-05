import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter, once } from 'node:events'
import http from 'node:http'
import { mkdir, mkdtemp, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { startBroker } from '../broker.mjs'
import { AGENT_PROTOCOL, createClient } from '../client.mjs'
import { ClientRecoveryStore } from '../client-recovery.mjs'
import { lifecycle } from '../lifecycle.mjs'
import { acquireStartupGate, connectManaged, maintainManagedLease, resolveManagedOptions, releaseManagedConnection } from '../managed-runtime.mjs'

const results = fileURLToPath(new URL('../test-results/', import.meta.url))
await mkdir(results, { recursive: true })
const state = async () => {
  for (let attempt = 0; attempt < 10; attempt++) {
    const directory = await mkdtemp(path.join(results, 'recovery-'))
    try { await (await acquireStartupGate(directory, 100))(); return directory }
    catch (error) { if (error.code !== 'STARTUP_LOCK_FAILED') throw error }
  }
  throw new Error('No available fixture startup gate')
}
const request = async (connection, method, args = {}) => {
  const response = await fetch(`${connection.endpoint}/rpc`, { method: 'POST', headers: { Authorization: `Bearer ${connection.token ?? connection.adminToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ method, args }) })
  return { status: response.status, body: await response.json() }
}
function browser() {
  const value = new EventEmitter()
  value.send = async () => ({ targetInfos: [] })
  value.close = async () => { value.closed = true; value.emit('closed', { exitCode: 0 }) }
  return value
}
const launch = stateDir => startBroker({ executable: process.execPath, stateDir, browserFactory: async () => browser() })

test('recovery registry authenticates owner and persists only hashes and task state', async () => {
  const directory = await state(), owner = randomUUID(), peer = randomUUID(), taskId = randomUUID()
  const store = new ClientRecoveryStore(directory, 'policy')
  const secret = await store.register(owner), other = await store.register(peer)
  await store.record(owner, taskId)
  const raw = await readFile(path.join(directory, 'client-recovery.json'), 'utf8')
  assert.ok(!raw.includes(secret) && !raw.includes(other))
  const fresh = new ClientRecoveryStore(directory, 'policy')
  await fresh.authenticate(owner, secret)
  await assert.rejects(fresh.authenticate(owner, other), { code: 'UNAUTHORIZED' })
  assert.deepEqual(fresh.tasks(peer), [])
  assert.equal(fresh.tasks(owner)[0].state, 'recovery-needed')
  assert.equal(fresh.tasks(owner)[0].domRestored, false)
  await fresh.revoke(owner)
  await assert.rejects(fresh.authenticate(owner, secret), { code: 'UNAUTHORIZED' })
})

test('lifecycle diagnostics project only enumerated metadata and process exit values', async () => {
  const directory = await state(), secret = 'SyntheticCredentialCanary'
  lifecycle(directory, 'process-fatal', { code: secret, phase: secret, reason: secret, token: secret, message: secret, exitCode: 9, childPid: 123 })
  lifecycle(directory, secret, { code: secret })
  const raw = await readFile(path.join(directory, 'lifecycle.jsonl'), 'utf8')
  assert.ok(!raw.includes(secret))
  const record = JSON.parse(raw)
  assert.equal(record.code, 'BROKER_ERROR')
  assert.equal(record.exitCode, 9); assert.equal(record.childPid, 123)
  assert.equal(record.phase, undefined); assert.equal(record.reason, undefined)
})

test('same-owner reconnect rotates bearer without replacing pending owner state; restart exposes only own tombstones', async t => {
  const directory = await state()
  let app = await launch(directory)
  t.after(() => app.close())
  const config = await resolveManagedOptions({ executable: process.execPath, stateDir: directory, startupTimeoutMs: 2000 })
  const connection = await connectManaged(config), peer = await connectManaged(config)
  const original = { ...connection }, clientRecord = app.broker.clients.get(connection.client)
  const taskId = randomUUID()
  await app.broker.recoveryStore.record(connection.client, taskId)
  const reconnect = await connection.reconnect()
  assert.equal(reconnect.clientId, original.client)
  assert.equal(app.broker.clients.get(connection.client), clientRecord)
  assert.notEqual(connection.token, original.token)
  assert.equal((await request(original, 'task_list')).status, 401)
  assert.equal((await createClient(peer).call('task_list')).tasks.length, 0)
  assert.equal(Object.keys(connection).includes('reconnect'), false)
  assert.equal(JSON.stringify(connection).includes('recoverySecret'), false)
  await app.close()
  app = await launch(directory)
  await connection.reconnect()
  const tasks = (await createClient(connection).call('task_list')).tasks
  assert.equal(tasks.length, 1)
  assert.equal(tasks[0].taskId, taskId)
  assert.equal(tasks[0].state, 'recovery-needed')
  await assert.rejects(createClient(connection).call('task_observe', { taskId }), { code: 'RECOVERY_NEEDED' })
  const fresh = await connectManaged(config)
  assert.deepEqual((await createClient(fresh).call('task_list')).tasks, [])
  await assert.rejects(createClient(fresh).call('task_observe', { taskId }), { code: 'NOT_FOUND' })
  await releaseManagedConnection(connection)
  await assert.rejects(connection.reconnect(), { code: 'LEASE_REJECTED' })
})

test('recoverable manual handoff survives lease grace and blocks mutation until heartbeat', async t => {
  const directory = await state(), app = await launch(directory)
  t.after(() => app.close())
  const config = await resolveManagedOptions({ executable: process.execPath, stateDir: directory })
  const connection = await connectManaged(config)
  const caller = app.broker.clients.get(connection.client)
  caller.expiresAt = Date.now() - 1000
  const task = { taskId: randomUUID(), owner: connection.client, state: 'human', handoff: { id: randomUUID() }, pages: new Map(), queue: Promise.resolve(), downloads: [], blockedOrigins: [] }
  app.broker.tasks.set(task.taskId, task)
  await app.broker.expireClients()
  assert.equal(task.state, 'human')
  assert.equal(caller.released, false)
  await assert.rejects(createClient(connection).call('task_cancel', { taskId: task.taskId }), { code: 'LEASE_EXPIRED' })
  assert.equal((await request(connection, 'client_heartbeat')).body.ok, true)
  assert.equal(task.state, 'human')
  assert.ok(caller.expiresAt > Date.now())
})

test('one heartbeat failure does not release a client, while exhaustion retains safe cause', async t => {
  let failures = 1, heartbeats = 0, releases = 0, onSuccess
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk
    const { method } = JSON.parse(raw)
    if (method === 'client_release') releases++
    else { heartbeats++; if (failures-- > 0) { req.socket.destroy(); return } }
    res.end(JSON.stringify({ ok: true, result: {} })); onSuccess?.()
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(() => { server.closeAllConnections(); server.close() })
  const connection = { endpoint: `http://127.0.0.1:${server.address().port}`, token: 'fixture' }
  let failure
  const lease = maintainManagedLease(connection, error => { failure = error }, { heartbeatMs: 10, retryWindowMs: 80 })
  t.after(() => lease.release())
  await new Promise(resolve => { onSuccess = resolve })
  assert.ok(heartbeats >= 2); assert.equal(releases, 0); assert.equal(failure, undefined)
  await lease.release()
  assert.equal(releases, 1)
  failures = 100
  const exhausted = new Promise(resolve => {
    const second = maintainManagedLease(connection, error => resolve({ error, second }), { heartbeatMs: 10, retryWindowMs: 40 })
  })
  const result = await exhausted
  assert.equal(result.error.code, 'LEASE_RECOVERY_NEEDED')
  assert.equal(result.error.phase, 'heartbeat')
  assert.equal(result.error.causeCode, 'LEASE_UNAVAILABLE')
  assert.equal(releases, 1)
  await result.second.release()
})

test('transport repair never replays a mutation with unknown delivery', async t => {
  let mutations = 0, repaired = 0
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk
    const { method } = JSON.parse(raw)
    if (method === 'agent_protocol') res.end(JSON.stringify({ ok: true, result: { agentProtocol: AGENT_PROTOCOL } }))
    else { mutations++; req.socket.destroy() }
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(() => { server.closeAllConnections(); server.close() })
  const client = createClient({ endpoint: `http://127.0.0.1:${server.address().port}`, token: 'fixture', reconnect: async () => { repaired++ } })
  await assert.rejects(client.call('task_act', { taskId: 'own', observationId: 'obs', actions: [{ type: 'click', ref: 'e1' }] }), error => error.code === 'CONNECTION_ERROR' && error.actionResult.delivery === 'unknown')
  assert.equal(mutations, 1); assert.equal(repaired, 1)
})

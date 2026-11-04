import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { createClient } from '../client.mjs'
import { acquireStartupGate, adminRpc, connectManaged, diagnostic, maintainManagedLease, parseManagedOptions, readManagedDescriptor, releaseManagedConnection, resolveManagedOptions, runManagedBroker } from '../managed-runtime.mjs'
import { effectivePolicyIdentity } from '../policy-identity.mjs'

const directory = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(directory, '..')
const fake = path.join(directory, 'fixtures', 'managed-fake-broker.mjs')
const results = path.join(root, 'test-results')
await mkdir(results, { recursive: true })

async function options(extra = {}) {
  const stateDir = await mkdtemp(path.join(results, 'managed-'))
  return resolveManagedOptions({ executable: process.execPath, stateDir, daemonScript: fake, startupTimeoutMs: 8000, ...extra })
}

async function stop(stateDir) {
  const descriptor = await readManagedDescriptor(stateDir)
  if (!descriptor) return
  await adminRpc(descriptor, 'shutdown')
  const deadline = Date.now() + 5000
  for (;;) {
    try { process.kill(descriptor.pid, 0) } catch (error) { if (error.code === 'ESRCH') return; throw error }
    if (Date.now() > deadline) throw new Error('Owned fake broker did not exit after shutdown')
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

async function deadPid() {
  const child = spawn(process.execPath, ['-e', ''], { windowsHide: true, stdio: 'ignore' })
  await once(child, 'exit')
  return child.pid
}

test('five concurrent clients share one daemon and receive isolated credentials', async t => {
  const config = await options()
  t.after(() => stop(config.stateDir))
  const connections = await Promise.all(Array.from({ length: 5 }, (_, i) => connectManaged({ ...config, label: `Codex ${i}` })))
  assert.equal(new Set(connections.map(value => value.client)).size, 5)
  assert.equal(new Set(connections.map(value => value.token)).size, 5)
  assert.equal(new Set(connections.map(value => value.endpoint)).size, 1)
  const before = await readManagedDescriptor(config.stateDir)
  for (const connection of connections) {
    assert.deepEqual(Object.keys(connection).sort(), ['client', 'endpoint', 'leaseMs', 'token'])
    assert.equal(connection.leaseMs, 30000)
    assert.notEqual(connection.token, before.adminToken)
    assert.equal((await createClient(connection).call('task_list')).owner, connection.client)
  }
  const sixth = await connectManaged(config)
  assert.equal(sixth.endpoint, before.endpoint)
  assert.equal((await readManagedDescriptor(config.stateDir)).pid, before.pid)
  assert.equal((await createClient(connections[4]).call('task_list')).owner, connections[4].client)
  const log = await readFile(path.join(config.stateDir, 'managed-broker.log'), 'utf8')
  for (const secret of [before.adminToken, ...connections.map(value => value.token)]) assert.ok(!log.includes(secret))
})

function stdioClient(config) {
  const child = spawn(process.execPath, [path.join(root, 'managed-mcp.mjs'), '--browser', process.execPath, '--state-dir', config.stateDir], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  let output = '', stderr = '', buffer = '', sequence = 0
  const pending = new Map()
  child.stdout.on('data', chunk => {
    output += chunk
    buffer += chunk
    for (;;) {
      const end = buffer.indexOf('\n')
      if (end < 0) break
      const line = buffer.slice(0, end)
      buffer = buffer.slice(end + 1)
      let message
      try { message = JSON.parse(line) } catch {
        for (const waiter of pending.values()) waiter.reject(new Error('Non-protocol output on MCP stdout'))
        continue
      }
      const waiter = pending.get(message.id)
      if (waiter) { pending.delete(message.id); message.error ? waiter.reject(new Error('MCP request failed')) : waiter.resolve(message.result) }
    }
  })
  child.stderr.on('data', chunk => { stderr += chunk })
  const exited = once(child, 'exit')
  return {
    call(method, params) {
      const id = ++sequence
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`MCP test request timed out: ${method} (${output.length} stdout bytes, ${stderr.length} stderr bytes)`)) }, 60000)
        pending.set(id, { resolve: result => { clearTimeout(timeout); resolve(result) }, reject: error => { clearTimeout(timeout); reject(error) } })
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
      })
    },
    initialized() { child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n') },
    async close() { child.stdin.end(); await exited },
    get output() { return output }, get stderr() { return stderr }
  }
}

test('five MCP stdio clients initialize and closing one leaves peers and broker alive', async t => {
  const config = await options()
  t.after(() => stop(config.stateDir))
  await connectManaged(config)
  const descriptor = await readManagedDescriptor(config.stateDir)
  const clients = Array.from({ length: 5 }, () => stdioClient(config))
  t.after(async () => { await Promise.all(clients.map(client => client.close())) })
  await Promise.all(clients.map(async client => {
    const result = await client.call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'managed-test', version: '1.0.0' } })
    assert.equal(result.serverInfo.name, 'velmren-agent')
    client.initialized()
  }))
  const owners = await Promise.all(clients.map(async client => {
    const response = await client.call('tools/call', { name: 'velmren_list_tasks', arguments: {} })
    assert.equal(response.isError, undefined)
    return JSON.parse(response.content[0].text).owner
  }))
  assert.equal(new Set(owners).size, 5)
  await clients[0].close()
  const afterClose = await adminRpc(descriptor, 'broker_status')
  assert.equal(afterClose.releasedClients, 1)
  assert.equal(afterClose.clients, 5)
  const response = await clients[4].call('tools/call', { name: 'velmren_list_tasks', arguments: {} })
  assert.equal(JSON.parse(response.content[0].text).owner, owners[4])
  assert.equal((await readManagedDescriptor(config.stateDir)).pid, descriptor.pid)
  for (const client of clients) {
    assert.ok(!client.output.includes(descriptor.adminToken))
    assert.ok(!client.output.includes('"adminToken"'))
    assert.ok(!client.output.includes('"token"'))
    assert.equal(client.stderr, '')
  }
})

test('effective policy identity normalizes defaults, ordering, and explicit-origin precedence', () => {
  assert.equal(effectivePolicyIdentity({}), effectivePolicyIdentity({ maxTasks: 8, maxActiveActions: 5, webCompatibility: false, allowWeb: false }))
  assert.equal(effectivePolicyIdentity({ allowedOrigins: ['https://b.test', 'https://a.test', 'https://a.test'], allowWeb: true }), effectivePolicyIdentity({ allowedOrigins: ['https://a.test', 'https://b.test'] }))
  for (const policy of [{ webCompatibility: true }, { allowWeb: true }, { maxTasks: 7 }, { maxActiveActions: 4 }, { futurePolicy: { enabled: true } }]) {
    assert.notEqual(effectivePolicyIdentity({}), effectivePolicyIdentity(policy))
  }
  assert.equal(effectivePolicyIdentity({ futurePolicy: { b: 2, a: 1 } }), effectivePolicyIdentity({ futurePolicy: { a: 1, b: 2 } }))
})

test('a live daemon rejects changed or missing requested policies before registration', async t => {
  const config = await options()
  t.after(() => stop(config.stateDir))
  await connectManaged(config)
  const descriptor = await readManagedDescriptor(config.stateDir)
  const policyFile = path.join(config.stateDir, 'requested-policy.json')
  await assert.rejects(connectManaged({ ...config, policyFile }), { code: 'INVALID_POLICY' })
  await writeFile(policyFile, JSON.stringify({ maxActiveActions: 1 }))
  await assert.rejects(connectManaged({ ...config, policyFile }), { code: 'POLICY_MISMATCH' })
  assert.equal((await adminRpc(descriptor, 'broker_status')).clients, 1)
  await writeFile(policyFile, '\uFEFF' + JSON.stringify({ maxActiveActions: 5, maxTasks: 8 }))
  await connectManaged({ ...config, policyFile })
  await writeFile(policyFile, JSON.stringify({ allowWeb: true }))
  await assert.rejects(connectManaged({ ...config, policyFile }), { code: 'POLICY_MISMATCH' })
  assert.equal((await adminRpc(descriptor, 'broker_status')).clients, 2)
})

test('an unhealthy broker is rejected without spawning or registering another client', async t => {
  const config = await options()
  t.after(() => stop(config.stateDir))
  await connectManaged(config)
  const descriptor = await readManagedDescriptor(config.stateDir)
  await adminRpc(descriptor, 'set_browser_health', { healthy: false })
  let spawned = false
  await assert.rejects(connectManaged(config, { spawnDaemon: () => { spawned = true } }), { code: 'BROKER_UNHEALTHY' })
  assert.equal(spawned, false)
  assert.equal((await adminRpc(descriptor, 'broker_status')).clients, 1)
  await adminRpc(descriptor, 'set_browser_health', {})
  await assert.rejects(connectManaged(config, { spawnDaemon: () => { spawned = true } }), { code: 'BROKER_INCOMPATIBLE' })
  assert.equal(spawned, false)
})

test('lease heartbeat and release use only the scoped credential and leave peers alive', async t => {
  const config = await options()
  t.after(() => stop(config.stateDir))
  const connection = await connectManaged(config)
  const peer = await connectManaged(config)
  const descriptor = await readManagedDescriptor(config.stateDir)
  let failure
  const lease = maintainManagedLease(connection, error => { failure = error }, { heartbeatMs: 20 })
  t.after(() => lease.release())
  const deadline = Date.now() + 3000
  while (!(await adminRpc(descriptor, 'broker_status')).heartbeats) {
    assert.ok(Date.now() < deadline, 'Lease heartbeat did not arrive')
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  await lease.release()
  await lease.release()
  assert.equal(failure, undefined)
  const status = await adminRpc(descriptor, 'broker_status')
  assert.equal(status.releasedClients, 1)
  assert.equal(status.clients, 1)
  await assert.rejects(createClient(connection).call('task_list'))
  assert.equal((await createClient(peer).call('task_list')).owner, peer.client)
  await releaseManagedConnection(peer)
})

test('known dead managed broker files are backed up before a fresh daemon starts', async t => {
  const config = await options()
  t.after(() => stop(config.stateDir))
  const pid = await deadPid()
  const stale = { endpoint: 'http://127.0.0.1:1', pid, adminToken: 'old-admin-credential' }
  await writeFile(path.join(config.stateDir, 'connection.json'), JSON.stringify(stale))
  await writeFile(path.join(config.stateDir, 'broker.lock'), String(pid))
  await writeFile(path.join(config.stateDir, 'managed-owner.json'), JSON.stringify({ schema: 1, purpose: 'velmren-managed-broker', stateDir: config.stateDir, pid, nonce: 'test-receipt' }))
  const connection = await connectManaged(config)
  assert.notEqual(connection.endpoint, stale.endpoint)
  const backups = await readdir(path.join(config.stateDir, 'recovery'))
  assert.equal(backups.length, 1)
  const backup = path.join(config.stateDir, 'recovery', backups[0])
  assert.deepEqual(JSON.parse(await readFile(path.join(backup, 'connection.json'))), stale)
  assert.equal(await readFile(path.join(backup, 'broker.lock'), 'utf8'), String(pid))
})

test('live or unowned stale processes are never replaced', async () => {
  for (const owned of [false, true]) {
    const config = await options()
    await writeFile(path.join(config.stateDir, 'broker.lock'), String(process.pid))
    if (owned) await writeFile(path.join(config.stateDir, 'managed-owner.json'), JSON.stringify({ schema: 1, purpose: 'velmren-managed-broker', stateDir: config.stateDir, pid: process.pid, nonce: 'test-receipt' }))
    let called = false
    await assert.rejects(runManagedBroker(config, { startBroker: () => { called = true } }), { code: owned ? 'BROKER_STILL_RUNNING' : 'UNOWNED_STATE' })
    assert.equal(called, false)
    assert.equal(await readFile(path.join(config.stateDir, 'broker.lock'), 'utf8'), String(process.pid))
  }
})

test('startup gate is exclusive and bounded, then becomes reusable', async () => {
  const config = await options()
  const release = await acquireStartupGate(config.stateDir, 500)
  try { await assert.rejects(acquireStartupGate(config.stateDir, 100), { code: 'STARTUP_TIMEOUT' }) }
  finally { await release() }
  await (await acquireStartupGate(config.stateDir, 100))()
})

test('initialization failure is bounded and diagnostics exclude private errors', async () => {
  const config = await options()
  config.policyFile = path.join(config.stateDir, 'policy.json')
  await writeFile(config.policyFile, JSON.stringify({ fail: true }))
  const start = Date.now()
  await assert.rejects(connectManaged(config), { code: 'INITIALIZATION_FAILED' })
  assert.ok(Date.now() - start < config.startupTimeoutMs)
  assert.equal(await readManagedDescriptor(config.stateDir), null)
  const log = await readFile(path.join(config.stateDir, 'managed-broker.log'), 'utf8')
  assert.ok(!log.includes('fake-admin-credential'))
  assert.ok(!diagnostic(new Error('fake-admin-credential')).includes('fake-admin-credential'))
})

test('MCP CLI errors and help never write stdout or secrets', async () => {
  for (const args of [['--help'], ['--unknown', 'fake-admin-credential']]) {
    const child = spawn(process.execPath, [path.join(root, 'managed-mcp.mjs'), ...args], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    child.stdout.on('data', value => { stdout += value })
    child.stderr.on('data', value => { stderr += value })
    await once(child, 'exit')
    assert.equal(stdout, '')
    assert.ok(stderr.length > 0)
    assert.ok(!stderr.includes('fake-admin-credential'))
  }
  assert.throws(() => parseManagedOptions(['--label', 'bad\nlabel']), { code: 'INVALID_OPTIONS' })
})

test('Windows launcher relay preserves UTF-8 protocol bytes and quoted arguments', { skip: process.platform !== 'win32', timeout: 60000 }, async () => {
  const executable = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const child = spawn(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(directory, 'fixtures', 'managed-relay-test.ps1'), '-NodePath', process.execPath], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  const output = [], errors = []
  child.stdout.on('data', value => output.push(value))
  child.stderr.on('data', value => errors.push(value))
  const payload = Buffer.from('{"jsonrpc":"2.0","text":"Привет — ✓"}\n', 'utf8')
  child.stdin.end(payload)
  const [code] = await once(child, 'exit')
  assert.equal(code, 0, Buffer.concat(errors).toString())
  assert.equal(Buffer.concat(errors).toString(), 'relay-stderr')
  const prefix = Buffer.from(JSON.stringify(['space and "quote"', 'C:\\trailing slash\\']) + '\n')
  assert.deepEqual(Buffer.concat(output), Buffer.concat([prefix, payload]))
})

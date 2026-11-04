import { spawn, execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, realpath, rename, stat, writeFile, open } from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { effectivePolicyIdentity } from './policy-identity.mjs'

const execute = promisify(execFile)
const directory = path.dirname(fileURLToPath(import.meta.url))
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const OWNER_FILE = 'managed-owner.json'
export const MANAGED_LEASE_MS = 30000

export class ManagedError extends Error {
  constructor(code, message) { super(message); this.code = code; this.name = 'ManagedError' }
}

const fail = (code, message) => { throw new ManagedError(code, message) }
export const diagnostic = error => error instanceof ManagedError
  ? `velmren-mcp: ${error.code}: ${error.message}\n`
  : 'velmren-mcp: INITIALIZATION_FAILED: Managed browser initialization failed.\n'

export function parseManagedOptions(argv) {
  const options = { label: 'Codex', startupTimeoutMs: 60000 }
  const names = { '--install-root': 'installRoot', '--browser': 'executable', '--state-dir': 'stateDir', '--policy': 'policyFile', '--label': 'label', '--startup-timeout-ms': 'startupTimeoutMs' }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--help' || argv[i] === '-h') { options.help = true; continue }
    const name = names[argv[i]], value = argv[++i]
    if (!name || !value || value.startsWith('--')) fail('INVALID_OPTIONS', 'Expected --install-root, or --browser and --state-dir; optional --policy and --label.')
    options[name] = value
  }
  options.startupTimeoutMs = Number(options.startupTimeoutMs)
  if (!Number.isInteger(options.startupTimeoutMs) || options.startupTimeoutMs < 500 || options.startupTimeoutMs > 120000) fail('INVALID_OPTIONS', 'Startup timeout must be 500–120000 milliseconds.')
  if (typeof options.label !== 'string' || !options.label.trim() || options.label.length > 200 || /[\r\n]/.test(options.label)) fail('INVALID_OPTIONS', 'Client label must be a short single-line name.')
  return options
}

async function regularFile(file, code) {
  try { if ((await stat(file)).isFile()) return } catch {}
  fail(code, 'The requested installed runtime or browser file is unavailable.')
}

export async function resolveManagedOptions(options) {
  const resolved = { startupTimeoutMs: 60000, label: 'Codex', ...options }
  if (options.installRoot) {
    const root = path.resolve(options.installRoot)
    let installation
    try {
      const output = await execute(path.join(root, 'Velmren.exe'), ['resolve'], { windowsHide: true, timeout: 90000, maxBuffer: 65536, encoding: 'utf8' })
      installation = JSON.parse(output.stdout.replace(/^\uFEFF/, ''))
    } catch { fail('INSTALLATION_UNAVAILABLE', 'The installed Velmren launcher could not resolve its current runtime.') }
    for (const key of ['browser', 'agentRuntime', 'appRoot', 'agentStateDir']) {
      if (typeof installation[key] !== 'string' || !path.isAbsolute(installation[key])) fail('INVALID_INSTALLATION', 'The installed launcher returned an invalid runtime description.')
    }
    resolved.executable ??= installation.browser
    resolved.stateDir ??= installation.agentStateDir
    resolved.nodeExecutable = installation.agentRuntime
    resolved.daemonScript = path.join(installation.appRoot, 'agent', 'managed-broker.mjs')
  }
  if (!resolved.executable || !resolved.stateDir) fail('INVALID_OPTIONS', 'Supply --install-root, or both --browser and --state-dir.')
  resolved.executable = path.resolve(resolved.executable)
  resolved.nodeExecutable ??= process.execPath
  resolved.daemonScript ??= path.join(directory, 'managed-broker.mjs')
  await regularFile(resolved.executable, 'BROWSER_UNAVAILABLE')
  await regularFile(resolved.nodeExecutable, 'RUNTIME_UNAVAILABLE')
  await regularFile(resolved.daemonScript, 'RUNTIME_UNAVAILABLE')
  await mkdir(path.resolve(resolved.stateDir), { recursive: true, mode: 0o700 })
  resolved.stateDir = await realpath(path.resolve(resolved.stateDir))
  if (resolved.policyFile) resolved.policyFile = path.resolve(resolved.policyFile)
  return resolved
}

export async function readManagedJson(file) {
  let data
  try { data = await readFile(file, 'utf8') } catch (error) {
    if (error.code === 'ENOENT') return null
    fail('STATE_UNAVAILABLE', 'Cannot read managed browser state.')
  }
  if (data.length > 1024 * 1024) fail('INVALID_STATE', 'Managed browser state is too large.')
  try { return JSON.parse(data.replace(/^\uFEFF/, '')) } catch { fail('INVALID_STATE', 'Managed browser state is incomplete or invalid; it was preserved.') }
}

function validateDescriptor(value) {
  if (!value) return null
  let endpoint
  try { endpoint = new URL(value.endpoint) } catch {}
  if (!endpoint || endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || !endpoint.port || endpoint.pathname !== '/' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash ||
      !Number.isSafeInteger(value.pid) || value.pid < 1 || typeof value.adminToken !== 'string' || value.adminToken.length < 16 || /[\r\n]/.test(value.adminToken)) {
    fail('INVALID_STATE', 'The broker connection description is invalid; it was preserved.')
  }
  return { endpoint: endpoint.origin, pid: value.pid, adminToken: value.adminToken }
}

export async function readManagedDescriptor(stateDir) {
  return validateDescriptor(await readManagedJson(path.join(stateDir, 'connection.json')))
}

export async function adminRpc(descriptor, method, args = {}, timeoutMs = 2000) {
  let response, payload
  try {
    response = await fetch(`${descriptor.endpoint}/rpc`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
      headers: { Authorization: `Bearer ${descriptor.adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ method, args })
    })
    payload = await response.json()
  } catch { fail('BROKER_UNAVAILABLE', 'The local broker did not respond. No browser action was replayed.') }
  if (!response.ok || payload?.ok !== true) fail('BROKER_REJECTED', 'The local broker rejected the connection request.')
  return payload.result
}

async function requestedPolicy(options) {
  let policy = {}
  if (options.policyFile) policy = await readManagedJson(options.policyFile)
  try { return { policy, identity: effectivePolicyIdentity(policy) } }
  catch { fail('INVALID_POLICY', 'The requested broker policy is missing or invalid.') }
}

async function healthy(descriptor, identity) {
  if (!descriptor) return false
  let status
  try { status = await adminRpc(descriptor, 'broker_status') } catch { return false }
  if (typeof status?.policyIdentity !== 'string' || typeof status.browserHealthy !== 'boolean') fail('BROKER_INCOMPATIBLE', 'The running broker does not support managed policy and health checks.')
  if (status.policyIdentity !== identity) fail('POLICY_MISMATCH', 'The running broker uses a different policy. Existing clients and tasks were preserved.')
  if (!status.browserHealthy) fail('BROKER_UNHEALTHY', 'The managed browser is unavailable. Wait for its broker to stop before reconnecting.')
  return true
}

function dead(pid) {
  try { process.kill(pid, 0); return false } catch (error) { return error.code === 'ESRCH' }
}

// The OS releases this gate on process death. No stale file lock is ever stolen.
export async function acquireStartupGate(stateDir, timeoutMs = 60000) {
  const canonical = process.platform === 'win32' ? stateDir.toLowerCase() : stateDir
  const port = 20000 + createHash('sha256').update(canonical).digest().readUInt32BE(0) % 35000
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const server = net.createServer(socket => socket.destroy())
    const error = await new Promise(resolve => {
      server.once('error', resolve)
      server.listen({ host: '127.0.0.1', port, exclusive: true }, () => resolve(null))
    })
    if (!error) return () => new Promise(resolve => server.close(resolve))
    server.close()
    if (error.code !== 'EADDRINUSE') fail('STARTUP_LOCK_FAILED', 'Cannot acquire the local broker startup lock.')
    if (Date.now() >= deadline) fail('STARTUP_TIMEOUT', 'Timed out waiting for the local broker startup lock; existing processes were left running.')
    await pause(Math.min(100, Math.max(1, deadline - Date.now())))
  }
}

async function recoverOwnedState(options) {
  const { stateDir } = options
  const owner = await readManagedJson(path.join(stateDir, OWNER_FILE))
  const descriptor = await readManagedDescriptor(stateDir)
  let lock = null
  try { lock = await readFile(path.join(stateDir, 'broker.lock'), 'utf8') } catch (error) { if (error.code !== 'ENOENT') fail('STATE_UNAVAILABLE', 'Cannot read the broker ownership lock.') }
  if (!owner && !descriptor && lock === null) return
  if (!owner || owner.schema !== 1 || owner.purpose !== 'velmren-managed-broker' || owner.stateDir !== stateDir || !Number.isSafeInteger(owner.pid) || owner.pid < 1 || typeof owner.nonce !== 'string') fail('UNOWNED_STATE', 'Existing broker state has no managed ownership receipt; it was preserved.')
  if (!dead(owner.pid)) fail('BROKER_STILL_RUNNING', 'The recorded broker process is still running but unavailable; it was left running.')
  if ((descriptor && descriptor.pid !== owner.pid) || (lock !== null && (!/^\d+\s*$/.test(lock) || Number(lock) !== owner.pid))) fail('OWNERSHIP_MISMATCH', 'Broker state does not match the recorded managed process; it was preserved.')
  const backup = path.join(stateDir, 'recovery', `${Date.now()}-${randomUUID()}`)
  await mkdir(backup, { recursive: true, mode: 0o700 })
  for (const file of ['connection.json', 'broker.lock', OWNER_FILE]) {
    try { await rename(path.join(stateDir, file), path.join(backup, file)) } catch (error) { if (error.code !== 'ENOENT') fail('RECOVERY_FAILED', 'Cannot preserve the previous broker state; startup stopped.') }
  }
}

export async function runManagedBroker(options, { startBroker } = {}) {
  const { policy, identity } = await requestedPolicy(options)
  const release = await acquireStartupGate(options.stateDir, options.startupTimeoutMs)
  try {
    const descriptor = await readManagedDescriptor(options.stateDir)
    if (await healthy(descriptor, identity)) return { reused: true }
    await recoverOwnedState(options)
    await writeFile(path.join(options.stateDir, OWNER_FILE), JSON.stringify({
      schema: 1, purpose: 'velmren-managed-broker', pid: process.pid, nonce: randomUUID(),
      stateDir: options.stateDir, executable: options.executable, startedAt: new Date().toISOString()
    }), { flag: 'wx', mode: 0o600 })
    const start = startBroker ?? (await import('./broker.mjs')).startBroker
    const app = await start({ executable: options.executable, stateDir: options.stateDir, policy, port: 0 })
    return { reused: false, ...app }
  } finally { await release() }
}

async function spawnManagedDaemon(options) {
  const args = [options.daemonScript, '--browser', options.executable, '--state-dir', options.stateDir, '--startup-timeout-ms', String(options.startupTimeoutMs)]
  if (options.policyFile) args.push('--policy', options.policyFile)
  const log = await open(path.join(options.stateDir, 'managed-broker.log'), 'a', 0o600)
  let child
  const outcome = { exited: false, failed: false }
  try {
    child = spawn(options.nodeExecutable, args, { detached: true, windowsHide: true, stdio: ['ignore', 'ignore', log.fd] })
    child.on('error', () => { outcome.exited = true; outcome.failed = true })
    child.once('exit', code => { outcome.exited = true; outcome.failed = code !== 0 })
    child.unref()
  } catch { outcome.exited = true; outcome.failed = true } finally { await log.close() }
  return outcome
}

export async function connectManaged(options, { spawnDaemon = spawnManagedDaemon } = {}) {
  const { identity } = await requestedPolicy(options)
  let descriptor = await readManagedDescriptor(options.stateDir)
  if (!await healthy(descriptor, identity)) {
    const outcome = await spawnDaemon(options)
    const deadline = Date.now() + options.startupTimeoutMs
    for (;;) {
      descriptor = await readManagedDescriptor(options.stateDir)
      if (await healthy(descriptor, identity)) break
      if (outcome.exited && outcome.failed) fail('INITIALIZATION_FAILED', 'Managed browser initialization failed. Existing processes and saved state were preserved.')
      if (Date.now() >= deadline) fail('STARTUP_TIMEOUT', 'Timed out starting the managed browser. Existing processes were left running.')
      await pause(100)
    }
  }
  // Registration is performed once. Only this scoped credential reaches MCP tools.
  const registered = await adminRpc(descriptor, 'client_register', { label: options.label ?? 'Codex', policyIdentity: identity, leaseMs: MANAGED_LEASE_MS }, 5000)
  if (typeof registered?.clientId !== 'string' || !registered.clientId || registered.clientId === 'admin' || typeof registered.token !== 'string' || registered.token.length < 16 || /[\r\n]/.test(registered.token) || registered.token === descriptor.adminToken || registered.leaseMs !== MANAGED_LEASE_MS) fail('INVALID_REGISTRATION', 'The broker returned an invalid scoped client credential or lease.')
  return { endpoint: descriptor.endpoint, client: registered.clientId, token: registered.token, leaseMs: registered.leaseMs }
}

async function leaseRpc(connection, method) {
  let response, payload
  try {
    response = await fetch(`${connection.endpoint}/rpc`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(2000),
      headers: { Authorization: `Bearer ${connection.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ method, args: {} })
    })
    payload = await response.json()
  } catch { fail('LEASE_UNAVAILABLE', 'The managed connection lease is unavailable. No browser action was replayed.') }
  if (!response.ok || payload?.ok !== true) fail('LEASE_REJECTED', 'The managed connection lease has ended.')
  return payload.result
}

export const releaseManagedConnection = connection => leaseRpc(connection, 'client_release')

export function maintainManagedLease(connection, onFailure = () => {}, { heartbeatMs = 10000 } = {}) {
  let closed = false, pending = false, released
  const timer = setInterval(async () => {
    if (closed || pending) return
    pending = true
    try { await leaseRpc(connection, 'client_heartbeat') }
    catch (error) { if (!closed) { closed = true; clearInterval(timer); onFailure(error) } }
    finally { pending = false }
  }, heartbeatMs)
  timer.unref()
  return {
    release() {
      closed = true
      clearInterval(timer)
      return released ??= releaseManagedConnection(connection).catch(() => {})
    }
  }
}

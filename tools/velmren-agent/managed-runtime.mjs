import { spawn, execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, realpath, rename, stat, writeFile, open, unlink } from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { effectivePolicyIdentity } from './policy-identity.mjs'
import { assertNoManualProfileSession } from './manual-profile.mjs'

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
  const manual = status.profileLogin?.automationConnected === false &&
    ['stopping-automation', 'manual', 'awaiting-confirmation', 'restarting'].includes(status.profileLogin.phase)
  if (!status.browserHealthy && !manual) fail('BROKER_UNHEALTHY', 'The managed browser is unavailable. Wait for its broker to stop before reconnecting.')
  return true
}

function dead(pid) {
  try { process.kill(pid, 0); return false } catch (error) { return error.code === 'ESRCH' }
}

// The OS releases this gate on process death. No stale file lock is ever stolen.
export async function acquireStartupGate(stateDir, timeoutMs = 60000, signal) {
  const canonical = process.platform === 'win32' ? stateDir.toLowerCase() : stateDir
  const port = 20000 + createHash('sha256').update(canonical).digest().readUInt32BE(0) % 35000
  const deadline = Date.now() + timeoutMs
  for (;;) {
    signal?.throwIfAborted()
    const server = net.createServer(socket => socket.destroy())
    const error = await new Promise(resolve => {
      server.once('error', resolve)
      server.listen({ host: '127.0.0.1', port, exclusive: true }, () => resolve(null))
    })
    if (!error) {
      if (signal?.aborted) { await new Promise(resolve => server.close(resolve)); signal.throwIfAborted() }
      return () => new Promise(resolve => server.close(resolve))
    }
    server.close()
    if (error.code !== 'EADDRINUSE') fail('STARTUP_LOCK_FAILED', 'Cannot acquire the local broker startup lock.')
    if (Date.now() >= deadline) fail('STARTUP_TIMEOUT', 'Timed out waiting for the local broker startup lock; existing processes were left running.')
    await pause(Math.min(100, Math.max(1, deadline - Date.now())))
  }
}

function recoveryLineage(receipt) {
  return { schema: 1, loginId: receipt.id, brokerPid: receipt.brokerPid, browserPid: receipt.browserPid,
    browserStartTime: receipt.browserStartTime, executable: receipt.executable, profile: receipt.profile, policyIdentity: receipt.policyIdentity }
}

async function recoverOwnedState(options, manualReceipt) {
  const { stateDir } = options
  if (manualReceipt && !dead(manualReceipt.brokerPid)) fail('BROKER_STILL_RUNNING', 'The recorded manual sign-in broker process is still running; it was left running.')
  const owner = await readManagedJson(path.join(stateDir, OWNER_FILE))
  const descriptor = await readManagedDescriptor(stateDir)
  let lock = null
  try { lock = await readFile(path.join(stateDir, 'broker.lock'), 'utf8') } catch (error) { if (error.code !== 'ENOENT') fail('STATE_UNAVAILABLE', 'Cannot read the broker ownership lock.') }
  if (!owner && !descriptor && lock === null) return
  if (!owner || owner.schema !== 1 || owner.purpose !== 'velmren-managed-broker' || owner.stateDir !== stateDir || !Number.isSafeInteger(owner.pid) || owner.pid < 1 || typeof owner.nonce !== 'string') fail('UNOWNED_STATE', 'Existing broker state has no managed ownership receipt; it was preserved.')
  if (manualReceipt) {
    // A recovered broker may later initiate a different manual login itself.
    const original = owner.pid === manualReceipt.brokerPid
    const lineage = recoveryLineage(manualReceipt)
    const attempt = owner.executable === manualReceipt.executable && owner.profileLoginRecovery &&
      Object.entries(lineage).every(([key, value]) => owner.profileLoginRecovery[key] === value)
    if (!original && !attempt) fail('OWNERSHIP_MISMATCH', 'Managed ownership does not match the manual sign-in recovery lineage; existing state was preserved.')
  }
  if (!dead(owner.pid)) fail('BROKER_STILL_RUNNING', 'The recorded broker process is still running but unavailable; it was left running.')
  if ((descriptor && descriptor.pid !== owner.pid) || (lock !== null && (!/^\d+\s*$/.test(lock) || Number(lock) !== owner.pid))) fail('OWNERSHIP_MISMATCH', 'Broker state does not match the recorded managed process; it was preserved.')
  const backup = path.join(stateDir, 'recovery', `${Date.now()}-${randomUUID()}`)
  await mkdir(backup, { recursive: true, mode: 0o700 })
  for (const file of ['connection.json', 'broker.lock', OWNER_FILE]) {
    try { await rename(path.join(stateDir, file), path.join(backup, file)) } catch (error) { if (error.code !== 'ENOENT') fail('RECOVERY_FAILED', 'Cannot preserve the previous broker state; startup stopped.') }
  }
}

export async function runManagedBroker(options, { startBroker, signal, profileLoginRecovery } = {}) {
  const controller = new AbortController()
  const startupSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
  const ipc = typeof process.send === 'function'
  const disconnected = () => controller.abort(new ManagedError('STARTUP_CANCELLED', 'Managed browser startup was cancelled.'))
  let accept
  const accepted = new Promise(resolve => { accept = resolve })
  const message = value => { if (value?.type === 'managed-startup-accept') accept() }
  if (ipc) {
    process.once('disconnect', disconnected)
    process.on('message', message)
    if (!process.connected) disconnected()
  }
  let release, app, ownerNonce
  const acceptStartup = async () => {
    startupSignal.throwIfAborted()
    if (!ipc) return
    // Keep the startup gate until the spawning client has registered or cancelled.
    await new Promise((resolve, reject) => process.send({ type: 'managed-startup-ready' }, error => error ? reject(error) : resolve()))
    startupSignal.throwIfAborted()
    await Promise.race([accepted, new Promise((_, reject) => startupSignal.addEventListener('abort', () => reject(startupSignal.reason), { once: true }))])
    startupSignal.throwIfAborted()
  }
  try {
    const { policy, identity } = await requestedPolicy(options)
    release = await acquireStartupGate(options.stateDir, options.startupTimeoutMs, startupSignal)
    const descriptor = await readManagedDescriptor(options.stateDir)
    if (profileLoginRecovery === undefined && await healthy(descriptor, identity)) return { reused: true }
    startupSignal.throwIfAborted()
    let recoveryReceipt
    if (profileLoginRecovery === undefined) await assertNoManualProfileSession(options.stateDir)
    else {
      const { validateProfileLoginRecovery } = await import('./broker.mjs')
      recoveryReceipt = await validateProfileLoginRecovery({ executable: options.executable, stateDir: options.stateDir, policy }, profileLoginRecovery)
    }
    await recoverOwnedState(options, recoveryReceipt)
    startupSignal.throwIfAborted()
    const nonce = randomUUID()
    await writeFile(path.join(options.stateDir, OWNER_FILE), JSON.stringify({
      schema: 1, purpose: 'velmren-managed-broker', pid: process.pid, nonce,
      stateDir: options.stateDir, executable: recoveryReceipt?.executable ?? options.executable, startedAt: new Date().toISOString(),
      ...(recoveryReceipt ? { profileLoginRecovery: recoveryLineage(recoveryReceipt) } : {})
    }), { flag: 'wx', mode: 0o600, flush: true })
    ownerNonce = nonce
    startupSignal.throwIfAborted()
    const start = startBroker ?? (await import('./broker.mjs')).startBroker
    app = await start({ executable: options.executable, stateDir: options.stateDir, policy, port: 0,
      ...(profileLoginRecovery === undefined ? {} : { profileLoginRecovery, signal: startupSignal, beforeProfileLoginComplete: acceptStartup }) })
    // Recovery already crossed its receipt commit boundary after readiness/acceptance.
    if (!app.profileLoginRecovered) await acceptStartup()
    return { reused: false, ...app }
  } catch (error) {
    await app?.close()
    if (profileLoginRecovery !== undefined && ownerNonce) {
      const owner = await readManagedJson(path.join(options.stateDir, OWNER_FILE))
      // A failed recovery must not replace the original receipt's owner identity.
      if (owner?.pid === process.pid && owner.nonce === ownerNonce) await unlink(path.join(options.stateDir, OWNER_FILE))
    }
    throw error
  } finally {
    await release?.()
    process.off('disconnect', disconnected)
    process.off('message', message)
    if (ipc && process.connected) process.disconnect()
  }
}

export async function spawnManagedDaemon(options) {
  const args = [options.daemonScript, '--browser', options.executable, '--state-dir', options.stateDir, '--startup-timeout-ms', String(options.startupTimeoutMs)]
  if (options.policyFile) args.push('--policy', options.policyFile)
  const log = await open(path.join(options.stateDir, 'managed-broker.log'), 'a', 0o600)
  let child
  const outcome = { exited: false, failed: false, ready: false }
  let exited, disconnected
  const exit = new Promise(resolve => { exited = resolve })
  const settled = new Promise(resolve => { disconnected = resolve })
  try {
    child = spawn(options.nodeExecutable, args, { detached: true, windowsHide: true, stdio: ['ignore', 'ignore', log.fd, 'ipc'] })
    outcome.pid = child.pid
    child.on('error', () => { outcome.exited = true; outcome.failed = true; exited(); disconnected() })
    child.once('exit', code => { outcome.exited = true; outcome.failed = code !== 0; exited(); disconnected() })
    child.once('disconnect', disconnected)
    child.on('message', value => { if (value?.type === 'managed-startup-ready') outcome.ready = true })
    child.unref()
  } catch { outcome.exited = true; outcome.failed = true; exited(); disconnected() } finally { await log.close() }
  outcome.accept = async () => {
    await new Promise((resolve, reject) => child.send({ type: 'managed-startup-accept' }, error => error ? reject(error) : resolve()))
    outcome.accepted = true
    await settled
    if (outcome.failed) fail('INITIALIZATION_FAILED', 'Managed browser initialization failed. Existing processes and saved state were preserved.')
  }
  outcome.cancel = async () => {
    if (outcome.accepted) return
    child?.ref()
    if (child?.connected) child.disconnect()
    await exit
  }
  return outcome
}

export async function connectManaged(options, { spawnDaemon = spawnManagedDaemon, signal } = {}) {
  const deadline = Date.now() + options.startupTimeoutMs
  const { identity } = await requestedPolicy(options)
  let descriptor, outcome, connection, release
  const cancelled = () => { void outcome?.cancel() }
  signal?.addEventListener('abort', cancelled, { once: true })
  try {
    signal?.throwIfAborted()
    release = await acquireStartupGate(options.stateDir, Math.max(1, deadline - Date.now()), signal)
    descriptor = await readManagedDescriptor(options.stateDir)
    if (!await healthy(descriptor, identity)) {
      await assertNoManualProfileSession(options.stateDir)
      await release(); release = null
      signal?.throwIfAborted()
      outcome = await spawnDaemon(options)
      signal?.throwIfAborted()
      for (;;) {
        signal?.throwIfAborted()
        descriptor = await readManagedDescriptor(options.stateDir)
        if (outcome.ready && descriptor?.pid === outcome.pid && await healthy(descriptor, identity)) break
        if (outcome.exited) {
          release = await acquireStartupGate(options.stateDir, Math.max(1, deadline - Date.now()), signal)
          descriptor = await readManagedDescriptor(options.stateDir)
          if (await healthy(descriptor, identity)) break
          await release(); release = null
          if (outcome.failed) fail('INITIALIZATION_FAILED', 'Managed browser initialization failed. Existing processes and saved state were preserved.')
        }
        if (Date.now() >= deadline) fail('STARTUP_TIMEOUT', 'Timed out starting the managed browser. Existing processes were left running.')
        await pause(100)
      }
    }
    signal?.throwIfAborted()
    // Registration is performed once. Only this scoped credential reaches MCP tools.
    const registered = await adminRpc(descriptor, 'client_register', { label: options.label ?? 'Codex', policyIdentity: identity, leaseMs: MANAGED_LEASE_MS }, 5000)
    if (typeof registered?.clientId !== 'string' || !registered.clientId || registered.clientId === 'admin' || typeof registered.token !== 'string' || registered.token.length < 16 || /[\r\n]/.test(registered.token) || registered.token === descriptor.adminToken || registered.leaseMs !== MANAGED_LEASE_MS) fail('INVALID_REGISTRATION', 'The broker returned an invalid scoped client credential or lease.')
    connection = { endpoint: descriptor.endpoint, client: registered.clientId, token: registered.token, leaseMs: registered.leaseMs }
    signal?.throwIfAborted()
    if (outcome?.ready && !outcome.exited) await outcome.accept()
    signal?.throwIfAborted()
    return connection
  } catch (error) {
    if (connection) await releaseManagedConnection(connection).catch(() => {})
    await outcome?.cancel()
    throw error
  } finally {
    signal?.removeEventListener('abort', cancelled)
    await release?.()
  }
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

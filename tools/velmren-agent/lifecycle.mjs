import { appendFileSync, existsSync, renameSync, statSync } from 'node:fs'
import path from 'node:path'
import { sanitizePublicError } from './privacy.mjs'

const events = new Set(['process-start', 'process-fatal', 'process-exit', 'process-signal', 'process-start-failed', 'shutdown-deferred', 'broker-start-failed', 'broker-ready', 'broker-close', 'browser-exit', 'child-process-exit', 'previous-process-unavailable', 'client-reconnected', 'client-released', 'lease-heartbeat-failed'])
const phases = new Set(['startup', 'runtime', 'exit', 'recovery', 'ready', 'shutdown', 'browser', 'daemon', 'lease', 'heartbeat'])
const signals = new Set(['SIGINT', 'SIGTERM', 'SIGKILL', 'SIGABRT', 'SIGSEGV', 'SIGHUP', 'SIGQUIT', 'SIGBREAK'])
const reasons = new Set(['event_loop_empty', 'uncaught_exception', 'unknown', 'startup_failed', 'exit_cause_unknown', 'explicit_close', 'explicit_release', 'browser_closed', 'idle_retirement', 'admin_shutdown', ...signals])
const codes = new Set(['UNCAUGHT_EXCEPTION', 'ERR_UNHANDLED_REJECTION', 'EPIPE', 'ECONNRESET', 'ECONNREFUSED', 'ENOENT', 'EACCES', 'EBUSY', 'ENOMEM', 'INVALID_OPTIONS', 'INSTALLATION_UNAVAILABLE', 'INVALID_INSTALLATION', 'STATE_UNAVAILABLE', 'BROKER_UNAVAILABLE', 'BROKER_REJECTED', 'INVALID_POLICY', 'BROKER_UNHEALTHY', 'STARTUP_LOCK_FAILED', 'STARTUP_TIMEOUT', 'BROKER_STILL_RUNNING', 'UNOWNED_STATE', 'OWNERSHIP_MISMATCH', 'RECOVERY_FAILED', 'STARTUP_CANCELLED', 'INITIALIZATION_FAILED', 'INVALID_REGISTRATION', 'LEASE_REJECTED', 'LEASE_UNAVAILABLE', 'BROWSER_UNAVAILABLE', 'RUNTIME_UNAVAILABLE'])
const safeCode = code => codes.has(code) ? code : sanitizePublicError({ code }).code
export function lifecycle(stateDir, event, values = {}) {
  if (!events.has(event)) return
  const record = { timestamp: new Date().toISOString(), event, pid: process.pid }
  for (const [key, allowed] of [['phase', phases], ['signal', signals], ['reason', reasons]]) if (allowed.has(values[key])) record[key] = values[key]
  if (values.code !== undefined) record.code = safeCode(values.code)
  for (const key of ['childPid', 'exitCode', 'previousPid']) if (Number.isSafeInteger(values[key])) record[key] = values[key]
  try {
    const file = path.join(stateDir, 'lifecycle.jsonl')
    if (existsSync(file) && statSync(file).size > 1024 * 1024) renameSync(file, `${file}.1`)
    appendFileSync(file, JSON.stringify(record) + '\n', { mode: 0o600, flush: true })
  } catch { /* Diagnostics must never terminate the broker. */ }
}

export function installLifecycle(stateDir) {
  let reason = 'event_loop_empty'
  const fatal = error => { reason = 'uncaught_exception'; lifecycle(stateDir, 'process-fatal', { phase: 'runtime', code: error?.code ?? 'UNCAUGHT_EXCEPTION' }) }
  const exit = exitCode => lifecycle(stateDir, 'process-exit', { phase: 'exit', reason, exitCode })
  process.on('uncaughtExceptionMonitor', fatal)
  process.on('exit', exit)
  lifecycle(stateDir, 'process-start', { phase: 'startup' })
  return { reason(value) { reason = reasons.has(value) ? value : 'unknown' }, dispose() { process.off('uncaughtExceptionMonitor', fatal); process.off('exit', exit) } }
}

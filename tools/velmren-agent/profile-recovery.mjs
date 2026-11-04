import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { ManualProfileError } from './manual-profile.mjs'
import { diagnostic, ManagedError, parseManagedOptions, resolveManagedOptions, runManagedBroker } from './managed-runtime.mjs'

const usage = 'Usage: profile-recovery.mjs --login-id ID --user-confirmed true (--install-root DIR | --browser EXE --state-dir DIR) [--policy JSON] [--startup-timeout-ms MS]\n'

export function parseProfileRecoveryOptions(argv) {
  const managed = [], recovery = {}
  for (let i = 0; i < argv.length; i++) {
    const name = { '--login-id': 'loginId', '--user-confirmed': 'userConfirmed' }[argv[i]]
    if (!name) { managed.push(argv[i]); continue }
    if (Object.hasOwn(recovery, name)) throw new ManagedError('INVALID_OPTIONS', 'Recovery arguments must not be repeated.')
    const value = argv[++i]
    if (!value || value.startsWith('--')) throw new ManagedError('INVALID_OPTIONS', 'Recovery requires a login identity and explicit confirmation.')
    recovery[name] = value
  }
  const options = parseManagedOptions(managed)
  if (!options.help) {
    if (typeof recovery.loginId !== 'string' || !recovery.loginId || recovery.loginId.length > 256 || /[\x00-\x1f]/.test(recovery.loginId)) throw new ManagedError('INVALID_OPTIONS', 'Recovery requires a valid login identity.')
    if (recovery.userConfirmed !== 'true') throw new ManagedError('USER_CONFIRMATION_REQUIRED', 'Pass --user-confirmed true only after the manual browser has been closed.')
  }
  return { options, profileLoginRecovery: { loginId: recovery.loginId, userConfirmed: recovery.userConfirmed === 'true' } }
}

export async function main(argv = process.argv.slice(2)) {
  const parsed = parseProfileRecoveryOptions(argv)
  if (parsed.options.help) { process.stderr.write(usage); return }
  const options = await resolveManagedOptions(parsed.options)
  const startup = new AbortController()
  const watchdog = setTimeout(() => startup.abort(new ManagedError('STARTUP_TIMEOUT', 'Manual sign-in recovery startup timed out.')), options.startupTimeoutMs)
  try {
    const app = await runManagedBroker(options, { signal: startup.signal, profileLoginRecovery: parsed.profileLoginRecovery })
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => {
      try { await app.close(); process.exit(0) }
      catch (error) { process.stderr.write(recoveryDiagnostic(error)) }
    })
    process.stdout.write(`${JSON.stringify({ status: 'ready', profileLogin: app.broker.profileLoginView() })}\n`)
    return app
  } finally { clearTimeout(watchdog) }
}

function recoveryDiagnostic(error) {
  return error instanceof ManualProfileError ? `velmren-profile-recovery: ${error.code}: ${error.message}\n` : diagnostic(error)
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { process.stderr.write(recoveryDiagnostic(error)); process.exit(1) })
}

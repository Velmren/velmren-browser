import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { diagnostic, ManagedError, parseManagedOptions, resolveManagedOptions, runManagedBroker } from './managed-runtime.mjs'
import { installLifecycle, lifecycle } from './lifecycle.mjs'

export async function main(argv = process.argv.slice(2)) {
  const options = await resolveManagedOptions(parseManagedOptions(argv))
  const journal = installLifecycle(options.stateDir)
  const startup = new AbortController()
  const watchdog = setTimeout(() => {
    startup.abort(new ManagedError('STARTUP_TIMEOUT', 'Managed broker startup timed out.'))
  }, options.startupTimeoutMs)
  try {
    const app = await runManagedBroker(options, { signal: startup.signal })
    if (!app.reused) {
      for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => {
        journal.reason(signal)
        lifecycle(options.stateDir,'process-signal',{phase:'shutdown',signal})
        try { await app.close(signal); process.exit(0) }
        catch (error) { lifecycle(options.stateDir,'shutdown-deferred',{phase:'shutdown',code:error.code}); process.stderr.write(diagnostic(error)) }
      })
    } else journal.dispose()
    return app
  } catch(error) {
    journal.reason('startup_failed')
    lifecycle(options.stateDir,'process-start-failed',{phase:'startup',code:error.code})
    throw error
  } finally { clearTimeout(watchdog) }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { process.stderr.write(diagnostic(error)); process.exit(1) })
}

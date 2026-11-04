import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { diagnostic, ManagedError, parseManagedOptions, resolveManagedOptions, runManagedBroker } from './managed-runtime.mjs'

export async function main(argv = process.argv.slice(2)) {
  const options = await resolveManagedOptions(parseManagedOptions(argv))
  const startup = new AbortController()
  const watchdog = setTimeout(() => {
    startup.abort(new ManagedError('STARTUP_TIMEOUT', 'Managed broker startup timed out.'))
  }, options.startupTimeoutMs)
  try {
    const app = await runManagedBroker(options, { signal: startup.signal })
    if (!app.reused) {
      for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => {
        try { await app.close() } finally { process.exit(0) }
      })
    }
    return app
  } finally { clearTimeout(watchdog) }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { process.stderr.write(diagnostic(error)); process.exit(1) })
}

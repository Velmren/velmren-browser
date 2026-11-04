import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { diagnostic, parseManagedOptions, resolveManagedOptions, runManagedBroker } from './managed-runtime.mjs'

export async function main(argv = process.argv.slice(2)) {
  const options = await resolveManagedOptions(parseManagedOptions(argv))
  const watchdog = setTimeout(() => {
    process.stderr.write('velmren-mcp: STARTUP_TIMEOUT: Managed broker startup timed out.\n')
    process.exit(1)
  }, options.startupTimeoutMs)
  try {
    const app = await runManagedBroker(options)
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

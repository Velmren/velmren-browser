import path from 'node:path'
import { writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { startManagedMcp } from '../../managed-mcp.mjs'
import { diagnostic, parseManagedOptions } from '../../managed-runtime.mjs'

try {
  const options = parseManagedOptions(process.argv.slice(2))
  options.daemonScript = path.join(path.dirname(fileURLToPath(import.meta.url)), 'managed-fake-broker.mjs')
  await writeFile(path.join(options.stateDir, 'fixture-mcp-starting'), '')
  await startManagedMcp(options)
} catch (error) { process.stderr.write(diagnostic(error)); process.exitCode = 1 }

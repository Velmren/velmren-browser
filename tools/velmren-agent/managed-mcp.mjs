import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { STDIO_DEFAULT_MAX_BUFFER_SIZE } from '@modelcontextprotocol/sdk/shared/stdio.js'
import { createClient } from './client.mjs'
import { createMcpServer } from './mcp.mjs'
import { connectManaged, diagnostic, maintainManagedLease, parseManagedOptions, releaseManagedConnection, resolveManagedOptions } from './managed-runtime.mjs'

export async function startManagedMcp(options) {
  const startup = new AbortController()
  const cancelStartup = () => startup.abort()
  process.stdin.once('end', cancelStartup)
  process.stdin.once('close', cancelStartup)
  if (process.stdin.readableEnded || process.stdin.destroyed) cancelStartup()
  // Buffer protocol bytes while observing EOF, including EOF after initialize.
  const buffered = []
  let bytes = 0
  const buffer = chunk => {
    bytes += chunk.length
    if (bytes > STDIO_DEFAULT_MAX_BUFFER_SIZE) { cancelStartup(); return }
    buffered.push(chunk)
  }
  process.stdin.on('data', buffer)
  let connection
  try { connection = await connectManaged(await resolveManagedOptions(options), { signal: startup.signal }) }
  catch (error) { if (!startup.signal.aborted) throw error; return }
  finally {
    process.stdin.off('end', cancelStartup)
    process.stdin.off('close', cancelStartup)
    process.stdin.pause()
    process.stdin.off('data', buffer)
  }
  if (startup.signal.aborted) {
    await releaseManagedConnection(connection).catch(() => {})
    return
  }
  for (const chunk of buffered.reverse()) process.stdin.unshift(chunk)
  const server = createMcpServer(createClient(connection))
  let closing
  const lease = maintainManagedLease(connection, error => {
    process.stderr.write(diagnostic(error))
    void close()
  })
  const close = () => closing ??= (async () => {
    process.stdin.off('end', close)
    process.stdin.off('close', close)
    await lease.release()
    await server.close()
  })()
  server.onclose = () => { void close() }
  process.stdin.once('end', close)
  process.stdin.once('close', close)
  try { await server.connect(new StdioServerTransport()); process.stdin.resume() }
  catch (error) { await close(); throw error }
  // Releasing a lease affects only its own tasks; peer connections stay alive.
  return server
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseManagedOptions(argv)
  if (options.help) {
    process.stderr.write('Usage: managed-mcp.mjs --install-root DIR [--state-dir DIR] [--policy JSON] [--label Codex]\n       managed-mcp.mjs --browser EXE --state-dir DIR [--policy JSON]\n')
    return
  }
  return startManagedMcp(options)
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { process.stderr.write(diagnostic(error)); process.exitCode = 1 })
}

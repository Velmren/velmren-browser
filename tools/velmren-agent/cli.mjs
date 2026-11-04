import { pathToFileURL } from 'node:url'
import { connectClient, dashboardUrl, METHODS, parseOptions } from './client.mjs'
import { sanitizeActionResult, sanitizeWaitResult } from './action-result.mjs'

export async function main(argv = process.argv.slice(2)) {
  const options = parseOptions(argv)
  if (options.help) {
    process.stdout.write(`Usage:\n  node cli.mjs --state-dir <directory> --client scripts <method> '<json>'\n  node cli.mjs --state-dir <directory> dashboard\n  node cli.mjs --state-dir <directory> --client codex mcp\n\nMethods: ${METHODS.join(', ')}\nDashboard prints a private admin link. Do not share it.\n`)
    return
  }
  const [method, json, ...extra] = options.positional
  if (!method || extra.length) throw new Error('Expected one method and optional JSON object; use --help')
  if (method === 'dashboard') {
    if (json) throw new Error('dashboard accepts no JSON arguments')
    process.stdout.write(`${await dashboardUrl(options.stateDir)}\n`)
    return
  }
  if (method === 'mcp') {
    if (json) throw new Error('mcp accepts no JSON arguments')
    const { startMcp } = await import('./mcp.mjs')
    return startMcp(options)
  }
  let args
  try { args = json === undefined ? {} : JSON.parse(json) } catch { throw new Error('Arguments must be a valid JSON object') }
  const result = await (await connectClient(options.stateDir, options.client)).call(method, args)
  process.stdout.write(`${JSON.stringify({ ok: true, result }, null, 2)}\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    const actionResult = sanitizeActionResult(error.actionResult), waitResult = sanitizeWaitResult(error.waitResult)
    process.stderr.write(`${JSON.stringify({ ok: false, error: error.message, code: error.code ?? 'CLI_ERROR', ...(actionResult ? { actionResult } : {}), ...(waitResult ? { waitResult } : {}) })}\n`)
    process.exitCode = 1
  })
}

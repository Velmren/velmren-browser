// node test/vbr014-privacy-integration.mjs BROWSER_EXE NEW_OUTPUT_DIR [--agent-directory=DIR]
// Fresh headless profile, local fixtures and synthetic URL markers only.
import { createServer } from 'node:http'
import { mkdir, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const args = process.argv.slice(2), positional = args.filter(value => !value.startsWith('--'))
if (positional.length !== 2 || args.some(value => value.startsWith('--') && !value.startsWith('--agent-directory='))) throw new Error('Expected browser, fresh output directory and optional agent directory')
const directory = path.resolve(args.find(value => value.startsWith('--agent-directory='))?.slice(18) ?? fileURLToPath(new URL('../', import.meta.url)))
const output = path.resolve(positional[1]), stateDir = path.join(output, 'state')
await mkdir(path.dirname(output), { recursive: true }); await mkdir(output)
const marker = 'VBR014_SYNTHETIC_URL_CANARY'
const url = `https://synthetic-user:${marker}@identity.example.test:8443/oauth/${marker}?client_id=${marker}&state=${marker}&code=${marker}#${marker}`
const encoded = encodeURIComponent(encodeURIComponent(url)), publicOrigin = 'https://identity.example.test:8443'
const escapeHtml = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;')
const html = `<!doctype html><title>Continue ${escapeHtml(url)}</title><h1>Continue ${escapeHtml(url)}</h1><p>${escapeHtml(encoded)}</p><p>callback_${escapeHtml(url)}</p><p>callback_${escapeHtml(encoded)}</p><label for="name">${escapeHtml(url)}</label><input id="name" title="${escapeHtml(encoded)}"><button>Done</button>`
const ensure = (condition, code) => { if (!condition) throw Object.assign(new Error('Privacy acceptance failed'), { code }) }
const clean = value => ensure(!JSON.stringify(value).includes(marker), 'PUBLIC_URL_CANARY_LEAK')
const hash = data => createHash('sha256').update(Buffer.from(data, 'base64')).digest('hex')
const report = { passed: false, cases: [], images: [], cleanup: {} }, tasks = [], captures = []
let app, server, client, registration, stage = 'startup'
const record = name => { report.cases.push({ name, passed: true }); console.log(`PASS ${name}`) }
const mcp = async (method, values = {}, isError = false) => {
  const result = await client.callTool({ name: `velmren_${method}`, arguments: values }, undefined, { timeout: 40000 })
  clean(result); ensure(Boolean(result.isError) === isError, 'MCP_ERROR_STATE_MISMATCH')
  return result.content[0].type === 'image' ? result.content[0] : JSON.parse(result.content[0].text)
}
const http = async (method, values = {}, isError = false) => {
  const response = await fetch(`${app.descriptor.endpoint}/rpc`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${registration.token}` }, body: JSON.stringify({ method, args: values }), signal: AbortSignal.timeout(40000) })
  const envelope = await response.json(); clean(envelope)
  ensure(!envelope.ok === isError, 'HTTP_ERROR_STATE_MISMATCH')
  return envelope.ok ? envelope.result : envelope
}
const cli = async (method, values = {}) => {
  const result = await promisify(execFile)(process.execPath, [path.join(directory, 'cli.mjs'), '--state-dir', stateDir, '--client', 'scripts', method, JSON.stringify(values)], { windowsHide: true, timeout: 45000, maxBuffer: 4 * 1024 * 1024 })
  clean(result.stdout); clean(result.stderr)
  const envelope = JSON.parse(result.stdout); ensure(envelope.ok, 'CLI_ERROR_STATE_MISMATCH'); return envelope.result
}
const checkImage = (image, channel, before) => {
  ensure(captures.length === before + 1, 'NATIVE_SCREENSHOT_COUNT')
  ensure(image.mimeType === 'image/png' && typeof image.data === 'string', 'PNG_IMAGE_MISSING')
  ensure(Buffer.from(image.data, 'base64').toString('base64') === image.data, 'PNG_BASE64_CHANGED')
  ensure(hash(image.data) === captures.at(-1).sha256, 'PNG_BYTES_CHANGED')
  report.images.push({ channel, ...captures.at(-1), unchanged: true })
}

try {
  server = createServer((request, response) => { response.writeHead(200, { 'content-type': 'text/html' }); response.end(html) })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  const { startBroker } = await import(pathToFileURL(path.join(directory, 'broker.mjs')))
  app = await startBroker({ executable: path.resolve(positional[0]), stateDir, policy: { profileMode: 'isolated', allowedOrigins: [origin], webCompatibility: true }, browserArgs: ['--headless=new'] })
  const send = app.broker.browser.send.bind(app.broker.browser)
  app.broker.browser.send = async (...values) => {
    const result = await send(...values)
    if (values[0] === 'Page.captureScreenshot') captures.push({ sha256: hash(result.data), byteLength: Buffer.from(result.data, 'base64').length, containsDoubleSlash: result.data.includes('//') })
    return result
  }
  registration = await app.broker.rpc('admin', 'client_register', { label: 'VBR-014 privacy acceptance' })
  const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('./multi-agent-mcp-entry.mjs', import.meta.url)), directory], env: { VELMREN_ACCEPTANCE_CONNECTION: JSON.stringify({ endpoint: app.descriptor.endpoint, token: registration.token, client: registration.clientId }) }, stderr: 'pipe' })
  transport.stderr?.resume(); client = new Client({ name: 'vbr014-privacy', version: '1' }); await client.connect(transport)

  stage = 'public-string-fields'
  const task = await mcp('create_task', { url: `${origin}/oauth/${marker}?state=${marker}#${marker}` }); tasks.push(task.taskId)
  let observation = await mcp('observe', { taskId: task.taskId })
  ensure(observation.pages[0].title === `Continue ${publicOrigin}`, 'TITLE_NOT_ORIGIN_ONLY')
  ensure(observation.text.includes(publicOrigin) && !observation.text.includes('oauth'), 'TEXT_NOT_ORIGIN_ONLY')
  ensure(observation.text.includes(`callback_${publicOrigin}`), 'EMBEDDED_URL_NOT_ORIGIN_ONLY')
  await mcp('list_tasks'); await http('task_list'); await http('task_observe', { taskId: task.taskId })
  const cliTask = await cli('task_create', { url: `${origin}/oauth/${marker}?state=${marker}` }); tasks.push(cliTask.taskId)
  await cli('task_observe', { taskId: cliTask.taskId }); await cli('task_list')
  record('Native titles, text and form metadata expose only origins through MCP, HTTP and CLI')

  stage = 'nested-metadata'
  const page = app.broker.page(app.broker.tasks.get(task.taskId)), originalObserve = page.observe.bind(page)
  page.observe = async (...values) => ({ ...await originalObserve(...values), metadata: { [encoded]: [{ title: url, annotation: encoded }] } })
  observation = await mcp('observe', { taskId: task.taskId })
  ensure(observation.metadata[publicOrigin][0].title === publicOrigin, 'NESTED_METADATA_NOT_ORIGIN_ONLY')
  await http('task_observe', { taskId: task.taskId })
  page.observe = originalObserve
  record('Nested page metadata values and keys are projected at the runtime boundary')

  stage = 'error-envelopes'
  page.observe = async () => { throw Object.assign(new Error(url), { code: 'NAVIGATION_FAILED', diagnostic: { reason: 'navigation', phase: 'navigate', networkError: 'ERR_CONNECTION_REFUSED', extra: encoded } }) }
  for (const result of [await mcp('observe', { taskId: task.taskId }, true), await http('task_observe', { taskId: task.taskId }, true)]) {
    ensure(result.code === 'NAVIGATION_FAILED' && result.diagnostic?.reason === 'navigation', 'SAFE_DIAGNOSTIC_MISSING')
  }
  page.observe = originalObserve
  record('Error envelopes preserve safe categories and omit URL-bearing exception content')

  stage = 'png-roundtrip'
  let before = captures.length
  checkImage(await mcp('screenshot', { taskId: task.taskId }), 'MCP', before)
  before = captures.length
  checkImage(await http('task_screenshot', { taskId: task.taskId }), 'HTTP', before)
  before = captures.length
  checkImage(await cli('task_screenshot', { taskId: cliTask.taskId }), 'CLI', before)
  ensure(report.images.every(image => image.containsDoubleSlash), 'PNG_DOUBLE_SLASH_COVERAGE_MISSING')
  record('Native PNG bytes remain identical through MCP, HTTP and CLI including double-slash base64')

  stage = 'sensitive-projection'
  const sensitive = await mcp('create_task', { url: `${origin}/protected`, sensitive: true }); tasks.push(sensitive.taskId)
  const protectedView = await mcp('observe', { taskId: sensitive.taskId })
  ensure(protectedView.pages.every(page => page.title === undefined), 'SENSITIVE_TITLE_NOT_SUPPRESSED')
  before = captures.length
  const blocked = await mcp('screenshot', { taskId: sensitive.taskId }, true)
  ensure(blocked.code === 'SENSITIVE_SCREENSHOT_BLOCKED' && captures.length === before, 'SENSITIVE_IMAGE_NOT_BLOCKED')
  record('Sensitive titles and screenshots remain suppressed before native capture')
  report.passed = true
} catch (error) {
  report.failure = { stage, code: /^[A-Z][A-Z_]{2,80}$/.test(error?.code ?? '') ? error.code : 'UNEXPECTED_FAILURE' }
  process.exitCode = 1
} finally {
  let cleanup = true
  if (client) await client.close().catch(() => { cleanup = false })
  if (app) {
    for (const taskId of tasks) await app.broker.rpc('admin', 'task_cancel', { taskId }).catch(() => { cleanup = false })
    await app.close().catch(() => { cleanup = false })
    report.cleanup.browserClosed = app.broker.browser.closed
  }
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); report.cleanup.fixtureClosed = true }
  report.cleanup.passed = cleanup
  if (!cleanup) { report.passed = false; process.exitCode = 1 }
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report))
}

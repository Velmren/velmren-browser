// node test/sensitive-integration.mjs BROWSER_EXE NEW_OUTPUT_DIR [--agent-directory=DIR]
import { mkdir, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { startSensitiveFixture } from './sensitive-fixture.mjs'

const argv = process.argv.slice(2), positional = argv.filter(value => !value.startsWith('--'))
if (positional.length !== 2 || argv.some(value => value.startsWith('--') && !value.startsWith('--agent-directory='))) throw new Error('Expected browser, fresh output directory and optional agent directory')
const directory = path.resolve(argv.find(value => value.startsWith('--agent-directory='))?.slice(18) ?? fileURLToPath(new URL('../', import.meta.url)))
const output = path.resolve(positional[1]), stateDir = path.join(output, 'state')
await mkdir(path.dirname(output), { recursive: true }); await mkdir(output)
const report = { passed: false, cases: [], cleanup: {} }, clients = [], tasks = [], nativePngReceipts = []
let fixture, app, stagePrivateInput, stage = 'startup', caseName = 'startup', captures = 0, deliveryProbe
const ensure = (condition, code = 'ASSERTION_FAILED') => { if (!condition) throw Object.assign(new Error('Acceptance condition failed'), { code }) }
const codeOf = error => /^[A-Z][A-Z_]{2,64}$/.test(error?.code ?? '') ? error.code : 'UNEXPECTED_FAILURE'
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
function verifyPngRoundtrip(result, previousCaptures) {
  ensure(nativePngReceipts.length === previousCaptures + 1, 'SCREENSHOT_NATIVE_CAPTURE_COUNT')
  ensure(result?.mimeType === 'image/png' && typeof result.data === 'string', 'SCREENSHOT_IMAGE_MISSING')
  const bytes = Buffer.from(result.data, 'base64'), native = nativePngReceipts.at(-1)
  ensure(bytes.toString('base64') === result.data, 'SCREENSHOT_INVALID_BASE64')
  ensure(bytes.length === native.byteLength && hash(bytes) === native.sha256, 'SCREENSHOT_BYTES_CHANGED_IN_TRANSPORT')
}
function clean(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  ensure(!fixture.probes.some(probe => text.includes(probe)), 'PUBLIC_CANARY_LEAK')
}
function originsOnly(value) {
  if (!value || typeof value !== 'object') return
  for (const [key, item] of Object.entries(value)) {
    if (/^(?:url|href|src|origin|topOrigin)$/i.test(key) && typeof item === 'string' && /^https?:/.test(item)) ensure(new URL(item).origin === item, 'URL_METADATA_NOT_ORIGIN_ONLY')
    if (item && typeof item === 'object') originsOnly(item)
  }
}
async function scenario(name, run) {
  stage = caseName = name
  try { await run(); report.cases.push({ name, passed: true }); console.log(`PASS ${name}`) }
  catch (error) { const code = codeOf(error); report.cases.push({ name, passed: false, stage, code }); console.log(`FAIL ${name} ${code}`) }
}
async function connect(label) {
  const registration = await app.broker.rpc('admin', 'client_register', { label })
  const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('./multi-agent-mcp-entry.mjs', import.meta.url)), directory], env: { VELMREN_ACCEPTANCE_CONNECTION: JSON.stringify({ endpoint: app.descriptor.endpoint, token: registration.token, client: registration.clientId }) }, stderr: 'pipe' })
  transport.stderr?.resume()
  const client = new Client({ name: label, version: '1' }); clients.push(client); await client.connect(transport)
  return { client, registration }
}
async function call(owner, method, args = {}, expectedError = false) {
  stage = `${caseName}:mcp_${method}`
  const envelope = await owner.client.callTool({ name: `velmren_${method}`, arguments: args }, undefined, { timeout: 40000 })
  clean(envelope)
  const result = JSON.parse(envelope.content.find(item => item.type === 'text').text)
  originsOnly(result)
  if (expectedError !== null) ensure(Boolean(envelope.isError) === expectedError, result.code ?? 'UNEXPECTED_RPC_RESULT')
  return result
}
async function httpCall(owner, method, args = {}, expectedError = false) {
  stage = `${caseName}:http_${method}`
  const response = await fetch(`${app.descriptor.endpoint}/rpc`, { method: 'POST', headers: { authorization: `Bearer ${owner.registration.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ method, args }) })
  const text = await response.text(); clean(text)
  const envelope = JSON.parse(text); originsOnly(envelope)
  ensure(!envelope.ok === expectedError, envelope.code ?? 'UNEXPECTED_HTTP_RESULT')
  return envelope.ok ? envelope.result : envelope
}
async function cli(method, args = {}, expectedError = false) {
  stage = `${caseName}:cli_${method}`
  let result
  try { result = await promisify(execFile)(process.execPath, [path.join(directory, 'cli.mjs'), '--state-dir', stateDir, '--client', 'scripts', method, JSON.stringify(args)], { windowsHide: true, timeout: 45000, maxBuffer: 1024 * 1024 }) }
  catch (error) { result = error }
  clean(result.stdout ?? ''); clean(result.stderr ?? '')
  ensure(Boolean(result.code) === expectedError, 'UNEXPECTED_CLI_RESULT')
  const envelope = JSON.parse(result.stdout || result.stderr); originsOnly(envelope)
  return envelope.ok ? envelope.result : envelope
}
async function create(owner, { sensitive = false, route = '/form', label = 'Synthetic privacy acceptance' } = {}) {
  const task = await call(owner, 'create_task', { url: `${fixture.origin}${route}/${fixture.urlMarker}?code=${fixture.urlMarker}#${fixture.urlMarker}`, sensitive, label })
  tasks.push({ owner, taskId: task.taskId }); return task
}
const local = task => app.broker.page(app.broker.tasks.get(task.taskId))
const privacy = value => value.privacy ?? value.observation?.privacy
const observation = value => value.observation ?? value
const element = (value, predicate) => { const found = observation(value).elements.find(predicate); ensure(found, 'EXPECTED_CONTROL_MISSING'); return found }
const field = (value, name) => element(value, el => el.tag === 'input' && el.name === name)
const attrs = (task, value, ref, frameId) => ({ taskId: task.taskId, ...(frameId ? { frameId } : {}), observationId: observation(value).observationId, ref })
async function evaluateBoolean(page, expression) {
  const result = await page.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); ensure(!result.exceptionDetails, 'FIXTURE_EVALUATION_FAILED'); ensure(result.result?.value === true, 'FIXTURE_BOOLEAN_MISMATCH')
}
async function mutate(page, expression) { await page.send('Runtime.evaluate', { expression: `(()=>{${expression};return true})()`, returnByValue: true }) }
async function fill(owner, task, value, ref, options, frameId) {
  const { ref: target, ...binding } = attrs(task, value, ref, frameId)
  return call(owner, 'act', { ...binding, actions: [{ type: 'fill', ref: target, ...options }] })
}
async function privateStage(task, value, ref, { frameId, origin = fixture.origin, topOrigin = fixture.origin, readSecret = async () => fixture.secret } = {}) {
  stage = `${caseName}:private_prepare`
  return stagePrivateInput({ stateDir, ...attrs(task, value, ref, frameId), origin, topOrigin, readSecret })
}
const endArgs = (task, value, overrides = {}) => ({ taskId: task.taskId, action: 'end', phaseId: privacy(value).phaseId, documentId: privacy(value).documentId, expectedOrigin: fixture.origin, safeToReveal: true, ...overrides })

try {
  fixture = await startSensitiveFixture()
  const { startBroker } = await import(pathToFileURL(path.join(directory, 'broker.mjs')))
  ;({ stagePrivateInput } = await import(pathToFileURL(path.join(directory, 'private-input.mjs'))))
  app = await startBroker({ executable: path.resolve(positional[0]), stateDir, policy: { profileMode: 'persistent', allowedOrigins: [fixture.origin, fixture.crossOrigin], webCompatibility: true, maxTasks: 16 }, browserArgs: ['--headless=new', '--site-per-process'] })
  report.browserPid = app.broker.browser.process.pid
  const send = app.broker.browser.send.bind(app.broker.browser)
  app.broker.browser.send = (method, ...args) => {
    if (method === 'Page.captureScreenshot') captures++
    deliveryProbe?.(method, args[0])
    const pending = send(method, ...args)
    if (method !== 'Page.captureScreenshot') return pending
    return pending.then(result => {
      ensure(typeof result?.data === 'string', 'NATIVE_SCREENSHOT_DATA_MISSING')
      const bytes = Buffer.from(result.data, 'base64')
      nativePngReceipts.push({ sha256: hash(bytes), byteLength: bytes.length, containsDoubleSlash: result.data.includes('//') })
      return result
    })
  }
  const a = await connect('Sensitive acceptance A'), b = await connect('Sensitive acceptance B')

  await scenario('mcp_catalog_has_explicit_phase_and_no_private_input_tool', async () => {
    const catalog = await a.client.listTools(); ensure(catalog.tools.length === 22, 'WRONG_TOOL_COUNT')
    ensure(catalog.tools.some(tool => tool.name === 'velmren_sensitive'), 'PHASE_TOOL_MISSING')
    ensure(!catalog.tools.some(tool => /private_input/.test(tool.name)), 'PRIVATE_INPUT_EXPOSED')
  })

  await scenario('public_url_metadata_is_origin_only_across_lifecycle_and_frames', async () => {
    const task = await create(a)
    ensure(task.url === fixture.origin, 'CREATE_URL_NOT_ORIGIN')
    await call(a, 'list_tasks'); await call(a, 'list_pages', { taskId: task.taskId })
    const frames = await call(a, 'list_frames', { taskId: task.taskId }); ensure(frames.frames.length === 3, 'FIXTURE_FRAMES_MISSING')
    await httpCall(a, 'task_list')
    await call(a, 'finish', { taskId: task.taskId }); await call(a, 'list_tasks')
    const cancel = await create(a); await call(a, 'cancel', { taskId: cancel.taskId })
  })

  await scenario('automatic_password_phase_blocks_all_echoes_and_capture_before_dispatch', async () => {
    const task = await create(a), value = task.observation, password = field(value, 'Password')
    const result = await fill(a, task, value, password.ref, { value: fixture.secret })
    ensure(privacy(result)?.active, 'PASSWORD_PHASE_NOT_ARMED')
    await evaluateBoolean(local(task), `document.querySelector('#password').value===window.fixtureSecret&&document.querySelector('#decoy').value===''&&document.title===window.fixtureSecret`)
    const protectedValue = await call(a, 'observe', { taskId: task.taskId })
    ensure(!protectedValue.text && !protectedValue.title && protectedValue.elements.every(el => !el.name && !el.value && !el.description), 'SENSITIVE_PAGE_TEXT_PRESENT')
    const select = element(protectedValue, el => el.tag === 'select')
    await call(a, 'list_options', { ...attrs(task, protectedValue, select.ref) })
    const frameList = await call(a, 'list_frames', { taskId: task.taskId })
    for (const frame of frameList.frames) {
      await call(a, 'observe', { taskId: task.taskId, frameId: frame.frameId })
      // Prove each renderer received the canary, so clean output is meaningful.
      const echoed = await local(task).frames.select(frame.frameId).evaluate(({ value, split }) =>
        document.title === value && document.querySelector('#helper').textContent.includes(value) &&
        (window === window.top || document.querySelector('#helper').textContent.includes(split)),
      { value: fixture.secret, split: [...fixture.digits].join(' ') })
      ensure(echoed === true, 'FRAME_ECHO_NOT_EXERCISED')
    }
    const before = captures
    const blocked = await call(a, 'screenshot', { taskId: task.taskId }, true)
    ensure(blocked.code === 'SENSITIVE_SCREENSHOT_BLOCKED' && captures === before, 'SCREENSHOT_DISPATCHED')
    await httpCall(a, 'task_observe', { taskId: task.taskId })
    await httpCall(a, 'task_screenshot', { taskId: task.taskId }, true)
    await call(a, 'act', { taskId: task.taskId, observationId: protectedValue.observationId, actions: [{ type: 'fill', ref: 'e99999', value: fixture.secret, sensitive: true }] }, true)
    // Wait may return a boolean match; its transport must still contain no text.
    await call(a, 'wait', { taskId: task.taskId, text: fixture.secret, timeoutMs: 500 })
    await call(a, 'list_tasks'); await call(a, 'finish', { taskId: task.taskId }); await call(a, 'list_tasks')
  })

  for (const kind of ['one_time_code', 'explicit_sensitive_text']) await scenario(`${kind}_automatically_arms_entire_task`, async () => {
    const task = await create(a), value = task.observation, target = field(value, kind === 'one_time_code' ? 'One-time code' : 'Private text')
    const result = await fill(a, task, value, target.ref, { value: fixture.secret, ...(kind === 'explicit_sensitive_text' ? { sensitive: true } : {}) })
    ensure(privacy(result)?.active, 'AUTOMATIC_PHASE_NOT_ARMED')
    await call(a, 'cancel', { taskId: task.taskId })
  })

  for (const [name, label, id] of [['section_otp', 'Section one-time code', 'section-otp'], ['textarea_otp', 'Multiline one-time code', 'textarea-otp']]) await scenario(`${name}_automatically_arms_entire_task`, async () => {
    const task = await create(a), value = task.observation
    const target = element(value, el => ['input', 'textarea'].includes(el.tag) && el.name === label)
    const result = await fill(a, task, value, target.ref, { value: fixture.secret })
    ensure(privacy(result)?.active, 'OTP_VARIANT_PHASE_NOT_ARMED')
    await evaluateBoolean(local(task), `document.getElementById(${JSON.stringify(id)}).value===window.fixtureSecret&&document.querySelector('#decoy').value===''`)
    await call(a, 'observe', { taskId: task.taskId })
    const before = captures
    await call(a, 'screenshot', { taskId: task.taskId }, true)
    ensure(captures === before, 'OTP_VARIANT_SCREENSHOT_DISPATCHED')
    await call(a, 'cancel', { taskId: task.taskId })
  })

  await scenario('ordinary_text_fill_remains_observable', async () => {
    const task = await create(a, { route: '/safe' }), value = task.observation, target = field(value, 'Full name')
    const result = await fill(a, task, value, target.ref, { value: 'Ordinary edited name' })
    ensure(!privacy(result)?.active && JSON.stringify(result).includes('Ordinary edited name'), 'ORDINARY_INPUT_SUPPRESSED')
    await evaluateBoolean(local(task), "document.querySelector('input').value==='Ordinary edited name'")
    await call(a, 'finish', { taskId: task.taskId })
  })

  await scenario('ordinary_png_bytes_survive_mcp_http_and_cli_roundtrips', async () => {
    const task = await create(a, { route: '/safe' })
    let before = nativePngReceipts.length
    stage = `${caseName}:mcp_screenshot`
    const envelope = await a.client.callTool({ name: 'velmren_screenshot', arguments: { taskId: task.taskId } }, undefined, { timeout: 40000 })
    clean(envelope); ensure(!envelope.isError, 'MCP_SCREENSHOT_FAILED')
    verifyPngRoundtrip(envelope.content.find(item => item.type === 'image'), before)
    before = nativePngReceipts.length
    const httpResult = await httpCall(a, 'task_screenshot', { taskId: task.taskId })
    verifyPngRoundtrip(httpResult, before)
    await call(a, 'finish', { taskId: task.taskId })
    const cliTask = await cli('task_create', { url: `${fixture.origin}/safe` })
    tasks.push({ cli: true, taskId: cliTask.taskId })
    before = nativePngReceipts.length
    const cliResult = await cli('task_screenshot', { taskId: cliTask.taskId })
    verifyPngRoundtrip(cliResult, before)
    const receipts = nativePngReceipts.slice(-3)
    const slashCaptures = receipts.filter(receipt => receipt.containsDoubleSlash).length
    ensure(slashCaptures > 0, 'PNG_URL_PATTERN_NOT_EXERCISED')
    report.pngTransport = { checkedCaptures: receipts.length, capturesContainingDoubleSlash: slashCaptures, allByteHashesMatched: true }
    await cli('task_finish', { taskId: cliTask.taskId })
  })

  for (const mode of ['focus-password', 'focus-otp', 'scroll-password']) await scenario(`late_${mode.replaceAll('-', '_')}_arms_before_delivery_or_rejects`, async () => {
    const task = await create(a, { route: `/late-${mode}` }), value = task.observation
    const target = field(value, 'Late private field'), page = local(task)
    ensure(target.type === 'text', 'LATE_FIELD_ALREADY_PRIVATE')
    let observedDispatch = false, unprotectedDispatch = false
    deliveryProbe = (method, params) => {
      const nativeFill = method === 'Input.insertText' && params?.text === fixture.secret
      const nodeFill = method === 'Runtime.evaluate' && params?.expression?.includes(fixture.secret) && /return \((?:async )?function (?:applyPrivateValue|applyFormValue)\b/.test(params.expression)
      if (nativeFill || nodeFill) {
        observedDispatch = true
        if (!app.broker.tasks.get(task.taskId).sensitive?.active) unprotectedDispatch = true
      }
    }
    let result
    try {
      result = await call(a, 'act', { taskId: task.taskId, observationId: value.observationId, actions: [{ type: 'fill', ref: target.ref, value: fixture.secret }] }, null)
    } finally { deliveryProbe = undefined }
    await evaluateBoolean(page, "window.fixtureLateTriggered===true")
    ensure(!unprotectedDispatch, 'LATE_INPUT_DISPATCHED_UNPROTECTED')
    const untouched = await page.evaluate(() => document.querySelector('#late').value === '' && document.querySelector('#decoy').value === '')
    if (!untouched) {
      ensure(observedDispatch && privacy(result)?.active, 'LATE_INPUT_PHASE_NOT_ARMED')
      await evaluateBoolean(page, "document.querySelector('#late').value===window.fixtureSecret&&document.querySelector('#decoy').value===''")
    } else ensure(Boolean(result.code) || result.actionResult?.delivery === 'not_delivered', 'LATE_INPUT_SILENTLY_SKIPPED')
    await call(a, 'observe', { taskId: task.taskId })
    await call(a, 'cancel', { taskId: task.taskId })
  })

  await scenario('private_callback_validates_origin_before_read_and_preserves_owner_capability', async () => {
    const task = await create(a), value = task.observation, password = field(value, 'Password')
    let reads = 0, rejected = false
    try { await privateStage(task, value, password.ref, { origin: fixture.crossOrigin, readSecret: async () => { reads++; return fixture.secret } }) } catch { rejected = true }
    ensure(rejected && reads === 0, 'CALLBACK_READ_BEFORE_VALIDATION')
    const staged = await privateStage(task, value, password.ref, { readSecret: async () => { reads++; return fixture.secret } })
    ensure(reads === 1 && /^vsi_[A-Za-z0-9_-]{43}$/.test(staged.secretRef), 'PRIVATE_REFERENCE_INVALID')
    const binding = attrs(task, value, password.ref), { ref, ...rest } = binding
    await call(b, 'act', { ...rest, actions: [{ type: 'fill', ref, secretRef: staged.secretRef }] }, true)
    const result = await call(a, 'act', { ...rest, actions: [{ type: 'fill', ref, secretRef: staged.secretRef }] })
    ensure(result.actionResult?.delivery === 'delivered_verified', 'PRIVATE_INPUT_NOT_VERIFIED')
    await evaluateBoolean(local(task), `document.querySelector('#password').value===window.fixtureSecret&&document.querySelector('#decoy').value===''`)
    await call(a, 'act', { ...rest, actions: [{ type: 'fill', ref, secretRef: staged.secretRef }] }, true)
    const fresh = await call(a, 'observe', { taskId: task.taskId }), current = element(fresh, el => el.type === 'password')
    const currentBinding = attrs(task, fresh, current.ref); delete currentBinding.ref
    await call(a, 'act', { ...currentBinding, actions: [{ type: 'fill', ref: current.ref, secretRef: staged.secretRef }] }, true)
    await call(a, 'cancel', { taskId: task.taskId })
  })

  await scenario('replaced_node_rejects_staging_before_callback_and_delivery_after_staging', async () => {
    const task = await create(a), initial = task.observation, password = field(initial, 'Password')
    await mutate(local(task), "document.querySelector('#password').replaceWith(document.querySelector('#password').cloneNode(true))")
    let reads = 0, rejected = false
    try { await privateStage(task, initial, password.ref, { readSecret: async () => { reads++; return fixture.secret } }) } catch { rejected = true }
    ensure(rejected && reads === 0, 'REPLACED_NODE_CALLBACK_READ')
    const fresh = await call(a, 'observe', { taskId: task.taskId }), next = field(fresh, 'Password')
    const staged = await privateStage(task, fresh, next.ref)
    await mutate(local(task), "document.querySelector('#password').replaceWith(document.querySelector('#password').cloneNode(true))")
    const binding = attrs(task, fresh, next.ref); delete binding.ref
    await call(a, 'act', { ...binding, actions: [{ type: 'fill', ref: next.ref, secretRef: staged.secretRef }] }, true)
    await evaluateBoolean(local(task), "document.querySelector('#password').value===''&&document.querySelector('#decoy').value===''")
    await call(a, 'cancel', { taskId: task.taskId })
  })

  await scenario('private_input_capability_is_bound_to_frame_and_full_document', async () => {
    const task = await create(a), frames = await call(a, 'list_frames', { taskId: task.taskId })
    const cross = frames.frames.find(frame => !frame.main && frame.url === fixture.crossOrigin); ensure(cross, 'CROSS_ORIGIN_FRAME_MISSING')
    const value = await call(a, 'observe', { taskId: task.taskId, frameId: cross.frameId }), target = field(value, 'Password')
    let reads = 0, rejected = false
    try { await privateStage(task, value, target.ref, { frameId: cross.frameId, origin: fixture.crossOrigin, topOrigin: fixture.crossOrigin, readSecret: async () => { reads++; return fixture.secret } }) } catch { rejected = true }
    ensure(rejected && reads === 0, 'TOP_ORIGIN_CALLBACK_READ')
    const staged = await privateStage(task, value, target.ref, { frameId: cross.frameId, origin: fixture.crossOrigin })
    const result = await fill(a, task, value, target.ref, { secretRef: staged.secretRef }, cross.frameId)
    ensure(result.actionResult?.delivery === 'delivered_verified', 'FRAME_PRIVATE_INPUT_NOT_VERIFIED')
    const delivered = await local(task).frames.select(cross.frameId).evaluate(value =>
      document.querySelector('#password').value === value && document.querySelector('#decoy').value === '', fixture.secret)
    ensure(delivered === true, 'FRAME_INPUT_REDIRECTED')
    await call(a, 'observe', { taskId: task.taskId })
    const newValue = await call(a, 'observe', { taskId: task.taskId, frameId: cross.frameId }), newTarget = element(newValue, el => el.type === 'password')
    const abandoned = await privateStage(task, newValue, newTarget.ref, { frameId: cross.frameId, origin: fixture.crossOrigin })
    await call(a, 'navigate', { taskId: task.taskId, url: `${fixture.origin}/safe` })
    const binding = attrs(task, newValue, newTarget.ref, cross.frameId); delete binding.ref
    await call(a, 'act', { ...binding, actions: [{ type: 'fill', ref: newTarget.ref, secretRef: abandoned.secretRef }] }, true)
    await evaluateBoolean(local(task), "document.body.innerText.includes('Authentication confirmed')&&!document.body.innerText.includes(window.fixtureSecret||'not-present')")
    await call(a, 'finish', { taskId: task.taskId })
  })

  await scenario('phase_survives_spa_full_navigation_popup_close_and_safe_transition', async () => {
    const task = await create(a), peer = await create(b, { route: '/safe' })
    const begun = await call(a, 'sensitive', { taskId: task.taskId, action: 'begin' })
    ensure(privacy(begun)?.active, 'EXPLICIT_PHASE_NOT_ARMED')
    await call(a, 'sensitive', endArgs(task, begun), true)
    await mutate(local(task), "history.pushState(null,'','/safe-spa');window.fixtureEcho(window.fixtureSecret)")
    const spa = await call(a, 'observe', { taskId: task.taskId }); ensure(privacy(spa).active && privacy(spa).documentId === privacy(begun).documentId, 'SPA_CLEARED_PHASE')
    await call(a, 'sensitive', endArgs(task, spa), true)
    const intermediate = await call(a, 'navigate', { taskId: task.taskId, url: `${fixture.origin}/activation/${fixture.urlMarker}` })
    ensure(privacy(intermediate).active && privacy(intermediate).phaseId === privacy(begun).phaseId && privacy(intermediate).documentId !== privacy(begun).documentId, 'NAVIGATION_CLEARED_PHASE')
    const rootId = local(task).pageId
    await mutate(local(task), "document.querySelector('#popup').click()")
    const waitUntil = Date.now() + 8000
    while (app.broker.pages(app.broker.tasks.get(task.taskId)).size < 2 && Date.now() < waitUntil) await new Promise(resolve => setTimeout(resolve, 50))
    const pages = await call(a, 'list_pages', { taskId: task.taskId }), popup = pages.pages.find(page => page.pageId !== rootId); ensure(popup, 'POPUP_MISSING')
    const before = captures
    await call(a, 'screenshot', { taskId: task.taskId, pageId: popup.pageId }, true)
    ensure(captures === before, 'POPUP_SCREENSHOT_DISPATCHED')
    await call(a, 'select_page', { taskId: task.taskId, pageId: rootId })
    const safe = await call(a, 'navigate', { taskId: task.taskId, url: `${fixture.origin}/safe` })
    await call(a, 'sensitive', endArgs(task, safe), true)
    await call(a, 'close_page', { taskId: task.taskId, pageId: popup.pageId })
    const afterClose = await call(a, 'observe', { taskId: task.taskId }); ensure(privacy(afterClose).active, 'POPUP_CLOSE_CLEARED_PHASE')
    await call(a, 'sensitive', endArgs(task, begun), true)
    await call(a, 'sensitive', endArgs(task, afterClose, { phaseId: '00000000-0000-4000-8000-000000000000' }), true)
    await call(a, 'sensitive', endArgs(task, afterClose, { expectedOrigin: fixture.crossOrigin }), true)
    const released = await call(a, 'sensitive', endArgs(task, afterClose))
    ensure(privacy(released)?.active === false, 'SAFE_RELEASE_FAILED')
    ensure(JSON.stringify(released).includes('Privacy acceptance User') && JSON.stringify(released).includes('Settings') && JSON.stringify(released).includes('Authentication confirmed'), 'NORMAL_CONTENT_NOT_RESTORED')
    const unaffected = await call(b, 'observe', { taskId: peer.taskId }); ensure(!privacy(unaffected)?.active && JSON.stringify(unaffected).includes('Privacy acceptance User'), 'PEER_TASK_SUPPRESSED')
    const list = await call(a, 'list_tasks'); ensure(!list.tasks.find(item => item.taskId === task.taskId)?.label, 'HISTORICAL_LABEL_RESTORED')
    await call(a, 'finish', { taskId: task.taskId }); await call(a, 'list_tasks'); await call(b, 'finish', { taskId: peer.taskId })
  })

  await scenario('sensitive_activation_and_dialog_envelopes_remain_clean', async () => {
    const task = await create(a, { sensitive: true, route: '/activation', label: fixture.secret })
    ensure(privacy(task)?.active, 'CREATE_PHASE_NOT_ARMED')
    const page = local(task)
    const evaluation = page.send('Runtime.evaluate', { expression: 'setTimeout(()=>document.querySelector("#dialog").click(),0);true', returnByValue: true })
    await evaluation
    const waitUntil = Date.now() + 8000
    while (!page.dialog && Date.now() < waitUntil) await new Promise(resolve => setTimeout(resolve, 50))
    ensure(page.dialog, 'DIALOG_MISSING')
    const dialog = await call(a, 'observe', { taskId: task.taskId }); ensure(dialog.dialog?.type === 'alert', 'DIALOG_ENVELOPE_MISSING')
    await httpCall(a, 'task_observe', { taskId: task.taskId })
    const retained = await call(a, 'sensitive', endArgs(task, dialog), true)
    ensure(retained.code === 'SENSITIVE_DOCUMENTS_REMAIN', 'DIALOG_RELEASE_NOT_BLOCKED')
    await call(a, 'handle_dialog', { taskId: task.taskId, accept: true })
    await call(a, 'cancel', { taskId: task.taskId }); await call(a, 'list_tasks')
  })

  await scenario('sensitive_creation_requires_new_document_before_explicit_release', async () => {
    const task = await create(a, { sensitive: true, route: '/activation' })
    ensure(privacy(task)?.active && privacy(task).documentId, 'SENSITIVE_CREATION_BASELINE_MISSING')
    const initial = await call(a, 'sensitive', endArgs(task, task), true)
    ensure(initial.code === 'SENSITIVE_TRANSITION_REQUIRED', 'SENSITIVE_CREATION_INITIAL_DOCUMENT_RELEASED')
    await mutate(local(task), "history.pushState(null,'','/safe-spa')")
    const spa = await call(a, 'observe', { taskId: task.taskId })
    ensure(privacy(spa).active && privacy(spa).documentId === privacy(task).documentId, 'SENSITIVE_CREATION_SPA_CHANGED_BASELINE')
    const rejected = await call(a, 'sensitive', endArgs(task, spa), true)
    ensure(rejected.code === 'SENSITIVE_TRANSITION_REQUIRED', 'SENSITIVE_CREATION_SPA_RELEASED')
    const before = captures
    await call(a, 'screenshot', { taskId: task.taskId }, true)
    ensure(captures === before, 'SENSITIVE_CREATION_SCREENSHOT_DISPATCHED')
    const safe = await call(a, 'navigate', { taskId: task.taskId, url: `${fixture.origin}/safe` })
    ensure(privacy(safe).active && privacy(safe).documentId !== privacy(task).documentId, 'SENSITIVE_CREATION_SAFE_NAVIGATION_INVALID')
    const released = await call(a, 'sensitive', endArgs(task, safe))
    ensure(privacy(released)?.active === false && JSON.stringify(released).includes('Authentication confirmed'), 'SENSITIVE_CREATION_SAFE_RELEASE_FAILED')
    await call(a, 'finish', { taskId: task.taskId })
  })

  await scenario('new_sensitive_popup_requires_new_document_after_opener_closes', async () => {
    const task = await create(a, { sensitive: true, route: '/activation' }), rootId = local(task).pageId
    await mutate(local(task), "document.querySelector('#popup').click()")
    const waitUntil = Date.now() + 8000
    while (app.broker.pages(app.broker.tasks.get(task.taskId)).size < 2 && Date.now() < waitUntil) await new Promise(resolve => setTimeout(resolve, 50))
    const pages = await call(a, 'list_pages', { taskId: task.taskId }), popup = pages.pages.find(page => page.pageId !== rootId)
    ensure(popup, 'BASELINE_POPUP_MISSING')
    const selected = await call(a, 'select_page', { taskId: task.taskId, pageId: popup.pageId })
    ensure(privacy(selected)?.active && privacy(selected).documentId, 'POPUP_FIRST_OBSERVATION_BASELINE_MISSING')
    await call(a, 'close_page', { taskId: task.taskId, pageId: rootId })
    const remaining = await call(a, 'list_pages', { taskId: task.taskId })
    ensure(remaining.pages.length === 1 && remaining.selectedPageId === popup.pageId, 'POPUP_NOT_SOLE_SELECTED_PAGE')
    const rejected = await call(a, 'sensitive', endArgs(task, selected, { pageId: popup.pageId }), true)
    ensure(rejected.code === 'SENSITIVE_TRANSITION_REQUIRED', 'INITIAL_POPUP_DOCUMENT_RELEASED')
    const stillProtected = await call(a, 'observe', { taskId: task.taskId, pageId: popup.pageId })
    ensure(privacy(stillProtected).active && privacy(stillProtected).documentId === privacy(selected).documentId, 'POPUP_BASELINE_CHANGED_AFTER_OPENER_CLOSE')
    const safe = await call(a, 'navigate', { taskId: task.taskId, pageId: popup.pageId, url: `${fixture.origin}/safe` })
    ensure(privacy(safe).active && privacy(safe).documentId !== privacy(selected).documentId, 'POPUP_SAFE_NAVIGATION_INVALID')
    const released = await call(a, 'sensitive', endArgs(task, safe, { pageId: popup.pageId }))
    ensure(privacy(released)?.active === false && JSON.stringify(released).includes('Authentication confirmed'), 'POPUP_SAFE_RELEASE_FAILED')
    await call(a, 'finish', { taskId: task.taskId })
  })

  for (const fault of ['observe_failure', 'same_origin_document', 'cross_origin_document']) await scenario(`safe_release_${fault}_retains_protection`, async () => {
    const task = await create(a, { sensitive: true, route: '/activation' })
    const safe = await call(a, 'navigate', { taskId: task.taskId, url: `${fixture.origin}/safe` })
    const page = local(task), observe = page.observe
    let injected = false
    page.observe = async function (...args) {
      if (!injected) {
        injected = true
        if (fault === 'observe_failure') throw Object.assign(new Error(fixture.secret), { code: 'CDP_PROTOCOL_ERROR' })
        const destination = fault === 'cross_origin_document' ? fixture.crossOrigin : fixture.origin
        await this.navigate(`${destination}/activation/${fixture.urlMarker}`)
      }
      return observe.apply(this, args)
    }
    try { await call(a, 'sensitive', endArgs(task, safe), true) }
    finally { page.observe = observe }
    ensure(injected, 'SAFE_RELEASE_RACE_NOT_EXERCISED')
    ensure(app.broker.tasks.get(task.taskId).sensitive?.active, 'FAILED_RELEASE_CLEARED_PHASE')
    const retained = await call(a, 'observe', { taskId: task.taskId })
    ensure(privacy(retained)?.active, 'FAILED_RELEASE_OUTPUT_UNPROTECTED')
    const before = captures
    await call(a, 'screenshot', { taskId: task.taskId }, true)
    ensure(captures === before, 'FAILED_RELEASE_SCREENSHOT_DISPATCHED')
    await httpCall(a, 'task_observe', { taskId: task.taskId })
    await call(a, 'cancel', { taskId: task.taskId })
  })

  await scenario('cli_outputs_preserve_phase_and_origin_only_metadata', async () => {
    const task = await cli('task_create', { url: `${fixture.origin}/activation/${fixture.urlMarker}?token=${fixture.urlMarker}#${fixture.urlMarker}`, sensitive: true, label: fixture.secret })
    tasks.push({ cli: true, taskId: task.taskId }); ensure(privacy(task)?.active, 'CLI_PHASE_NOT_ARMED')
    await cli('task_observe', { taskId: task.taskId }); await cli('task_list'); await cli('task_list_frames', { taskId: task.taskId })
    const before = captures, blocked = await cli('task_screenshot', { taskId: task.taskId }, true)
    ensure(blocked.code === 'SENSITIVE_SCREENSHOT_BLOCKED' && captures === before, 'CLI_SCREENSHOT_DISPATCHED')
    await cli('task_cancel', { taskId: task.taskId }); await cli('task_list')
  })
} catch (error) {
  report.cases.push({ name: 'setup_or_harness', passed: false, stage, code: codeOf(error) })
  console.log(`FAIL setup_or_harness ${codeOf(error)}`)
} finally {
  let cleanup = true
  for (const task of tasks) {
    const current = app?.broker.tasks.get(task.taskId)
    if (current && !['completed', 'cancelled'].includes(current.state)) {
      try { if (task.cli) await cli('task_cancel', { taskId: task.taskId }); else await call(task.owner, 'cancel', { taskId: task.taskId }) } catch { cleanup = false }
    }
  }
  for (const client of clients) await client.close().catch(() => { cleanup = false })
  report.cleanup.clientsClosed = cleanup
  if (app) { await app.close().catch(() => { cleanup = false }); report.cleanup.browserClosed = app.broker.browser.closed }
  if (fixture) { await fixture.close().catch(() => { cleanup = false }); report.cleanup.fixtureClosed = true }
  report.passed = cleanup && report.cleanup.browserClosed === true && report.cases.length > 0 && report.cases.every(test => test.passed)
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2))
}
if (!report.passed) process.exitCode = 1

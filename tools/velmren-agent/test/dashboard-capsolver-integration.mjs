// node test/dashboard-capsolver-integration.mjs BROWSER_EXE NEW_OUTPUT_DIR [--agent-directory=DIR]
import { createHash, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const argv = process.argv.slice(2), positional = argv.filter(value => !value.startsWith('--'))
if (positional.length !== 2 || argv.some(value => value.startsWith('--') && !value.startsWith('--agent-directory='))) {
  throw new Error('Expected browser, fresh output directory and optional agent directory')
}
const directory = path.resolve(argv.find(value => value.startsWith('--agent-directory='))?.slice(18) ?? fileURLToPath(new URL('../', import.meta.url)))
const output = path.resolve(positional[1])
await mkdir(path.dirname(output), { recursive: true })
await mkdir(output)

const report = { passed: false, agentDirectory: directory, syntheticResponsesOnly: true, cases: [], cleanup: {} }
const marker = `synthetic-key-${randomUUID()}`, token = 'synthetic-capsolver-dashboard-token'
const counts = { status: 0, observe: 0, get: 0, save: 0, check: 0, remove_key: 0, keySaves: 0, blankSaves: 0, unexpected: 0 }
const outcomeTotals = { solutionsDelivered: 0, failed: 0, cancelled: 0, uncertain: 0 }
let statsAvailable = false
const fixtureTask = {
  taskId: 'synthetic-counter-task', state: 'agent-active', owner: 'Acceptance fixture', label: 'Synthetic CAPTCHA task',
  url: 'https://fixture.invalid', selectedPageId: 'synthetic-page',
  pages: [{ pageId: 'synthetic-page', title: 'Synthetic counter fixture', url: 'https://fixture.invalid' }]
}
const settings = {
  provider: 'capsolver', enabled: false, hasKey: false, storageAvailable: true,
  limits: { maxRequestsPerDay: 100, maxConcurrent: 2, maxAttemptsPerTask: 3 },
  usage: { requestsLast24Hours: 0, active: 0 }, verification: { status: 'unchecked' }
}
let browser, server, send, contextId, gate, stage = 'setup', failAction, checkInvalid = false
const heldRequests = new Set()
const ensure = (condition, code) => { if (!condition) throw Object.assign(new Error('Dashboard acceptance condition failed'), { code }) }
const codeOf = error => /^[A-Z][A-Z_]{2,64}$/.test(error?.code ?? '') ? error.code : 'UNEXPECTED_FAILURE'
const reply = (response, payload, status = 200) => {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  response.end(JSON.stringify(payload))
}

async function startFixture() {
  const assets = new Map(await Promise.all(['index.html', 'app.js', 'style.css'].map(async name => [name, await readFile(path.join(directory, 'public', name))])))
  report.assetSha256 = Object.fromEntries([...assets].map(([name, data]) => [name, createHash('sha256').update(data).digest('hex')]))
  server = createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url, 'http://127.0.0.1').pathname
      if (request.method === 'GET' && ['/', '/index.html', '/app.js', '/style.css'].includes(pathname)) {
        const name = pathname === '/' ? 'index.html' : pathname.slice(1)
        response.writeHead(200, { 'content-type': name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html', 'cache-control': 'no-store' })
        response.end(assets.get(name)); return
      }
      if (request.method !== 'POST' || pathname !== '/rpc') { response.writeHead(404); response.end(); return }
      ensure(request.headers.authorization === `Bearer ${token}`, 'FIXTURE_AUTH_MISMATCH')
      let body = ''
      for await (const chunk of request) body += chunk
      const { method, args } = JSON.parse(body)
      if (method === 'broker_status') {
        counts.status++
        reply(response, { ok: true, result: { tasks: [fixtureTask], maxTasks: 4, ...(statsAvailable ? { captchaStats: outcomeTotals } : {}) } }); return
      }
      if (method === 'task_observe') {
        ensure(args.taskId === fixtureTask.taskId, 'FIXTURE_TASK_MISMATCH'); counts.observe++
        reply(response, { ok: true, result: { taskId: fixtureTask.taskId, pageId: fixtureTask.selectedPageId, observationId: 'synthetic-observation', title: 'Synthetic counter fixture', text: 'Synthetic task page', elements: [], state: fixtureTask.state, url: fixtureTask.url } }); return
      }
      ensure(method === 'captcha_settings', 'UNEXPECTED_FIXTURE_METHOD')
      ensure(['get', 'save', 'check', 'remove_key'].includes(args.action), 'UNEXPECTED_FIXTURE_ACTION')
      counts[args.action]++
      if (args.action === 'save') {
        if (Object.hasOwn(args, 'key')) { ensure(args.key === marker, 'SYNTHETIC_KEY_MISMATCH'); counts.keySaves++ }
        else counts.blankSaves++
        ensure(typeof args.enabled === 'boolean', 'MISSING_EXPLICIT_ENABLE')
        for (const [name, max] of [['maxRequestsPerDay', 1000], ['maxConcurrent', 5], ['maxAttemptsPerTask', 10]]) {
          ensure(Number.isInteger(args[name]) && args[name] >= 1 && args[name] <= max, 'INVALID_LIMIT_SENT')
        }
      } else ensure(Object.keys(args).length === 1, 'UNEXPECTED_ACTION_ARGUMENTS')
      const failure = failAction === args.action
      if (failure) failAction = undefined
      else if (args.action === 'save') {
        settings.enabled = args.enabled
        settings.hasKey ||= Object.hasOwn(args, 'key')
        for (const name of Object.keys(settings.limits)) settings.limits[name] = args[name]
        if (Object.hasOwn(args, 'key')) settings.verification = { status: 'unchecked' }
      } else if (args.action === 'check') {
        ensure(settings.hasKey, 'CHECK_WITHOUT_SAVED_KEY')
        settings.verification = checkInvalid ? { status: 'error', checkedAt: '2026-11-04T12:00:00Z' }
          : { status: 'valid', balanceUsd: 12.5, checkedAt: '2026-11-04T12:00:00Z' }
        settings.usage = { requestsLast24Hours: 7, active: 1 }
      } else if (args.action === 'remove_key') {
        settings.enabled = false; settings.hasKey = false; settings.verification = { status: 'unchecked' }
      }
      // Deliberately include a synthetic key in untrusted error/extra fields.
      const payload = failure ? { ok: false, error: `Synthetic rejected value ${marker}` }
        : { ok: true, result: { ...structuredClone(settings), usage: { ...settings.usage, ...(statsAvailable ? outcomeTotals : {}) }, ignoredProviderMessage: marker } }
      if (gate?.action === args.action) {
        const held = gate; gate = undefined; heldRequests.add(held)
        held.release = () => { reply(response, payload, failure ? 403 : 200); heldRequests.delete(held) }
        clearTimeout(held.timer); held.resolve(); return
      }
      reply(response, payload, failure ? 403 : 200)
    } catch {
      counts.unexpected++
      reply(response, { ok: false, error: 'Synthetic fixture failure' }, 500)
    }
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  return `http://127.0.0.1:${server.address().port}`
}

function holdNext(action) {
  ensure(!gate, 'FIXTURE_GATE_ALREADY_PENDING')
  const held = { action }
  held.arrived = new Promise((resolve, reject) => {
    held.resolve = resolve
    held.timer = setTimeout(() => reject(Object.assign(new Error('Fixture request did not arrive'), { code: 'FIXTURE_REQUEST_TIMEOUT' })), 12000)
  })
  gate = held
  return held
}

async function evaluate(fn, args) {
  const result = await send('Runtime.evaluate', { contextId, expression: `(${fn.toString()})(${JSON.stringify(args) ?? ''})`, awaitPromise: true, returnByValue: true })
  ensure(!result.exceptionDetails, 'RENDERER_EVALUATION_FAILED')
  return result.result.value
}

async function waitFor(predicate, args) {
  const matched = await evaluate(({ source, args }) => new Promise(resolve => {
    const predicate = (0, eval)(`(${source})`)
    let observer, timer
    const finish = value => { clearTimeout(timer); observer?.disconnect(); resolve(value) }
    const check = () => { if (predicate(args)) finish(true) }
    observer = new MutationObserver(check)
    observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true })
    timer = setTimeout(() => finish(false), 12000)
    check()
  }), { source: predicate.toString(), args })
  ensure(matched, 'DOM_CONDITION_TIMEOUT')
}

async function click(selector) {
  const point = await evaluate(selector => {
    const node = document.querySelector(selector)
    if (!node || node.matches(':disabled') || node.hidden) return null
    node.scrollIntoView({ block: 'center' })
    const rect = node.getBoundingClientRect()
    return rect.width && rect.height ? { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 } : null
  }, selector)
  ensure(point, 'CONTROL_UNAVAILABLE')
  for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 })
}

async function key(key, code, windowsVirtualKeyCode) {
  for (const type of ['keyDown', 'keyUp']) await send('Input.dispatchKeyEvent', {
    type, key, code, windowsVirtualKeyCode,
    ...(type === 'keyDown' && (key === 'Enter' || key === ' ') ? { text: key === 'Enter' ? '\r' : ' ' } : {})
  })
}
async function focus(id) { await evaluate(id => document.getElementById(id).focus(), id) }
async function fill(id, value) {
  await evaluate(({ id }) => { const input = document.getElementById(id); input.focus(); input.select() }, { id })
  if (value === '') await key('Backspace', 'Backspace', 8)
  else await send('Input.insertText', { text: String(value) })
}
async function idle() { await waitFor(() => document.getElementById('captcha-form').getAttribute('aria-busy') === 'false') }
async function reopenSettings() {
  await click('#captcha-settings-heading'); await waitFor(() => !document.getElementById('captcha-settings').open)
  const held = holdNext('get')
  await click('#captcha-settings-heading'); await held.arrived; held.release(); await idle()
}
async function requireNoKey() {
  const safe = await evaluate(marker => ({
    empty: document.getElementById('captcha-key').value === '',
    absent: !document.documentElement.outerHTML.includes(marker) && ![...document.querySelectorAll('input,textarea')].some(node => node.value.includes(marker)),
    storageEmpty: localStorage.length === 0 && sessionStorage.length === 0 && document.cookie === '',
    fragmentRemoved: location.hash === ''
  }), marker)
  ensure(Object.values(safe).every(Boolean), 'SYNTHETIC_KEY_RETAINED_OR_ECHOED')
  return safe
}
async function requirePending() {
  const pending = await evaluate(() => ['captcha-enabled', 'captcha-key', 'captcha-daily', 'captcha-task', 'captcha-concurrent', 'captcha-save', 'captcha-check', 'captcha-remove'].every(id => document.getElementById(id).matches(':disabled')) && document.getElementById('captcha-form').getAttribute('aria-busy') === 'true')
  ensure(pending, 'PENDING_CONTROLS_NOT_DISABLED')
}
async function screenshot(name) {
  await evaluate(() => document.getElementById('captcha-settings').scrollIntoView({ block: 'start' }))
  const result = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  await writeFile(path.join(output, name), Buffer.from(result.data, 'base64'))
}
async function scenario(name, run) {
  stage = name
  const result = await run()
  report.cases.push({ name, passed: true, ...result })
  console.log(`PASS ${name}`)
}

try {
  const origin = await startFixture()
  const { BrowserPipe } = await import(pathToFileURL(path.join(directory, 'cdp.mjs')))
  browser = await BrowserPipe.launch({ executable: path.resolve(positional[0]), profile: path.join(output, 'owned-profile'), args: ['--headless=new', '--disable-background-networking', '--disable-component-update', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'] })
  report.browserProduct = browser.version.product
  report.browserPid = browser.process.pid
  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true })
  send = (method, params) => browser.send(method, params, sessionId)
  await send('Page.enable'); await send('Runtime.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false })
  const loaded = new Promise((resolve, reject) => {
    const listener = message => {
      if (message.sessionId === sessionId && message.method === 'Page.loadEventFired') { clearTimeout(timer); browser.off('protocol', listener); resolve() }
    }
    const timer = setTimeout(() => { browser.off('protocol', listener); reject(Object.assign(new Error('Dashboard did not load'), { code: 'DASHBOARD_LOAD_TIMEOUT' })) }, 12000)
    browser.on('protocol', listener)
  })
  await send('Page.navigate', { url: `${origin}/#token=${token}` }); await loaded
  const { frameTree } = await send('Page.getFrameTree')
  ;({ executionContextId: contextId } = await send('Page.createIsolatedWorld', { frameId: frameTree.frame.id, worldName: 'dashboard-capsolver-acceptance' }))
  await waitFor(() => document.getElementById('connection-state').textContent === 'Connected locally')

  await scenario('collapsed_settings_make_no_rpc_requests', async () => {
    await click('#refresh'); await waitFor(() => !document.getElementById('refresh').disabled)
    ensure(counts.get === 0 && counts.status >= 2, 'COLLAPSED_SETTINGS_REQUESTED')
    ensure(await evaluate(() => !document.getElementById('captcha-settings').open && !document.getElementById('captcha-enabled').checked), 'SETTINGS_NOT_COLLAPSED_OR_DEFAULT_OFF')
    ensure(await evaluate(() => document.getElementById('captcha-total').textContent === '0' && document.querySelector('.task-captcha-count').textContent === 'CAPTCHA solutions: 0'), 'OPTIONAL_COUNTERS_NOT_DEFAULT_ZERO')
    return { privacy: await requireNoKey() }
  })

  await scenario('collapsed_total_and_selected_task_show_distinct_outcomes', async () => {
    statsAvailable = true
    Object.assign(outcomeTotals, { solutionsDelivered: 8, failed: 3, cancelled: 2, uncertain: 1 })
    fixtureTask.captchaStats = { solutionsDelivered: 2, failed: 1, cancelled: 1, uncertain: 0 }
    await click('#refresh'); await waitFor(() => !document.getElementById('refresh').disabled && document.getElementById('captcha-total').textContent === '8')
    ensure(counts.get === 0, 'COUNTER_TRIGGERED_SETTINGS_LOAD')
    ensure(await evaluate(() => !document.getElementById('captcha-settings').open && document.getElementById('captcha-total').getBoundingClientRect().height > 0 && document.querySelector('.task-captcha-count').textContent === 'CAPTCHA solutions: 2'), 'COLLAPSED_OR_TASK_COUNTER_INCORRECT')
    await click('.task-card .observe')
    await waitFor(() => document.getElementById('page-text').textContent === 'Synthetic task page' && document.querySelector('.task-card').getAttribute('aria-busy') === 'false')
    ensure(await evaluate(() => document.getElementById('inspection-captcha-outcomes').textContent === 'CAPTCHA solutions: 2 · Failed: 1 · Cancelled: 1 · Uncertain: 0' && document.querySelector('.task-captcha-summary').textContent.includes('site acceptance may differ') && document.querySelector('.task-captcha-summary').textContent.includes('Paid attempts may still count after cancellation')), 'SELECTED_TASK_OUTCOMES_OR_EXPLANATION_MISSING')
    await screenshot('counters-collapsed.png')
  })

  await scenario('keyboard_disclosure_loads_accessible_labeled_fields', async () => {
    const held = holdNext('get')
    await focus('captcha-settings-heading'); await key('Enter', 'Enter', 13); await held.arrived
    await requirePending(); held.release(); await idle()
    await key('Tab', 'Tab', 9)
    ensure(await evaluate(() => document.activeElement.id === 'captcha-enabled'), 'DISCLOSURE_KEYBOARD_ORDER_WRONG')
    const accessible = await evaluate(() => ({
      labels: [...document.querySelectorAll('#captcha-form input')].every(input => input.labels.length && [...input.labels].some(label => label.textContent.trim())),
      help: [...document.querySelectorAll('#captcha-form input')].every(input => input.getAttribute('aria-describedby')?.split(' ').every(id => document.getElementById(id))),
      password: document.getElementById('captcha-key').type === 'password' && document.getElementById('captcha-key').autocomplete === 'off',
      liveStatus: document.getElementById('captcha-status').getAttribute('role') === 'status' && document.getElementById('captcha-error').getAttribute('role') === 'alert',
      noSavedKey: document.getElementById('captcha-key-state').textContent === 'No key saved' && document.getElementById('captcha-check').disabled
    }))
    ensure(Object.values(accessible).every(Boolean), 'ACCESSIBILITY_OR_INITIAL_STATE_FAILED')
    ensure(await evaluate(() => document.getElementById('captcha-outcomes').textContent === 'CAPTCHA solutions: 8 · Failed: 3 · Cancelled: 2 · Uncertain: 1'), 'EXPANDED_OUTCOME_TOTALS_INCORRECT')
    return { accessible }
  })

  await scenario('local_validation_announces_errors_and_focuses_fields', async () => {
    await key(' ', 'Space', 32); await click('#captcha-save')
    ensure(await evaluate(() => document.activeElement.id === 'captcha-key' && document.activeElement.getAttribute('aria-invalid') === 'true' && !document.getElementById('captcha-key-error').hidden), 'MISSING_KEY_ERROR_NOT_ACCESSIBLE')
    await fill('captcha-key', marker)
    await fill('captcha-daily', 0); await fill('captcha-task', 11); await fill('captcha-concurrent', '1.5')
    await click('#captcha-save')
    ensure(await evaluate(() => document.activeElement.id === 'captcha-daily' && ['captcha-daily', 'captcha-task', 'captcha-concurrent'].every(id => document.getElementById(id).getAttribute('aria-invalid') === 'true' && !document.getElementById(id + '-error').hidden)), 'LIMIT_ERRORS_NOT_LOCAL_OR_FOCUSED')
    ensure(counts.save === 0, 'INVALID_SETTINGS_SENT')
    await fill('captcha-daily', 100); await fill('captcha-task', 3); await fill('captcha-concurrent', 2)
  })

  await scenario('save_clears_plaintext_while_pending_and_never_echoes_key', async () => {
    const held = holdNext('save')
    await focus('captcha-save'); await key('Enter', 'Enter', 13); await held.arrived
    await requirePending(); await requireNoKey(); held.release(); await idle()
    ensure(counts.keySaves === 1 && settings.enabled, 'KEY_OR_EXPLICIT_ENABLE_NOT_SAVED')
    ensure(await evaluate(() => document.getElementById('captcha-key-state').textContent === 'A key is saved' && document.getElementById('captcha-verification').textContent === 'Key not checked' && document.getElementById('captcha-enabled').checked && document.activeElement.id === 'captcha-save'), 'SAVED_STATE_OR_FOCUS_INCORRECT')
    return { privacy: await requireNoKey() }
  })

  await scenario('blank_key_preserves_key_and_saves_explicit_limits', async () => {
    await click('#captcha-enabled'); await fill('captcha-daily', 25); await fill('captcha-task', 2); await fill('captcha-concurrent', 1)
    await click('#captcha-save'); await idle()
    ensure(counts.blankSaves === 1 && settings.hasKey && !settings.enabled && settings.limits.maxRequestsPerDay === 25 && settings.limits.maxAttemptsPerTask === 2 && settings.limits.maxConcurrent === 1, 'BLANK_SAVE_CHANGED_KEY_OR_LIMITS')
    ensure(await evaluate(() => !document.getElementById('captcha-enabled').checked && document.getElementById('captcha-summary').textContent === 'Disabled · CapSolver'), 'EXPLICIT_DISABLED_STATE_NOT_REFLECTED')
  })

  await scenario('check_displays_returned_balance_usage_and_verification', async () => {
    const held = holdNext('check')
    await focus('captcha-check'); await key('Enter', 'Enter', 13); await held.arrived
    await requirePending(); held.release(); await idle()
    report.balanceSnapshot = await evaluate(() => ({ verification: document.getElementById('captcha-verification').textContent, usage: document.getElementById('captcha-usage').textContent, focus: document.activeElement.id }))
    ensure(report.balanceSnapshot.verification.includes('Key verified') && /12[.,]50/.test(report.balanceSnapshot.verification) && report.balanceSnapshot.verification.includes('Checked') && report.balanceSnapshot.usage === '7 paid attempts in the last 24 hours · 1 active' && report.balanceSnapshot.focus === 'captcha-check', 'BALANCE_USAGE_OR_FOCUS_INCORRECT')
    await screenshot('settings-desktop.png')
    return { privacy: await requireNoKey() }
  })

  await scenario('status_poll_updates_outcomes_without_resetting_unsaved_settings', async () => {
    const before = { status: counts.status, get: counts.get, save: counts.save }
    await click('#captcha-enabled'); await fill('captcha-daily', 77); await fill('captcha-key', marker)
    Object.assign(outcomeTotals, { solutionsDelivered: 9, failed: 5, cancelled: 4, uncertain: 3 })
    fixtureTask.captchaStats = { solutionsDelivered: 3, failed: 2, cancelled: 2, uncertain: 1 }
    await waitFor(() => document.getElementById('captcha-total').textContent === '9')
    ensure(counts.status > before.status && counts.get === before.get && counts.save === before.save, 'POLL_TRIGGERED_SETTINGS_REQUEST')
    ensure(await evaluate(marker => document.getElementById('captcha-enabled').checked && document.getElementById('captcha-daily').value === '77' && document.getElementById('captcha-key').value === marker && document.activeElement.id === 'captcha-key', marker), 'POLL_RESET_UNSAVED_SETTINGS_OR_FOCUS')
    ensure(await evaluate(() => document.getElementById('captcha-outcomes').textContent === 'CAPTCHA solutions: 9 · Failed: 5 · Cancelled: 4 · Uncertain: 3' && document.getElementById('inspection-captcha-outcomes').textContent === 'CAPTCHA solutions: 3 · Failed: 2 · Cancelled: 2 · Uncertain: 1' && document.querySelector('.task-captcha-count').textContent === 'CAPTCHA solutions: 3'), 'POLLED_OUTCOMES_NOT_UPDATED')
    await fill('captcha-key', ''); await fill('captcha-daily', 25); await click('#captcha-enabled')
    return { privacy: await requireNoKey() }
  })

  await scenario('failed_save_check_and_remove_do_not_echo_or_claim_success', async () => {
    failAction = 'save'; await fill('captcha-key', marker)
    const held = holdNext('save'); await click('#captcha-save'); await held.arrived
    await requirePending(); await requireNoKey(); held.release(); await idle()
    ensure(await evaluate(() => !document.getElementById('captcha-error').hidden && document.getElementById('captcha-error').textContent.startsWith('Could not save') && document.getElementById('captcha-status').textContent === ''), 'SAVE_FAILURE_NOT_SHOWN')
    await requireNoKey()
    failAction = 'check'; await click('#captcha-check'); await idle()
    ensure(await evaluate(() => document.getElementById('captcha-error').textContent.startsWith('Could not check') && !document.getElementById('captcha-verification').textContent.includes('Key verified') && !document.getElementById('captcha-verification').textContent.includes('12.50')), 'FAILED_CHECK_RETAINS_VERIFIED_BALANCE')
    failAction = 'remove_key'; await click('#captcha-remove'); await idle()
    ensure(await evaluate(() => document.getElementById('captcha-error').textContent.startsWith('Could not remove') && document.getElementById('captcha-key-state').textContent === 'A key is saved' && !document.getElementById('captcha-remove').disabled), 'FAILED_REMOVE_CLAIMS_SUCCESS')
    return { privacy: await requireNoKey() }
  })

  await scenario('provider_rejection_and_remove_render_live_safe_state', async () => {
    checkInvalid = true; await click('#captcha-check'); await idle()
    ensure(await evaluate(() => document.getElementById('captcha-verification').textContent.startsWith('Key check failed') && !document.getElementById('captcha-verification').textContent.includes('Balance:')), 'PROVIDER_REJECTION_NOT_REFLECTED')
    const held = holdNext('remove_key'); await click('#captcha-remove'); await held.arrived
    await requirePending(); held.release(); await idle()
    ensure(await evaluate(() => !document.getElementById('captcha-enabled').checked && document.getElementById('captcha-key-state').textContent === 'No key saved' && document.getElementById('captcha-check').disabled && document.getElementById('captcha-remove').disabled && document.getElementById('captcha-status').textContent === 'Key removed. CapSolver is disabled.'), 'REMOVAL_NOT_REFLECTED')
    ensure(await evaluate(() => document.getElementById('captcha-total').textContent === '9' && document.getElementById('captcha-outcomes').textContent === 'CAPTCHA solutions: 9 · Failed: 5 · Cancelled: 4 · Uncertain: 3'), 'REMOVAL_RESET_OUTCOMES')
    return { privacy: await requireNoKey() }
  })

  await scenario('collapse_clears_draft_and_mobile_layout_has_no_overflow', async () => {
    await fill('captcha-key', marker); await focus('captcha-settings-heading'); await key('Enter', 'Enter', 13)
    await waitFor(() => !document.getElementById('captcha-settings').open && document.getElementById('captcha-key').value === '')
    await requireNoKey()
    const held = holdNext('get')
    await key('Enter', 'Enter', 13); await held.arrived; held.release(); await idle()
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 1400, deviceScaleFactor: 1, mobile: false })
    ensure(await evaluate(() => document.documentElement.scrollWidth <= innerWidth && [...document.querySelectorAll('.settings-actions button, .settings-field input')].every(node => node.getBoundingClientRect().height >= 44)), 'MOBILE_OVERFLOW_OR_SMALL_CONTROLS')
    await screenshot('settings-mobile.png')
  })

  await scenario('storage_unavailable_and_admin_load_error_are_recoverable', async () => {
    settings.storageAvailable = false
    await reopenSettings()
    ensure(await evaluate(() => !document.getElementById('captcha-storage').hidden && document.getElementById('captcha-key').matches(':disabled') && document.getElementById('captcha-save').disabled), 'UNAVAILABLE_STORAGE_NOT_EXPLAINED')
    failAction = 'get'; await reopenSettings()
    ensure(await evaluate(() => document.getElementById('captcha-error').textContent.includes('private admin dashboard link') && document.getElementById('captcha-save').disabled), 'ADMIN_LOAD_FAILURE_NOT_RECOVERABLE')
    settings.storageAvailable = true
    await focus('captcha-retry'); await key('Enter', 'Enter', 13); await idle()
    ensure(await evaluate(() => document.getElementById('captcha-retry').hidden && document.getElementById('captcha-error').hidden && document.getElementById('captcha-storage').hidden && !document.getElementById('captcha-save').disabled), 'SETTINGS_RETRY_FAILED')
    return { privacy: await requireNoKey() }
  })
  ensure(counts.unexpected === 0, 'UNEXPECTED_FIXTURE_REQUESTS')
} catch (error) {
  report.cases.push({ name: stage, passed: false, code: codeOf(error) })
  console.log(`FAIL ${stage} ${codeOf(error)}`)
} finally {
  clearTimeout(gate?.timer)
  for (const held of heldRequests) held.release()
  try {
    try { await browser?.closeForManual({ timeoutMs: 15000 }) }
    catch { await browser.close(); await browser.closeForManual({ timeoutMs: 4000 }) }
    report.cleanup.browserClosed = !browser || browser.processExited === true || browser.process.exitCode !== null
  }
  catch { report.cleanup.browserClosed = false }
  try { if (server) await new Promise(resolve => { server.close(resolve); server.closeAllConnections() }); report.cleanup.fixtureClosed = true }
  catch { report.cleanup.fixtureClosed = false }
  report.counts = counts
  report.passed = report.cases.length === 12 && report.cases.every(test => test.passed) && report.cleanup.browserClosed && report.cleanup.fixtureClosed
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2))
}
if (!report.passed) process.exitCode = 1

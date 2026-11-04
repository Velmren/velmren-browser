// node test/dashboard-privacy-integration.mjs BROWSER_EXE NEW_OUTPUT_DIR [--agent-directory=DIR]
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

const report = { passed: false, agentDirectory: directory, cases: [], cleanup: {} }
const marker = `synthetic-${randomUUID()}`
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS1sAAAAASUVORK5CYII='
const taskId = 'synthetic-dashboard-task', pageId = 'synthetic-page', token = 'synthetic-local-fixture-token'
const counts = { status: 0, observe: 0, screenshot: 0, delayedObserve: 0, delayedScreenshot: 0, unexpected: 0 }
let browser, server, send, contextId, active = false, phase = 0, gate, stage = 'setup'
const ensure = (condition, code) => { if (!condition) throw Object.assign(new Error('Dashboard acceptance condition failed'), { code }) }
const codeOf = error => /^[A-Z][A-Z_]{2,64}$/.test(error?.code ?? '') ? error.code : 'UNEXPECTED_FAILURE'
const privacy = () => ({ active, phaseId: `synthetic-phase-${phase}` })
const status = () => ({ maxTasks: 4, tasks: [{
  taskId, selectedPageId: pageId, label: 'Synthetic dashboard acceptance', owner: 'Local acceptance fixture',
  state: 'agent-active', url: 'https://fixture.invalid', privacy: privacy(),
  pages: [{ pageId, title: 'Synthetic fixture', url: 'https://fixture.invalid' }]
}] })
const observation = () => ({
  taskId, pageId, observationId: `synthetic-observation-${counts.observe}`, state: 'agent-active', privacy: privacy(),
  url: 'https://fixture.invalid', title: `${marker} title`, text: `${marker} page text`,
  elements: [{ ref: 'e1', tag: 'input', role: 'textbox', name: `${marker} control` }],
  downloads: [{ name: `${marker} download`, path: `${marker} path`, state: 'completed' }],
  dialog: { type: 'prompt', message: `${marker} dialog`, defaultPrompt: `${marker} prompt` }
})
const reply = (response, result) => {
  response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  response.end(JSON.stringify({ ok: true, result }))
}

async function startFixture() {
  const assets = new Map(await Promise.all(['index.html', 'app.js', 'style.css'].map(async name => {
    const data = await readFile(path.join(directory, 'public', name))
    return [name, data]
  })))
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
      let result
      if (method === 'broker_status') { counts.status++; result = status() }
      else if (method === 'task_observe') { ensure(args.taskId === taskId, 'FIXTURE_TASK_MISMATCH'); counts.observe++; result = observation() }
      else if (method === 'task_screenshot') { ensure(args.taskId === taskId, 'FIXTURE_TASK_MISMATCH'); counts.screenshot++; result = { mimeType: 'image/png', data: png } }
      else { counts.unexpected++; throw Object.assign(new Error('Unexpected fixture method'), { code: 'UNEXPECTED_FIXTURE_METHOD' }) }
      if (gate?.method === method) {
        const held = gate; gate = undefined
        held.wasOrdinary = !active
        held.release = () => { reply(response, result); held.released = true }
        if (method === 'task_observe') counts.delayedObserve++
        else counts.delayedScreenshot++
        clearTimeout(held.timer); held.resolve(); return
      }
      reply(response, result)
    } catch {
      counts.unexpected++
      if (!response.headersSent) response.writeHead(500, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ ok: false, error: 'Synthetic fixture failure' }))
    }
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  return `http://127.0.0.1:${server.address().port}`
}

function holdNext(method) {
  ensure(!gate, 'FIXTURE_GATE_ALREADY_PENDING')
  const held = { method, wasOrdinary: false, released: false }
  held.arrived = new Promise((resolve, reject) => {
    held.resolve = resolve
    held.timer = setTimeout(() => reject(Object.assign(new Error('Fixture request did not arrive'), { code: 'FIXTURE_REQUEST_TIMEOUT' })), 12000)
  })
  gate = held
  return held
}

async function evaluate(fn, args) {
  const result = await send('Runtime.evaluate', {
    contextId, expression: `(${fn.toString()})(${JSON.stringify(args) ?? ''})`, awaitPromise: true, returnByValue: true
  })
  ensure(!result.exceptionDetails, 'RENDERER_EVALUATION_FAILED')
  return result.result.value
}

async function waitFor(predicate, args) {
  const matched = await evaluate(({ source, args }) => new Promise(resolve => {
    const predicate = (0, eval)(`(${source})`)
    let observer, timer
    const finish = value => { clearTimeout(timer); observer?.disconnect(); document.removeEventListener('load', check, true); resolve(value) }
    const check = () => { if (predicate(args)) finish(true) }
    observer = new MutationObserver(check)
    observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true })
    document.addEventListener('load', check, true)
    timer = setTimeout(() => finish(false), 12000)
    check()
  }), { source: predicate.toString(), args })
  ensure(matched, 'DOM_CONDITION_TIMEOUT')
}

async function click(selector) {
  const point = await evaluate(selector => {
    const node = document.querySelector(selector)
    if (!node || node.disabled || node.hidden) return null
    node.scrollIntoView({ block: 'center' })
    const rect = node.getBoundingClientRect()
    return rect.width && rect.height ? { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 } : null
  }, selector)
  ensure(point, 'CONTROL_UNAVAILABLE')
  for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 })
}

async function inspect() {
  return evaluate(marker => {
    const get = id => document.getElementById(id)
    const dialog = get('page-prompt-response').closest('fieldset')
    const image = get('screenshot-image')
    return {
      inspectorVisible: !get('inspection').hidden,
      normalText: get('page-text').textContent.includes(marker),
      normalTitle: get('inspection-title').textContent.includes(marker),
      normalControl: get('elements').textContent.includes(marker),
      normalDownload: get('downloads').textContent.includes(marker),
      normalDialog: !dialog.hidden && dialog.querySelector('pre').textContent.includes(marker),
      normalPrompt: get('page-prompt-response').value.includes(marker),
      protectedText: get('page-text').textContent === 'Page content is protected during sensitive input.',
      protectedTitle: get('inspection-title').textContent === 'Protected page',
      protectedControlSummary: get('elements-summary').textContent === 'Page controls (protected)',
      controlCount: get('elements').childElementCount,
      downloadCount: get('downloads').childElementCount,
      downloadsHidden: get('downloads-details').hidden,
      dialogHidden: dialog.hidden,
      dialogMessageEmpty: dialog.querySelector('pre').textContent === '',
      promptEmpty: get('page-prompt-response').value === '',
      screenshotHidden: get('screenshot-view').hidden,
      screenshotSourceRemoved: !image.hasAttribute('src'),
      screenshotDisabled: get('screenshot').disabled,
      screenshotAccessible: !get('screenshot-view').hidden && image.complete && image.naturalWidth > 0 && image.src.startsWith('data:image/png;base64,'),
      markerPresent: document.documentElement.outerHTML.includes(marker) || [...document.querySelectorAll('input,textarea')].some(node => node.value.includes(marker)),
      busy: document.querySelector('.task-card').getAttribute('aria-busy') === 'true'
    }
  }, marker)
}

async function requireProtected() {
  const snapshot = await inspect()
  ensure(snapshot.inspectorVisible && snapshot.protectedText && snapshot.protectedTitle, 'PROTECTED_HEADING_OR_TEXT_MISSING')
  ensure(snapshot.protectedControlSummary, 'STALE_CONTROL_COUNT_RETAINED')
  ensure(snapshot.controlCount === 0 && snapshot.downloadCount === 0 && snapshot.downloadsHidden, 'CACHED_CONTROL_OR_DOWNLOAD_RETAINED')
  ensure(snapshot.dialogHidden && snapshot.dialogMessageEmpty && snapshot.promptEmpty, 'CACHED_DIALOG_OR_PROMPT_RETAINED')
  ensure(snapshot.screenshotHidden && snapshot.screenshotSourceRemoved && snapshot.screenshotDisabled, 'CACHED_SCREENSHOT_RETAINED')
  ensure(!snapshot.markerPresent, 'CACHED_SYNTHETIC_CONTENT_RETAINED')
  return snapshot
}

async function watchProtected() {
  await evaluate(marker => {
    const state = { checks: 0, leaked: false }
    const check = () => {
      state.checks++
      state.leaked ||= document.documentElement.outerHTML.includes(marker) ||
        [...document.querySelectorAll('input,textarea')].some(node => node.value.includes(marker)) ||
        document.getElementById('screenshot-image').hasAttribute('src') || !document.getElementById('screenshot-view').hidden
    }
    state.observer = new MutationObserver(check)
    state.observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true })
    globalThis.__dashboardPrivacyGuard = state
    check()
  }, marker)
}

async function finishProtectedWatch() {
  const result = await evaluate(() => {
    const state = globalThis.__dashboardPrivacyGuard
    state.observer.disconnect()
    delete globalThis.__dashboardPrivacyGuard
    return { checks: state.checks, leaked: state.leaked }
  })
  ensure(result.checks > 1, 'PROTECTED_RACE_NOT_OBSERVED')
  ensure(!result.leaked, 'TRANSIENT_CACHED_CONTENT_RESTORED')
  return result
}

async function normalObservation() {
  await click('.task-card .observe')
  await waitFor(marker => document.getElementById('page-text').textContent.includes(marker) && document.querySelector('.task-card').getAttribute('aria-busy') === 'false' && !document.getElementById('screenshot').disabled, marker)
  const snapshot = await inspect()
  ensure(snapshot.inspectorVisible && snapshot.normalText && snapshot.normalTitle && snapshot.normalControl && snapshot.normalDownload && snapshot.normalDialog && snapshot.normalPrompt, 'NORMAL_CHANNELS_NOT_RENDERED')
  return snapshot
}

async function capture() {
  await click('#screenshot')
  await waitFor(() => {
    const image = document.getElementById('screenshot-image')
    return !document.getElementById('screenshot-view').hidden && image.complete && image.naturalWidth > 0 && !document.getElementById('screenshot').disabled
  })
  const snapshot = await inspect()
  ensure(snapshot.screenshotAccessible, 'NORMAL_SCREENSHOT_UNAVAILABLE')
  return snapshot
}

async function setPrivacy(value) {
  await waitFor(() => !document.getElementById('refresh').disabled)
  active = value; phase++
  await click('#refresh')
  await waitFor(active => !document.getElementById('refresh').disabled && (active
    ? document.getElementById('inspection-title').textContent === 'Protected page' && document.getElementById('screenshot').disabled
    : !document.getElementById('screenshot').disabled), active)
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
  browser = await BrowserPipe.launch({ executable: path.resolve(positional[0]), profile: path.join(output, 'owned-profile'), args: ['--headless=new'] })
  report.browserProduct = browser.version.product
  report.browserPid = browser.process.pid
  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true })
  send = (method, params) => browser.send(method, params, sessionId)
  await send('Page.enable')
  await send('Runtime.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false })
  const loaded = new Promise((resolve, reject) => {
    const listener = message => {
      if (message.sessionId === sessionId && message.method === 'Page.loadEventFired') { clearTimeout(timer); browser.off('protocol', listener); resolve() }
    }
    const timer = setTimeout(() => { browser.off('protocol', listener); reject(Object.assign(new Error('Dashboard did not load'), { code: 'DASHBOARD_LOAD_TIMEOUT' })) }, 12000)
    browser.on('protocol', listener)
  })
  await send('Page.navigate', { url: `${origin}/#token=${token}` })
  await loaded
  const { frameTree } = await send('Page.getFrameTree')
  ;({ executionContextId: contextId } = await send('Page.createIsolatedWorld', { frameId: frameTree.frame.id, worldName: 'dashboard-privacy-acceptance' }))
  await waitFor(() => document.querySelectorAll('.task-card').length === 1 && document.getElementById('connection-state').textContent === 'Connected locally')

  await scenario('ordinary_content_and_screenshot_are_accessible', async () => {
    await normalObservation()
    return { snapshot: await capture() }
  })

  await scenario('active_status_clears_every_cached_inspector_channel', async () => {
    await setPrivacy(true)
    return { snapshot: await requireProtected() }
  })

  await scenario('safe_phase_can_be_observed_again', async () => {
    await setPrivacy(false)
    return { snapshot: await normalObservation() }
  })

  await scenario('late_ordinary_observation_cannot_restore_protected_content', async () => {
    const held = holdNext('task_observe')
    await click('#inspect-again'); await held.arrived
    ensure(held.wasOrdinary && !held.released, 'ORDINARY_OBSERVATION_NOT_HELD')
    await setPrivacy(true); await requireProtected(); await watchProtected()
    held.release()
    await waitFor(() => document.querySelector('.task-card').getAttribute('aria-busy') === 'false' && !document.getElementById('refresh').disabled)
    return { delayedOrdinaryReplyReleased: held.released, protectedWatch: await finishProtectedWatch(), snapshot: await requireProtected() }
  })

  await scenario('late_screenshot_cannot_restore_protected_image', async () => {
    await setPrivacy(false); await normalObservation(); await capture()
    const held = holdNext('task_screenshot')
    await click('#screenshot'); await held.arrived
    ensure(held.wasOrdinary && !held.released, 'ORDINARY_SCREENSHOT_NOT_HELD')
    await setPrivacy(true); await requireProtected(); await watchProtected()
    held.release()
    await waitFor(() => document.getElementById('screenshot').textContent === 'Capture screenshot' && !document.getElementById('refresh').disabled && document.querySelector('.task-card').getAttribute('aria-busy') === 'false')
    const protectedWatch = await finishProtectedWatch()
    const snapshot = await requireProtected()
    const screenshot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
    await writeFile(path.join(output, 'protected-dashboard.png'), Buffer.from(screenshot.data, 'base64'))
    return { delayedOrdinaryReplyReleased: held.released, protectedWatch, snapshot }
  })

  await scenario('fresh_safe_observation_and_screenshot_recover_after_both_races', async () => {
    await setPrivacy(false); await normalObservation()
    return { snapshot: await capture() }
  })
  ensure(counts.unexpected === 0 && counts.delayedObserve === 1 && counts.delayedScreenshot === 1, 'FIXTURE_COVERAGE_MISMATCH')
} catch (error) {
  report.cases.push({ name: stage, passed: false, code: codeOf(error) })
  console.log(`FAIL ${stage} ${codeOf(error)}`)
} finally {
  clearTimeout(gate?.timer)
  try { await browser?.close(); report.cleanup.browserClosed = !browser || browser.processExited === true || browser.process.exitCode !== null }
  catch { report.cleanup.browserClosed = false }
  try {
    if (server) await new Promise(resolve => { server.close(resolve); server.closeAllConnections() })
    report.cleanup.fixtureClosed = true
  } catch { report.cleanup.fixtureClosed = false }
  report.counts = counts
  report.passed = report.cases.length === 6 && report.cases.every(test => test.passed) && report.cleanup.browserClosed && report.cleanup.fixtureClosed
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2))
}
if (!report.passed) process.exitCode = 1

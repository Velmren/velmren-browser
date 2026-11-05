// node test/vbr020-028-integration.mjs BROWSER_EXE FRESH_OUTPUT [AGENT_DIRECTORY]
import http from 'node:http'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'

const [executable, output, agentDirectory] = process.argv.slice(2)
const directory = agentDirectory ?? fileURLToPath(new URL('../', import.meta.url))
const { startBroker } = await import(pathToFileURL(path.join(directory, 'broker.mjs')))
const { stagePrivateInput } = await import(pathToFileURL(path.join(directory, 'private-input.mjs')))
const { sanitizePublicError } = await import(pathToFileURL(path.join(directory, 'privacy.mjs')))
await mkdir(output, { recursive: true })
const report = { cases: [], cleanup: {} }, marker = 'VBR020_028_SYNTHETIC_PRIVATE_MARKER'
const document = body => `<!doctype html><title>Native privacy regression</title><style>body{margin:24px;font:18px sans-serif}label{display:block;margin:12px}input{font:inherit}</style>${body}`
const server = http.createServer((request, response) => {
  response.setHeader('Content-Type', 'text/html')
  if (request.url.startsWith('/login')) response.end(document('<h1>Login</h1><aside id="tick">0</aside><label>Email<input id="email" type="text"></label><label>Password<input id="password" type="password" autocomplete="current-password"></label><button type="submit">Sign in</button>'))
  else if (request.url.startsWith('/activation')) response.end(document('<h1>Activation</h1><a id="popup" href="/activation" target="_blank">Activation popup</a>'))
  else response.end(document('<h1>Safe destination</h1><input value="public">'))
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`, tasks = []
let app
const clean = value => { assert.ok(!JSON.stringify(value).includes(marker)); return value }
const call = async (method, args) => clean(await app.broker.rpc('scripts', `task_${method}`, args))
const create = async route => { const task = await call('create', { url: origin + route, sensitive: true }); tasks.push(task.taskId); return task }
const local = task => app.broker.page(app.broker.tasks.get(task.taskId))
const evaluate = async (page, expression) => {
  const result = await page.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  assert.ok(!result.exceptionDetails); assert.equal(result.result.value, true)
}
const stageInput = (task, value, ref, readSecret = async () => marker, extra = {}) => stagePrivateInput({ stateDir: path.join(output, 'state'), taskId: task.taskId,
  observationId: value.observationId, ref, origin, topOrigin: origin, readSecret, ...extra })
const endArgs = (task, value) => ({ taskId: task.taskId, pageId: value.pageId, action: 'end', phaseId: value.privacy.phaseId, documentId: value.privacy.documentId, expectedOrigin: origin, safeToReveal: true })
async function scenario(name, run) {
  try { await run(); report.cases.push({ name, passed: true }); console.log(`PASS ${name}`) }
  catch (error) { report.cases.push({ name, passed: false, ...sanitizePublicError(error, { sensitive: true }) }); console.log(`FAIL ${name}`) }
}
try {
  app = await startBroker({ executable, stateDir: path.join(output, 'state'), policy: { profileMode: 'isolated', allowedOrigins: [origin], webCompatibility: true }, browserArgs: ['--headless=new'] })
  await scenario('private_input_tolerates_unrelated_mutation_before_prepare_and_consume', async () => {
    const task = await create('/login'), page = local(task)
    const observed = await call('observe', { taskId: task.taskId }), password = observed.elements.find(el => el.type === 'password')
    await evaluate(page, "document.querySelector('#tick').textContent='1';true")
    let reads = 0
    const staged = await stageInput(task, observed, password.ref, async () => { reads++; await evaluate(page, "document.querySelector('#tick').textContent='2';true"); return marker })
    assert.equal(staged.ready, true); assert.equal(reads, 1)
    const result = await call('act', { taskId: task.taskId, observationId: observed.observationId, actions: [{ type: 'fill', ref: password.ref, secretRef: staged.secretRef }] })
    assert.equal(result.actionResult.delivery, 'delivered_verified')
    await evaluate(page, `document.querySelector('#password').value===${JSON.stringify(marker)}`)
    assert.equal(app.broker.privateInputs.entries.size, 0)
  })
  await scenario('private_input_rejects_target_mutation_before_reader_and_after_provide', async () => {
    const task = await create('/login'), page = local(task)
    let observed = await call('observe', { taskId: task.taskId }), password = observed.elements.find(el => el.type === 'password'), reads = 0
    await evaluate(page, "document.querySelector('#password').setAttribute('name','replacement');true")
    await assert.rejects(stageInput(task, observed, password.ref, async () => { reads++; return marker }))
    assert.equal(reads, 0)
    observed = await call('observe', { taskId: task.taskId }); password = observed.elements.find(el => el.type === 'password')
    const staged = await stageInput(task, observed, password.ref)
    await evaluate(page, "document.querySelector('#password').outerHTML='<input id=\"replacement\" type=\"password\">';true")
    await assert.rejects(call('act', { taskId: task.taskId, observationId: observed.observationId, actions: [{ type: 'fill', ref: password.ref, secretRef: staged.secretRef }] }))
    await evaluate(page, "document.querySelector('#replacement').value==='' ")
    app.broker.privateInputs.drop(staged.secretRef)
  })
  await scenario('private_input_reports_origin_and_callback_failures_without_secrets', async () => {
    const task = await create('/login'), observed = await call('observe', { taskId: task.taskId }), password = observed.elements.find(el => el.type === 'password')
    let reads = 0
    await assert.rejects(stageInput(task, observed, password.ref, async () => { reads++; return marker }, { origin: 'https://other.test' }), error => {
      const safe = clean(sanitizePublicError(error, { sensitive: true })); assert.equal(safe.diagnostic.stage, 'private_prepare'); assert.equal(safe.diagnostic.reason, 'origin-mismatch'); return true
    })
    assert.equal(reads, 0)
    await assert.rejects(stageInput(task, observed, password.ref, async () => { throw new Error(marker) }), error => {
      const safe = clean(sanitizePublicError(error, { sensitive: true })); assert.equal(safe.diagnostic.stage, 'private_read'); assert.equal(safe.diagnostic.reason, 'reader-failed'); return true
    })
    assert.equal(app.broker.privateInputs.entries.size, 0)
  })
  await scenario('unobserved_popup_retains_first_document_across_navigation_and_opener_close', async () => {
    const task = await create('/activation'), root = local(task)
    await evaluate(root, "document.querySelector('#popup').click();true")
    const deadline = Date.now() + 10000
    let popup
    while (Date.now() < deadline) {
      popup = [...app.broker.pages(app.broker.tasks.get(task.taskId)).values()].find(page => page.pageId !== root.pageId)
      if (popup) { await popup.ready; if (popup.url.includes('/activation')) break }
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    assert.ok(popup)
    // No public observation of the popup before its known safe transition.
    await call('close_page', { taskId: task.taskId, pageId: root.pageId })
    await popup.navigate(origin + '/intermediate')
    const safe = await call('navigate', { taskId: task.taskId, pageId: popup.pageId, url: origin + '/safe' })
    assert.equal(safe.privacy.active, true)
    const result = await call('sensitive', endArgs(task, safe))
    assert.equal(result.privacy.active, false); assert.match(result.text, /Safe destination/)
  })
  await scenario('sensitive_end_rejects_first_document_spa_wrong_origin_and_races', async () => {
    const task = await create('/activation'), page = local(task)
    let observed = await call('observe', { taskId: task.taskId })
    await assert.rejects(call('sensitive', endArgs(task, observed)), error => { assert.equal(error.diagnostic.reason, 'new-document-required'); return true })
    await evaluate(page, "history.pushState(null,'','/safe-spa');true")
    observed = await call('observe', { taskId: task.taskId })
    await assert.rejects(call('sensitive', endArgs(task, observed)), { code: 'SENSITIVE_TRANSITION_REQUIRED' })
    const safe = await call('navigate', { taskId: task.taskId, url: origin + '/safe' })
    await assert.rejects(call('sensitive', { ...endArgs(task, safe), expectedOrigin: 'https://other.test' }), { code: 'SENSITIVE_ORIGIN_MISMATCH' })
    const observe = page.observe
    let raced = false
    page.observe = async function (...args) { if (!raced) { raced = true; await this.navigate(origin + '/another') }; return observe.apply(this, args) }
    await assert.rejects(call('sensitive', endArgs(task, safe)), { code: 'SENSITIVE_DOCUMENT_CHANGED' })
    page.observe = observe
    assert.equal(app.broker.tasks.get(task.taskId).sensitive.active, true)
  })
  await scenario('native_metadata_projects_bare_oauth_titles_and_preserves_png', async () => {
    const task = await call('create', { url: origin + '/safe' }); tasks.push(task.taskId)
    await evaluate(local(task), `document.title='forum.open.mp/member.php?code=${marker}&state=${marker}#${marker}';true`)
    const value = await call('observe', { taskId: task.taskId }); assert.equal(value.title, 'https://forum.open.mp')
    const image = await call('screenshot', { taskId: task.taskId }); assert.equal(image.mimeType, 'image/png'); assert.ok(Buffer.from(image.data, 'base64').length > 100)
  })
} finally {
  if (app) {
    for (const taskId of tasks) await app.broker.rpc('scripts', 'task_cancel', { taskId }).catch(() => {})
    await app.close(); report.cleanup.browserClosed = app.broker.browser.closed
  }
  await new Promise(resolve => server.close(resolve)); report.cleanup.fixtureClosed = true
  report.passed = report.cases.length === 6 && report.cases.every(item => item.passed) && report.cleanup.browserClosed
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2))
}
if (!report.passed) process.exitCode = 1

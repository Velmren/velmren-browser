// Native localhost fixtures and injected provider transport only; no paid API calls.
// node test/capsolver-metadata-integration.mjs BROWSER_EXE NEW_OUTPUT_DIR [--agent-directory=DIR]
import { createServer } from 'node:http'
import { mkdir, readFile, readdir, writeFile, stat } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const argv = process.argv.slice(2), positional = argv.filter(value => !value.startsWith('--'))
if (positional.length !== 2 || argv.some(value => value.startsWith('--') && !value.startsWith('--agent-directory='))) throw new Error('Expected browser, fresh output directory and optional agent directory')
const directory = path.resolve(argv.find(value => value.startsWith('--agent-directory='))?.slice(18) ?? fileURLToPath(new URL('../', import.meta.url)))
const executable = path.resolve(positional[0]), output = path.resolve(positional[1]), stateDir = path.join(output, 'state')
if (!(await stat(executable)).isFile()) throw new Error('Browser executable is not a file')
await mkdir(path.dirname(output), { recursive: true }); await mkdir(output)

const report = { passed: false, agentDirectory: directory, executable, syntheticResponsesOnly: true, cases: [], cleanup: {} }
const key = `SyntheticKey_${randomUUID()}`, tokenPrefix = `SyntheticToken_${randomUUID()}_`
const userAgent = `SyntheticProviderUA_${randomUUID()}`, secChUa = `SyntheticProviderHints_${randomUUID()}`
const cookie = `SyntheticProviderCookie_${randomUUID()}`, urlMarker = `SyntheticPrivateURL_${randomUUID()}`
const probes = [key, tokenPrefix, userAgent, secChUa, cookie, urlMarker]
const fixtures = new Map(), providerTasks = new Map(), tasks = [], clients = []
let app, fixture, origin, service, stage = 'setup', currentCase, publicResponses = 0
const failure = code => Object.assign(new Error('Synthetic metadata acceptance failure'), { code })
const ensure = (condition, code) => { if (!condition) throw failure(code) }
const codeOf = error => /^[A-Z][A-Z_]{2,64}$/.test(error?.code ?? '') ? error.code : 'UNEXPECTED_FAILURE'
const clean = (value, code = 'PUBLIC_CANARY_LEAK') => {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  ensure(!probes.some(probe => text.includes(probe)), code)
}
const same = (actual, expected, code) => ensure(JSON.stringify(actual) === JSON.stringify(expected), code)
function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}
async function bounded(promise, code, timeout = 10000) {
  let timer
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(failure(code)), timeout) })]) }
  finally { clearTimeout(timer) }
}
async function scenario(name, run) {
  currentCase = { name, passed: false }; stage = name
  try { await run(); currentCase.passed = true; console.log(`PASS ${name}`) }
  catch (error) {
    currentCase.stage = stage; currentCase.code = codeOf(error)
    currentCase.location = error.stack?.split('\n').find(line => line.includes('capsolver-metadata-integration.mjs:') && !/at (failure|ensure|same) /.test(line))?.trim()
    console.log(`FAIL ${name} ${currentCase.code}`)
  }
  report.cases.push(currentCase)
}
function fixtureFor(name, kind = 'recaptcha', mode = 'poll', malformed = false) {
  const item = { name, kind, mode, malformed, creates: 0, polls: 0, dispatched: deferred(), released: deferred(), aborted: false }
  fixtures.set(name, item); return item
}
function solutionFor(item) {
  // Metadata matches the documented provider shape but is deliberately unrelated
  // to this browser. It must never become browser configuration or public data.
  return {
    [item.kind === 'turnstile' ? 'token' : 'gRecaptchaResponse']: tokenPrefix + item.name + (item.malformed ? ' invalid token' : ''),
    userAgent, secChUa, cookies: { fixture_session: cookie, provider_cookie: cookie }
  }
}
const json = value => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } })
async function mockFetch(url, options) {
  ensure(url.startsWith('https://capsolver.invalid/') && options.method === 'POST', 'UNEXPECTED_PROVIDER_ENDPOINT')
  const body = JSON.parse(options.body)
  ensure(body.clientKey === key, 'WRONG_SYNTHETIC_KEY')
  if (url.endsWith('/getBalance')) return json({ errorId: 0, balance: 12.5 })
  let item
  if (url.endsWith('/createTask')) {
    item = fixtures.get(body.task?.websiteKey?.replace(/^synthetic-/, ''))
    ensure(item && body.task.websiteURL === origin + '/', 'UNEXPECTED_PROVIDER_TASK')
    const type = item.kind === 'turnstile' ? 'AntiTurnstileTaskProxyLess' : item.kind === 'enterprise' ? 'ReCaptchaV2EnterpriseTaskProxyLess' : 'ReCaptchaV2TaskProxyLess'
    ensure(body.task.type === type, 'WRONG_PROVIDER_TASK_TYPE')
    ensure(!['userAgent', 'cookies', 'secChUa'].some(field => Object.hasOwn(body.task, field)), 'BROWSER_METADATA_SENT_TO_PROVIDER')
    item.creates++
    const taskId = `mock-${item.name}`; providerTasks.set(taskId, item)
    if (item.mode === 'poll') return json({ errorId: 0, status: 'processing', taskId })
  } else {
    ensure(url.endsWith('/getTaskResult'), 'UNEXPECTED_PROVIDER_OPERATION')
    item = providerTasks.get(body.taskId); ensure(item, 'UNKNOWN_PROVIDER_TASK'); item.polls++
  }
  const onAbort = () => { item.aborted = true }
  options.signal.addEventListener('abort', onAbort, { once: true })
  item.dispatched.resolve()
  try { await item.released.promise }
  finally { options.signal.removeEventListener('abort', onAbort) }
  return json({ errorId: 0, status: 'ready', taskId: `mock-${item.name}`, solution: solutionFor(item) })
}
async function startFixture() {
  fixture = createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1')
    response.setHeader('cache-control', 'no-store')
    if (url.pathname === '/identity') {
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify(Object.fromEntries(Object.entries(request.headers).filter(([key]) => key === 'user-agent' || key === 'cookie' || key.startsWith('sec-ch-ua')))))
      return
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8',
      'content-security-policy': "default-src 'self'; script-src 'unsafe-inline'; connect-src 'self'; frame-src 'none'; form-action 'none'" })
    const name = url.pathname.slice(1), item = fixtures.get(name)
    if (!item) { response.end('<!doctype html><title>Safe local destination</title>Safe local destination'); return }
    response.end(`<!doctype html><meta charset="utf-8"><title>Synthetic metadata fixture</title>
      <h1>Synthetic local widget</h1><p id="echo"></p><input id="ordinary" value="ordinary value">
      <form><div id="widget"></div></form><script>
      document.cookie='fixture_session=original_local_cookie; Path=/; SameSite=Strict';
      globalThis.fixtureCalls=[];
      globalThis.fixtureCallback=token=>{fixtureCalls.push(token);document.title=token;document.querySelector('#echo').textContent=token};
      function provider(){return {
        render(node,options){node.innerHTML='<input type="hidden" name="${item.kind === 'turnstile' ? 'cf-turnstile-response' : 'g-recaptcha-response'}">';return 'fixture-widget'},
        reset(){document.querySelector('#widget input').value='';return 'reset-receipt'}
      }};
      globalThis.grecaptcha=provider();grecaptcha.enterprise=provider();globalThis.turnstile=provider();
      globalThis.fixtureProvider=${item.kind === 'enterprise' ? 'grecaptcha.enterprise' : item.kind === 'turnstile' ? 'turnstile' : 'grecaptcha'};
      globalThis.fixtureWidget=fixtureProvider.render(document.querySelector('#widget'),{sitekey:'synthetic-${name}',callback:fixtureCallback${item.kind === 'enterprise' ? ",s:'synthetic-enterprise-s',action:'login'" : item.kind === 'turnstile' ? ",action:'signup',cData:'synthetic_data'" : ''}});
      </script>`)
  })
  await new Promise((resolve, reject) => { fixture.once('error', reject); fixture.listen(0, '127.0.0.1', resolve) })
  origin = `http://127.0.0.1:${fixture.address().port}`
}
async function connect() {
  const registration = await app.broker.rpc('admin', 'client_register', { label: 'Metadata acceptance' })
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL('./multi-agent-mcp-entry.mjs', import.meta.url)), directory],
    env: { VELMREN_ACCEPTANCE_CONNECTION: JSON.stringify({ endpoint: app.descriptor.endpoint, token: registration.token, client: registration.clientId }) }, stderr: 'pipe' })
  const client = new Client({ name: 'Metadata acceptance', version: '1' }), owner = { client, registration, closed: false }
  clients.push(owner)
  transport.stderr?.on('data', chunk => { try { clean(chunk.toString()) } catch { report.stderrLeak = true } })
  await client.connect(transport); return owner
}
async function call(owner, method, args = {}, expectedError = false) {
  stage = `${currentCase?.name ?? 'setup'}:mcp_${method}`
  const envelope = await owner.client.callTool({ name: `velmren_${method}`, arguments: args }, undefined, { timeout: 20000 })
  clean(envelope); ensure(!JSON.stringify(envelope).includes('encryptedKey'), 'PUBLIC_ENCRYPTED_KEY_LEAK'); publicResponses++
  const result = JSON.parse(envelope.content.find(item => item.type === 'text').text)
  ensure(Boolean(envelope.isError) === expectedError, result.code ?? 'UNEXPECTED_MCP_RESULT')
  return result
}
async function admin(method, args = {}) {
  const response = await fetch(`${app.descriptor.endpoint}/rpc`, { method: 'POST', signal: AbortSignal.timeout(20000),
    headers: { authorization: `Bearer ${app.descriptor.adminToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ method, args }) })
  const text = await response.text(); clean(text); ensure(!text.includes('encryptedKey'), 'PUBLIC_ENCRYPTED_KEY_LEAK'); publicResponses++
  const envelope = JSON.parse(text); ensure(envelope.ok, envelope.code ?? 'UNEXPECTED_ADMIN_RESULT'); return envelope.result
}
const local = task => app.broker.page(app.broker.tasks.get(task.taskId))
async function evaluate(task, expression) {
  const result = await local(task).send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  ensure(!result.exceptionDetails, 'FIXTURE_EVALUATION_FAILED'); return result.result?.value
}
async function identity(task) {
  const page = await evaluate(task, `(async()=>({userAgent:navigator.userAgent,
    hints:navigator.userAgentData ? {basic:navigator.userAgentData.toJSON(),high:await navigator.userAgentData.getHighEntropyValues(['architecture','bitness','model','platformVersion','uaFullVersion','fullVersionList','wow64'])}:null,
    cookies:document.cookie,headers:await (await fetch('/identity')).json()}))()`)
  const cookies = (await local(task).send('Network.getCookies', { urls: [origin + '/'] })).cookies
  ensure(page.userAgent && page.hints?.basic?.brands?.length && page.hints.high.fullVersionList?.length && page.headers['sec-ch-ua'], 'BROWSER_IDENTITY_PROBES_MISSING')
  ensure(page.headers['user-agent'] === page.userAgent && page.cookies.includes('fixture_session=original_local_cookie') && cookies.some(cookie => cookie.name === 'fixture_session' && cookie.value === 'original_local_cookie'), 'BROWSER_IDENTITY_PROBES_INVALID')
  return { ...page, cookieStore: cookies.sort((a, b) => a.name.localeCompare(b.name)) }
}
async function create(owner, item) {
  const result = await call(owner, 'create_task', { url: `${origin}/${item.name}?private=${urlMarker}#${urlMarker}`, label: 'Synthetic metadata fixture' })
  const task = { owner, item, taskId: result.taskId, ended: false }; tasks.push(task); return task
}
async function end(task) { if (!task.ended) { await call(task.owner, 'cancel', { taskId: task.taskId }); task.ended = true } }
async function inspect(task) {
  const result = await call(task.owner, 'captcha', { taskId: task.taskId, action: 'inspect' })
  ensure(result.enabled && result.challenges.length === 1 && result.challenges[0].supported, 'EXPECTED_SUPPORTED_WIDGET_MISSING')
  return result.challenges[0].challengeId
}
async function solve(task, challengeId) { return call(task.owner, 'captcha', { taskId: task.taskId, action: 'solve', challengeId }) }
async function poll(task, jobId) {
  const deadline = Date.now() + 10000
  while (Date.now() < deadline) {
    const result = await call(task.owner, 'captcha', { taskId: task.taskId, action: 'status', jobId })
    if (result.status !== 'pending') return result
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw failure('JOB_COMPLETION_TIMEOUT')
}
async function begin(owner, item) {
  const task = await create(owner, item), before = await identity(task), challengeId = await inspect(task), job = await solve(task, challengeId)
  ensure(job.status === 'pending', 'SOLVE_NOT_PENDING')
  await bounded(item.dispatched.promise, 'PROVIDER_DISPATCH_TIMEOUT')
  const attempts = JSON.parse(await readFile(path.join(stateDir, 'services/capsolver/attempts.json'), 'utf8'))
  ensure(attempts.entries.filter(entry => entry.taskId === task.taskId && entry.challengeId === challengeId).length === 1, 'DURABLE_ATTEMPT_NOT_RESERVED')
  const duplicate = await solve(task, challengeId)
  ensure(duplicate.jobId === job.jobId && duplicate.status === 'pending' && item.creates === 1, 'PENDING_SOLVE_REDISPATCHED')
  return { task, before, challengeId, job }
}
async function settled(item, expectedStatus, expectedCode) {
  const result = await poll(item.task, item.job.jobId)
  currentCase.outcome = { status: result.status, ...(result.code ? { code: result.code } : {}) }
  ensure(result.status === expectedStatus && (!expectedCode || result.code === expectedCode), result.code ?? 'UNEXPECTED_JOB_OUTCOME')
  const repeated = await solve(item.task, item.challengeId)
  ensure(repeated.jobId === item.job.jobId && repeated.status === result.status && item.task.item.creates === 1, 'SETTLED_SOLVE_REDISPATCHED')
  currentCase.createCalls = item.task.item.creates; currentCase.resultPolls = item.task.item.polls
  return result
}
async function noDelivery(task) {
  ensure(await evaluate(task, 'fixtureCalls.length===0 && document.querySelector("#widget input").value==="" && document.querySelector("#ordinary").value==="ordinary value"'), 'UNEXPECTED_TOKEN_DELIVERY')
}
async function checkIdentity(task, before) {
  same(await identity(task), before, 'BROWSER_IDENTITY_CHANGED')
  currentCase.identityUnchanged = { navigator: true, clientHints: true, cookies: true, requestHeaders: true }
}
async function scanDurable(directoryToScan) {
  let count = 0
  for (const entry of await readdir(directoryToScan, { withFileTypes: true })) {
    const file = path.join(directoryToScan, entry.name)
    ensure(!entry.isSymbolicLink(), 'UNEXPECTED_DURABLE_SYMLINK')
    if (entry.isDirectory()) count += await scanDurable(file)
    else if (entry.isFile()) {
      const bytes = await readFile(file)
      ensure(!probes.some(probe => bytes.includes(Buffer.from(probe)) || bytes.includes(Buffer.from(probe, 'utf16le'))), 'DURABLE_CANARY_LEAK')
      count++
    }
  }
  return count
}

try {
  const [{ CapSolverClient }, { CaptchaService }, { startBroker }] = await Promise.all([
    import(pathToFileURL(path.join(directory, 'capsolver-provider.mjs'))),
    import(pathToFileURL(path.join(directory, 'capsolver-service.mjs'))),
    import(pathToFileURL(path.join(directory, 'broker.mjs')))
  ])
  await startFixture()
  const provider = new CapSolverClient({ readKey: () => service.readKey(), fetchImpl: mockFetch, baseUrl: 'https://capsolver.invalid', pollIntervalMs: 1, timeoutMs: 30000 })
  const protector = { available: true, ensureDirectory: async () => {},
    protect: async value => { ensure(value === key, 'UNEXPECTED_KEY'); return 'U3ludGhldGljU2VhbGVkS2V5' },
    unprotect: async value => { ensure(value === 'U3ludGhldGljU2VhbGVkS2V5', 'UNEXPECTED_SEALED_KEY'); return key } }
  service = new CaptchaService(stateDir, { protector, provider }); await service.ready
  app = await startBroker({ executable, stateDir, captchaService: service,
    policy: { profileMode: 'persistent', allowedOrigins: [origin], webCompatibility: true, maxTasks: 16 },
    browserArgs: ['--headless=new', '--disable-background-networking', '--disable-component-update', '--disable-sync',
      '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost'] })
  report.browser = app.broker.browser.version; report.browserPid = app.broker.browser.process.pid
  const owner = await connect()
  await admin('captcha_settings', { action: 'save', enabled: true, key, maxRequestsPerDay: 100, maxConcurrent: 2, maxAttemptsPerTask: 3 })
  ensure((await admin('captcha_settings', { action: 'check' })).verification.status === 'valid', 'MOCK_BALANCE_NOT_VERIFIED')
  for (const kind of ['recaptcha', 'enterprise', 'turnstile']) await scenario(`${kind}_metadata_delivers_once_without_identity_mutation`, async () => {
    const fixture = fixtureFor(`success-${kind}`, kind, kind === 'enterprise' ? 'create' : 'poll'), item = await begin(owner, fixture)
    fixture.released.resolve()
    const result = await settled(item, 'delivered')
    ensure(result.receipt.applied && result.receipt.callbackInvoked && !result.receipt.deliveryUncertain, 'NATIVE_DELIVERY_NOT_CONFIRMED')
    ensure(await evaluate(item.task, `fixtureCalls.length===1 && fixtureCalls[0]===${JSON.stringify(tokenPrefix + fixture.name)} && document.querySelector('#widget input').value===fixtureCalls[0] && document.querySelector('#ordinary').value==='ordinary value'`), 'NATIVE_TOKEN_OR_CALLBACK_MISMATCH')
    await checkIdentity(item.task, item.before)
    const observation = await call(owner, 'observe', { taskId: item.task.taskId })
    ensure(observation.privacy?.active && !observation.text && !observation.title, 'TOKEN_NOT_REDACTED')
    ensure((await call(owner, 'screenshot', { taskId: item.task.taskId }, true)).code === 'SENSITIVE_SCREENSHOT_BLOCKED', 'TOKEN_SCREENSHOT_ALLOWED')
    await end(item.task)
  })
  for (const mode of ['reset', 'navigation']) await scenario(`metadata_preserves_stale_${mode}_guard`, async () => {
    const fixture = fixtureFor(`stale-${mode}`), item = await begin(owner, fixture)
    if (mode === 'reset') {
      ensure(await evaluate(item.task, 'fixtureProvider.reset(fixtureWidget)==="reset-receipt"'), 'RESET_SEMANTICS_CHANGED')
      ensure(await inspect(item.task) !== item.challengeId, 'RESET_REUSED_CHALLENGE')
    } else await call(owner, 'navigate', { taskId: item.task.taskId, url: `${origin}/${fixture.name}?fresh=1` })
    fixture.released.resolve(); await settled(item, 'failed', 'CAPTCHA_STALE')
    await noDelivery(item.task); await checkIdentity(item.task, item.before); await end(item.task)
  })
  await scenario('metadata_preserves_pending_cancellation_without_recharge', async () => {
    const fixture = fixtureFor('cancelled', 'turnstile'), item = await begin(owner, fixture)
    await call(owner, 'captcha', { taskId: item.task.taskId, action: 'cancel', jobId: item.job.jobId })
    await settled(item, 'cancelled', 'CAPTCHA_CANCELLED'); ensure(fixture.aborted, 'PROVIDER_SIGNAL_NOT_CANCELLED')
    fixture.released.resolve(); await noDelivery(item.task); await checkIdentity(item.task, item.before); await end(item.task)
  })
  for (const mode of ['create', 'poll']) await scenario(`malformed_token_${mode}_rejected_without_replay`, async () => {
    const fixture = fixtureFor(`malformed-${mode}`, mode === 'poll' ? 'turnstile' : 'recaptcha', mode, true), item = await begin(owner, fixture)
    fixture.released.resolve()
    await settled(item, mode === 'create' ? 'uncertain' : 'failed', mode === 'create' ? 'CAPTCHA_DELIVERY_UNCERTAIN' : 'CAPTCHA_PROVIDER_ERROR')
    await noDelivery(item.task); await checkIdentity(item.task, item.before); await end(item.task)
  })
  await scenario('public_status_and_durable_accounting_are_redacted_and_exact', async () => {
    const status = await admin('broker_status'), settings = await admin('captcha_settings', { action: 'get' })
    const expected = { solutionsDelivered: 3, failed: 3, cancelled: 1, uncertain: 1, persisted: true }
    ensure(Object.entries(expected).every(([key, value]) => status.captchaStats[key] === value && settings.usage[key] === value), 'OUTCOME_STATISTICS_MISMATCH')
    ensure(settings.usage.active === 0 && settings.usage.requestsLast24Hours === fixtures.size && [...fixtures.values()].every(item => item.creates === 1), 'DUPLICATE_PROVIDER_CHARGE')
    const attempts = JSON.parse(await readFile(path.join(stateDir, 'services/capsolver/attempts.json'), 'utf8')); clean(attempts)
    ensure(attempts.entries.length === fixtures.size, 'DURABLE_ATTEMPT_COUNT_MISMATCH')
    const statistics = JSON.parse(await readFile(path.join(stateDir, 'services/capsolver/statistics.json'), 'utf8')); clean(statistics)
    ensure(Object.entries(expected).filter(([key]) => key !== 'persisted').every(([key, value]) => statistics[key] === value) && statistics.pending.length === 0, 'DURABLE_STATISTICS_MISMATCH')
    await app.broker.trace.flush()
    clean(await readFile(path.join(stateDir, 'requests.jsonl'), 'utf8'))
    report.statistics = status.captchaStats; report.attempts = attempts.entries.length
    report.publicResponsesChecked = publicResponses
    report.providerCalls = Object.fromEntries([...fixtures].map(([name, item]) => [name, { creates: item.creates, polls: item.polls }]))
  })
} catch (error) {
  report.cases.push({ name: 'setup_or_harness', passed: false, stage, code: codeOf(error) }); console.log(`FAIL setup_or_harness ${codeOf(error)}`)
} finally {
  let cleanup = true
  service?.close()
  for (const item of fixtures.values()) item.released.resolve()
  for (const task of tasks) if (!task.ended && !task.owner.closed) await end(task).catch(() => { cleanup = false })
  for (const owner of clients) await owner.client.close().then(() => { owner.closed = true }, () => { cleanup = false })
  report.cleanup.clientsClosed = clients.every(owner => owner.closed)
  if (app) {
    await app.close().catch(() => { cleanup = false }); report.cleanup.browserClosed = app.broker.browser.closed
    try { clean(app.broker.browser.stderr) } catch { cleanup = false; report.cleanup.outputLeak = true }
  }
  if (fixture) { fixture.closeAllConnections(); await new Promise(resolve => fixture.close(resolve)); report.cleanup.fixtureClosed = true }
  await scenario('all_durable_files_exclude_private_provider_canaries', async () => {
    report.durableFilesChecked = await scanDurable(stateDir)
    ensure(report.durableFilesChecked > 3 && !report.stderrLeak, 'REDACTION_COVERAGE_INCOMPLETE')
  })
  report.passed = cleanup && report.cleanup.browserClosed === true && !report.stderrLeak && report.cases.length === 10 && report.cases.every(item => item.passed)
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2))
}
if (!report.passed) process.exitCode = 1

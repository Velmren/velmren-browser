// Synthetic localhost widgets/provider only. Never contacts CapSolver.
// node test/capsolver-integration.mjs BROWSER_EXE NEW_OUTPUT_DIR [--agent-directory=DIR]
import { createServer } from 'node:http'
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises'
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
const key = `SyntheticKey_${randomUUID()}`, tokenPrefix = `SyntheticToken_${randomUUID()}_`, urlMarker = `SyntheticUrl_${randomUUID()}`
const probes = [key, tokenPrefix, urlMarker], clients = [], tasks = [], gates = new Map(), counts = new Map()
const expectedTotals = { solutionsDelivered: 6, failed: 3, cancelled: 2, uncertain: 2, persisted: true }
const expectedAttempts = 13
let app, fixture, origin, service, CaptchaService, startBroker, heldNavigation, stage = 'setup', caseName = 'setup', publicResponses = 0
const failure = code => Object.assign(new Error('Synthetic acceptance failure'), { code })
const ensure = (condition, code) => { if (!condition) throw failure(code) }
const codeOf = error => /^[A-Z][A-Z_]{2,64}$/.test(error?.code ?? '') ? error.code : 'UNEXPECTED_FAILURE'
function clean(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  ensure(!probes.some(probe => text.includes(probe)), 'PUBLIC_CANARY_LEAK')
  ensure(!text.includes('encryptedKey'), 'PUBLIC_ENCRYPTED_KEY_LEAK')
}
function sameStats(actual, expected, code) {
  ensure(actual && Object.entries(expected).every(([name, value]) => actual[name] === value), code)
}
async function scenario(name, run) {
  stage = caseName = name
  try { await run(); report.cases.push({ name, passed: true }); console.log(`PASS ${name}`) }
  catch (error) {
    report.cases.push({ name, passed: false, stage, code: codeOf(error), location: error.stack?.split('\n').find(line => line.includes('capsolver-integration.mjs:') && !/at (failure|ensure|sameStats) /.test(line))?.trim() })
    console.log(`FAIL ${name} ${codeOf(error)}`)
  }
}
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
function gateFor(name) {
  ensure(!gates.has(name), 'DUPLICATE_FIXTURE_GATE')
  const gate = { dispatched: deferred(), released: deferred(), returned: deferred(), aborted: false }
  gates.set(name, gate); return gate
}
const protector = () => ({ available: true, ensureDirectory: async () => {},
  protect: async value => { ensure(value === key, 'UNEXPECTED_KEY'); return 'U3ludGhldGljU2VhbGVkS2V5' },
  unprotect: async value => { ensure(value === 'U3ludGhldGljU2VhbGVkS2V5', 'UNEXPECTED_SEALED_KEY'); return key } })
const provider = {
  balance: async () => ({ balanceUsd: 12.5 }),
  async solve(task, { signal, onDispatch }) {
    const name = task.websiteKey?.replace(/^synthetic-/, ''), gate = gates.get(name)
    ensure(gate && task.websiteURL === origin + '/', 'UNEXPECTED_PROVIDER_TASK')
    counts.set(name, (counts.get(name) ?? 0) + 1)
    await onDispatch()
    gate.dispatched.resolve()
    await new Promise((resolve, reject) => {
      const abort = () => { gate.aborted = true; reject(failure('CAPTCHA_CANCELLED')) }
      signal.addEventListener('abort', abort, { once: true })
      gate.released.promise.then(() => { signal.removeEventListener('abort', abort); resolve() })
      if (signal.aborted) abort()
    })
    if (name === 'provider-failure') throw Object.assign(new Error(key + tokenPrefix), { code: 'CAPTCHA_PROVIDER_ERROR' })
    if (name === 'provider-uncertain') throw Object.assign(new Error(key + tokenPrefix), { code: 'CAPTCHA_DELIVERY_UNCERTAIN' })
    gate.returned.resolve()
    return { token: tokenPrefix + name }
  }
}
async function startFixture() {
  fixture = createServer(async (request, response) => {
    const name = new URL(request.url, 'http://127.0.0.1').pathname.slice(1)
    if (name === 'held-navigation' && heldNavigation) {
      heldNavigation.requested.resolve()
      await heldNavigation.released.promise
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
      'content-security-policy': "default-src 'self'; script-src 'unsafe-inline'; connect-src 'none'; frame-src 'none'; form-action 'none'" })
    if (!/^[a-z-]+$/.test(name)) { response.end('<!doctype html>Safe destination'); return }
    response.end(`<!doctype html><meta charset="utf-8"><title>Synthetic CAPTCHA acceptance</title>
      <h1>Synthetic local widget</h1><p id="echo"></p><input id="ordinary" value="ordinary value">
      <form><div id="widget" class="g-recaptcha" data-sitekey="synthetic-${name}" data-callback="fixtureCallback"><textarea name="g-recaptcha-response"></textarea></div></form>
      <script>globalThis.fixtureCalls=[]; globalThis.fixtureCallback=token=>{
        fixtureCalls.push(token); document.title=token; document.querySelector('#echo').textContent=token;
        if(${JSON.stringify(name)}==='callback-uncertain') throw new Error('Synthetic callback failure');
      };
      if(${JSON.stringify(name)}==='reset-generation') {
        globalThis.grecaptcha={
          render(node, options) { return 'synthetic-widget-id'; },
          reset(id) { document.querySelector('textarea').value=''; return 'reset-receipt'; }
        };
        globalThis.fixtureWidget=grecaptcha.render(document.querySelector('#widget'),{sitekey:'synthetic-reset-generation',callback:fixtureCallback});
      }</script>`)
  })
  await new Promise((resolve, reject) => { fixture.once('error', reject); fixture.listen(0, '127.0.0.1', resolve) })
  origin = `http://127.0.0.1:${fixture.address().port}`
}
async function start() {
  service = new CaptchaService(stateDir, { protector: protector(), provider })
  await service.ready
  app = await startBroker({ executable, stateDir, captchaService: service,
    policy: { profileMode: 'persistent', allowedOrigins: [origin], webCompatibility: true, maxTasks: 16 },
    browserArgs: ['--headless=new', '--disable-background-networking'] })
  report.browser = app.broker.browser.version
  report.browserPids ??= []; report.browserPids.push(app.broker.browser.process.pid)
}
async function connect(label) {
  const registration = await app.broker.rpc('admin', 'client_register', { label })
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL('./multi-agent-mcp-entry.mjs', import.meta.url)), directory],
    env: { VELMREN_ACCEPTANCE_CONNECTION: JSON.stringify({ endpoint: app.descriptor.endpoint, token: registration.token, client: registration.clientId }) }, stderr: 'pipe' })
  const client = new Client({ name: label, version: '1' })
  const owner = { client, registration, closed: false }
  clients.push(owner)
  transport.stderr?.on('data', chunk => { try { clean(chunk.toString()) } catch { report.stderrLeak = true } })
  await client.connect(transport); return owner
}
async function call(owner, method, args = {}, expectedError = false) {
  stage = `${caseName}:mcp_${method}`
  const envelope = await owner.client.callTool({ name: `velmren_${method}`, arguments: args }, undefined, { timeout: 20000 })
  clean(envelope); publicResponses++
  const result = JSON.parse(envelope.content.find(item => item.type === 'text').text)
  if (expectedError !== null) ensure(Boolean(envelope.isError) === expectedError, result.code ?? 'UNEXPECTED_MCP_RESULT')
  return result
}
async function http(owner, method, args = {}, expectedError = false) {
  stage = `${caseName}:http_${method}`
  const response = await fetch(`${app.descriptor.endpoint}/rpc`, { method: 'POST', signal: AbortSignal.timeout(20000),
    headers: { authorization: `Bearer ${owner === 'admin' ? app.descriptor.adminToken : owner.registration.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ method, args }) })
  const text = await response.text(); clean(text); publicResponses++
  const envelope = JSON.parse(text)
  ensure(!envelope.ok === expectedError, envelope.code ?? 'UNEXPECTED_HTTP_RESULT')
  return envelope.ok ? envelope.result : envelope
}
async function create(owner, name) {
  const result = await call(owner, 'create_task', { url: `${origin}/${name}?private=${urlMarker}#${urlMarker}`, label: 'Synthetic CAPTCHA acceptance' })
  const task = { owner, taskId: result.taskId, ended: false, name }; tasks.push(task); return task
}
async function end(task) { if (!task.ended) { await call(task.owner, 'cancel', { taskId: task.taskId }); task.ended = true } }
const local = task => app.broker.page(app.broker.tasks.get(task.taskId))
async function fixtureBoolean(task, expression) {
  const result = await local(task).send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  ensure(!result.exceptionDetails && result.result?.value === true, 'FIXTURE_BOOLEAN_MISMATCH')
}
async function inspect(task) {
  const result = await call(task.owner, 'captcha', { taskId: task.taskId, action: 'inspect' })
  ensure(result.enabled && result.challenges.length === 1 && result.challenges[0].supported, 'EXPECTED_WIDGET_MISSING')
  clean(result); return result.challenges[0].challengeId
}
async function solve(task, challengeId) {
  const result = await call(task.owner, 'captcha', { taskId: task.taskId, action: 'solve', challengeId })
  ensure(result.status === 'pending' && typeof result.jobId === 'string', 'SOLVE_DID_NOT_RETURN_PENDING')
  return result
}
async function poll(task, jobId) {
  const deadline = Date.now() + 10000
  while (Date.now() < deadline) {
    const result = await call(task.owner, 'captcha', { taskId: task.taskId, action: 'status', jobId })
    if (result.status !== 'pending') return result
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw failure('JOB_COMPLETION_TIMEOUT')
}
async function begin(owner, name) {
  const gate = gateFor(name), task = await create(owner, name), challengeId = await inspect(task), job = await solve(task, challengeId)
  await bounded(gate.dispatched.promise, 'PROVIDER_DISPATCH_TIMEOUT')
  return { gate, task, challengeId, job }
}
async function noDelivery(task) {
  await fixtureBoolean(task, 'fixtureCalls.length===0 && document.querySelector("textarea").value==="" && document.querySelector("#ordinary").value==="ordinary value"')
}
async function delivered(task, { calls = 1, ordinary = 'ordinary value' } = {}) {
  await fixtureBoolean(task, `fixtureCalls.length===${calls} && fixtureCalls.every(value=>value===${JSON.stringify(tokenPrefix + task.name)}) && document.querySelector('textarea').value===fixtureCalls[0] && document.title===fixtureCalls[0] && document.querySelector('#ordinary').value===${JSON.stringify(ordinary)}`)
}
async function closeClients() {
  const results = await Promise.allSettled(clients.filter(owner => !owner.closed).map(async owner => { await owner.client.close(); owner.closed = true }))
  ensure(results.every(result => result.status === 'fulfilled'), 'CLIENT_CLEANUP_FAILED')
}

try {
  ;({ CaptchaService } = await import(pathToFileURL(path.join(directory, 'capsolver-service.mjs'))))
  ;({ startBroker } = await import(pathToFileURL(path.join(directory, 'broker.mjs'))))
  await startFixture(); await start()
  const a = await connect('CAPTCHA acceptance A'), b = await connect('CAPTCHA acceptance B')

  await scenario('tool_23_schema_and_no_settings_or_key_tool', async () => {
    const catalog = await a.client.listTools(); clean(catalog)
    ensure(catalog.tools.length === 24, 'WRONG_TOOL_COUNT')
    const tool = catalog.tools.find(item => item.name === 'velmren_captcha')
    ensure(tool && tool.inputSchema.additionalProperties === false && tool.inputSchema.oneOf.length === 3, 'CAPTCHA_SCHEMA_MISSING')
    ensure(JSON.stringify(tool.inputSchema.properties.action.enum) === JSON.stringify(['inspect', 'solve', 'status', 'cancel']), 'CAPTCHA_ACTION_SCHEMA')
    ensure(['taskId', 'pageId', 'frameId', 'challengeId', 'jobId'].every(name => tool.inputSchema.properties[name]), 'CAPTCHA_SCOPE_SCHEMA')
    ensure(!catalog.tools.some(item => /settings|api_key|private_input/.test(item.name)), 'PRIVATE_TOOL_EXPOSED')
  })
  await scenario('disabled_has_no_hooks_or_provider_calls_and_client_settings_denied', async () => {
    const task = await create(a, 'disabled')
    await fixtureBoolean(task, 'Object.getOwnPropertyDescriptor(globalThis,"grecaptcha")===undefined && Object.getOwnPropertyDescriptor(globalThis,"turnstile")===undefined && !Object.keys(globalThis).some(key=>key.startsWith("__velmrenCaptcha_"))')
    const result = await call(a, 'captcha', { taskId: task.taskId, action: 'inspect' })
    ensure(result.enabled === false && result.challenges.length === 0, 'DISABLED_INSPECT_ACTIVE')
    const rejected = await call(a, 'captcha', { taskId: task.taskId, action: 'solve', challengeId: randomUUID() }, true)
    ensure(rejected.code === 'CAPTCHA_DISABLED' && counts.size === 0, 'DISABLED_SOLVER_DISPATCHED')
    for (const owner of [a, b]) for (const action of ['get', 'check', 'remove_key']) await http(owner, 'captcha_settings', { action }, true)
    const settings = await http('admin', 'captcha_settings', { action: 'get' })
    ensure(!settings.enabled && !settings.hasKey, 'DEFAULT_SETTINGS_ENABLED')
    await end(task)
  })
  await scenario('admin_configuration_enables_new_tasks_without_key_echo', async () => {
    const settings = await http('admin', 'captcha_settings', { action: 'save', enabled: true, key, maxRequestsPerDay: 100, maxConcurrent: 2, maxAttemptsPerTask: 3 })
    ensure(settings.enabled && settings.hasKey, 'SETTINGS_NOT_ENABLED')
    const verified = await http('admin', 'captcha_settings', { action: 'check' })
    ensure(verified.verification.status === 'valid', 'MOCK_BALANCE_NOT_VERIFIED')
    const disk = await readFile(path.join(stateDir, 'services/capsolver/settings.json'), 'utf8')
    ensure(!probes.some(probe => disk.includes(probe)), 'PLAINTEXT_KEY_ON_DISK')
    await http(a, 'captcha_settings', { action: 'save', enabled: false, maxRequestsPerDay: 1, maxConcurrent: 1, maxAttemptsPerTask: 1 }, true)
    ensure((await http('admin', 'captcha_settings', { action: 'get' })).enabled, 'CLIENT_CHANGED_SETTINGS')
  })
  await scenario('two_clients_native_delivery_once_deduplication_and_owner_isolation', async () => {
    const first = await begin(a, 'delivered-a'), second = await begin(b, 'delivered-b')
    const again = await call(a, 'captcha', { taskId: first.task.taskId, action: 'solve', challengeId: first.challengeId })
    ensure(again.jobId === first.job.jobId && again.status === 'pending', 'PENDING_JOB_NOT_DEDUPLICATED')
    for (const action of ['inspect', 'solve', 'status', 'cancel']) {
      const args = { taskId: first.task.taskId, action, ...(action === 'solve' ? { challengeId: first.challengeId } : ['status', 'cancel'].includes(action) ? { jobId: first.job.jobId } : {}) }
      ensure((await call(b, 'captcha', args, true)).code === 'NOT_FOUND', 'CROSS_OWNER_CAPTCHA_ALLOWED')
    }
    ensure((await call(b, 'captcha', { taskId: second.task.taskId, action: 'status', jobId: first.job.jobId }, true)).code === 'NOT_FOUND', 'CROSS_TASK_JOB_VISIBLE')
    const list = await call(a, 'list_tasks'); ensure(!list.tasks.some(task => task.taskId === second.task.taskId), 'PEER_TASK_VISIBLE')
    first.gate.released.resolve(); second.gate.released.resolve()
    for (const item of [first, second]) {
      const result = await poll(item.task, item.job.jobId)
      ensure(result.status === 'delivered' && result.receipt.applied && result.receipt.callbackInvoked && !result.receipt.deliveryUncertain, 'NATIVE_DELIVERY_NOT_CONFIRMED')
      sameStats(result.captchaStats, { solutionsDelivered: 1, failed: 0, cancelled: 0, uncertain: 0, persisted: true }, 'TASK_DELIVERY_STATS')
      await delivered(item.task)
      const repeat = await call(item.task.owner, 'captcha', { taskId: item.task.taskId, action: 'solve', challengeId: item.challengeId })
      ensure(repeat.jobId === item.job.jobId && repeat.status === 'delivered' && counts.get(item.task.name) === 1, 'DELIVERED_JOB_REDISPATCHED')
      const observation = await call(item.task.owner, 'observe', { taskId: item.task.taskId })
      ensure(observation.privacy?.active && !observation.text && !observation.title, 'SOLVE_DID_NOT_PROTECT_PAGE')
      await http(item.task.owner, 'task_observe', { taskId: item.task.taskId })
      ensure((await call(item.task.owner, 'screenshot', { taskId: item.task.taskId }, true)).code === 'SENSITIVE_SCREENSHOT_BLOCKED', 'TOKEN_SCREENSHOT_ALLOWED')
      await end(item.task)
    }
  })
  await scenario('pending_provider_cancel_and_status_bypass_task_action_queue', async () => {
    const item = await begin(a, 'cancelled')
    heldNavigation = { requested: deferred(), released: deferred() }
    let navigationCompleted = false
    const navigation = http(a, 'task_navigate', { taskId: item.task.taskId, url: `${origin}/held-navigation` }).finally(() => { navigationCompleted = true })
    try {
      await bounded(heldNavigation.requested.promise, 'NAVIGATION_REQUEST_TIMEOUT')
      ensure(!navigationCompleted && (await http('admin', 'broker_status')).activeActions > 0, 'QUEUE_PROBE_ALREADY_COMPLETED')
      const started = performance.now()
      await call(a, 'captcha', { taskId: item.task.taskId, action: 'status', jobId: item.job.jobId })
      await call(a, 'captcha', { taskId: item.task.taskId, action: 'cancel', jobId: item.job.jobId })
      const result = await poll(item.task, item.job.jobId)
      ensure(performance.now() - started < 1500 && !navigationCompleted, 'CAPTCHA_CONTROL_BLOCKED_BY_QUEUE')
      ensure(result.status === 'cancelled' && item.gate.aborted, 'PENDING_PROVIDER_NOT_CANCELLED')
      sameStats(result.captchaStats, { solutionsDelivered: 0, failed: 0, cancelled: 1, uncertain: 0 }, 'CANCELLED_STATS')
      item.gate.released.resolve(); heldNavigation.released.resolve(); await navigation
      await noDelivery(item.task)
    } finally {
      await call(a, 'captcha', { taskId: item.task.taskId, action: 'cancel', jobId: item.job.jobId }).catch(() => {})
      heldNavigation.released.resolve(); await navigation; item.gate.released.resolve(); await end(item.task)
    }
  })
  for (const cancel of [false, true]) await scenario(`solution_${cancel ? 'cancelled_while_queued' : 'delivery_waits_for_native_action'}`, async () => {
    const item = await begin(a, cancel ? 'queued-cancel' : 'queued-delivery')
    const observation = await call(a, 'observe', { taskId: item.task.taskId })
    const target = observation.elements.find(element => element.tag === 'input' && element.type === 'text')
    ensure(target, 'ORDINARY_INPUT_MISSING')
    const page = local(item.task), send = page.send, act = page.act, entered = deferred(), released = deferred(), attempted = deferred(), events = []
    const value = 'ordinary queued value'
    let intercepted = false, actCompleted = false
    page.send = function(method, params, ...rest) {
      if (method === 'Input.insertText' && params?.text === value && !intercepted) {
        intercepted = true; events.push('action-held'); entered.resolve()
        return released.promise.then(() => send.call(this, method, params, ...rest))
      }
      if (method === 'Runtime.callFunctionOn' && params?.arguments?.[0]?.value === 'apply') {
        events.push('captcha-apply'); attempted.resolve()
      }
      return send.call(this, method, params, ...rest)
    }
    page.act = async function(...args) { const result = await act.apply(this, args); events.push('action-finished'); return result }
    const action = call(a, 'act', { taskId: item.task.taskId, observationId: observation.observationId,
      actions: [{ type: 'fill', ref: target.ref, value }] }).finally(() => { actCompleted = true })
    action.catch(() => {})
    try {
      await bounded(entered.promise, 'NATIVE_ACTION_HOLD_NOT_REACHED')
      item.gate.released.resolve(); await bounded(item.gate.returned.promise, 'PROVIDER_RESULT_NOT_READY')
      // Give the renderer an explicit opportunity to reveal an out-of-queue
      // dispatch; also record ordering at actual native action/apply commands.
      const earlyApply = await Promise.race([attempted.promise.then(() => true), new Promise(resolve => setTimeout(() => resolve(false), 150))])
      ensure(!earlyApply && !actCompleted, 'CAPTCHA_APPLIED_DURING_NATIVE_ACTION')
      await noDelivery(item.task)
      const started = performance.now()
      const status = await call(a, 'captcha', { taskId: item.task.taskId, action: 'status', jobId: item.job.jobId })
      ensure(status.status === 'pending', 'QUEUED_JOB_ALREADY_TERMINAL')
      if (cancel) await call(a, 'captcha', { taskId: item.task.taskId, action: 'cancel', jobId: item.job.jobId })
      ensure(performance.now() - started < 1500 && !actCompleted, 'QUEUED_STATUS_CANCEL_BLOCKED')
      released.resolve()
      const actionResult = await action
      ensure(actionResult.actionResult?.delivery === 'delivered_verified', 'HELD_NATIVE_ACTION_FAILED')
      const result = await poll(item.task, item.job.jobId)
      ensure(result.status === (cancel ? 'cancelled' : 'delivered'), 'QUEUED_DELIVERY_OUTCOME')
      sameStats(result.captchaStats, { solutionsDelivered: cancel ? 0 : 1, failed: 0, cancelled: cancel ? 1 : 0, uncertain: 0 }, 'QUEUED_DELIVERY_STATS')
      if (cancel) {
        ensure(!events.includes('captcha-apply'), 'CANCELLED_QUEUE_DISPATCHED_TOKEN')
        await fixtureBoolean(item.task, `fixtureCalls.length===0 && document.querySelector('textarea').value==='' && document.querySelector('#ordinary').value===${JSON.stringify(value)}`)
      } else {
        ensure(events.indexOf('action-finished') >= 0 && events.indexOf('action-finished') < events.indexOf('captcha-apply'), 'APPLY_PRECEDED_ACTION_COMPLETION')
        await delivered(item.task, { ordinary: value })
      }
      report.nativeActionOrdering ??= []; report.nativeActionOrdering.push({ cancelled: cancel, events })
    } finally {
      released.resolve(); item.gate.released.resolve()
      await action.catch(() => {}); page.send = send; page.act = act
      await call(a, 'captcha', { taskId: item.task.taskId, action: 'cancel', jobId: item.job.jobId }).catch(() => {})
      await end(item.task)
    }
  })
  await scenario('unrelated_dom_mutation_keeps_valid_challenge_deliverable', async () => {
    const item = await begin(a, 'unrelated-dom')
    await fixtureBoolean(item.task, 'document.querySelector("h1").textContent="Unrelated live content changed";true')
    item.gate.released.resolve()
    const result = await poll(item.task, item.job.jobId)
    ensure(result.status === 'delivered', 'UNRELATED_DOM_INVALIDATED_CHALLENGE')
    await delivered(item.task); await end(item.task)
  })
  await scenario('provider_reset_creates_new_challenge_and_deduplicates_each_generation', async () => {
    const item = await begin(a, 'reset-generation'); item.gate.released.resolve()
    ensure((await poll(item.task, item.job.jobId)).status === 'delivered', 'FIRST_GENERATION_NOT_DELIVERED')
    await delivered(item.task)
    await fixtureBoolean(item.task, 'grecaptcha.reset(fixtureWidget)==="reset-receipt" && document.querySelector("textarea").value===""')
    const nextChallenge = await inspect(item.task)
    ensure(nextChallenge !== item.challengeId, 'RESET_REUSED_CHALLENGE_ID')
    const old = await call(a, 'captcha', { taskId: item.task.taskId, action: 'solve', challengeId: item.challengeId })
    ensure(old.jobId === item.job.jobId && old.status === 'delivered' && counts.get(item.task.name) === 1, 'OLD_GENERATION_REDISPATCHED')
    gates.delete(item.task.name)
    const nextGate = gateFor(item.task.name), nextJob = await solve(item.task, nextChallenge)
    await bounded(nextGate.dispatched.promise, 'RESET_PROVIDER_DISPATCH_TIMEOUT')
    const duplicate = await call(a, 'captcha', { taskId: item.task.taskId, action: 'solve', challengeId: nextChallenge })
    ensure(nextJob.jobId !== item.job.jobId && duplicate.jobId === nextJob.jobId && counts.get(item.task.name) === 2, 'RESET_GENERATION_DEDUP_FAILED')
    nextGate.released.resolve()
    const result = await poll(item.task, nextJob.jobId)
    ensure(result.status === 'delivered', 'RESET_GENERATION_NOT_DELIVERED')
    sameStats(result.captchaStats, { solutionsDelivered: 2, failed: 0, cancelled: 0, uncertain: 0 }, 'RESET_GENERATION_STATS')
    await delivered(item.task, { calls: 2 }); await end(item.task)
  })
  for (const mode of ['dom', 'navigation']) await scenario(`stale_${mode}_rejects_delivery`, async () => {
    const item = await begin(a, `stale-${mode}`)
    if (mode === 'dom') await fixtureBoolean(item.task, 'document.querySelector("#widget").replaceWith(document.querySelector("#widget").cloneNode(true));true')
    else await call(a, 'navigate', { taskId: item.task.taskId, url: `${origin}/fresh-document` })
    item.gate.released.resolve()
    const result = await poll(item.task, item.job.jobId)
    ensure(result.status === 'failed' && result.code === 'CAPTCHA_STALE', 'STALE_SOLUTION_DELIVERED')
    sameStats(result.captchaStats, { solutionsDelivered: 0, failed: 1, cancelled: 0, uncertain: 0 }, 'STALE_STATS')
    await noDelivery(item.task); await end(item.task)
  })
  for (const [name, outcome, code] of [['provider-failure', 'failed', 'CAPTCHA_PROVIDER_ERROR'], ['provider-uncertain', 'uncertain', 'CAPTCHA_DELIVERY_UNCERTAIN'], ['callback-uncertain', 'uncertain', null]]) await scenario(`${name.replaceAll('-', '_')}_has_safe_result_and_exact_counter`, async () => {
    const item = await begin(a, name); item.gate.released.resolve()
    const result = await poll(item.task, item.job.jobId)
    ensure(result.status === outcome && (!code || result.code === code), 'WRONG_FAILURE_OUTCOME')
    sameStats(result.captchaStats, { solutionsDelivered: 0, failed: outcome === 'failed' ? 1 : 0, cancelled: 0, uncertain: outcome === 'uncertain' ? 1 : 0 }, 'FAILURE_STATS')
    if (name === 'callback-uncertain') { ensure(result.receipt?.deliveryUncertain && result.receipt?.callbackInvoked, 'CALLBACK_UNCERTAINTY_LOST'); await delivered(item.task) }
    else await noDelivery(item.task)
    const repeated = await call(a, 'captcha', { taskId: item.task.taskId, action: 'solve', challengeId: item.challengeId })
    ensure(repeated.jobId === item.job.jobId && repeated.status === outcome && counts.get(name) === 1, 'FAILED_JOB_REDISPATCHED')
    await http(a, 'task_captcha', { taskId: item.task.taskId, action: 'status', jobId: item.job.jobId })
    await end(item.task)
  })
  await scenario('global_task_and_persisted_statistics_match_no_public_secret_leaks', async () => {
    const status = await http('admin', 'broker_status'), settings = await http('admin', 'captcha_settings', { action: 'get' })
    sameStats(status.captchaStats, expectedTotals, 'GLOBAL_STATS_MISMATCH'); sameStats(settings.usage, expectedTotals, 'SETTINGS_STATS_MISMATCH')
    ensure(settings.usage.requestsLast24Hours === expectedAttempts && settings.usage.active === 0, 'ATTEMPT_ACCOUNTING_MISMATCH')
    const disk = JSON.parse(await readFile(path.join(stateDir, 'services/capsolver/statistics.json'), 'utf8'))
    const { persisted, ...totals } = expectedTotals; sameStats(disk, totals, 'DISK_STATS_MISMATCH')
    await app.broker.trace.flush()
    const trace = await readFile(path.join(stateDir, 'requests.jsonl'), 'utf8'); clean(trace)
    ensure(trace.split('\n').some(line => line.includes('task_captcha')), 'CAPTCHA_TRACE_MISSING')
    ensure(!report.stderrLeak && publicResponses > 40, 'PUBLIC_TRANSPORT_COVERAGE')
    report.publicResponsesChecked = publicResponses; report.providerCalls = Object.fromEntries(counts); report.statistics = status.captchaStats
  })
  await scenario('statistics_survive_broker_service_restart_and_task_counters_reset', async () => {
    for (const task of tasks) await end(task)
    await closeClients(); await app.close(); ensure(app.broker.browser.closed, 'FIRST_BROWSER_NOT_CLOSED')
    await start()
    const owner = await connect('CAPTCHA acceptance after restart')
    sameStats((await http('admin', 'broker_status')).captchaStats, expectedTotals, 'RESTART_GLOBAL_STATS_MISMATCH')
    const settings = await http('admin', 'captcha_settings', { action: 'get' })
    ensure(settings.enabled && settings.hasKey && settings.usage.requestsLast24Hours === expectedAttempts, 'RESTART_CONFIGURATION_MISMATCH')
    const task = await create(owner, 'after-restart')
    const result = await call(owner, 'captcha', { taskId: task.taskId, action: 'inspect' })
    sameStats(result.captchaStats, { solutionsDelivered: 0, failed: 0, cancelled: 0, uncertain: 0, persisted: true }, 'NEW_TASK_INHERITED_STATS')
    await end(task)
  })
} catch (error) {
  report.cases.push({ name: 'setup_or_harness', passed: false, stage, code: codeOf(error) })
  console.log(`FAIL setup_or_harness ${codeOf(error)}`)
} finally {
  let cleanup = true
  service?.close()
  heldNavigation?.released.resolve()
  for (const gate of gates.values()) gate.released.resolve()
  for (const task of tasks) if (!task.ended && !task.owner.closed) await end(task).catch(() => { cleanup = false })
  await closeClients().catch(() => { cleanup = false })
  report.cleanup.clientsClosed = clients.every(owner => owner.closed)
  if (app) {
    await app.close().catch(() => { cleanup = false }); report.cleanup.browserClosed = app.broker.browser.closed
    try { clean(app.broker.browser.stderr) } catch { cleanup = false; report.cleanup.outputLeak = true }
  }
  if (fixture) { fixture.closeAllConnections(); await new Promise(resolve => fixture.close(resolve)); report.cleanup.fixtureClosed = true }
  report.passed = cleanup && report.cleanup.browserClosed === true && !report.stderrLeak && report.cases.length > 0 && report.cases.every(item => item.passed)
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2))
}
if (!report.passed) process.exitCode = 1

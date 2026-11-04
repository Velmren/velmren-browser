import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { AgentBroker } from '../runtime.mjs'
import { BrowserPipe } from '../cdp.mjs'
import { startBroker } from '../broker.mjs'

const results = fileURLToPath(new URL('../test-results/', import.meta.url))
await mkdir(results, { recursive: true })
const stateDirectory = () => mkdtemp(path.join(results, 'profile-login-runtime-'))
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const policy = { profileMode: 'persistent', allowWeb: true }
const startArgs = { url: 'https://example.com/login', userConfirmed: true }
const errorCode = code => error => error.code === code

function fakeBrowser(name = 'automated') {
  const browser = new EventEmitter()
  browser.version = { product: name }
  browser.closed = false
  browser.calls = []
  browser.send = async (method, params) => {
    browser.calls.push({ method, params })
    if (method === 'Target.getBrowserContexts') return { defaultBrowserContextId: `context-${name}`, browserContextIds: [] }
    if (method === 'Target.getTargets') return { targetInfos: [] }
    return {}
  }
  browser.closeForManual = async () => { browser.calls.push({ method: 'closeForManual' }); browser.closed = true; browser.emit('closed') }
  browser.close = async () => { browser.calls.push({ method: 'close' }); browser.closed = true; browser.emit('closed') }
  return browser
}

function fakeManual() {
  return {
    receipt: null, open: false, calls: [],
    async load() { return this.receipt ? this.status() : null },
    async prepare(value) { this.calls.push('prepare'); this.receipt = { ...value, secret: 'must not escape' } },
    async launch(url) { this.calls.push('launch'); this.url = url; this.open = true },
    async status() { return { ...this.receipt, windowOpen: this.open, executable: 'private-executable', profile: 'private-profile' } },
    async assertClosed(loginId) {
      this.calls.push('assertClosed')
      assert.equal(loginId, this.receipt.loginId)
      if (this.open) throw Object.assign(new Error('Manual browser is still open'), { code: 'MANUAL_PROFILE_STILL_OPEN' })
    },
    async finish(loginId, options) { await this.assertClosed(loginId); assert.equal(options.userConfirmed, true); this.calls.push('finish') },
    async complete(loginId) { assert.equal(loginId, this.receipt.loginId); this.calls.push('complete'); this.receipt = null },
    async close() { this.calls.push('close') }
  }
}

async function fixture(t, overrides = {}) {
  const browser = fakeBrowser(), replacement = fakeBrowser('replacement'), manual = fakeManual()
  const broker = new AgentBroker(browser, await stateDirectory(), { ...policy, ...overrides }, { trace: null, manualSession: manual, browserFactory: async () => replacement })
  t.after(() => { clearInterval(broker.lifecycleTimer); broker.unbindBrowser() })
  const start = owner => broker.rpc(owner ?? 'codex', 'profile_login_start', startArgs)
  const finish = (loginId, owner = 'codex') => broker.rpc(owner, 'profile_login_finish', { loginId, userConfirmed: true })
  return { broker, browser, replacement, manual, start, finish }
}

test('login gates the profile before receipt I/O and closes automation before native launch', async t => {
  const f = await fixture(t), gate = deferred(), prepare = f.manual.prepare.bind(f.manual)
  f.manual.prepare = async value => { await prepare(value); await gate.promise }
  f.manual.launch = async url => { assert.equal(f.browser.closed, true); f.manual.url = url; f.manual.open = true }
  const starting = f.start()
  assert.equal(f.broker.profileLogin.phase, 'stopping-automation')
  await assert.rejects(f.start('claude'), errorCode('PROFILE_LOGIN_ACTIVE'))
  await assert.rejects(f.broker.rpc('claude', 'task_create', { url: 'https://example.com/' }), errorCode('PROFILE_LOGIN_ACTIVE'))
  assert.equal(f.browser.calls.length, 0)
  gate.resolve()
  const result = await starting
  assert.equal(result.phase, 'manual')
  assert.equal(result.automationConnected, false)
  assert.equal(result.windowOpen, true)
  assert.equal(f.manual.url, startArgs.url)
  assert.deepEqual(Object.keys(result).sort(), ['automationConnected', 'loginId', 'phase', 'windowOpen'])
})

test('busy peers, retained cleanup, pages, downloads, slots, and queues prevent login without cancelling peers', async t => {
  const cases = [
    broker => broker.tasks.set('peer', { taskId: 'peer', owner: 'claude', state: 'agent-active', pages: new Map() }),
    broker => broker.tasks.set('peer', { taskId: 'peer', state: 'completed', pages: new Map([['page', {}]]) }),
    broker => broker.tasks.set('peer', { taskId: 'peer', state: 'cancelled', pages: new Map(), contextId: 'retained' }),
    broker => broker.tasks.set('peer', { taskId: 'peer', state: 'cancelled', pages: new Map(), cleanupRetryQueued: true }),
    broker => broker.tasks.set('peer', { taskId: 'peer', state: 'completed', pages: new Map(), downloads: [{ state: 'inProgress' }] }),
    broker => broker.downloadOwners.set('download', { task: null }),
    broker => broker.contexts.set('retained', {}),
    broker => broker.pendingAttachments.set('pending', {}),
    broker => { broker.slots.active = 1 },
    broker => broker.slots.waiters.push(() => {}),
    broker => { broker.queuedOperations = 1 },
    broker => { broker.protocolActive = 1 }
  ]
  for (const setup of cases) {
    const f = await fixture(t)
    setup(f.broker)
    const before = f.broker.tasks.get('peer')?.state
    await assert.rejects(f.start(), errorCode('PROFILE_LOGIN_BUSY'))
    assert.equal(f.broker.tasks.get('peer')?.state, before)
    assert.equal(f.broker.profileLogin.phase, 'automated')
    assert.deepEqual(f.manual.calls, [])
    assert.deepEqual(f.browser.calls, [])
  }
})

test('ordinary login requires persistent unrestricted web policy and explicit confirmation', async t => {
  for (const override of [{ profileMode: 'isolated' }, { allowWeb: false }, { allowedOrigins: [] }, { allowedOrigins: ['https://example.com'] }]) {
    const f = await fixture(t, override)
    await assert.rejects(f.start(), errorCode('PROFILE_LOGIN_POLICY'))
    assert.equal(f.broker.profileLogin.phase, 'automated')
  }
  const f = await fixture(t)
  await assert.rejects(f.broker.startProfileLogin('codex', { ...startArgs, userConfirmed: false }), errorCode('INVALID_ARGUMENTS'))
  for (const url of ['file:///private', 'https://u:p@example.com/', 'https://example.com/a b', 'https://example.com/\n']) {
    await assert.rejects(f.broker.startProfileLogin('codex', { ...startArgs, url }), errorCode('INVALID_ARGUMENTS'))
    assert.equal(f.broker.profileLogin.phase, 'automated')
    assert.deepEqual(f.manual.calls, [])
  }
})

test('queued creation and task serialization recheck the profile phase on entry', async t => {
  const f = await fixture(t), slot = deferred(), queue = deferred()
  f.broker.slots.max = 1
  const occupying = f.broker.slots.run(() => slot.promise)
  const creating = f.broker.rpc('codex', 'task_create', { url: 'https://example.com/' })
  const creationRejected = assert.rejects(creating, errorCode('PROFILE_LOGIN_ACTIVE'))
  let entered = false
  const queued = f.broker.serialize({ queue: queue.promise }, () => { entered = true })
  const queueRejected = assert.rejects(queued, errorCode('PROFILE_LOGIN_ACTIVE'))
  f.broker.profileLogin = { phase: 'manual' }
  slot.resolve(); queue.resolve()
  await Promise.all([occupying, creationRejected, queueRejected])
  assert.equal(entered, false)
  assert.equal(f.broker.tasks.size, 0)
  assert.equal(f.browser.calls.length, 0)
})

test('manual mode permits registration, status, lists, heartbeat and release but blocks task mutations and shutdown', async t => {
  const f = await fixture(t)
  const client = await f.broker.rpc('admin', 'client_register', { label: 'owner', policyIdentity: f.broker.policyIdentity, leaseMs: 30000 })
  const { loginId } = await f.start(client.clientId)
  const peer = await f.broker.rpc('admin', 'client_register', { label: 'peer' })
  assert.ok(peer.clientId)
  assert.equal((await f.broker.rpc(client.clientId, 'client_heartbeat')).leaseMs, 30000)
  assert.deepEqual((await f.broker.rpc('claude', 'task_list')).tasks, [])
  const status = await f.broker.rpc('admin', 'broker_status')
  assert.equal(status.browserHealthy, false)
  assert.equal(status.profileLogin.phase, 'manual')
  assert.equal((await f.broker.rpc('claude', 'profile_login_status')).loginId, loginId)
  for (const [method, args] of [
    ['task_cancel', { taskId: 'missing' }], ['task_select_page', { taskId: 'missing', pageId: 'page' }],
    ['task_control', { taskId: 'missing', action: 'show' }], ['shutdown', {}]
  ]) await assert.rejects(f.broker.rpc('admin', method, args), errorCode('PROFILE_LOGIN_ACTIVE'))
  await f.broker.rpc(client.clientId, 'client_release')
  f.broker.checkIdle(Date.now() + 120000)
  assert.equal(f.broker.retirementRequested, undefined)
  await assert.rejects(f.broker.close(), errorCode('PROFILE_LOGIN_ACTIVE'))
  assert.equal(f.broker.stopping, false)
  assert.equal(f.manual.open, true)
  assert.ok(!f.manual.calls.includes('close'))
  await assert.rejects(f.finish(loginId, client.clientId), errorCode('UNAUTHORIZED'))
  f.manual.open = false
  await f.finish(loginId, 'admin')
})

test('finish requires the matching owner, explicit confirmation and native process exit', async t => {
  const f = await fixture(t), { loginId } = await f.start()
  await assert.rejects(f.finish(loginId, 'claude'), errorCode('UNAUTHORIZED'))
  await assert.rejects(f.finish('old-id'), errorCode('NOT_FOUND'))
  await assert.rejects(f.broker.finishProfileLogin('codex', { loginId, userConfirmed: false }), errorCode('INVALID_ARGUMENTS'))
  await assert.rejects(f.finish(loginId), errorCode('MANUAL_PROFILE_STILL_OPEN'))
  assert.equal(f.replacement.calls.length, 0)
  f.manual.open = false
  assert.equal((await f.broker.rpc('codex', 'profile_login_status')).phase, 'awaiting-confirmation')
  assert.ok(f.manual.receipt)
  assert.equal((await f.finish(loginId)).phase, 'automated')
})

test('rebind resets browser maps and clears the receipt only after initialization', async t => {
  const f = await fixture(t), { loginId } = await f.start()
  f.manual.open = false
  for (const map of [f.broker.sessions, f.broker.targets, f.broker.ownedTargets, f.broker.frameOwners]) map.set('old', {})
  const complete = f.manual.complete.bind(f.manual)
  f.manual.complete = async id => {
    assert.equal(f.broker.browser, f.replacement)
    assert.equal(f.broker.profileLogin.phase, 'restarting')
    assert.equal(f.replacement.calls.at(-1).method, 'Target.setAutoAttach')
    assert.equal(f.broker.profileContextId, 'context-replacement')
    await complete(id)
  }
  const result = await f.finish(loginId)
  assert.deepEqual(result, { phase: 'automated', automationConnected: true, windowOpen: false })
  assert.equal(f.manual.receipt, null)
  for (const map of [f.broker.sessions, f.broker.targets, f.broker.ownedTargets, f.broker.frameOwners]) assert.equal(map.size, 0)
  assert.equal((await f.broker.rpc('admin', 'broker_status')).browserHealthy, true)
})

test('old browser callbacks cannot mutate or shut down a rebound generation', async t => {
  const f = await fixture(t), oldProtocol = f.broker.listener, oldClosed = f.broker.closedListener
  let shutdowns = 0
  f.broker.onShutdown = () => { shutdowns++ }
  const { loginId } = await f.start()
  f.manual.open = false
  await f.finish(loginId)
  const task = { taskId: 'new', state: 'agent-active', pages: new Map() }
  f.broker.tasks.set(task.taskId, task)
  f.broker.targets.set('new-page', { page: { title: 'current' } })
  oldProtocol({ method: 'Target.targetInfoChanged', params: { targetInfo: { targetId: 'new-page', title: 'stale' } } })
  oldClosed()
  f.browser.emit('closed')
  assert.equal(task.state, 'agent-active')
  assert.equal(f.broker.targets.get('new-page').page.title, 'current')
  assert.equal(shutdowns, 0)
  assert.equal(f.browser.listenerCount('protocol'), 0)
  assert.equal(f.browser.listenerCount('closed'), 0)
})

test('replacement exit during receipt completion rejects finish and schedules normal broker shutdown', async t => {
  const f = await fixture(t), { loginId } = await f.start(), completing = deferred(), release = deferred(), shutdown = deferred()
  f.manual.open = false
  const complete = f.manual.complete.bind(f.manual)
  f.manual.complete = async id => { completing.resolve(); await release.promise; return complete(id) }
  let shutdowns = 0
  f.broker.onShutdown = () => { shutdowns++; shutdown.resolve() }
  const finishing = f.finish(loginId)
  const rejected = assert.rejects(finishing, errorCode('PROFILE_LOGIN_RESTART_FAILED'))
  await completing.promise
  f.replacement.closed = true
  f.replacement.emit('closed')
  assert.equal(f.broker.profileLogin.phase, 'restarting')
  assert.equal(shutdowns, 0)
  release.resolve()
  await rejected
  const watchdog = setTimeout(() => shutdown.reject(new Error('Browser exit was not handed to normal shutdown')), 1000)
  try { await shutdown.promise } finally { clearTimeout(watchdog) }
  assert.equal(shutdowns, 1)
  assert.equal(f.manual.receipt, null)
  assert.equal(f.broker.profileLogin.phase, 'automated')
  assert.equal((await f.broker.rpc('admin', 'broker_status')).browserHealthy, false)
  assert.ok(!f.manual.calls.includes('close'))
  assert.ok(!f.replacement.calls.some(call => call.method === 'closeForManual'))
})

test('failed automated exit leaves the receipt and profile gate intact without native launch', async t => {
  const f = await fixture(t)
  f.browser.closeForManual = async () => { throw new Error('exit timeout') }
  await assert.rejects(f.start(), { code: 'BROKER_ERROR', message: 'Browser operation failed.' })
  assert.equal(f.broker.profileLogin.phase, 'stopping-automation')
  assert.ok(f.manual.receipt)
  assert.ok(!f.manual.calls.includes('launch'))
  assert.equal((await f.broker.profileLoginStatus()).recoveryRequired, true)
  await assert.rejects(f.broker.rpc('codex', 'task_create', { url: 'https://example.com/' }), errorCode('PROFILE_LOGIN_ACTIVE'))
})

test('failed rebind retains the receipt and permits an explicit retry after the failed child exits', async t => {
  const f = await fixture(t), { loginId } = await f.start()
  f.manual.open = false
  const send = f.replacement.send
  f.replacement.send = async () => { throw new Error('initialization failed') }
  await assert.rejects(f.finish(loginId), { code: 'BROKER_ERROR', message: 'Browser operation failed.' })
  assert.ok(f.manual.receipt)
  assert.equal(f.broker.profileLogin.phase, 'awaiting-confirmation')
  assert.equal(f.replacement.closed, true)
  const next = fakeBrowser('retry')
  f.broker.browserFactory = async () => next
  f.replacement.send = send
  await f.finish(loginId)
  assert.equal(f.broker.browser, next)
  assert.equal(f.manual.receipt, null)
})

test('concurrent finish calls cannot launch two automated browsers', async t => {
  const f = await fixture(t), { loginId } = await f.start(), gate = deferred()
  f.manual.open = false
  let launches = 0
  f.broker.browserFactory = async () => { launches++; await gate.promise; return f.replacement }
  const finishing = f.finish(loginId)
  await assert.rejects(f.finish(loginId, 'admin'), errorCode('PROFILE_LOGIN_ACTIVE'))
  gate.resolve()
  await finishing
  assert.equal(launches, 1)
})

test('failed replacement protocol work drains before another browser can be bound', async t => {
  const f = await fixture(t), { loginId } = await f.start(), gate = deferred(), entered = deferred()
  f.manual.open = false
  f.broker.onProtocol = async () => { entered.resolve(); await gate.promise; f.broker.targets.set('stale', {}) }
  const send = f.replacement.send
  f.replacement.send = async (method, params) => {
    if (method === 'Target.setDiscoverTargets') f.replacement.emit('protocol', { method: 'late-event' })
    if (method === 'Target.setAutoAttach') throw new Error('failed initialization')
    return send(method, params)
  }
  const finishing = f.finish(loginId)
  const rejected = assert.rejects(finishing, { code: 'BROKER_ERROR', message: 'Browser operation failed.' })
  await entered.promise
  await assert.rejects(f.finish(loginId, 'admin'), errorCode('PROFILE_LOGIN_ACTIVE'))
  gate.resolve()
  await rejected
  assert.equal(f.broker.protocolActive, 0)
  f.broker.browserFactory = async () => fakeBrowser('retry')
  await f.finish(loginId)
  assert.equal(f.broker.targets.has('stale'), false)
})

test('broker health does not wait for native process inspection', async t => {
  const f = await fixture(t)
  await f.start()
  f.manual.status = async () => { throw new Error('process inspection unavailable') }
  const status = await f.broker.rpc('admin', 'broker_status')
  assert.equal(status.browserHealthy, false)
  assert.equal(status.profileLogin.phase, 'manual')
})

test('strict pipe close waits for actual exit after Browser.close acknowledgement', async () => {
  const pipe = new BrowserPipe(), child = new EventEmitter(), acknowledged = deferred()
  pipe.process = child
  let closed = false
  pipe.send = async method => { assert.equal(method, 'Browser.close'); acknowledged.resolve(); return {} }
  const closing = pipe.closeForManual().then(() => { closed = true })
  await acknowledged.promise
  assert.equal(closed, false)
  child.emit('exit', 0)
  await closing
  assert.equal(closed, true)
})

test('strict pipe close never treats EOF as process exit and never force kills', async () => {
  const pipe = new BrowserPipe(), child = new EventEmitter()
  pipe.process = child
  pipe.closed = true
  let killed = false
  child.kill = () => { killed = true }
  pipe.send = async () => { throw new Error('pipe EOF') }
  await assert.rejects(pipe.closeForManual({ timeoutMs: 15 }), errorCode('PROFILE_LOGIN_BROWSER_NOT_EXITED'))
  assert.equal(killed, false)
  assert.equal(child.listenerCount('exit'), 0)
})

test('broker keeps endpoint credentials and lock during login and relaunches with original options', async t => {
  const stateDir = await stateDirectory(), manual = fakeManual(), launches = [], browsers = []
  const app = await startBroker({ executable: process.execPath, stateDir, policy, browserArgs: ['--lang=en-US'], manualSession: manual,
    browserFactory: async options => { launches.push(options); const browser = fakeBrowser(String(launches.length)); browsers.push(browser); return browser } })
  t.after(async () => { app.broker.profileLogin = { phase: 'automated' }; await app.close() })
  const descriptor = await readFile(path.join(stateDir, 'connection.json'), 'utf8')
  const lock = await readFile(path.join(stateDir, 'broker.lock'), 'utf8')
  const { loginId } = await app.broker.rpc('codex', 'profile_login_start', startArgs)
  await assert.rejects(app.close(), errorCode('PROFILE_LOGIN_ACTIVE'))
  assert.equal(app.server.listening, true)
  assert.equal(await readFile(path.join(stateDir, 'connection.json'), 'utf8'), descriptor)
  assert.equal(await readFile(path.join(stateDir, 'broker.lock'), 'utf8'), lock)
  manual.open = false
  await app.broker.rpc('codex', 'profile_login_finish', { loginId, userConfirmed: true })
  assert.deepEqual(launches[1], launches[0])
  assert.equal(app.broker.browser, browsers[1])
  assert.equal(await readFile(path.join(stateDir, 'connection.json'), 'utf8'), descriptor)
})

test('startup refuses a surviving or malformed manual receipt before automated launch', async () => {
  for (const malformed of [false, true]) {
    const stateDir = await stateDirectory(), manual = fakeManual()
    manual.receipt = { loginId: 'surviving' }
    await writeFile(path.join(stateDir, 'manual-profile.json'), malformed ? '{bad' : JSON.stringify(manual.receipt))
    let launches = 0
    await assert.rejects(startBroker({ executable: process.execPath, stateDir, policy, ...(malformed ? {} : { manualSession: manual }), browserFactory: async () => { launches++; return fakeBrowser() } }), /manual|receipt/i)
    assert.equal(launches, 0)
    await assert.rejects(readFile(path.join(stateDir, 'broker.lock')), { code: 'ENOENT' })
    if (malformed) assert.equal(await readFile(path.join(stateDir, 'manual-profile.json'), 'utf8'), '{bad')
  }
})

test('fresh broker startup does not require a pre-existing browser profile directory', async t => {
  const stateDir = await stateDirectory()
  const app = await startBroker({ executable: process.execPath, stateDir, policy, browserFactory: async () => fakeBrowser() })
  t.after(() => app.close())
  assert.equal(app.broker.profileLogin.phase, 'automated')
  assert.equal(app.server.listening, true)
})

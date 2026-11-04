import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { EventEmitter, once } from 'node:events'
import net from 'node:net'
import { mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { startBroker } from '../broker.mjs'
import { ManualProfileSession, readManualProfileReceipt } from '../manual-profile.mjs'
import { acquireStartupGate, adminRpc, connectManaged, parseManagedOptions, resolveManagedOptions, runManagedBroker } from '../managed-runtime.mjs'
import { effectivePolicyIdentity } from '../policy-identity.mjs'
import { parseProfileRecoveryOptions } from '../profile-recovery.mjs'

const results = fileURLToPath(new URL('../test-results/', import.meta.url))
await mkdir(results, { recursive: true })
const policy = { profileMode: 'persistent', allowWeb: true }
const recovery = { loginId: 'recovery-login', userConfirmed: true }
const child = spawn(process.execPath, ['-e', ''], { windowsHide: true, stdio: 'ignore' })
await once(child, 'exit')
const deadPid = child.pid
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }

async function stateDirectory(prefix = 'profile-recovery-') {
  for (let attempt = 0; attempt < 10; attempt++) {
    const stateDir = await realpath(await mkdtemp(path.join(results, prefix)))
    try { await (await acquireStartupGate(stateDir, 100))(); return stateDir }
    catch (error) {
      // Windows reserves TCP ranges which can include a random fixture's hash.
      if (error.code !== 'STARTUP_LOCK_FAILED' || attempt === 9) throw error
    }
  }
}

async function fixture({ inspect, receipt: changes = {} } = {}) {
  const stateDir = await stateDirectory()
  const executable = await realpath(process.execPath)
  const profile = path.join(stateDir, 'browser-profile')
  await mkdir(profile)
  const receipt = { version: 1, id: recovery.loginId, owner: 'prior-client', state: 'manual', brokerPid: deadPid,
    browserPid: deadPid, browserStartTime: 'recorded-native-process-creation-time', executable, profile,
    policyIdentity: effectivePolicyIdentity(policy), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ...changes }
  await writeFile(path.join(stateDir, 'manual-profile.json'), JSON.stringify(receipt))
  await writeFile(path.join(stateDir, 'profile-policy.json'), JSON.stringify({ schema: 1, identity: effectivePolicyIdentity(policy) }))
  const events = []
  const manualSession = new ManualProfileSession({ stateDir, executable, profile, policyIdentity: effectivePolicyIdentity(policy),
    inspectProcesses: async query => {
      events.push('inspect')
      assert.equal(query.pid, receipt.browserPid)
      assert.equal(query.profile, profile)
      return inspect ? inspect(query, events.filter(event => event === 'inspect').length) : { matches: [], requested: null }
    } })
  const browser = new EventEmitter()
  browser.closed = false
  browser.version = { product: 'recovery-fixture' }
  browser.send = async method => {
    assert.ok(await readManualProfileReceipt(stateDir), 'The crash guard must remain throughout initialization')
    events.push(method)
    return method === 'Target.getBrowserContexts' ? { defaultBrowserContextId: 'default-context', browserContextIds: [] } : {}
  }
  browser.closeForManual = async () => { events.push('closeForManual'); browser.closed = true }
  browser.close = async () => { events.push('close'); browser.closed = true }
  const browserFactory = async () => {
    events.push('launch')
    assert.equal((await readManualProfileReceipt(stateDir)).id, recovery.loginId)
    return browser
  }
  const config = { executable, stateDir, policy, manualSession, browserFactory }
  const options = await resolveManagedOptions({ executable, stateDir, startupTimeoutMs: 2000 })
  options.policyFile = path.join(stateDir, 'requested-policy.json')
  await writeFile(options.policyFile, JSON.stringify(policy))
  return { config, options, stateDir, receipt, manualSession, browser, events,
    start: extra => startBroker({ ...config, profileLoginRecovery: recovery, ...extra }),
    managedStart: incoming => startBroker({ ...config, ...incoming }) }
}

async function assertUnlocked(stateDir) {
  await assert.rejects(readFile(path.join(stateDir, 'broker.lock')), { code: 'ENOENT' })
  await (await acquireStartupGate(stateDir, 100))()
}

async function ownership(f, pid = deadPid, extra = {}) {
  const files = {
    'managed-owner.json': JSON.stringify({ schema: 1, purpose: 'velmren-managed-broker', stateDir: f.stateDir, pid, nonce: 'old-owner', ...extra }),
    'connection.json': JSON.stringify({ endpoint: 'http://127.0.0.1:1', pid, adminToken: 'old-recovery-credential' }),
    'broker.lock': String(pid)
  }
  for (const [name, value] of Object.entries(files)) await writeFile(path.join(f.stateDir, name), value)
  return files
}

async function crashRecovery(f) {
  const script = `
    import { writeFile } from 'node:fs/promises'
    import path from 'node:path'
    const { runManagedBroker } = await import(process.argv[1])
    const options = JSON.parse(process.argv[2]), recovery = JSON.parse(process.argv[3])
    await runManagedBroker(options, { profileLoginRecovery: recovery, startBroker: async () => {
      await writeFile(path.join(options.stateDir, 'broker.lock'), String(process.pid))
      await writeFile(path.join(options.stateDir, 'connection.json'), JSON.stringify({ endpoint: 'http://127.0.0.1:1', pid: process.pid, adminToken: 'crashed-fixture-credential' }))
      process.exit(23)
    } })`
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, new URL('../managed-runtime.mjs', import.meta.url).href, JSON.stringify(f.options), JSON.stringify(recovery)], { windowsHide: true, stdio: 'ignore' })
  const [code] = await once(child, 'exit')
  assert.equal(code, 23, 'Fixture must exit abruptly after writing recovery ownership')
  assert.notEqual(child.pid, f.receipt.brokerPid)
  return { pid: child.pid, owner: JSON.parse(await readFile(path.join(f.stateDir, 'managed-owner.json'), 'utf8')) }
}

test('ordinary broker and managed startup retain the manual receipt guard', async () => {
  const f = await fixture()
  await assert.rejects(startBroker(f.config), { code: 'MANUAL_PROFILE_ACTIVE' })
  await assert.rejects(runManagedBroker(f.options, { startBroker: f.managedStart }), { code: 'MANUAL_PROFILE_ACTIVE' })
  await assert.rejects(connectManaged(f.options, { spawnDaemon: () => { throw new Error('must not spawn') } }), { code: 'MANUAL_PROFILE_ACTIVE' })
  assert.deepEqual(f.events, [])
  assert.deepEqual(await readManualProfileReceipt(f.stateDir), f.receipt)
  await assertUnlocked(f.stateDir)
})

test('recovery requires exact confirmation, login, policy, configuration and recorded process identity', async t => {
  const cases = [
    ['missing confirmation', { profileLoginRecovery: { loginId: recovery.loginId } }, {}, 'USER_CONFIRMATION_REQUIRED'],
    ['string confirmation', { profileLoginRecovery: { ...recovery, userConfirmed: 'true' } }, {}, 'USER_CONFIRMATION_REQUIRED'],
    ['missing login', { profileLoginRecovery: { userConfirmed: true } }, {}, 'INVALID_ARGUMENTS'],
    ['wrong login', { profileLoginRecovery: { ...recovery, loginId: 'different' } }, {}],
    ['changed policy', { policy: { ...policy, webCompatibility: true } }, {}],
    ['changed executable', {}, { executable: path.join(results, 'different-browser.exe') }],
    ['changed profile', {}, { profile: path.join(results, 'different-profile') }],
    ['missing PID', {}, { browserPid: null }],
    ['missing start time', {}, { browserStartTime: null }],
    ['incomplete launch', {}, { state: 'preparing' }],
    ['live controller', {}, { brokerPid: process.pid }, 'BROKER_STILL_RUNNING']
  ]
  for (const [name, extra, receipt, code = 'MANUAL_PROFILE_RECOVERY_REQUIRED'] of cases) await t.test(name, async () => {
    const f = await fixture({ receipt })
    await assert.rejects(f.start(extra), { code })
    assert.deepEqual(f.events, [])
    assert.deepEqual(await readManualProfileReceipt(f.stateDir), f.receipt)
    await assertUnlocked(f.stateDir)
  })
})

test('missing receipt and changed receipt during load refuse recovery without launching', async () => {
  const f = await fixture()
  const originalLoad = f.manualSession.load.bind(f.manualSession)
  f.manualSession.load = async () => {
    await writeFile(path.join(f.stateDir, 'manual-profile.json'), JSON.stringify({ ...f.receipt, browserStartTime: 'changed-identity' }))
    return originalLoad()
  }
  await assert.rejects(f.start(), { code: 'MANUAL_PROFILE_RECOVERY_REQUIRED' })
  assert.ok(!f.events.includes('launch'))
  await assertUnlocked(f.stateDir)
  const empty = await stateDirectory('profile-recovery-empty-')
  await assert.rejects(startBroker({ ...f.config, stateDir: empty, profileLoginRecovery: recovery }), { code: 'MANUAL_PROFILE_RECOVERY_REQUIRED' })
  await assertUnlocked(empty)
})

test('open, unverifiable, reused-PID and freshly reopened manual browsers never launch automation', async t => {
  for (const scenario of ['open', 'inspection failure', 'PID reuse', 'reopened']) await t.test(scenario, async () => {
    const f = await fixture({ inspect: (query, count) => {
      const identity = { pid: query.pid, executable: query.executable, startTime: 'another-process-start' }
      if (scenario === 'inspection failure') throw new Error('native inspection failed')
      if (scenario === 'PID reuse') return { matches: [], requested: identity }
      if (scenario === 'reopened' && count === 1) return { matches: [], requested: null }
      return { matches: [identity], requested: identity }
    } })
    await assert.rejects(f.start(), { code: ['open', 'reopened'].includes(scenario) ? 'MANUAL_PROFILE_OPEN' : 'MANUAL_PROFILE_RECOVERY_REQUIRED' })
    assert.ok(!f.events.includes('launch'))
    assert.ok(await readManualProfileReceipt(f.stateDir))
    await assertUnlocked(f.stateDir)
  })
})

test('recovery proves closure afresh then keeps the receipt until replacement CDP initialization', async t => {
  const f = await fixture()
  const app = await f.start()
  t.after(() => app.close())
  assert.deepEqual(f.events, ['inspect', 'inspect', 'inspect', 'launch', 'Target.getBrowserContexts', 'Browser.setDownloadBehavior', 'Target.setDiscoverTargets', 'Target.setAutoAttach'])
  assert.equal(await readManualProfileReceipt(f.stateDir), null)
  assert.equal(app.broker.browser, f.browser)
  assert.equal((await adminRpc(app.descriptor, 'broker_status')).profileLogin.automationConnected, true)
})

test('factory and initialization failures preserve receipt and release startup locks', async t => {
  for (const failure of ['factory', 'initialization']) await t.test(failure, async () => {
    const f = await fixture()
    if (failure === 'initialization') f.browser.send = async () => { assert.ok(await readManualProfileReceipt(f.stateDir)); throw new Error('fixture init failed') }
    await assert.rejects(f.start(failure === 'factory' ? { browserFactory: async () => { f.events.push('factory failure'); throw new Error('fixture factory failed') } } : {}), /fixture .* failed/)
    assert.ok(await readManualProfileReceipt(f.stateDir))
    assert.equal(f.events.includes('closeForManual'), failure === 'initialization')
    assert.equal(f.browser.closed, failure === 'initialization')
    await assertUnlocked(f.stateDir)
    await assert.rejects(startBroker(f.config), { code: 'MANUAL_PROFILE_ACTIVE' })
  })
})

test('managed recovery refuses live and mismatched owners without moving their files', async t => {
  for (const pid of [process.pid, deadPid]) await t.test(pid === process.pid ? 'live owner' : 'mismatched owner', async () => {
    const f = await fixture({ receipt: pid === process.pid ? { brokerPid: process.pid } : {} })
    const files = await ownership(f, pid === process.pid ? pid : process.pid)
    let launched = false
    await assert.rejects(runManagedBroker(f.options, { profileLoginRecovery: recovery, startBroker: () => { launched = true } }), { code: pid === process.pid ? 'BROKER_STILL_RUNNING' : 'OWNERSHIP_MISMATCH' })
    assert.equal(launched, false)
    for (const [name, value] of Object.entries(files)) assert.equal(await readFile(path.join(f.stateDir, name), 'utf8'), value)
    assert.deepEqual(await readManualProfileReceipt(f.stateDir), f.receipt)
    await (await acquireStartupGate(f.stateDir, 100))()
  })
})

test('managed recovery backs up stale owner files, completes login and permits normal client reuse', async t => {
  const f = await fixture()
  const files = await ownership(f)
  const app = await runManagedBroker(f.options, { profileLoginRecovery: recovery, startBroker: f.managedStart })
  t.after(() => app.close())
  assert.equal(app.reused, false)
  assert.equal(await readManualProfileReceipt(f.stateDir), null)
  const backups = await readdir(path.join(f.stateDir, 'recovery'))
  assert.equal(backups.length, 1)
  for (const [name, value] of Object.entries(files)) assert.equal(await readFile(path.join(f.stateDir, 'recovery', backups[0], name), 'utf8'), value)
  const connection = await connectManaged(f.options, { spawnDaemon: () => { throw new Error('must reuse recovery broker') } })
  assert.equal(connection.endpoint, app.descriptor.endpoint)
  assert.equal(f.events.filter(event => event === 'launch').length, 1)
})

test('failed managed recovery keeps the original receipt and permits a later explicit retry', async t => {
  const f = await fixture()
  const files = await ownership(f)
  await assert.rejects(runManagedBroker(f.options, { profileLoginRecovery: recovery,
    startBroker: incoming => f.managedStart({ ...incoming, browserFactory: async () => { throw new Error('fixture recovery failure') } }) }), /fixture recovery failure/)
  assert.equal((await readManualProfileReceipt(f.stateDir)).brokerPid, deadPid)
  await assert.rejects(readFile(path.join(f.stateDir, 'managed-owner.json')), { code: 'ENOENT' })
  await assertUnlocked(f.stateDir)
  const backups = await readdir(path.join(f.stateDir, 'recovery'))
  for (const [name, value] of Object.entries(files)) assert.equal(await readFile(path.join(f.stateDir, 'recovery', backups[0], name), 'utf8'), value)
  await assert.rejects(runManagedBroker(f.options), { code: 'MANUAL_PROFILE_ACTIVE' })
  const app = await runManagedBroker(f.options, { profileLoginRecovery: recovery, startBroker: f.managedStart })
  t.after(() => app.close())
  assert.equal(await readManualProfileReceipt(f.stateDir), null)
})

test('cancelled recovery closes only its just-launched replacement and retains the receipt', async () => {
  const f = await fixture(), controller = new AbortController()
  await ownership(f)
  await assert.rejects(runManagedBroker(f.options, { profileLoginRecovery: recovery, signal: controller.signal,
    startBroker: incoming => f.managedStart({ ...incoming, browserFactory: async () => {
      controller.abort(Object.assign(new Error('fixture cancellation'), { code: 'STARTUP_CANCELLED' }))
      return f.browser
    } }) }), { code: 'STARTUP_CANCELLED' })
  assert.equal(f.browser.closed, true)
  assert.ok(await readManualProfileReceipt(f.stateDir))
  assert.ok(!f.events.includes('Target.getBrowserContexts'))
  await assert.rejects(readFile(path.join(f.stateDir, 'managed-owner.json')), { code: 'ENOENT' })
  await assertUnlocked(f.stateDir)
})

test('abrupt recovery attempt death retains exact lineage for a later explicit recovery', async t => {
  const f = await fixture()
  await ownership(f)
  const crashed = await crashRecovery(f)
  assert.deepEqual(crashed.owner.profileLoginRecovery, { schema: 1, loginId: recovery.loginId, brokerPid: f.receipt.brokerPid,
    browserPid: f.receipt.browserPid, browserStartTime: f.receipt.browserStartTime, executable: f.receipt.executable,
    profile: f.receipt.profile, policyIdentity: f.receipt.policyIdentity })
  assert.deepEqual(await readManualProfileReceipt(f.stateDir), f.receipt)
  await assert.rejects(runManagedBroker(f.options), { code: 'MANUAL_PROFILE_ACTIVE' })
  const app = await runManagedBroker(f.options, { profileLoginRecovery: recovery, startBroker: f.managedStart })
  t.after(() => app.close())
  assert.equal(await readManualProfileReceipt(f.stateDir), null)
  const backups = await readdir(path.join(f.stateDir, 'recovery'))
  assert.equal(backups.length, 2)
  const owners = await Promise.all(backups.map(dir => readFile(path.join(f.stateDir, 'recovery', dir, 'managed-owner.json'), 'utf8').then(JSON.parse)))
  assert.ok(owners.some(owner => owner.pid === crashed.pid && owner.profileLoginRecovery.loginId === recovery.loginId))
})

test('recovery rejects dead attempt lineage mismatches, mismatched locks, and live attempts', async t => {
  const origin = await fixture()
  const crashed = await crashRecovery(origin)
  const cases = [
    ['loginId', 'another-login'], ['brokerPid', crashed.pid], ['browserPid', crashed.pid], ['browserStartTime', 'other-time'],
    ['executable', path.join(results, 'other.exe')], ['profile', path.join(results, 'other-profile')], ['policyIdentity', 'other-policy'], ['schema', 2],
    ['missing lineage'], ['mismatched lock'], ['mismatched descriptor'], ['live attempt']
  ]
  for (const [name, value] of cases) await t.test(name, async () => {
    const f = await fixture()
    const lineage = { ...crashed.owner.profileLoginRecovery, profile: f.receipt.profile }
    if (value !== undefined) lineage[name] = value
    const pid = name === 'live attempt' ? process.pid : crashed.pid
    const files = await ownership(f, pid, { executable: f.receipt.executable, ...(name === 'missing lineage' ? {} : { profileLoginRecovery: lineage }) })
    if (name === 'mismatched lock') files['broker.lock'] = String(deadPid)
    if (name === 'mismatched descriptor') files['connection.json'] = JSON.stringify({ endpoint: 'http://127.0.0.1:1', pid: deadPid, adminToken: 'different-fixture-credential' })
    for (const name of ['broker.lock', 'connection.json']) await writeFile(path.join(f.stateDir, name), files[name])
    await assert.rejects(runManagedBroker(f.options, { profileLoginRecovery: recovery, startBroker: f.managedStart }), { code: name === 'live attempt' ? 'BROKER_STILL_RUNNING' : 'OWNERSHIP_MISMATCH' })
    for (const [name, value] of Object.entries(files)) assert.equal(await readFile(path.join(f.stateDir, name), 'utf8'), value)
    assert.deepEqual(await readManualProfileReceipt(f.stateDir), f.receipt)
    assert.ok(!f.events.includes('launch'))
  })
})

test('cancellation during deferred CDP initialization keeps the receipt and closes the owned replacement', async () => {
  const f = await fixture(), controller = new AbortController(), initializing = deferred(), resume = deferred()
  await ownership(f)
  const send = f.browser.send
  f.browser.send = async method => {
    const result = await send(method)
    if (method === 'Target.setAutoAttach') { initializing.resolve(); await resume.promise }
    return result
  }
  const starting = runManagedBroker(f.options, { profileLoginRecovery: recovery, signal: controller.signal, startBroker: f.managedStart })
  await initializing.promise
  assert.ok(await readManualProfileReceipt(f.stateDir))
  controller.abort(Object.assign(new Error('fixture initialization cancelled'), { code: 'STARTUP_CANCELLED' }))
  resume.resolve()
  await assert.rejects(starting, { code: 'STARTUP_CANCELLED' })
  assert.ok(await readManualProfileReceipt(f.stateDir))
  assert.equal(f.browser.closed, true)
  assert.ok(f.events.includes('closeForManual'))
  await assert.rejects(readFile(path.join(f.stateDir, 'connection.json')), { code: 'ENOENT' })
  await assert.rejects(readFile(path.join(f.stateDir, 'managed-owner.json')), { code: 'ENOENT' })
  await assertUnlocked(f.stateDir)
})

test('cancellation at queued receipt completion is checked before its unlink commit', async () => {
  const f = await fixture(), controller = new AbortController(), completing = deferred(), resume = deferred()
  const complete = f.manualSession.complete.bind(f.manualSession)
  f.manualSession.complete = async (loginId, options) => { completing.resolve(); await resume.promise; return complete(loginId, options) }
  const starting = f.start({ signal: controller.signal })
  await completing.promise
  controller.abort(Object.assign(new Error('fixture commit cancelled'), { code: 'STARTUP_CANCELLED' }))
  resume.resolve()
  await assert.rejects(starting, { code: 'STARTUP_CANCELLED' })
  assert.ok(await readManualProfileReceipt(f.stateDir))
  assert.equal(f.browser.closed, true)
  await assertUnlocked(f.stateDir)
})

test('cancellation after successful receipt commit does not report a failed recovery', async t => {
  const f = await fixture(), controller = new AbortController()
  const launch = f.config.browserFactory
  let launches = 0
  f.config.browserFactory = async () => ++launches === 1 ? launch() : f.browser
  const complete = f.manualSession.complete.bind(f.manualSession)
  f.manualSession.complete = async (loginId, options) => {
    const result = await complete(loginId, options)
    controller.abort(Object.assign(new Error('fixture late cancellation'), { code: 'STARTUP_CANCELLED' }))
    return result
  }
  const app = await runManagedBroker(f.options, { profileLoginRecovery: recovery, signal: controller.signal, startBroker: f.managedStart })
  t.after(() => app.close())
  assert.equal(app.profileLoginRecovered, true)
  assert.equal(await readManualProfileReceipt(f.stateDir), null)
  assert.equal(f.browser.closed, false)
  assert.equal((await adminRpc(app.descriptor, 'broker_status')).profileLogin.automationConnected, true)
  assert.equal(await app.broker.browserFactory(), f.browser, 'A completed startup signal must not poison later rebinds')
})

test('endpoint startup failure retains the receipt before launching recovery', async t => {
  const f = await fixture({ receipt: { state: 'awaiting-confirmation' } }), occupied = net.createServer()
  await new Promise(resolve => occupied.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => occupied.close(resolve)))
  await assert.rejects(f.start({ port: occupied.address().port }), { code: 'EADDRINUSE' })
  assert.deepEqual(await readManualProfileReceipt(f.stateDir), f.receipt)
  assert.ok(!f.events.includes('launch'))
  await assert.rejects(readFile(path.join(f.stateDir, 'connection.json')), { code: 'ENOENT' })
  await assertUnlocked(f.stateDir)
})

test('recovery flags belong exclusively to the explicit CLI and require literal confirmation', () => {
  const base = ['--browser', process.execPath, '--state-dir', results]
  assert.throws(() => parseManagedOptions([...base, '--login-id', recovery.loginId]), { code: 'INVALID_OPTIONS' })
  for (const args of [[], ['--user-confirmed', 'false'], ['--user-confirmed', '1']]) assert.throws(() => parseProfileRecoveryOptions([...base, '--login-id', recovery.loginId, ...args]), { code: 'USER_CONFIRMATION_REQUIRED' })
  assert.throws(() => parseProfileRecoveryOptions([...base, '--user-confirmed', 'true']), { code: 'INVALID_OPTIONS' })
  assert.throws(() => parseProfileRecoveryOptions([...base, '--login-id', recovery.loginId, '--login-id', recovery.loginId, '--user-confirmed', 'true']), { code: 'INVALID_OPTIONS' })
  const parsed = parseProfileRecoveryOptions([...base, '--login-id', recovery.loginId, '--user-confirmed', 'true'])
  assert.deepEqual(parsed.profileLoginRecovery, recovery)
  assert.equal(parsed.options.executable, process.execPath)
})

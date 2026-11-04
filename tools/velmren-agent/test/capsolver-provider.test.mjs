import test from 'node:test'
import assert from 'node:assert/strict'
import { CapSolverClient, CapSolverError } from '../capsolver-provider.mjs'

const fixtureKey = 'CAP-SyntheticUserKey'
const fixtureId = 'synthetic-task-id'
const fixtureToken = 'Synthetic.Token_123-abc'
const task = (type = 'ReCaptchaV2TaskProxyLess', fields = {}) => ({
  type, websiteURL: 'https://fixture.test/check', websiteKey: 'Synthetic_sitekey', ...fields
})
const json = (value, init = {}) => new Response(JSON.stringify(value), {
  ...init, headers: { 'content-type': 'application/json; charset=utf-8', ...init.headers }
})
const created = (fields = {}) => json({ errorId: 0, taskId: fixtureId, ...fields })
const ready = (type = 'ReCaptchaV2TaskProxyLess', fields = {}) => json({
  errorId: 0, status: 'ready', taskId: fixtureId,
  solution: { [type === 'AntiTurnstileTaskProxyLess' ? 'token' : 'gRecaptchaResponse']: fixtureToken, ...fields }
})
function mockClient(replies, options = {}) {
  const calls = []
  const client = new CapSolverClient({ readKey: () => fixtureKey, pollIntervalMs: 1, timeoutMs: 2000,
    fetchImpl: async (url, init) => {
      calls.push({ url, ...init, payload: JSON.parse(init.body) })
      assert.ok(replies.length > 0, 'Unexpected provider call')
      const reply = replies.shift()
      return typeof reply === 'function' ? reply(url, init) : reply
    }, ...options })
  return { client, calls }
}
async function rejectsSafe(promise, code) {
  await assert.rejects(promise, error => {
    assert.ok(error instanceof CapSolverError)
    assert.equal(error.code, code)
    assert.equal(error.message, 'CAPTCHA provider request could not be completed')
    assert.equal(error.cause, undefined)
    assert.deepEqual(Object.keys(error).sort(), ['code', 'name'])
    assert.doesNotMatch(error.stack, /SyntheticUserKey|Synthetic\.Token|Synthetic_sitekey|synthetic-task-id|PrivateRemoteDetail/)
    return true
  })
}

test('async solutions poll the same task, retain the operation key and expose only the private token', async () => {
  for (const type of ['ReCaptchaV2TaskProxyLess', 'ReCaptchaV2EnterpriseTaskProxyLess', 'AntiTurnstileTaskProxyLess']) {
    let reads = 0, dispatched = 0
    const { client, calls } = mockClient([
      created({ status: 'idle' }), json({ errorId: 0, status: 'processing' }),
      ready(type, { userAgent: 'Synthetic Browser/1.0', secChUa: 'PrivateClientHints', createTime: 1671615324290,
        'recaptcha-ca-e': 'PrivateCookie', 'recaptcha-ca-t': 'PrivateSessionCookie', extra: fixtureKey })
    ], { readKey: () => { reads++; return fixtureKey } })
    const result = await client.solve(task(type), { onDispatch: () => { dispatched++; assert.equal(calls.length, 0) } })
    assert.deepEqual(result, { token: fixtureToken })
    assert.equal(reads, 1)
    assert.equal(dispatched, 1)
    assert.deepEqual(calls.map(call => call.url), [
      'https://api.capsolver.com/createTask', 'https://api.capsolver.com/getTaskResult', 'https://api.capsolver.com/getTaskResult'
    ])
    assert.deepEqual(calls[0].payload, { clientKey: fixtureKey, task: task(type) })
    for (const call of calls.slice(1)) assert.deepEqual(call.payload, { clientKey: fixtureKey, taskId: fixtureId })
    for (const call of calls) {
      assert.equal(call.method, 'POST')
      assert.equal(call.redirect, 'error')
      assert.equal(call.credentials, 'omit')
      assert.equal(call.cache, 'no-store')
      assert.equal(call.referrerPolicy, 'no-referrer')
      assert.deepEqual(call.headers, { 'content-type': 'application/json', accept: 'application/json' })
    }
    assert.equal(JSON.stringify(client), '{}')
  }
})

test('a valid immediate ready response returns without polling', async () => {
  for (const type of ['ReCaptchaV2TaskProxyLess', 'ReCaptchaV2EnterpriseTaskProxyLess', 'AntiTurnstileTaskProxyLess']) {
    for (const fields of [{}, { userAgent: 'Synthetic Browser/1.0', secChUa: 'PrivateClientHints',
      'recaptcha-ca-e': 'PrivateCookie', 'recaptcha-ca-t': 'PrivateSessionCookie', extra: fixtureKey }]) {
      const { client, calls } = mockClient([ready(type, fields)])
      assert.deepEqual(await client.solve(task(type)), { token: fixtureToken })
      assert.equal(calls.length, 1)
    }
  }
})

test('documented per-type optional fields are copied and page fragments are removed', async () => {
  const cases = [
    task('ReCaptchaV2TaskProxyLess', { isInvisible: true, pageAction: 'submit', recaptchaDataSValue: 'SyntheticS', apiDomain: 'www.recaptcha.net' }),
    task('ReCaptchaV2EnterpriseTaskProxyLess', { enterprisePayload: { s: 'SyntheticS' } }),
    task('AntiTurnstileTaskProxyLess', { metadata: { action: 'login', cdata: 'synthetic-cdata' } })
  ]
  for (const value of cases) {
    const { client, calls } = mockClient([ready(value.type)])
    await client.solve({ ...value, websiteURL: `${value.websiteURL}#local-state` })
    assert.deepEqual(calls[0].payload.task, value)
  }
})

test('invalid and undeclared task fields cannot dispatch or read a key', async () => {
  const invalid = [
    null, [], task('UnsupportedTask'), task(undefined, { websiteKey: '' }),
    task(undefined, { websiteURL: 'file:///private' }), task(undefined, { websiteURL: 'https://user:pass@fixture.test/' }),
    task(undefined, { websiteURL: 'https://fixture.test/\nsecret' }), task(undefined, { websiteKey: 'bad key' }),
    task(undefined, { isInvisible: 'true' }), task(undefined, { apiDomain: 'evil.test' }),
    task(undefined, { cookies: 'PrivateCookie' }), task(undefined, { callbackUrl: 'https://evil.test/' }),
    task(undefined, { proxy: 'secret:proxy' }), task(undefined, { appId: 'developer-key' }),
    task(undefined, { isSession: true }), task(undefined, { clientKey: 'OverrideKey' }),
    task(undefined, { userAgent: 'OverrideBrowser' }), task(undefined, { secChUa: 'OverrideHints' }),
    task('AntiTurnstileTaskProxyLess', { metadata: { pagedata: 'UnsupportedChallenge' } }),
    task(undefined, { enterprisePayload: { s: 'wrong-type' } }),
    task('ReCaptchaV2EnterpriseTaskProxyLess', { enterprisePayload: { s: 'value', extra: 'hidden' } }),
    task('AntiTurnstileTaskProxyLess', { metadata: { action: 'a'.repeat(33) } }),
    task('AntiTurnstileTaskProxyLess', { metadata: { cdata: 'a'.repeat(256) } }),
    task('AntiTurnstileTaskProxyLess', { metadata: { action: 'login', pagedata: 'hidden' } }),
    task('AntiTurnstileTaskProxyLess', { metadata: { action: 'bad action' } }),
    task('AntiTurnstileTaskProxyLess', { pageAction: 'login' }),
    task(undefined, { toJSON: () => ({ clientKey: fixtureKey }) })
  ]
  let reads = 0
  const { client, calls } = mockClient([], { readKey: () => { reads++; return fixtureKey } })
  for (const value of invalid) await rejectsSafe(client.solve(value), 'CAPTCHA_PROVIDER_ERROR')
  assert.equal(reads, 0)
  assert.equal(calls.length, 0)
})

test('missing and failed credential reads do not dispatch', async () => {
  for (const key of [undefined, null, '', ' ', 'bad\nkey', {}, 'a'.repeat(1025)]) {
    const { client, calls } = mockClient([], { readKey: () => key })
    let dispatched = false
    await rejectsSafe(client.solve(task(), { onDispatch: () => { dispatched = true } }), 'CAPTCHA_AUTH_REQUIRED')
    await rejectsSafe(client.balance(), 'CAPTCHA_AUTH_REQUIRED')
    assert.equal(dispatched, false)
    assert.equal(calls.length, 0)
  }
  const { client, calls } = mockClient([], { readKey: () => { throw new Error(`PrivateRemoteDetail ${fixtureKey}`) } })
  await rejectsSafe(client.solve(task()), 'CAPTCHA_AUTH_REQUIRED')
  assert.equal(calls.length, 0)
})

test('balance returns only numeric USD and refreshes the user key for each operation', async () => {
  let reads = 0
  const { client, calls } = mockClient([
    json({ errorId: 0, balance: 12.345, packages: [{ token: 'PrivatePackageToken' }], clientKey: fixtureKey }),
    json({ errorId: 0, balance: 0 })
  ], { readKey: () => `SyntheticKey-${++reads}` })
  assert.deepEqual(await client.balance(), { balanceUsd: 12.345 })
  assert.deepEqual(await client.balance(), { balanceUsd: 0 })
  assert.deepEqual(calls.map(call => call.payload), [{ clientKey: 'SyntheticKey-1' }, { clientKey: 'SyntheticKey-2' }])
  assert.ok(calls.every(call => call.url === 'https://api.capsolver.com/getBalance'))
})

test('malformed balances are rejected without coercion', async () => {
  for (const balance of [undefined, null, -1, '1.00', {}, Infinity]) {
    const { client } = mockClient([json({ errorId: 0, balance })])
    await rejectsSafe(client.balance(), 'CAPTCHA_PROVIDER_ERROR')
  }
})

test('provider codes and HTTP authentication failures map to fixed safe errors', async () => {
  for (const [errorCode, code, status] of [
    ['ERROR_KEY_DENIED_ACCESS', 'CAPTCHA_AUTH_REQUIRED', 401],
    ['ERROR_ZERO_BALANCE', 'CAPTCHA_NO_BALANCE', 400],
    ['ERROR_TASK_TIMEOUT', 'CAPTCHA_TIMEOUT', 200],
    ['ERROR_CAPTCHA_UNSOLVABLE', 'CAPTCHA_PROVIDER_ERROR', 200],
    [`PrivateRemoteDetail ${fixtureKey}`, 'CAPTCHA_PROVIDER_ERROR', 400]
  ]) {
    const { client, calls } = mockClient([json({ errorId: 1, errorCode, errorDescription: `PrivateRemoteDetail ${fixtureKey}` }, { status })])
    await rejectsSafe(client.solve(task()), code)
    assert.equal(calls.length, 1)
  }
})

test('unknown error constructors and externally embellished errors cannot expose details', async () => {
  assert.equal(new CapSolverError('PrivateRemoteDetail').code, 'CAPTCHA_PROVIDER_ERROR')
  const external = new CapSolverError('CAPTCHA_NO_BALANCE')
  external.message = `PrivateRemoteDetail ${fixtureKey}`
  external.cause = fixtureToken
  const { client } = mockClient([() => { throw external }])
  await rejectsSafe(client.balance(), 'CAPTCHA_NO_BALANCE')
})

test('ambiguous create failures never retry or poll and keep details private', async () => {
  for (const reply of [
    () => { throw new Error(`PrivateRemoteDetail ${fixtureKey} ${fixtureId} ${fixtureToken}`) },
    json({ PrivateRemoteDetail: fixtureKey }), json({ errorId: '0', taskId: fixtureId }),
    json({ errorId: 0, errorCode: 'PrivateRemoteDetail', taskId: fixtureId }),
    json({ errorId: 0 }), created({ status: 'unexpected' }), created({ taskId: { secret: fixtureKey } }),
    new Response('PrivateRemoteDetail', { status: 500 }),
    new Response('PrivateRemoteDetail', { headers: { 'content-type': 'text/html' } }),
    new Response('{PrivateRemoteDetail', { headers: { 'content-type': 'application/json' } }),
    json(['PrivateRemoteDetail'])
  ]) {
    let dispatches = 0
    const { client, calls } = mockClient([reply])
    await rejectsSafe(client.solve(task(), { onDispatch: () => { dispatches++ } }), 'CAPTCHA_DELIVERY_UNCERTAIN')
    assert.equal(dispatches, 1)
    assert.equal(calls.length, 1)
  }
})

test('poll failure never creates another task', async () => {
  for (const reply of [
    () => { throw new Error('PrivateRemoteDetail') }, json({ errorId: 0, status: 'unexpected' }),
    ready('ReCaptchaV2TaskProxyLess', { gRecaptchaResponse: null }),
    json({ errorId: 0, status: 'processing', taskId: 'different-id' })
  ]) {
    const { client, calls } = mockClient([created(), reply])
    await rejectsSafe(client.solve(task()), 'CAPTCHA_PROVIDER_ERROR')
    assert.equal(calls.length, 2)
    assert.equal(calls.filter(call => call.url.endsWith('/createTask')).length, 1)
  }
})

test('malformed tokens are rejected before native delivery', async () => {
  const values = [undefined, null, {}, '', 'white space', '<script>', 'token\nvalue', 'a'.repeat(32769)]
  for (const token of values) {
    for (const type of ['ReCaptchaV2TaskProxyLess', 'ReCaptchaV2EnterpriseTaskProxyLess', 'AntiTurnstileTaskProxyLess']) {
      const field = type === 'AntiTurnstileTaskProxyLess' ? 'token' : 'gRecaptchaResponse'
      const { client } = mockClient([created(), ready(type, { [field]: token })])
      await rejectsSafe(client.solve(task(type)), 'CAPTCHA_PROVIDER_ERROR')
    }
  }
  const { client } = mockClient([ready(undefined, { gRecaptchaResponse: '<invalid>' })])
  await rejectsSafe(client.solve(task()), 'CAPTCHA_DELIVERY_UNCERTAIN')
})

test('unused provider metadata cannot reject a valid token or cross the adapter boundary', async () => {
  for (const type of ['ReCaptchaV2TaskProxyLess', 'ReCaptchaV2EnterpriseTaskProxyLess', 'AntiTurnstileTaskProxyLess']) {
    for (const userAgent of [null, {}, '', 'bad\r\nheader', 'a'.repeat(1025)]) {
      const { client, calls } = mockClient([created(), ready(type, {
        userAgent, secChUa: { untrusted: true }, cookies: [{ name: 'private', value: fixtureKey }]
      })])
      assert.deepEqual(await client.solve(task(type)), { token: fixtureToken })
      assert.equal(calls.length, 2)
    }
  }
})

test('redirects are rejected even if an injected transport follows one', async () => {
  const followed = ready()
  Object.defineProperty(followed, 'redirected', { value: true })
  for (const reply of [new Response(null, { status: 302, headers: { location: 'https://evil.test/' } }), followed]) {
    const { client, calls } = mockClient([reply])
    await rejectsSafe(client.solve(task()), 'CAPTCHA_DELIVERY_UNCERTAIN')
    assert.equal(calls[0].redirect, 'error')
    assert.equal(calls.length, 1)
  }
})

test('declared oversized or invalid lengths are rejected before consuming the response', async () => {
  for (const length of ['65537', 'invalid', '-1', '1e9']) {
    let consumed = false, cancelled = false
    const body = { getReader() { consumed = true }, cancel() { cancelled = true } }
    const { client } = mockClient([{ status: 200, headers: new Headers({ 'content-type': 'application/json', 'content-length': length }), body }])
    await rejectsSafe(client.balance(), 'CAPTCHA_PROVIDER_ERROR')
    assert.equal(consumed, false)
    assert.equal(cancelled, true)
  }
})

test('streamed responses are bounded independently of declared length', async () => {
  let cancelled = false
  const body = new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(40000)); controller.enqueue(new Uint8Array(40000)) },
    cancel() { cancelled = true }
  })
  const { client } = mockClient([new Response(body, { headers: { 'content-type': 'application/json', 'content-length': '1' } })])
  await rejectsSafe(client.balance(), 'CAPTCHA_PROVIDER_ERROR')
  assert.equal(cancelled, true)
})

test('malformed UTF-8 is rejected instead of silently changing the provider result', async () => {
  const { client } = mockClient([new Response(new Uint8Array([0xc3, 0x28]), { headers: { 'content-type': 'application/json' } })])
  await rejectsSafe(client.balance(), 'CAPTCHA_PROVIDER_ERROR')
})

test('pre-aborted operations do not read the key or dispatch', async () => {
  const controller = new AbortController()
  controller.abort(new Error('PrivateRemoteDetail'))
  let reads = 0
  const { client, calls } = mockClient([], { readKey: () => { reads++; return fixtureKey } })
  await rejectsSafe(client.solve(task(), { signal: controller.signal }), 'CAPTCHA_CANCELLED')
  await rejectsSafe(client.balance({ signal: controller.signal }), 'CAPTCHA_CANCELLED')
  assert.equal(reads, 0)
  assert.equal(calls.length, 0)
})

test('abort interrupts a key reader that ignores cancellation without a later dispatch', async () => {
  const controller = new AbortController()
  let release
  const { client, calls } = mockClient([], { readKey: () => {
    queueMicrotask(() => controller.abort())
    return new Promise(resolve => { release = resolve })
  } })
  await rejectsSafe(client.solve(task(), { signal: controller.signal }), 'CAPTCHA_CANCELLED')
  release(fixtureKey)
  await Promise.resolve()
  assert.equal(calls.length, 0)
})

test('abort interrupts an in-flight create without retrying even when fetch ignores its signal', async () => {
  const controller = new AbortController()
  let release, dispatches = 0
  const { client, calls } = mockClient([() => {
    queueMicrotask(() => controller.abort(new Error('PrivateRemoteDetail')))
    return new Promise(resolve => { release = resolve })
  }])
  await rejectsSafe(client.solve(task(), { signal: controller.signal, onDispatch: () => { dispatches++ } }), 'CAPTCHA_CANCELLED')
  assert.equal(calls[0].signal.aborted, true)
  assert.equal(dispatches, 1)
  release(created())
  await Promise.resolve()
  assert.equal(calls.length, 1)
})

test('abort during the polling wait creates no additional requests', async () => {
  const controller = new AbortController()
  const response = created()
  const reader = response.body.getReader()
  let cancelled = false
  const body = { getReader: () => ({
    async read() {
      const value = await reader.read()
      if (value.done) setImmediate(() => controller.abort())
      return value
    },
    cancel() { cancelled = true; return reader.cancel() }
  }) }
  const { client, calls } = mockClient([{ status: 200, headers: response.headers, body }], { pollIntervalMs: 1000 })
  await rejectsSafe(client.solve(task(), { signal: controller.signal }), 'CAPTCHA_CANCELLED')
  assert.equal(calls.length, 1)
  assert.equal(cancelled, true)
})

test('one total deadline bounds hung key reads, create requests and response streams', async () => {
  const never = () => new Promise(() => {})
  const key = mockClient([], { readKey: never, timeoutMs: 20 })
  await rejectsSafe(key.client.balance(), 'CAPTCHA_TIMEOUT')
  assert.equal(key.calls.length, 0)
  const request = mockClient([never], { timeoutMs: 20 })
  await rejectsSafe(request.client.solve(task()), 'CAPTCHA_TIMEOUT')
  assert.equal(request.calls.length, 1)
  assert.equal(request.calls[0].signal.aborted, true)
  let cancelled = false
  const body = { getReader: () => ({ read: never, cancel() { cancelled = true } }) }
  const stream = mockClient([{ status: 200, headers: new Headers({ 'content-type': 'application/json' }), body }], { timeoutMs: 20 })
  await rejectsSafe(stream.client.balance(), 'CAPTCHA_TIMEOUT')
  assert.equal(cancelled, true)
})

test('a polling deadline does not restart for each response', async () => {
  const { client, calls } = mockClient([created()], { timeoutMs: 20, pollIntervalMs: 1000 })
  await rejectsSafe(client.solve(task()), 'CAPTCHA_TIMEOUT')
  assert.equal(calls.length, 1)
})

test('the provider query cap is respected independently of the deadline', async () => {
  const replies = [created(), ...Array.from({ length: 120 }, () => json({ errorId: 0, status: 'processing' }))]
  const { client, calls } = mockClient(replies, { timeoutMs: 10000 })
  await rejectsSafe(client.solve(task()), 'CAPTCHA_TIMEOUT')
  assert.equal(calls.length, 121)
})

test('failed or hung dispatch hooks cannot leak errors or send a request later', async () => {
  const { client, calls } = mockClient([], { timeoutMs: 20 })
  await rejectsSafe(client.solve(task(), { onDispatch: () => { throw new Error('PrivateRemoteDetail') } }), 'CAPTCHA_PROVIDER_ERROR')
  let release
  await rejectsSafe(client.solve(task(), { onDispatch: () => new Promise(resolve => { release = resolve }) }), 'CAPTCHA_TIMEOUT')
  release()
  await Promise.resolve()
  assert.equal(calls.length, 0)
})

test('durable dispatch reservation must finish before the single network request', async () => {
  let enterHook, finishHook
  const entered = new Promise(resolve => { enterHook = resolve })
  const reservation = new Promise(resolve => { finishHook = resolve })
  let reservations = 0
  const { client, calls } = mockClient([ready()])
  const pending = client.solve(task(), { onDispatch: async (...args) => {
    assert.deepEqual(args, [])
    reservations++
    enterHook()
    await reservation
  } })
  await entered
  assert.equal(calls.length, 0)
  finishHook()
  assert.deepEqual(await pending, { token: fixtureToken })
  assert.equal(reservations, 1)
  assert.equal(calls.length, 1)
})

test('reservation refusal preserves allowlisted budget codes without dispatch or private callback details', async () => {
  for (const code of ['CAPTCHA_LIMIT_REACHED', 'CAPTCHA_ALREADY_ATTEMPTED',
    'CAPTCHA_DISABLED', 'CAPTCHA_STORAGE_UNAVAILABLE', 'CAPTCHA_CANCELLED', 'CAPTCHA_STALE']) {
    const { client, calls } = mockClient([])
    await rejectsSafe(client.solve(task(), { onDispatch: async () => {
      throw Object.assign(new Error(`PrivateRemoteDetail ${fixtureKey}`), { code })
    } }), code)
    assert.equal(calls.length, 0)
  }
})

test('native fetch cannot be redirected by constructor configuration; injected HTTPS mocks are supported', async () => {
  for (const baseUrl of ['http://api.capsolver.com', 'https://evil.test', 'https://api.capsolver.com/path',
    'https://user:pass@api.capsolver.com', 'https://api.capsolver.com?key=secret', 'https://api.capsolver.com#state']) {
    assert.throws(() => new CapSolverClient({ readKey: () => fixtureKey, baseUrl }), { code: 'CAPTCHA_PROVIDER_ERROR' })
  }
  const { client, calls } = mockClient([json({ errorId: 0, balance: 2 })], { baseUrl: 'https://fixture.invalid' })
  assert.deepEqual(await client.balance(), { balanceUsd: 2 })
  assert.equal(calls[0].url, 'https://fixture.invalid/getBalance')
  for (const options of [{ timeoutMs: 0 }, { timeoutMs: Infinity }, { timeoutMs: 120001 }, { pollIntervalMs: 0 }]) {
    assert.throws(() => new CapSolverClient({ readKey: () => fixtureKey, ...options }), { code: 'CAPTCHA_PROVIDER_ERROR' })
  }
})

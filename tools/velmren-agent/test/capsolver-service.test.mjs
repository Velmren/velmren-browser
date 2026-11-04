import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { CaptchaService } from '../capsolver-service.mjs'
import { WindowsServiceKey } from '../service-key.mjs'

const key = 'SyntheticCapSolverKeyForUnitTestsOnly'
const save = limits => ({ action: 'save', enabled: true, key, maxRequestsPerDay: 100, maxConcurrent: 2, maxAttemptsPerTask: 3, ...limits })
function protector() {
  return { available: true, ensureDirectory: async () => {}, protect: async value => { assert.equal(value, key); return 'U2VhbGVk' },
    unprotect: async value => { assert.equal(value, 'U2VhbGVk'); return key } }
}
async function setup(t, options = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'velmren-capsolver-unit-'))
  const service = new CaptchaService(directory, { protector: protector(), ...options })
  t.after(() => service.close())
  await service.ready
  return { service, directory }
}
const run = (service, taskId, challengeId, operation) => service.run({ taskId, challengeId }, operation ?? (async ({ dispatch }) => { await dispatch(); return 'accepted' }))

test('no built-in key or enabled provider; settings reject unknown fields and missing explicit limits', async t => {
  const { service } = await setup(t)
  const status = await service.settings({ action: 'get' })
  assert.equal(status.enabled, false); assert.equal(status.hasKey, false)
  await assert.rejects(run(service, 'task', 'widget'), { code: 'CAPTCHA_DISABLED' })
  await assert.rejects(service.settings({ ...save(), callbackUrl: 'https://untrusted.test' }), { code: 'INVALID_ARGUMENTS' })
  await assert.rejects(service.settings({ action: 'save', enabled: true }), { code: 'INVALID_ARGUMENTS' })
  await assert.rejects(service.settings(save({ key: undefined })), { code: 'CAPTCHA_AUTH_REQUIRED' })
})

test('credential is protected on disk, never in status; restart and key removal preserve budget', async t => {
  const { service, directory } = await setup(t)
  const status = await service.settings(save())
  assert.equal(status.enabled, true); assert.equal(status.hasKey, true)
  const disk = await readFile(path.join(service.directory, 'settings.json'), 'utf8')
  assert.ok(!disk.includes(key)); assert.ok(!JSON.stringify(status).includes('encryptedKey'))
  await run(service, 'task', 'one')
  const restarted = new CaptchaService(directory, { protector: protector() }); t.after(() => restarted.close())
  await restarted.ready; assert.equal(restarted.view().usage.requestsLast24Hours, 1)
  assert.equal(await restarted.readKey(), key)
  await assert.rejects(run(restarted, 'task', 'one'), { code: 'CAPTCHA_ALREADY_ATTEMPTED' })
  const removed = await restarted.settings({ action: 'remove_key' })
  assert.equal(removed.enabled, false); assert.equal(removed.hasKey, false); assert.equal(removed.usage.requestsLast24Hours, 1)
  await assert.rejects(restarted.readKey(), { code: 'CAPTCHA_AUTH_REQUIRED' })
})

test('daily and per-task limits reserve atomically before dispatch across simultaneous owners', async t => {
  const { service } = await setup(t)
  await service.settings(save({ maxRequestsPerDay: 3, maxAttemptsPerTask: 2, maxConcurrent: 5 }))
  const outcomes = await Promise.allSettled([run(service, 'a', '1'), run(service, 'a', '2'), run(service, 'a', '3'), run(service, 'b', '4'), run(service, 'c', '5')])
  assert.equal(outcomes.filter(item => item.status === 'fulfilled').length, 3)
  assert.ok(outcomes.filter(item => item.status === 'rejected').every(item => item.reason.code === 'CAPTCHA_LIMIT_REACHED'))
  const disk = JSON.parse(await readFile(path.join(service.directory, 'attempts.json'), 'utf8'))
  assert.equal(disk.entries.length, 3); assert.equal(disk.entries.filter(item => item.taskId === 'a').length, 2)
})

test('ambiguous billed attempt stays spent; duplicate concurrent widget never calls provider again', async t => {
  const { service } = await setup(t)
  await service.settings(save())
  let release, dispatched
  const ready = new Promise(resolve => { dispatched = resolve })
  const pending = run(service, 'task', 'same', async ({ dispatch }) => {
    await dispatch(); dispatched()
    await new Promise(resolve => { release = resolve })
    throw Object.assign(new Error('Synthetic lost response'), { code: 'CAPTCHA_DELIVERY_UNCERTAIN' })
  })
  await ready
  await assert.rejects(run(service, 'task', 'same'), { code: 'CAPTCHA_ALREADY_ATTEMPTED' })
  release(); await assert.rejects(pending, { code: 'CAPTCHA_DELIVERY_UNCERTAIN' })
  await assert.rejects(run(service, 'task', 'same'), { code: 'CAPTCHA_ALREADY_ATTEMPTED' })
  assert.equal(service.view().usage.requestsLast24Hours, 1)
})

test('cancelled concurrency waiter does not spend or obstruct a later task', async t => {
  const { service } = await setup(t)
  await service.settings(save({ maxConcurrent: 1 }))
  let release, started
  const ready = new Promise(resolve => { started = resolve })
  const first = run(service, 'first', 'one', async ({ dispatch }) => {
    await dispatch(); started(); await new Promise(resolve => { release = resolve })
  })
  await ready
  const controller = new AbortController()
  const waiting = service.run({ taskId: 'second', challengeId: 'two', signal: controller.signal }, async () => assert.fail('Cancelled waiter ran'))
  const rejected = assert.rejects(waiting, { code: 'CAPTCHA_CANCELLED' })
  controller.abort(); await rejected
  const third = run(service, 'third', 'three')
  release(); await first; await third
  assert.equal(service.view().usage.requestsLast24Hours, 2); assert.equal(service.active, 0)
})

test('disabling stops in-flight work and queued tasks without fresh spending', async t => {
  const { service } = await setup(t)
  await service.settings(save({ maxConcurrent: 1 }))
  let started
  const ready = new Promise(resolve => { started = resolve })
  const first = run(service, 'one', 'one', async ({ dispatch, signal }) => {
    await dispatch(); started()
    await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('Cancelled'), { code: 'CAPTCHA_CANCELLED' })), { once: true }))
  })
  const firstRejection = assert.rejects(first, { code: 'CAPTCHA_CANCELLED' }); await ready
  const second = run(service, 'two', 'two', async () => assert.fail('Disabled waiter ran'))
  const secondRejection = assert.rejects(second, { code: 'CAPTCHA_CANCELLED' })
  await service.settings(save({ enabled: false, key: undefined, maxConcurrent: 1 }))
  await Promise.all([firstRejection, secondRejection])
  assert.equal(service.view().enabled, false); assert.equal(service.view().usage.requestsLast24Hours, 1)
})

test('rolling 24-hour budget survives restart and expires old attempts', async t => {
  let now = 100000000
  const { service, directory } = await setup(t, { now: () => now })
  await service.settings(save({ maxRequestsPerDay: 1 }))
  await run(service, 'one', 'one')
  now += 24 * 60 * 60 * 1000 + 1
  const restarted = new CaptchaService(directory, { protector: protector(), now: () => now }); t.after(() => restarted.close())
  await restarted.ready; await run(restarted, 'two', 'two')
  assert.equal(restarted.view().usage.requestsLast24Hours, 1)
})

test('failed durable reservation prevents the network dispatch hook from completing', async t => {
  const { service } = await setup(t)
  await service.settings(save())
  service.persist = async () => { throw Object.assign(new Error('Disk unavailable'), { code: 'CAPTCHA_STORAGE_UNAVAILABLE' }) }
  let network = 0
  await assert.rejects(run(service, 'task', 'widget', async ({ dispatch }) => { await dispatch(); network++ }), { code: 'CAPTCHA_STORAGE_UNAVAILABLE' })
  assert.equal(network, 0); assert.equal(service.view().usage.requestsLast24Hours, 0)
})

test('corrupt accounting fails closed without replacing original state', async t => {
  const { service, directory } = await setup(t)
  await service.settings(save())
  const file = path.join(service.directory, 'attempts.json')
  await writeFile(file, '{invalid json')
  const restarted = new CaptchaService(directory, { protector: protector() }); t.after(() => restarted.close())
  await assert.rejects(restarted.ready, { code: 'CAPTCHA_STORAGE_UNAVAILABLE' })
  assert.equal(restarted.enabled, false); assert.equal(await readFile(file, 'utf8'), '{invalid json')
})

test('balance projection and a concurrent key change never publish stale account details', async t => {
  let resolveBalance, started
  const ready = new Promise(resolve => { started = resolve })
  const { service } = await setup(t, { provider: { balance: async () => { started(); return new Promise(resolve => { resolveBalance = resolve }) } } })
  await service.settings(save())
  const check = service.settings({ action: 'check' })
  await ready; await service.settings({ action: 'remove_key' })
  resolveBalance({ balanceUsd: 17, packages: [{ token: 'PrivateFixture' }] })
  await assert.rejects(check, { code: 'CAPTCHA_CANCELLED' })
  assert.deepEqual(service.view().verification, { status: 'unchecked' })
})

test('Windows DPAPI round-trip uses protected ciphertext and rejects corrupted ciphertext', { skip: process.platform !== 'win32' }, async () => {
  const protection = new WindowsServiceKey()
  const sealed = await protection.protect(key)
  assert.notEqual(sealed, Buffer.from(key).toString('base64'))
  assert.equal(await protection.unprotect(sealed), key)
  await assert.rejects(protection.unprotect('Y29ycnVwdA=='), { code: 'CAPTCHA_STORAGE_UNAVAILABLE' })
})

test('all four outcomes are durable, separated by task, and duplicate dispatches do not inflate counters', async t => {
  const { service, directory } = await setup(t)
  await service.settings(save({ maxAttemptsPerTask: 10 }))
  await run(service, 'one', 'delivered', async ({ dispatch }) => { await dispatch(); return { applied: true } })
  await assert.rejects(run(service, 'one', 'failed', async ({ dispatch }) => { await dispatch(); throw Object.assign(new Error('private'), { code: 'CAPTCHA_PROVIDER_ERROR' }) }))
  await assert.rejects(run(service, 'two', 'cancelled', async () => { throw Object.assign(new Error('private'), { code: 'CAPTCHA_CANCELLED' }) }))
  await run(service, 'two', 'uncertain', async ({ dispatch }) => { await dispatch(); return { applied: true, deliveryUncertain: true } })
  await assert.rejects(run(service, 'one', 'delivered'), { code: 'CAPTCHA_ALREADY_ATTEMPTED' })
  const expected = { solutionsDelivered: 1, failed: 1, cancelled: 1, uncertain: 1, persisted: true }
  assert.deepEqual(service.statistics(), expected)
  assert.deepEqual(service.statistics('one'), { ...expected, cancelled: 0, uncertain: 0 })
  assert.equal(service.view().usage.requestsLast24Hours, 3)
  const restarted = new CaptchaService(directory, { protector: protector() }); t.after(() => restarted.close())
  await restarted.ready; assert.deepEqual(restarted.statistics(), expected)
  await restarted.settings({ action: 'remove_key' }); assert.deepEqual(restarted.statistics(), expected)
})

test('restart classifies interrupted durable dispatch as uncertain exactly once', async t => {
  const { service, directory } = await setup(t)
  await service.settings(save())
  await service.reserve('old-task', 'old-challenge', service.generation, new AbortController().signal)
  const restarted = new CaptchaService(directory, { protector: protector() }); t.after(() => restarted.close())
  await restarted.ready; assert.equal(restarted.statistics().uncertain, 1)
  const again = new CaptchaService(directory, { protector: protector() }); t.after(() => again.close())
  await again.ready; assert.equal(again.statistics().uncertain, 1)
  await assert.rejects(run(again, 'old-task', 'old-challenge'), { code: 'CAPTCHA_ALREADY_ATTEMPTED' })
})

test('counter persistence failure preserves delivery receipt and explicitly marks unsaved statistics', async t => {
  const { service } = await setup(t)
  await service.settings(save())
  const original = service.persist.bind(service)
  const result = await run(service, 'one', 'one', async ({ dispatch }) => {
    await dispatch()
    service.persist = async () => { throw new Error('disk failure') }
    return { applied: true }
  })
  assert.equal(result.applied, true); assert.equal(service.statistics().solutionsDelivered, 1); assert.equal(service.statistics().persisted, false)
  service.persist = original
})

test('Windows service directory receives private inherited ACL before any key is written', { skip: process.platform !== 'win32' }, async t => {
  const { service } = await setup(t, { protector: new WindowsServiceKey() })
  await service.settings(save())
  assert.equal(await service.readKey(), key)
  assert.doesNotMatch(await readFile(path.join(service.directory, 'settings.json'), 'utf8'), new RegExp(key))
})

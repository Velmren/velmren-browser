import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { CaptchaService } from '../capsolver-service.mjs'

const key = 'SyntheticDurableReceiptKeyOnly'
const protector = { available: true, ensureDirectory: async () => {}, protect: async () => 'U2VhbGVk', unprotect: async () => key }
const job = (suffix = 'one', owner = 'owner-one') => ({ owner, jobId: `job-${suffix}`, taskId: `task-${suffix}`, challengeId: `challenge-${suffix}` })
async function setup(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'velmren-captcha-receipts-'))
  const start = async () => {
    const service = new CaptchaService(directory, { protector, provider: { solve() { assert.fail('Recovery must not call provider') } } })
    t.after(() => service.close()); await service.ready; return service
  }
  const service = await start()
  await service.settings({ action: 'save', enabled: true, key, maxRequestsPerDay: 100, maxConcurrent: 2, maxAttemptsPerTask: 3 })
  return { service, start, directory }
}
const receipt = (service, value) => service.receipt(value.owner, value.taskId, value.jobId)

test('exact terminal receipt survives restart without inferring delivery from aggregate totals', async t => {
  const { service, start } = await setup(t), value = job()
  await service.createJob(value)
  await service.run(value, async ({ dispatch }) => { await dispatch(); return { applied: true, callbackInvoked: true, token: 'SyntheticSecretNeverPersisted' } })
  const live = await receipt(service, value)
  assert.equal(live.status, 'delivered'); assert.equal(live.persisted, true); assert.equal(live.recovered, false)
  const restarted = await start(), restored = await receipt(restarted, value)
  assert.equal(restored.status, 'delivered'); assert.equal(restored.recovered, true); assert.equal(restored.outcomeEvidence, 'direct')
  assert.deepEqual(restored.receipt, { applied: true, callbackInvoked: true, deliveryUncertain: false })
  assert.equal(restored.captchaStats, undefined); assert.equal(restored.replayAllowed, false)
  assert.equal(restarted.statistics().solutionsDelivered, 1)
  await assert.rejects(restarted.receipt('other-owner', value.taskId, value.jobId), { code: 'NOT_FOUND' })
  await assert.rejects(restarted.receipt(value.owner, 'other-task', value.jobId), { code: 'NOT_FOUND' })
  const disk = await readFile(path.join(service.directory, 'statistics.json'), 'utf8')
  assert.ok(!disk.includes('SyntheticSecretNeverPersisted')); assert.ok(!disk.includes(key))
})

test('restart marks a reserved pending job uncertain once and never dispatches it again', async t => {
  const { service, start } = await setup(t), value = job()
  await service.createJob(value)
  await service.reserve(value.taskId, value.challengeId, service.generation, new AbortController().signal, value.jobId)
  const restarted = await start(), restored = await receipt(restarted, value)
  assert.equal(restored.status, 'uncertain'); assert.equal(restored.code, 'CAPTCHA_DELIVERY_UNCERTAIN')
  assert.equal(restored.outcomeEvidence, 'interrupted'); assert.equal(restored.captchaStats, undefined)
  assert.equal(restarted.statistics().uncertain, 1)
  await assert.rejects(restarted.run(value, async () => assert.fail('Duplicate solve dispatched')), { code: 'CAPTCHA_ALREADY_ATTEMPTED' })
  const again = await start()
  assert.equal(again.statistics().uncertain, 1); assert.equal((await receipt(again, value)).status, 'uncertain')
})

test('restart distinguishes work interrupted before any paid reservation', async t => {
  const { service, start } = await setup(t), value = job()
  await service.createJob(value)
  const restarted = await start(), restored = await receipt(restarted, value)
  assert.equal(restored.status, 'cancelled'); assert.equal(restored.outcomeEvidence, 'interrupted')
  assert.equal(restarted.statistics().cancelled, 1); assert.equal(restarted.view().usage.requestsLast24Hours, 0)
  assert.equal((await start()).statistics().cancelled, 1)
})

test('crash between attempt reservation and receipt update remains uncertain rather than unpaid', async t => {
  const { service, start } = await setup(t), value = job()
  await service.createJob(value)
  await service.persist('attempts.json', { version: 1, entries: [{ taskId: value.taskId, challengeId: value.challengeId, time: Date.now() }] })
  const restarted = await start()
  assert.equal((await receipt(restarted, value)).status, 'uncertain')
  assert.equal(restarted.view().usage.requestsLast24Hours, 1)
  assert.equal(restarted.statistics().uncertain, 1)
})

test('failed terminal persistence preserves a live receipt and recovers only uncertainty', async t => {
  const { service, start } = await setup(t), value = job()
  await service.createJob(value)
  const persist = service.persist.bind(service)
  await service.run(value, async ({ dispatch }) => {
    await dispatch(); service.persist = async () => { throw Error('Synthetic disk failure') }
    return { applied: true, callbackInvoked: false }
  })
  const live = await receipt(service, value)
  assert.equal(live.status, 'delivered'); assert.equal(live.persisted, false)
  service.persist = persist
  const restarted = await start()
  assert.equal((await receipt(restarted, value)).status, 'uncertain')
  assert.equal(restarted.statistics().solutionsDelivered, 0); assert.equal(restarted.statistics().uncertain, 1)
})

test('duplicate completion cannot count a job twice', async t => {
  const { service } = await setup(t), value = job()
  await service.createJob(value)
  await service.run(value, async ({ dispatch }) => { await dispatch(); return { applied: true } })
  await service.recordOutcome(value.taskId, value.challengeId, 'failed', { jobId: value.jobId, code: 'CAPTCHA_PROVIDER_ERROR' })
  assert.equal(service.statistics().solutionsDelivered, 1); assert.equal(service.statistics().failed, 0)
  assert.equal((await receipt(service, value)).status, 'delivered')
})

test('receipt archive retains old exact outcomes and owner boundary after bounded hot journal rolls over', async t => {
  const { service, start } = await setup(t)
  const now = Date.now(), entries = Array.from({ length: 1000 }, (_, index) => ({ ...job(String(index)), status: 'failed', dispatched: false,
    code: 'CAPTCHA_UNSUPPORTED', createdAt: now, updatedAt: now }))
  await service.persist('statistics.json', { version: 2, solutionsDelivered: 0, failed: 1000, cancelled: 0, uncertain: 0, pending: [], receipts: entries })
  const restarted = await start()
  await restarted.createJob(job('new'))
  assert.ok(restarted.receipts.size < 1000)
  const old = await receipt(restarted, job('0'))
  assert.equal(old.status, 'failed'); assert.equal(old.code, 'CAPTCHA_UNSUPPORTED'); assert.equal(old.persisted, true)
  assert.equal(old.captchaStats, undefined)
  await assert.rejects(restarted.receipt('peer-owner', 'task-0', 'job-0'), { code: 'NOT_FOUND' })
  assert.equal((await receipt(await start(), job('0'))).status, 'failed')
})

test('corrupt or secret-bearing receipt records fail closed and preserve the original file', async t => {
  const { service, directory } = await setup(t)
  const file = path.join(service.directory, 'statistics.json')
  const invalid = JSON.stringify({ version: 2, solutionsDelivered: 0, failed: 0, cancelled: 0, uncertain: 0, pending: [], receipts: [{ ...job(), token: 'forbidden' }] })
  await writeFile(file, invalid)
  const bad = new CaptchaService(directory, { protector }); t.after(() => bad.close())
  await assert.rejects(bad.ready, { code: 'CAPTCHA_STORAGE_UNAVAILABLE' })
  assert.equal(await readFile(file, 'utf8'), invalid)
})

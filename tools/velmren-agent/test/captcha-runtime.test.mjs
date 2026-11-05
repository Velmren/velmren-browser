import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { CapSolverClient } from '../capsolver-provider.mjs'
import { CaptchaService } from '../capsolver-service.mjs'
import { startCaptchaJob, captchaJobView } from '../captcha-runtime.mjs'

const key = 'SyntheticRuntimeKeyForTestsOnly'
const token = 'Synthetic.Runtime.Token'
const metadata = {
  userAgent: 'Synthetic Provider Browser/1.0', secChUa: 'Synthetic Client Hints',
  createTime: 1671615324290, 'recaptcha-ca-t': 'SyntheticSessionCookie',
  'recaptcha-ca-e': 'SyntheticEnterpriseCookie', extra: 'SyntheticIgnoredMetadata'
}
const taskTypes = ['ReCaptchaV2TaskProxyLess', 'ReCaptchaV2EnterpriseTaskProxyLess', 'AntiTurnstileTaskProxyLess']
const response = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })

async function setup(t, type, { afterDispatch, applyError } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'velmren-captcha-runtime-unit-'))
  const calls = [], applied = [], binding = Object.freeze({ originalDocument: true })
  const task = { taskId: 'synthetic-task', owner: 'synthetic-owner' }
  let active = true, deliveries = 0
  const provider = new CapSolverClient({ readKey: () => key, pollIntervalMs: 1,
    fetchImpl: async (url, init) => {
      const request = JSON.parse(init.body)
      calls.push({ url, request })
      if (url.endsWith('/createTask')) {
        await afterDispatch?.(() => { active = false })
        return response({ errorId: 0, taskId: 'synthetic-provider-task' })
      }
      assert.equal(url, 'https://api.capsolver.com/getTaskResult')
      return response({ errorId: 0, status: 'ready', taskId: 'synthetic-provider-task',
        solution: { ...metadata, [type === 'AntiTurnstileTaskProxyLess' ? 'token' : 'gRecaptchaResponse']: token } })
    } })
  const protector = { available: true, ensureDirectory: async () => {},
    protect: async value => { assert.equal(value, key); return 'U3ludGhldGlj'; },
    unprotect: async () => key }
  const service = new CaptchaService(directory, { protector, provider })
  t.after(() => service.close())
  await service.ready
  await service.settings({ action: 'save', enabled: true, key,
    maxRequestsPerDay: 10, maxConcurrent: 1, maxAttemptsPerTask: 3 })
  const page = { captcha: {
    prepare: async () => ({ task: { type, websiteURL: 'https://fixture.test/', websiteKey: 'synthetic-sitekey' }, binding }),
    apply: async (actualBinding, actualToken, stillActive) => {
      assert.equal(actualBinding, binding)
      assert.equal(stillActive(), true)
      if (applyError) throw Object.assign(new Error('Synthetic invalidated document'), { code: applyError })
      applied.push(actualToken)
      return { applied: true, callbackInvoked: true, deliveryUncertain: false }
    }
  } }
  const start = () => startCaptchaJob({ service, task, page, challengeId: 'synthetic-challenge',
    stillActive: () => active, deliver: async callback => { deliveries++; return callback() } })
  const finish = async job => {
    await task.captchaJobs.get(job.jobId).work
    return captchaJobView(task.captchaJobs.get(job.jobId), service, task.taskId)
  }
  return { directory, service, task, calls, applied, start, finish, deliveries: () => deliveries }
}

for (const type of taskTypes) {
  test(`documented ${type} metadata delivers once without exposing provider identity`, async t => {
    const run = await setup(t, type)
    const pending = await run.start()
    assert.equal(pending.status, 'pending')
    const done = await run.finish(pending)
    assert.equal(done.status, 'delivered')
    assert.deepEqual(done.receipt, { applied: true, callbackInvoked: true, deliveryUncertain: false })
    assert.deepEqual(run.applied, [token])
    assert.equal(run.deliveries(), 1)
    assert.deepEqual(await run.start(), done)
    assert.equal(run.calls.filter(call => call.url.endsWith('/createTask')).length, 1)
    assert.equal(run.calls.length, 2)
    assert.equal(run.service.view().usage.requestsLast24Hours, 1)
    assert.equal(done.captchaStats.solutionsDelivered, 1)
    assert.equal(done.captchaStats.failed, 0)
    const publicAndDisk = JSON.stringify([pending, done, run.service.view()]) +
      await readFile(path.join(run.service.directory, 'attempts.json'), 'utf8') +
      await readFile(path.join(run.service.directory, 'statistics.json'), 'utf8')
    for (const privateValue of [key, token, ...Object.values(metadata).filter(value => typeof value === 'string')]) {
      assert.ok(!publicAndDisk.includes(privateValue), 'Private provider data was retained outside delivery')
    }
  })
}

test('metadata-bearing result still cannot reach an invalidated document', async t => {
  const run = await setup(t, taskTypes[0], { applyError: 'CAPTCHA_STALE' })
  const done = await run.finish(await run.start())
  assert.equal(done.status, 'failed')
  assert.equal(done.code, 'CAPTCHA_STALE')
  assert.equal(done.captchaStats.failed, 1)
  assert.deepEqual(run.applied, [])
  assert.equal(run.calls.length, 2)
  assert.deepEqual(await run.start(), done)
  assert.equal(run.calls.length, 2)
})

test('cancellation after paid dispatch prevents delivery and preserves spent attempt', async t => {
  const run = await setup(t, taskTypes[0], { afterDispatch: deactivate => deactivate() })
  const done = await run.finish(await run.start())
  assert.equal(done.status, 'cancelled')
  assert.equal(done.code, 'CAPTCHA_CANCELLED')
  assert.equal(done.captchaStats.cancelled, 1)
  assert.equal(run.service.view().usage.requestsLast24Hours, 1)
  assert.equal(run.deliveries(), 0)
  assert.deepEqual(run.applied, [])
  assert.deepEqual(await run.start(), done)
  assert.equal(run.calls.filter(call => call.url.endsWith('/createTask')).length, 1)
})

test('preflight failure is not advertised as a durable terminal outcome before its write completes', async t => {
  const run = await setup(t, taskTypes[0])
  const create = run.service.createJob.bind(run.service), persist = run.service.persist.bind(run.service)
  let release, started
  const gate = new Promise(resolve => { release = resolve }), writing = new Promise(resolve => { started = resolve })
  run.service.createJob = async value => {
    await create(value); run.service.config.enabled = false
    run.service.persist = async (name, value) => { started(); await gate; return persist(name, value) }
  }
  const pending = await run.start(), job = run.task.captchaJobs.get(pending.jobId)
  try {
    await writing
    const visible = captchaJobView(job, run.service, run.task.taskId)
    const disk = JSON.parse(await readFile(path.join(run.service.directory, 'statistics.json'), 'utf8'))
    assert.equal(visible.status, 'pending'); assert.equal(disk.receipts[0].status, 'pending')
    assert.equal(visible.outcomeEvidence, 'pending'); assert.equal(run.calls.length, 0)
    assert.equal(visible.persisted, false); assert.equal(visible.captchaStats.persisted, false)
  } finally { release() }
  await job.work
  const done = captchaJobView(job, run.service, run.task.taskId)
  assert.equal(done.status, 'cancelled'); assert.equal(done.persisted, true); assert.equal(done.code, 'CAPTCHA_DISABLED')
  assert.equal(JSON.parse(await readFile(path.join(run.service.directory, 'statistics.json'), 'utf8')).receipts[0].status, 'cancelled')
})

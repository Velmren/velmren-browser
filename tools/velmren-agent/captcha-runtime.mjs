import { randomUUID } from 'node:crypto'
import { sanitizePublicError } from './privacy.mjs'

const failure = code => Object.assign(new Error('CAPTCHA operation did not complete.'), { code })

export function captchaJobView(job, service, taskId) {
  return { jobId: job.id, challengeId: job.challengeId, status: job.status,
    ...(job.receipt ? { receipt: { ...job.receipt } } : {}),
    ...(job.code ? { code: job.code } : {}), outcomeEvidence: job.status === 'pending' ? 'pending' : 'direct',
    recovered: false, persisted: job.persisted === true && service.statsPersisted, replayAllowed: false,
    captchaStats: service.statistics(taskId) }
}

export function findCaptchaJob(task, jobId) {
  const job = task.captchaJobs?.get(jobId)
  if (!job) throw failure('NOT_FOUND')
  return job
}

// Return a job receipt promptly; provider polling must not consume an MCP call
// timeout or hold one of the shared browser action slots.
export async function startCaptchaJob({ service, task, page, challengeId, stillActive, deliver }) {
  task.captchaJobs ??= new Map()
  const previous = [...task.captchaJobs.values()].find(job => job.challengeId === challengeId)
  if (previous) return captchaJobView(previous, service, task.taskId)
  if ([...task.captchaJobs.values()].some(job => job.status === 'pending')) throw failure('CAPTCHA_BUSY')
  if (task.captchaJobs.size >= 100) throw failure('CAPTCHA_LIMIT_REACHED')
  const controller = new AbortController()
  const job = { id: randomUUID(), challengeId, status: 'pending', controller }
  task.captchaJobs.set(job.id, job)
  try {
    await service.createJob({ jobId: job.id, owner: task.owner, taskId: task.taskId, challengeId })
    job.persisted = true
  } catch (error) { task.captchaJobs.delete(job.id); throw error }
  const watchdog = setInterval(() => { if (!stillActive()) controller.abort() }, 50)
  watchdog.unref()
  job.work = service.run({ taskId: task.taskId, challengeId, jobId: job.id, signal: controller.signal }, async ({ signal, dispatch, provider }) => {
    const active = () => !signal.aborted && stillActive()
    if (!active()) throw failure('CAPTCHA_CANCELLED')
    const prepared = await page.captcha.prepare(challengeId)
    if (!active()) throw failure('CAPTCHA_CANCELLED')
    const solution = await provider.solve(prepared.task, { signal, onDispatch: async () => {
      if (!active()) throw failure('CAPTCHA_CANCELLED')
      await dispatch()
    } })
    try {
      if (!active()) throw failure('CAPTCHA_CANCELLED')
      // Apply only the token through the original document/widget binding.
      // Provider metadata never changes this live page's browser identity.
      return await deliver(async () => {
        if (!active()) throw failure('CAPTCHA_CANCELLED')
        return page.captcha.apply(prepared.binding, solution.token, active)
      })
    } finally { solution.token = '' }
  }).then(receipt => {
    job.receipt = { applied: receipt.applied === true, callbackInvoked: receipt.callbackInvoked === true,
      deliveryUncertain: receipt.deliveryUncertain === true }
    job.status = receipt.deliveryUncertain ? 'uncertain' : receipt.applied ? 'delivered' : 'failed'
  }, async error => {
    const code = sanitizePublicError(error).code
    const status = ['failed', 'cancelled', 'uncertain'].includes(error.captchaOutcome) ? error.captchaOutcome : ['CAPTCHA_CANCELLED', 'CAPTCHA_DISABLED'].includes(code) ? 'cancelled'
      : ['CAPTCHA_DELIVERY_UNCERTAIN', 'CAPTCHA_TIMEOUT'].includes(code) ? 'uncertain' : 'failed'
    // run() can reject before acquiring a slot (for example after disabling).
    // Complete its already-persisted job exactly once in that case as well.
    await service.recordOutcome(task.taskId, challengeId, status, { jobId: job.id, code })
    job.code = code; job.status = status
  }).catch(() => {
    // A background accounting failure must not kill other owners' tasks.
    job.persisted = false
    if (job.status === 'pending') { job.status = 'uncertain'; job.code = 'CAPTCHA_STORAGE_UNAVAILABLE' }
  }).finally(() => clearInterval(watchdog))
  return captchaJobView(job, service, task.taskId)
}

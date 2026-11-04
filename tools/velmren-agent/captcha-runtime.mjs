import { randomUUID } from 'node:crypto'
import { sanitizePublicError } from './privacy.mjs'

const failure = code => Object.assign(new Error('CAPTCHA operation did not complete.'), { code })

export function captchaJobView(job, service, taskId) {
  return { jobId: job.id, challengeId: job.challengeId, status: job.status,
    ...(job.receipt ? { receipt: { ...job.receipt } } : {}),
    ...(job.code ? { code: job.code } : {}), captchaStats: service.statistics(taskId) }
}

export function findCaptchaJob(task, jobId) {
  const job = task.captchaJobs?.get(jobId)
  if (!job) throw failure('NOT_FOUND')
  return job
}

// Return a job receipt promptly; provider polling must not consume an MCP call
// timeout or hold one of the shared browser action slots.
export function startCaptchaJob({ service, task, page, challengeId, stillActive, deliver }) {
  task.captchaJobs ??= new Map()
  const previous = [...task.captchaJobs.values()].find(job => job.challengeId === challengeId)
  if (previous) return captchaJobView(previous, service, task.taskId)
  if ([...task.captchaJobs.values()].some(job => job.status === 'pending')) throw failure('CAPTCHA_BUSY')
  if (task.captchaJobs.size >= 100) throw failure('CAPTCHA_LIMIT_REACHED')
  const controller = new AbortController()
  const job = { id: randomUUID(), challengeId, status: 'pending', controller }
  task.captchaJobs.set(job.id, job)
  const watchdog = setInterval(() => { if (!stillActive()) controller.abort() }, 50)
  watchdog.unref()
  job.work = service.run({ taskId: task.taskId, challengeId, signal: controller.signal }, async ({ signal, dispatch, provider }) => {
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
      // A provider-specific User-Agent cannot safely replace this live page's
      // browser identity after navigation; do not apply such a bound result.
      if (solution.userAgent) throw failure('CAPTCHA_UNSUPPORTED')
      return await deliver(async () => {
        if (!active()) throw failure('CAPTCHA_CANCELLED')
        return page.captcha.apply(prepared.binding, solution.token, active)
      })
    } finally { solution.token = '' }
  }).then(receipt => {
    job.receipt = { applied: receipt.applied === true, callbackInvoked: receipt.callbackInvoked === true,
      deliveryUncertain: receipt.deliveryUncertain === true }
    job.status = receipt.deliveryUncertain ? 'uncertain' : receipt.applied ? 'delivered' : 'failed'
  }, error => {
    job.code = sanitizePublicError(error).code
    job.status = ['failed', 'cancelled', 'uncertain'].includes(error.captchaOutcome) ? error.captchaOutcome : ['CAPTCHA_CANCELLED', 'CAPTCHA_DISABLED'].includes(job.code) ? 'cancelled'
      : ['CAPTCHA_DELIVERY_UNCERTAIN', 'CAPTCHA_TIMEOUT'].includes(job.code) ? 'uncertain' : 'failed'
  }).finally(() => clearInterval(watchdog))
  return captchaJobView(job, service, task.taskId)
}

const states = new Set(['pending', 'delivered', 'failed', 'cancelled', 'uncertain'])
const codes = new Set(['CAPTCHA_CANCELLED', 'CAPTCHA_DISABLED', 'CAPTCHA_DELIVERY_UNCERTAIN', 'CAPTCHA_TIMEOUT',
  'CAPTCHA_STALE', 'CAPTCHA_UNSUPPORTED', 'CAPTCHA_ALREADY_SOLVED', 'CAPTCHA_CONTEXT_UNAVAILABLE',
  'CAPTCHA_PAGE_FAILED', 'CAPTCHA_INVALID_TOKEN', 'CAPTCHA_AUTH_REQUIRED', 'CAPTCHA_NO_BALANCE',
  'CAPTCHA_PROVIDER_ERROR', 'CAPTCHA_LIMIT_REACHED', 'CAPTCHA_ALREADY_ATTEMPTED', 'CAPTCHA_STORAGE_UNAVAILABLE'])
const text = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(value)
const object = value => value && typeof value === 'object' && !Array.isArray(value)
const fail = () => { throw Object.assign(new Error('CAPTCHA receipt storage is unavailable.'), { code: 'CAPTCHA_STORAGE_UNAVAILABLE' }) }

export function validateCaptchaReceipt(value) {
  if (!object(value) || Object.keys(value).some(key => !['jobId', 'owner', 'taskId', 'challengeId', 'status', 'dispatched', 'createdAt', 'updatedAt', 'receipt', 'code', 'interrupted'].includes(key)) ||
      !['jobId', 'owner', 'taskId', 'challengeId'].every(key => text(value[key])) || !states.has(value.status) ||
      typeof value.dispatched !== 'boolean' || !Number.isSafeInteger(value.createdAt) || value.createdAt < 0 ||
      !Number.isSafeInteger(value.updatedAt) || value.updatedAt < value.createdAt ||
      value.code !== undefined && !codes.has(value.code) || value.interrupted !== undefined && typeof value.interrupted !== 'boolean') fail()
  if (value.receipt !== undefined && (!object(value.receipt) || Object.keys(value.receipt).length !== 3 ||
      !['applied', 'callbackInvoked', 'deliveryUncertain'].every(key => typeof value.receipt[key] === 'boolean'))) fail()
  if (value.status === 'delivered' && (!value.receipt?.applied || value.receipt.deliveryUncertain)) fail()
  if (value.status === 'pending' && (value.receipt || value.code || value.interrupted)) fail()
  return value
}

export const safeCaptchaCode = code => codes.has(code) ? code : 'CAPTCHA_PROVIDER_ERROR'
export const tokenFreeReceipt = receipt => ({ applied: receipt?.applied === true,
  callbackInvoked: receipt?.callbackInvoked === true, deliveryUncertain: receipt?.deliveryUncertain === true })

export function publicCaptchaReceipt(value, { recovered = false, persisted = true } = {}) {
  return { jobId: value.jobId, challengeId: value.challengeId, status: value.status,
    ...(value.receipt ? { receipt: { ...value.receipt } } : {}), ...(value.code ? { code: value.code } : {}),
    outcomeEvidence: value.interrupted ? 'interrupted' : value.status === 'pending' ? 'pending' : 'direct',
    recovered, persisted, replayAllowed: false }
}

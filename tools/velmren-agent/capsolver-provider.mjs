const API_ORIGIN = 'https://api.capsolver.com'
const MAX_RESPONSE_BYTES = 65536
const MAX_POLLS = 120
const SAFE_CODES = new Set([
  'CAPTCHA_AUTH_REQUIRED', 'CAPTCHA_NO_BALANCE', 'CAPTCHA_PROVIDER_ERROR',
  'CAPTCHA_DELIVERY_UNCERTAIN', 'CAPTCHA_TIMEOUT', 'CAPTCHA_CANCELLED',
  'CAPTCHA_LIMIT_REACHED', 'CAPTCHA_ALREADY_ATTEMPTED', 'CAPTCHA_DISABLED',
  'CAPTCHA_STORAGE_UNAVAILABLE', 'CAPTCHA_STALE'
])
const TASK_TYPES = new Set([
  'ReCaptchaV2TaskProxyLess', 'ReCaptchaV2EnterpriseTaskProxyLess',
  'AntiTurnstileTaskProxyLess'
])
const MESSAGE = 'CAPTCHA provider request could not be completed'

export class CapSolverError extends Error {
  constructor(code = 'CAPTCHA_PROVIDER_ERROR') {
    super(MESSAGE)
    this.name = 'CapSolverError'
    this.code = SAFE_CODES.has(code) ? code : 'CAPTCHA_PROVIDER_ERROR'
  }
}

const fail = code => { throw new CapSolverError(code) }
const record = value => value !== null && typeof value === 'object' &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value))
const text = (value, max, pattern = /^[\x21-\x7e]+$/) =>
  typeof value === 'string' && value.length > 0 && value.length <= max && pattern.test(value)

function shape(value, keys) {
  if (!record(value) || Reflect.ownKeys(value).some(key =>
    !keys.includes(key) || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'))) fail()
}

// The caller binds this already-observed task to a native browser destination.
// Only documented, non-cookie fields cross the provider boundary.
function validateTask(task) {
  if (!record(task) || !TASK_TYPES.has(task.type)) fail()
  const turnstile = task.type === 'AntiTurnstileTaskProxyLess'
  const enterprise = task.type === 'ReCaptchaV2EnterpriseTaskProxyLess'
  shape(task, ['type', 'websiteURL', 'websiteKey', ...(turnstile ? ['metadata'] :
    ['isInvisible', 'pageAction', 'apiDomain', enterprise ? 'enterprisePayload' : 'recaptchaDataSValue'])])
  if (!text(task.websiteURL, 8192) || !text(task.websiteKey, 256, /^[A-Za-z0-9_-]+$/)) fail()
  const url = new URL(task.websiteURL)
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || !url.hostname) fail()
  url.hash = ''
  const result = { type: task.type, websiteURL: url.href, websiteKey: task.websiteKey }
  if (Object.hasOwn(task, 'isInvisible')) {
    if (typeof task.isInvisible !== 'boolean') fail()
    result.isInvisible = task.isInvisible
  }
  for (const key of ['pageAction', 'recaptchaDataSValue']) {
    if (!Object.hasOwn(task, key)) continue
    if (!text(task[key], key === 'pageAction' ? 256 : 8192)) fail()
    result[key] = task[key]
  }
  if (Object.hasOwn(task, 'apiDomain')) {
    if (!['www.google.com', 'www.recaptcha.net'].includes(task.apiDomain)) fail()
    result.apiDomain = task.apiDomain
  }
  if (Object.hasOwn(task, 'enterprisePayload')) {
    shape(task.enterprisePayload, ['s'])
    if (!text(task.enterprisePayload.s, 8192)) fail()
    result.enterprisePayload = { s: task.enterprisePayload.s }
  }
  if (Object.hasOwn(task, 'metadata')) {
    shape(task.metadata, ['action', 'cdata'])
    result.metadata = {}
    for (const key of ['action', 'cdata']) {
      if (!Object.hasOwn(task.metadata, key)) continue
      if (!text(task.metadata[key], key === 'action' ? 32 : 255, /^[A-Za-z0-9_-]+$/)) fail()
      result.metadata[key] = task.metadata[key]
    }
  }
  return result
}

// Race every async boundary, including key reads and response streams. An
// injected transport that ignores AbortSignal must not extend the deadline.
function operation(signal, timeoutMs) {
  if (signal !== undefined && !(signal instanceof AbortSignal)) fail()
  const controller = new AbortController()
  let code
  const stop = reason => { if (!code) { code = reason; controller.abort() } }
  const cancel = () => stop('CAPTCHA_CANCELLED')
  signal?.addEventListener('abort', cancel, { once: true })
  if (signal?.aborted) cancel()
  const timer = setTimeout(() => stop('CAPTCHA_TIMEOUT'), timeoutMs)
  const check = () => { if (code) fail(code) }
  return {
    signal: controller.signal, check,
    async wait(action) {
      check()
      let listener
      const interrupted = new Promise((resolve, reject) => {
        listener = () => reject(new CapSolverError(code))
        controller.signal.addEventListener('abort', listener, { once: true })
      })
      try {
        const result = await Promise.race([Promise.resolve().then(() => { check(); return action() }), interrupted])
        check()
        return result
      } finally { controller.signal.removeEventListener('abort', listener) }
    },
    async delay(ms) {
      let delayTimer
      try { await this.wait(() => new Promise(resolve => { delayTimer = setTimeout(resolve, ms) })) }
      finally { clearTimeout(delayTimer) }
    },
    close() { clearTimeout(timer); signal?.removeEventListener('abort', cancel); controller.abort() }
  }
}

function providerError(response) {
  if (!record(response) || !Number.isSafeInteger(response.errorId) || response.errorId < 0) fail()
  if (response.errorId === 0) {
    if (response.errorCode != null && response.errorCode !== '') fail()
    return
  }
  if (response.errorCode === 'ERROR_KEY_DENIED_ACCESS') fail('CAPTCHA_AUTH_REQUIRED')
  if (response.errorCode === 'ERROR_ZERO_BALANCE') fail('CAPTCHA_NO_BALANCE')
  if (response.errorCode === 'ERROR_TASK_TIMEOUT') fail('CAPTCHA_TIMEOUT')
  fail()
}

function solution(response, type) {
  if (!record(response.solution)) fail()
  const token = response.solution[type === 'AntiTurnstileTaskProxyLess' ? 'token' : 'gRecaptchaResponse']
  if (!text(token, 32768, /^[A-Za-z0-9._~+\/-]+=*$/)) fail()
  const result = { token }
  if (Object.hasOwn(response.solution, 'userAgent')) {
    if (!text(response.solution.userAgent, 1024, /^[\x20-\x7e]+$/)) fail()
    result.userAgent = response.solution.userAgent
  }
  return result
}

export class CapSolverClient {
  #readKey
  #fetch
  #origin
  #pollIntervalMs
  #timeoutMs

  // Alternate origins are for injected mock transports only. Production never
  // reads a provider endpoint or credential from the process environment.
  constructor({ readKey, fetchImpl = globalThis.fetch, baseUrl = API_ORIGIN,
    pollIntervalMs = 2000, timeoutMs = 120000 } = {}) {
    try {
      const endpoint = new URL(baseUrl)
      if (typeof readKey !== 'function' || typeof fetchImpl !== 'function' ||
          endpoint.protocol !== 'https:' || endpoint.username || endpoint.password ||
          endpoint.pathname !== '/' || endpoint.search || endpoint.hash ||
          (fetchImpl === globalThis.fetch && endpoint.origin !== API_ORIGIN) ||
          !Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 1 || pollIntervalMs > 120000 ||
          !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) fail()
      this.#readKey = readKey
      this.#fetch = fetchImpl
      this.#origin = endpoint.origin
      this.#pollIntervalMs = pollIntervalMs
      this.#timeoutMs = timeoutMs
    } catch { fail() }
  }

  async #key(scope) {
    try {
      const key = await scope.wait(() => this.#readKey())
      if (!text(key, 1024)) fail('CAPTCHA_AUTH_REQUIRED')
      return key
    } catch {
      scope.check()
      fail('CAPTCHA_AUTH_REQUIRED')
    }
  }

  async #post(path, payload, scope, onDispatch) {
    let reader, response
    try {
      const options = {
        method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(payload), signal: scope.signal,
        redirect: 'error', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer'
      }
      if (onDispatch) await scope.wait(() => onDispatch())
      response = await scope.wait(() => this.#fetch(`${this.#origin}/${path}`, options))
      if (!response || response.redirected || !Number.isInteger(response.status) ||
          response.status < 200 || response.status >= 300 && ![400, 401].includes(response.status)) fail()
      const mediaType = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase()
      if (mediaType !== 'application/json') fail()
      const length = response.headers.get('content-length')
      if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_RESPONSE_BYTES)) fail()
      if (!response.body || typeof response.body.getReader !== 'function') fail()
      reader = response.body.getReader()
      const chunks = []
      let size = 0
      while (true) {
        const { value, done } = await scope.wait(() => reader.read())
        if (done) break
        if (!(value instanceof Uint8Array)) fail()
        size += value.byteLength
        if (size > MAX_RESPONSE_BYTES) fail()
        chunks.push(value)
      }
      const result = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size)))
      if (!record(result)) fail()
      if (response.status === 401) fail('CAPTCHA_AUTH_REQUIRED')
      if (response.status === 400 && !(Number.isSafeInteger(result.errorId) && result.errorId > 0)) fail()
      return result
    } catch (error) {
      scope.check()
      if (error instanceof CapSolverError) throw new CapSolverError(error.code)
      fail()
    } finally {
      // Never wait for a hostile stream's cancellation promise.
      try { Promise.resolve(reader ? reader.cancel() : response?.body?.cancel()).catch(() => {}) } catch {}
    }
  }

  async balance({ signal } = {}) {
    let scope
    try {
      scope = operation(signal, this.#timeoutMs)
      const clientKey = await this.#key(scope)
      const response = await this.#post('getBalance', { clientKey }, scope)
      providerError(response)
      if (typeof response.balance !== 'number' || !Number.isFinite(response.balance) || response.balance < 0) fail()
      return { balanceUsd: response.balance }
    } catch (error) {
      if (error instanceof CapSolverError) throw new CapSolverError(error.code)
      fail()
    } finally { scope?.close() }
  }

  // The private result must go directly to the bound native delivery path.
  // onDispatch receives no arguments and runs once before the only create call.
  // Callers must retain that signal even when a later timeout/cancel is reported.
  async solve(task, { signal, onDispatch } = {}) {
    let scope
    try {
      const validated = validateTask(task)
      if (onDispatch !== undefined && typeof onDispatch !== 'function') fail()
      scope = operation(signal, this.#timeoutMs)
      const clientKey = await this.#key(scope)
      let created, dispatched = false
      try {
        created = await this.#post('createTask', { clientKey, task: validated }, scope, async () => {
          try { await onDispatch?.() }
          catch (error) { throw new CapSolverError(error?.code) }
          scope.check()
          dispatched = true
        })
      } catch (error) {
        if (dispatched && error.code === 'CAPTCHA_PROVIDER_ERROR') fail('CAPTCHA_DELIVERY_UNCERTAIN')
        throw error
      }
      // A well-formed provider rejection is definite; raw descriptions never escape.
      if (!Number.isSafeInteger(created.errorId) || created.errorId < 0 ||
          created.errorId === 0 && created.errorCode != null && created.errorCode !== '') {
        fail('CAPTCHA_DELIVERY_UNCERTAIN')
      }
      providerError(created)
      try {
        if (created.status === 'ready') return solution(created, validated.type)
        if (![undefined, null, 'idle', 'processing'].includes(created.status) ||
            !text(created.taskId, 256, /^[A-Za-z0-9_-]+$/)) fail()
      } catch { fail('CAPTCHA_DELIVERY_UNCERTAIN') }
      const taskId = created.taskId
      for (let poll = 0; poll < MAX_POLLS; poll++) {
        await scope.delay(this.#pollIntervalMs)
        const response = await this.#post('getTaskResult', { clientKey, taskId }, scope)
        providerError(response)
        if (Object.hasOwn(response, 'taskId') && response.taskId !== taskId) fail()
        if (response.status === 'ready') return solution(response, validated.type)
        if (!['idle', 'processing'].includes(response.status)) fail()
      }
      fail('CAPTCHA_TIMEOUT')
    } catch (error) {
      if (error instanceof CapSolverError) throw new CapSolverError(error.code)
      fail()
    } finally { scope?.close() }
  }
}

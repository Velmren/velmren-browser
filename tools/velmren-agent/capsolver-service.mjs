import { mkdir, readFile, writeFile, rename, lstat, unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { WindowsServiceKey } from './service-key.mjs'
import { CapSolverClient } from './capsolver-provider.mjs'

const day = 24 * 60 * 60 * 1000
const defaults = Object.freeze({ maxRequestsPerDay: 100, maxConcurrent: 2, maxAttemptsPerTask: 3 })
const limits = { maxRequestsPerDay: [1, 1000], maxConcurrent: [1, 5], maxAttemptsPerTask: [1, 10] }
const emptyStats = () => ({ solutionsDelivered: 0, failed: 0, cancelled: 0, uncertain: 0 })
const error = code => Object.assign(new Error('CAPTCHA service operation did not complete.'), { code })
const fail = code => { throw error(code) }
const validKey = value => typeof value === 'string' && /^[A-Za-z0-9_-]{20,256}$/.test(value)
const object = value => value && typeof value === 'object' && !Array.isArray(value)

export function validateCaptchaSettings(args) {
  if (!object(args) || !['get', 'save', 'check', 'remove_key'].includes(args.action)) fail('INVALID_ARGUMENTS')
  const allowed = args.action === 'save' ? ['action', 'enabled', 'key', ...Object.keys(limits)] : ['action']
  if (Object.keys(args).some(key => !allowed.includes(key))) fail('INVALID_ARGUMENTS')
  if (args.action === 'save') {
    if (typeof args.enabled !== 'boolean' || args.key !== undefined && !validKey(args.key)) fail('INVALID_ARGUMENTS')
    for (const [key, [minimum, maximum]] of Object.entries(limits)) {
      if (!Number.isInteger(args[key]) || args[key] < minimum || args[key] > maximum) fail('INVALID_ARGUMENTS')
    }
  }
}

export class CaptchaService {
  constructor(stateDir, { protector = new WindowsServiceKey(), provider, now = Date.now } = {}) {
    this.directory = path.join(stateDir, 'services', 'capsolver')
    this.protector = protector; this.now = now
    this.config = { version: 1, enabled: false, encryptedKey: null, limits: { ...defaults } }
    this.ledger = []; this.operations = new Map(); this.active = 0; this.waiters = []; this.generation = 0
    this.stats = emptyStats(); this.pendingOutcomes = []; this.taskStats = new Map(); this.statsPersisted = true
    this.verification = { status: 'unchecked' }; this.writes = Promise.resolve(); this.closed = false; this.updating = false
    this.provider = provider ?? new CapSolverClient({ readKey: () => this.readKey() })
    this.ready = this.load().catch(failure => { this.config.enabled = false; throw failure })
    this.ready.catch(() => {})
  }
  get enabled() { return this.config.enabled && !!this.config.encryptedKey && this.protector.available && !this.closed && !this.updating }
  async readJson(name) {
    try {
      const file = path.join(this.directory, name), stat = await lstat(file)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 512 * 1024) fail('CAPTCHA_STORAGE_UNAVAILABLE')
      return JSON.parse(await readFile(file, 'utf8'))
    } catch (failure) {
      if (failure.code === 'ENOENT') return null
      throw error('CAPTCHA_STORAGE_UNAVAILABLE')
    }
  }
  async load() {
    for (const directory of [path.dirname(this.directory), this.directory]) {
      try { if ((await lstat(directory)).isSymbolicLink()) fail('CAPTCHA_STORAGE_UNAVAILABLE') }
      catch (failure) { if (failure.code !== 'ENOENT') throw error('CAPTCHA_STORAGE_UNAVAILABLE') }
    }
    const saved = await this.readJson('settings.json')
    if (saved) {
      if (!object(saved) || saved.version !== 1 || Object.keys(saved).some(key => !['version', 'enabled', 'encryptedKey', 'limits'].includes(key)) ||
          !(saved.encryptedKey === null || typeof saved.encryptedKey === 'string' && saved.encryptedKey.length <= 16384 && /^[A-Za-z0-9+/]+={0,2}$/.test(saved.encryptedKey))) fail('CAPTCHA_STORAGE_UNAVAILABLE')
      try { validateCaptchaSettings({ action: 'save', enabled: saved.enabled, ...saved.limits }) } catch { fail('CAPTCHA_STORAGE_UNAVAILABLE') }
      this.config = saved
    }
    const ledger = await this.readJson('attempts.json')
    if (ledger) {
      if (!object(ledger) || ledger.version !== 1 || !Array.isArray(ledger.entries) || ledger.entries.length > 5000 || ledger.entries.some(item =>
        !object(item) || Object.keys(item).some(key => !['taskId', 'challengeId', 'time'].includes(key)) ||
        typeof item.taskId !== 'string' || item.taskId.length > 256 || typeof item.challengeId !== 'string' || item.challengeId.length > 256 || !Number.isSafeInteger(item.time) || item.time < 0)) fail('CAPTCHA_STORAGE_UNAVAILABLE')
      this.ledger = ledger.entries
    }
    this.prune()
    const statistics = await this.readJson('statistics.json')
    if (statistics) {
      if (!object(statistics) || statistics.version !== 1 || Object.keys(statistics).some(key => !['version', 'pending', ...Object.keys(emptyStats())].includes(key)) ||
          Object.keys(emptyStats()).some(key => !Number.isSafeInteger(statistics[key]) || statistics[key] < 0)) fail('CAPTCHA_STORAGE_UNAVAILABLE')
      this.stats = Object.fromEntries(Object.keys(emptyStats()).map(key => [key, statistics[key]]))
      if (statistics.pending !== undefined && (!Array.isArray(statistics.pending) || statistics.pending.length > 32 || statistics.pending.some(item =>
        !object(item) || Object.keys(item).some(key => !['taskId', 'challengeId'].includes(key)) ||
        typeof item.taskId !== 'string' || item.taskId.length > 256 || typeof item.challengeId !== 'string' || item.challengeId.length > 256))) fail('CAPTCHA_STORAGE_UNAVAILABLE')
      // A crash cannot prove what happened after a durable dispatch intent.
      if (statistics.pending?.length) {
        this.stats.uncertain += statistics.pending.length
        await this.persist('statistics.json', { version: 1, ...this.stats, pending: [] })
      }
    }
  }
  prune() { this.ledger = this.ledger.filter(item => item.time > this.now() - day) }
  serial(fn) {
    const operation = this.writes.catch(() => {}).then(fn)
    this.writes = operation.catch(() => {})
    return operation
  }
  async persist(name, data) {
    let temporary
    try {
      await mkdir(this.directory, { recursive: true, mode: 0o700 })
      if ((await lstat(this.directory)).isSymbolicLink() || (await lstat(path.dirname(this.directory))).isSymbolicLink()) fail('CAPTCHA_STORAGE_UNAVAILABLE')
      await this.protector.ensureDirectory(this.directory)
      temporary = path.join(this.directory, `${name}.${randomUUID()}.tmp`)
      await writeFile(temporary, JSON.stringify(data), { flag: 'wx', mode: 0o600, flush: true })
      await rename(temporary, path.join(this.directory, name))
    } catch { throw error('CAPTCHA_STORAGE_UNAVAILABLE') }
    finally { if (temporary) await unlink(temporary).catch(() => {}) }
  }
  async readKey() {
    await this.ready
    if (!this.config.encryptedKey) fail('CAPTCHA_AUTH_REQUIRED')
    return this.protector.unprotect(this.config.encryptedKey)
  }
  view() {
    this.prune()
    return { provider: 'capsolver', enabled: this.enabled, hasKey: !!this.config.encryptedKey,
      storageAvailable: this.protector.available, limits: { ...this.config.limits },
      usage: { requestsLast24Hours: this.ledger.length, active: this.active, ...this.statistics() }, verification: { ...this.verification } }
  }
  statistics(taskId) { return { ...(taskId ? this.taskStats.get(taskId) ?? emptyStats() : this.stats), persisted: this.statsPersisted } }
  async recordOutcome(taskId, challengeId, outcome) {
    return this.serial(async () => {
      this.stats[outcome]++
      const task = this.taskStats.get(taskId) ?? emptyStats()
      task[outcome]++; this.taskStats.set(taskId, task)
      this.pendingOutcomes = this.pendingOutcomes.filter(item => item.taskId !== taskId || item.challengeId !== challengeId)
      try { await this.persist('statistics.json', { version: 1, ...this.stats, pending: this.pendingOutcomes }); this.statsPersisted = true }
      catch { this.statsPersisted = false }
    })
  }
  async settings(args) {
    validateCaptchaSettings(args)
    await this.ready
    if (args.action === 'get') return this.view()
    if (args.action === 'check') {
      const generation = this.generation
      try {
        const { balanceUsd } = await this.provider.balance({ signal: AbortSignal.timeout(20000) })
        if (generation !== this.generation) fail('CAPTCHA_CANCELLED')
        this.verification = { status: 'valid', balanceUsd, checkedAt: new Date(this.now()).toISOString() }
        return this.view()
      } catch (failure) {
        if (generation === this.generation) this.verification = { status: 'error' }
        throw failure
      }
    }
    return this.serial(async () => {
      if (!this.protector.available) fail('CAPTCHA_STORAGE_UNAVAILABLE')
      this.updating = true; this.generation++; this.abortAll(); this.verification = { status: 'unchecked' }
      try {
        const config = { ...this.config, limits: { ...this.config.limits } }
        if (args.action === 'remove_key') { config.enabled = false; config.encryptedKey = null }
        else {
          config.enabled = args.enabled
          config.limits = Object.fromEntries(Object.keys(limits).map(key => [key, args[key]]))
          if (args.key !== undefined) config.encryptedKey = await this.protector.protect(args.key)
          if (config.enabled && !config.encryptedKey) fail('CAPTCHA_AUTH_REQUIRED')
        }
        await this.persist('settings.json', config)
        this.config = config
      } finally { this.updating = false }
      return this.view()
    })
  }
  guard(generation, signal) {
    if (signal?.aborted) fail('CAPTCHA_CANCELLED')
    if (!this.enabled || generation !== this.generation) fail('CAPTCHA_DISABLED')
  }
  async takeSlot(signal) {
    if (signal.aborted) fail('CAPTCHA_CANCELLED')
    if (this.active < this.config.limits.maxConcurrent && !this.waiters.length) { this.active++; return }
    if (this.waiters.length >= 64) fail('CAPTCHA_LIMIT_REACHED')
    await new Promise((resolve, reject) => {
      const entry = { signal, grant: () => { signal.removeEventListener('abort', abort); this.active++; resolve() } }
      const abort = () => { this.waiters = this.waiters.filter(item => item !== entry); reject(error('CAPTCHA_CANCELLED')) }
      this.waiters.push(entry); signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
    })
  }
  releaseSlot() {
    this.active--
    while (this.waiters.length && this.active < this.config.limits.maxConcurrent) {
      const entry = this.waiters.shift()
      if (!entry.signal.aborted) entry.grant()
    }
  }
  async reserve(taskId, challengeId, generation, signal) {
    await this.serial(async () => {
      this.guard(generation, signal); this.prune()
      if (this.ledger.some(item => item.taskId === taskId && item.challengeId === challengeId)) fail('CAPTCHA_ALREADY_ATTEMPTED')
      if (this.ledger.length >= this.config.limits.maxRequestsPerDay || this.ledger.filter(item => item.taskId === taskId).length >= this.config.limits.maxAttemptsPerTask) fail('CAPTCHA_LIMIT_REACHED')
      const entries = [...this.ledger, { taskId, challengeId, time: this.now() }]
      // Reserve durably before the first network byte. Uncertain attempts count.
      await this.persist('attempts.json', { version: 1, entries })
      this.ledger = entries
      const pending = [...this.pendingOutcomes, { taskId, challengeId }]
      await this.persist('statistics.json', { version: 1, ...this.stats, pending })
      this.pendingOutcomes = pending
      this.guard(generation, signal)
    })
  }
  async run({ taskId, challengeId, signal }, operation) {
    await this.ready
    const generation = this.generation
    this.guard(generation, signal); this.prune()
    const id = `${taskId}:${challengeId}`
    if (this.operations.has(id) || this.ledger.some(item => item.taskId === taskId && item.challengeId === challengeId)) fail('CAPTCHA_ALREADY_ATTEMPTED')
    const controller = new AbortController()
    const combined = AbortSignal.any([controller.signal, AbortSignal.timeout(150000), ...(signal ? [signal] : [])])
    this.operations.set(id, controller)
    let slot = false, dispatched = false, outcome = 'failed'
    try {
      await this.takeSlot(combined); slot = true; this.guard(generation, combined)
      const result = await operation({ signal: combined, dispatch: async () => {
        if (dispatched) fail('CAPTCHA_ALREADY_ATTEMPTED')
        await this.reserve(taskId, challengeId, generation, combined)
        dispatched = true
      }, provider: this.provider })
      outcome = result?.deliveryUncertain ? 'uncertain' : result?.applied === true ? 'solutionsDelivered' : 'failed'
      return result
    } catch (failure) {
      outcome = ['CAPTCHA_CANCELLED', 'CAPTCHA_DISABLED'].includes(failure.code) ? 'cancelled'
        : failure.code === 'CAPTCHA_DELIVERY_UNCERTAIN' || dispatched && failure.code === 'CAPTCHA_TIMEOUT' ? 'uncertain' : 'failed'
      throw Object.assign(error(failure.code), { captchaOutcome: outcome })
    } finally {
      this.operations.delete(id)
      if (slot) this.releaseSlot()
      await this.recordOutcome(taskId, challengeId, outcome)
    }
  }
  abortAll() { for (const controller of this.operations.values()) controller.abort() }
  close() { this.closed = true; this.generation++; this.abortAll() }
}

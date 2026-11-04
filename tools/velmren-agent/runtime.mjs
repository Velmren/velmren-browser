import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir, lstat, realpath, rename } from 'node:fs/promises'
import path from 'node:path'
import { AgentPage } from './page.mjs'
import { PageFrames } from './frames.mjs'
import { validateArguments, BrokerError, CLIENTS, AGENT_PROTOCOL } from './client.mjs'
import { effectivePolicyIdentity } from './policy-identity.mjs'
import { RequestTrace } from './trace.mjs'
import { sanitizeActionResult, sanitizeWaitResult } from './action-result.mjs'
import { requestHuman, resumeHuman } from './handoff.mjs'
import { validateManualProfileUrl } from './manual-profile.mjs'
import { sanitizePublicResult, sanitizePublicError } from './privacy.mjs'
import { PrivateInputs } from './private-input.mjs'
import { beginSensitive, endSensitive, validateSensitiveEnd, clearSensitiveObservations, rememberSensitiveDocument, sensitiveStatus } from './sensitive-state.mjs'

const terminal = new Set(['completed', 'cancelled'])
const fail = (message, code = 'INVALID_STATE') => { throw new BrokerError(message, code) }
const autoAttach = { autoAttach: true, waitForDebuggerOnStart: true, flatten: true, filter: [{ type: 'browser', exclude: true }, { type: 'tab', exclude: true }, {}] }
const taskAutoAttach = { ...autoAttach, filter: [{ type: 'shared_worker', exclude: true }, { type: 'service_worker', exclude: true }, ...autoAttach.filter] }
const mutations = new Set(['task_create', 'task_act', 'task_navigate', 'task_upload_files', 'task_handle_dialog', 'task_close_page', 'task_finish', 'task_cancel', 'task_request_human', 'task_resume', 'task_control', 'task_sensitive'])
const addQueueTime = (request, key, started) => { if (request) request.trace[key] += performance.now() - started }

export async function inspectUploadFiles(files) {
  const inspected = [], seen = new Set()
  let total = 0
  for (const [index, file] of files.entries()) {
    const absolute = path.resolve(file)
    const key = process.platform === 'win32' ? absolute.toLowerCase() : absolute
    if (seen.has(key)) fail(`files[${index}] duplicates another file`, 'INVALID_ARGUMENTS')
    seen.add(key)
    try {
      let current = absolute, info
      while (true) {
        const entry = await lstat(current)
        if (entry.isSymbolicLink()) fail(`files[${index}] uses a symbolic link or junction`, 'INVALID_ARGUMENTS')
        if (current === absolute) info = entry
        const parent = path.dirname(current)
        if (parent === current) break
        current = parent
      }
      const canonical = await realpath(absolute)
      if ((process.platform === 'win32' ? canonical.toLowerCase() : canonical) !== key) fail(`files[${index}] resolves through a redirected path`, 'INVALID_ARGUMENTS')
      if (!info.isFile()) fail(`files[${index}] must be a regular file`, 'INVALID_ARGUMENTS')
      total += info.size
      if (total > 100 * 1024 * 1024) fail('Files exceed the 100 MiB total limit', 'INVALID_ARGUMENTS')
      inspected.push({ path: absolute, name: path.basename(absolute), size: info.size })
    } catch (error) {
      if (error instanceof BrokerError) throw error
      // OS errors include local paths. Do not forward them through the tool.
      fail(`files[${index}] is missing or cannot be inspected`, 'INVALID_ARGUMENTS')
    }
  }
  return inspected
}

export function originAllowed(raw, allowedOrigins, allowWeb = false) {
  let url
  try { url = new URL(raw) } catch { return false }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return false
  return allowedOrigins ? allowedOrigins.includes(url.origin) : allowWeb || ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
}

class Slots {
  constructor(max) { this.max = max; this.active = 0; this.waiters = [] }
  async run(fn, request) {
    const started = performance.now()
    if (this.active >= this.max) await new Promise(resolve => this.waiters.push(resolve))
    else this.active++
    addQueueTime(request, 'activeSlotQueueMs', started)
    try { return await fn() }
    finally { const next = this.waiters.shift(); if (next) next(); else this.active-- }
  }
}

export class AgentBroker {
  constructor(browser, stateDir, policy = {}, { trace, manualSession, browserFactory } = {}) {
    this.privateInputs = new PrivateInputs()
    Object.assign(this, { browser, stateDir, tasks: new Map(), contexts: new Map(), sessions: new Map(), targets: new Map(), clients: new Map(), stopping: false })
    if (policy.allowedOrigins !== undefined && (!Array.isArray(policy.allowedOrigins) || policy.allowedOrigins.some(origin => {
      try { const url = new URL(origin); return !['http:', 'https:'].includes(url.protocol) || url.origin !== origin } catch { return true }
    }))) throw new Error('allowedOrigins must contain exact HTTP(S) origins')
    for (const key of ['allowWeb', 'webCompatibility']) if (policy[key] !== undefined && typeof policy[key] !== 'boolean') throw new Error(`${key} must be boolean`)
    this.allowedOrigins = policy.allowedOrigins
    this.allowWeb = policy.allowWeb === true
    this.webCompatibility = policy.webCompatibility === true
    this.webSocketPolicy = policy.webSocketPolicy ?? 'disabled'
    this.maxTasks = policy.maxTasks ?? 8
    const maxActions = policy.maxActiveActions ?? 5
    if (!Number.isInteger(this.maxTasks) || this.maxTasks < 1 || this.maxTasks > 32 || !Number.isInteger(maxActions) || maxActions < 1 || maxActions > 8) throw new Error('Invalid task/concurrency limits')
    this.slots = new Slots(maxActions)
    this.trace = trace === undefined ? new RequestTrace(() => this.stateDir) : trace
    this.policyIdentity = effectivePolicyIdentity(policy)
    this.profileMode = policy.profileMode ?? 'isolated'
    this.sharedProfile = this.profileMode === 'persistent'
    this.ownedTargets = new Map()
    this.frameOwners = new Map()
    this.pendingAttachments = new Map()
    this.downloadOwners = new Map()
    this.rootCreation = Promise.resolve()
    this.manualSession = manualSession
    this.browserFactory = browserFactory
    this.profileLogin = { phase: 'automated' }
    this.browserGeneration = 0
    this.protocolActive = 0
    this.protocolWork = new Set()
    this.queuedOperations = 0
    this.bindBrowser(browser)
  }
  bindBrowser(browser) {
    this.unbindBrowser()
    this.browser = browser
    const generation = ++this.browserGeneration
    const current = () => this.browser === browser && this.browserGeneration === generation
    browser.setMaxListeners(this.maxTasks * 16 + this.slots.max + 4)
    this.listener = message => {
      if (!current() || !['automated', 'restarting'].includes(this.profileLogin.phase)) return
      this.protocolActive++
      const work = this.onProtocol(message).catch(error => { if (current()) this.event('protocol-error', { message: error.message }) }).finally(() => { this.protocolActive--; this.protocolWork.delete(work) })
      this.protocolWork.add(work)
    }
    this.closedListener = () => {
      if (!current() || this.profileLogin.phase !== 'automated') return
      for (const task of this.tasks.values()) if (!terminal.has(task.state)) { task.state = 'cancelled'; task.reason = 'Browser stopped' }
      if (!this.stopping) setTimeout(() => { if (current() && this.profileLogin.phase === 'automated') this.onShutdown?.() }, 20).unref()
    }
    browser.on('protocol', this.listener)
    browser.on('closed', this.closedListener)
  }
  unbindBrowser() {
    if (this.listener) this.browser.off('protocol', this.listener)
    if (this.closedListener) this.browser.off('closed', this.closedListener)
    this.browserGeneration++
  }
  assertAutomated() {
    if (this.profileLogin.phase !== 'automated') fail('Profile login is active; close its browser and explicitly finish login before using automation', 'PROFILE_LOGIN_ACTIVE')
  }
  assertProfileLoginIdle() {
    const busy = [...this.tasks.values()].some(task => !terminal.has(task.state) || this.pages(task).size || task.contextId || task.ending || task.cleanupError || task.cleanupRetryQueued || task.cleanupRetryAt || task.creatingRoot || task.pendingRootAttachments?.size || task.closingPageIds?.size || task.downloads?.some(item => item.state === 'inProgress'))
    const downloading = [...this.downloadOwners.values()].some(owner => (owner.item?.state ?? owner.state ?? 'inProgress') === 'inProgress')
    if (busy || downloading || this.contexts.size || this.pendingAttachments.size || this.slots.active || this.slots.waiters.length || this.queuedOperations || this.protocolActive || this.creatingSharedRoot) fail('Profile login requires all tasks, pages, cleanup, queued actions, and downloads to be finished', 'PROFILE_LOGIN_BUSY')
  }
  profileLoginView() {
    const active = this.profileLogin
    return {
      phase: active.phase, automationConnected: active.phase === 'automated' && !this.browser.closed,
      ...(active.loginId ? { loginId: active.loginId } : {}),
      windowOpen: active.phase === 'automated' ? false : typeof active.windowOpen === 'boolean' ? active.windowOpen : null,
      ...(active.recoveryRequired ? { recoveryRequired: true } : {})
    }
  }
  async profileLoginStatus() {
    const current = this.profileLogin
    if (current.phase !== 'automated') {
      const status = await this.manualSession?.status()
      if (this.profileLogin === current) {
        current.windowOpen = typeof status?.windowOpen === 'boolean' ? status.windowOpen : null
        if (status?.recoveryRequired) current.recoveryRequired = true
        if (current.phase === 'manual' && status?.windowOpen === false) current.phase = 'awaiting-confirmation'
      }
    }
    return this.profileLoginView()
  }
  async startProfileLogin(owner, args) {
    this.assertAutomated()
    if (args.userConfirmed !== true) fail('Explicit user confirmation is required', 'INVALID_ARGUMENTS')
    const url = validateManualProfileUrl(args.url)
    if (!this.sharedProfile || !this.allowWeb || this.allowedOrigins !== undefined) fail('Ordinary profile login requires a persistent profile and unrestricted allowWeb policy', 'PROFILE_LOGIN_POLICY')
    if (!this.allowed(url)) fail('Origin is not permitted by the local policy', 'ORIGIN_DENIED')
    if (!this.manualSession || !this.browserFactory) fail('Manual profile login is not configured', 'PROFILE_LOGIN_UNAVAILABLE')
    if (this.stopping || this.browser.closed) fail('Automated browser is not running', 'INVALID_STATE')
    this.assertProfileLoginIdle()
    // Set the profile-wide gate before the first await, including receipt I/O.
    this.profileLogin = { phase: 'stopping-automation', loginId: randomUUID(), owner }
    this.idleSince = null
    try {
      await this.manualSession.prepare({ loginId: this.profileLogin.loginId, owner })
      this.unbindBrowser()
      await this.browser.closeForManual()
      this.profileLogin.phase = 'manual'
      await this.manualSession.launch(url)
      return await this.profileLoginStatus()
    } catch (error) {
      this.profileLogin.recoveryRequired = true
      throw error
    }
  }
  resetBrowserMaps() {
    for (const pending of this.pendingAttachments.values()) clearTimeout(pending.timer)
    for (const map of [this.contexts, this.sessions, this.targets, this.ownedTargets, this.frameOwners, this.pendingAttachments, this.downloadOwners]) map.clear()
    this.rootCreation = Promise.resolve()
    this.profileContextId = null
    this.creatingSharedRoot = false
  }
  async finishProfileLogin(owner, args, { signal, beforeComplete } = {}) {
    const current = this.profileLogin
    if (args.userConfirmed !== true) fail('Explicit user confirmation is required', 'INVALID_ARGUMENTS')
    if (!current.loginId || args.loginId !== current.loginId) fail('Profile login session not found', 'NOT_FOUND')
    if (owner !== 'admin' && owner !== current.owner) fail('Only the initiating client or administrator may finish profile login', 'UNAUTHORIZED')
    if (!['manual', 'awaiting-confirmation'].includes(current.phase) || this.profileLoginFinishing) fail('Profile login transition is already in progress or requires recovery', 'PROFILE_LOGIN_ACTIVE')
    this.profileLoginFinishing = true
    let replacement
    try {
      signal?.throwIfAborted()
      await this.manualSession.assertClosed(args.loginId)
      current.phase = 'awaiting-confirmation'
      current.windowOpen = false
      await this.manualSession.finish(args.loginId, { userConfirmed: true })
      current.phase = 'restarting'
      replacement = await this.browserFactory()
      this.resetBrowserMaps()
      this.bindBrowser(replacement)
      await this.init()
      if (replacement.closed) throw new Error('Automated browser exited while reconnecting')
      signal?.throwIfAborted()
      await beforeComplete?.()
      if (replacement.closed) throw new Error('Automated browser exited while reconnecting')
      await this.manualSession.complete(args.loginId, { signal })
      this.profileLogin = { phase: 'automated' }
      this.idleSince = null
      if (replacement.closed) {
        // Completion removed the manual receipt; hand a concurrent exit back
        // to the ordinary browser-failure lifecycle instead of retaining login.
        this.closedListener()
        fail('Automated browser exited while completing profile login', 'PROFILE_LOGIN_RESTART_FAILED')
      }
      return this.profileLoginStatus()
    } catch (error) {
      if (this.profileLogin === current && current.phase === 'restarting') {
        this.unbindBrowser()
        try {
          if (replacement) await replacement.closeForManual()
          await Promise.allSettled([...this.protocolWork])
          current.phase = 'awaiting-confirmation'
        } catch { /* Retain the blocked phase until the process can be recovered. */ }
        current.recoveryRequired = true
      }
      throw error
    } finally { this.profileLoginFinishing = false }
  }
  event(type, fields = {}) {
    const clean = { ...fields }
    if (Object.hasOwn(clean, 'message')) clean.message = sanitizePublicError({ code: clean.code }).error
    this.onEvent?.(sanitizePublicResult({ type, ...clean, time: new Date().toISOString() }))
  }
  allowed(url) { return originAllowed(url, this.allowedOrigins, this.allowWeb) }
  pages(task) {
    // Keep compatibility with embedders that supplied the original single page.
    if (!task.pages) {
      task.pages = new Map()
      if (task.page) { task.page.pageId ??= task.targetId; task.page.targetId ??= task.targetId; task.pages.set(task.targetId, task.page); task.selectedPageId = task.targetId }
    }
    return task.pages
  }
  pageRecords(task) { return [...this.pages(task).values()].map(page => sanitizePublicResult({ pageId: page.pageId, openerId: page.openerId ?? null, url: page.url ?? task.url, title: page.title ?? '', attached: !page.detached, ...(page.dialog ? { dialog: page.dialog } : {}) }, { sensitive: task.sensitiveHistory })) }
  record(task) {
    const { taskId, label, owner, state, reason, url, createdAt, downloads, blockedOrigins, selectedPageId } = task
    return sanitizePublicResult({ taskId, label, owner, state, reason, url, createdAt, downloads, blockedOrigins, profileMode: this.profileMode, sharedProfile: this.sharedProfile, pages: this.pageRecords(task), selectedPageId: selectedPageId ?? task.selectedPageId, privacy: sensitiveStatus(task, task.page), ...(task.targetPolicy ? { targetPolicy: task.targetPolicy } : {}), ...(task.handoff ? { handoff: { id: task.handoff.id, pageId: task.handoff.pageId, shown: task.handoff.shown } } : {}), ...(task.cleanupError ? { cleanupPending: true, cleanupError: task.cleanupError } : {}) }, { sensitive: task.sensitiveHistory })
  }
  task(id, owner) {
    const task = this.tasks.get(id)
    if (!task || (owner !== 'admin' && task.owner !== owner)) fail('Task not found', 'NOT_FOUND')
    return task
  }
  page(task, id = task.selectedPageId) {
    const pages = this.pages(task)
    const page = pages.get(id ?? task.selectedPageId)
    if (!page) fail('Page not found in this task', 'NOT_FOUND')
    if (page.detached) fail('Page is temporarily detached; observe again after reattachment', 'PAGE_DETACHED')
    return page
  }
  select(task, page) { task.selectedPageId = page.pageId; task.page = page; task.targetId = page.targetId; task.url = page.url ?? task.url }
  async setPageFileChooserInterception(task, page, enabled) {
    await page.setFileChooserInterception(enabled)
    for (const entry of this.sessions.values()) if (entry.task === task && entry.type === 'iframe' && (entry.ownerPageId === page.pageId || (enabled && !entry.ownerPageId))) {
      await this.browser.send('Page.setInterceptFileChooserDialog', { enabled }, entry.sessionId)
    }
  }
  serialize(task, fn, request) {
    const started = performance.now()
    this.queuedOperations++
    const result = task.queue.then(() => { this.assertAutomated(); addQueueTime(request, 'taskQueueMs', started); return fn() }).finally(() => { this.queuedOperations-- })
    task.queue = result.catch(() => {})
    return result
  }
  checkActive(task) { this.assertAutomated(); if (task.state !== 'agent-active') fail(`Task is ${task.state}; agent actions are paused`) }
  async init() {
    if (this.sharedProfile) {
      const contexts = await this.browser.send('Target.getBrowserContexts')
      if (!contexts.defaultBrowserContextId) throw new Error('Persistent agent profile requires a default browser context ID')
      this.profileContextId = contexts.defaultBrowserContextId
      this.downloadStagingDir = path.join(this.stateDir, 'download-staging')
      await mkdir(this.downloadStagingDir, { recursive: true, mode: 0o700 })
      await this.browser.send('Browser.setDownloadBehavior', { behavior: 'allowAndName', browserContextId: this.profileContextId, downloadPath: this.downloadStagingDir, eventsEnabled: true })
    }
    await this.browser.send('Target.setDiscoverTargets', { discover: true })
    await this.browser.send('Target.setAutoAttach', autoAttach)
  }
  scheduleLifecycle() {
    if (this.lifecycleTimer) return
    this.lifecycleTimer = setInterval(() => {
      if (this.lifecycleBusy || this.stopping) return
      this.lifecycleBusy = true
      void this.expireClients().catch(error => this.event('client-cleanup-error', { message: error.message })).finally(() => { this.lifecycleBusy = false })
    }, 1000)
    this.lifecycleTimer.unref()
  }
  async releaseClient(owner, now = Date.now()) {
    const client = this.clients.get(owner)
    if (!client || client.released) return { released: true }
    client.released = true; client.expiresAt = now + 30000
    const pending = []
    for (const task of this.tasks.values()) if (task.owner === owner && !terminal.has(task.state)) {
      task.controlGeneration = (task.controlGeneration ?? 0) + 1
      task.state = 'cancelled'; task.reason = 'Client disconnected or its lease expired'
      pending.push(this.serialize(task, () => this.end(task, 'cancelled')))
    }
    await Promise.all(pending)
    this.checkIdle(now)
    return { released: true }
  }
  checkIdle(now = Date.now()) {
    if (!this.managedMode || this.stopping || this.retirementRequested || this.profileLogin.phase !== 'automated') return
    const active = [...this.clients.values()].some(client => client.leaseMs && !client.released)
    const unfinished = [...this.tasks.values()].some(task => !terminal.has(task.state))
    const retrying = [...this.tasks.values()].some(task => task.contextId && (task.ending || task.cleanupRetryQueued || task.cleanupRetryAt))
    if (active || unfinished || retrying) this.idleSince = null
    else if (this.idleSince == null) this.idleSince = now
    else if (now - this.idleSince >= 30000) {
      this.idleSince = null; this.retirementRequested = true
      const retained = [...this.tasks.values()].filter(task => task.contextId).map(task => task.taskId)
      if (retained.length) this.event('retained-context-cleanup', { taskIds: retained, reason: 'Cleanup retries exhausted; closing the idle owned browser' })
      this.onShutdown?.()
    }
  }
  async expireClients(now = Date.now()) {
    const releases = []
    for (const [owner, client] of this.clients) {
      if (client.released && client.expiresAt <= now) this.clients.delete(owner)
      else if (client.leaseMs && !client.released && client.expiresAt <= now) releases.push(this.releaseClient(owner, now))
    }
    for (const result of await Promise.allSettled(releases)) if (result.status === 'rejected') this.event('client-cleanup-error', { message: result.reason.message })
    await this.retryCleanup(now)
    this.checkIdle(now)
  }
  async retryCleanup(now = Date.now()) {
    if (this.profileLogin.phase !== 'automated') return
    const retries = []
    for (const task of this.tasks.values()) {
      if (!terminal.has(task.state) || !task.contextId || task.ending || task.cleanupRetryQueued || !task.cleanupRetryAt || task.cleanupRetryAt > now) continue
      task.cleanupRetryQueued = true
      retries.push(this.serialize(task, () => this.end(task, task.state, { retry: true })).finally(() => { task.cleanupRetryQueued = false }))
    }
    for (const result of await Promise.allSettled(retries)) if (result.status === 'rejected') this.event('task-cleanup-error', { message: result.reason.message })
  }
  contentPolicy() {
    const sources = this.allowedOrigins?.length ? this.allowedOrigins.join(' ') : this.allowedOrigins ? "'none'" : this.allowWeb ? 'http: https:' : 'http://localhost:* https://localhost:* http://127.0.0.1:* https://127.0.0.1:* http://[::1]:* https://[::1]:*'
    const sockets = this.allowedOrigins ? this.allowedOrigins.map(origin => origin.replace(/^http/, 'ws')).join(' ') : this.allowWeb ? 'ws: wss:' : 'ws://localhost:* wss://localhost:* ws://127.0.0.1:* wss://127.0.0.1:* ws://[::1]:* wss://[::1]:*'
    // CSP intentionally allows ws -> wss and default-port secure upgrades.
    // This is a separate opt-in contract; HTTP(S) Fetch checks remain exact.
    const connect = this.webCompatibility && this.webSocketPolicy === 'csp-secure-upgrades' && sockets ? `${sources} ${sockets}` : sources
    const common = `connect-src ${connect}; object-src 'none'; frame-src ${sources}; form-action ${sources}`
    return this.webCompatibility ? `${common}; worker-src ${sources} blob:` : `${common}; worker-src 'none'; sandbox allow-scripts allow-same-origin allow-forms allow-downloads`
  }
  async configureSession(sessionId, entry) {
    if (entry?.type === 'worker') {
      // DedicatedWorkerDevToolsAgentHost has no Fetch handler. Its main script
      // and subresources use the ancestor frame's intercepted loader factory.
      entry.policyPhase = 'worker-ancestor-policy'
      const owner = this.sessions.get(entry.networkOwnerSessionId)
      if (!owner?.interceptionReady || owner.task !== entry.task || !['page', 'iframe'].includes(owner.type)) throw new Error('Dedicated worker has no verified frame network policy')
      entry.policyPhase = 'descendant-attachment'
      await this.browser.send('Target.setAutoAttach', this.sharedProfile ? taskAutoAttach : autoAttach, sessionId)
      return
    }
    // NetworkHandler sets bypass synchronously, then falls through to the
    // renderer. A noopener navigation suspends that reply until Runtime resume
    // releases TargetHandler::RequestThrottle (devtools_session.cc). Keep the
    // command ordered before Fetch/Target acknowledgements, but await its reply
    // only after the browser-side policy is installed and navigation resumes.
    entry.policyPhase = 'service-worker-bypass'
    entry.bypassAcknowledgement = this.browser.send('Network.setBypassServiceWorker', { bypass: !this.webCompatibility }, sessionId)
      .then(() => null, error => { entry.bypassError = error; return error })
    const patterns = [{ urlPattern: '*', requestStage: 'Request' }, { urlPattern: '*', resourceType: 'Document', requestStage: 'Response' }]
    // Chromium classifies worker main scripts as Other, imports as Script.
    // Their response CSP covers WebSockets, which Fetch cannot intercept.
    if (this.webCompatibility) for (const resourceType of ['Script', 'Other']) patterns.push({ urlPattern: '*', resourceType, requestStage: 'Response' })
    entry.policyPhase = 'request-interception'
    await this.browser.send('Fetch.enable', { patterns }, sessionId)
    if (entry) entry.interceptionReady = true
    entry.policyPhase = 'descendant-attachment'
    await this.browser.send('Target.setAutoAttach', this.sharedProfile ? taskAutoAttach : autoAttach, sessionId)
    // Queue renderer-side chooser policy before resume as well; its reply is
    // suspended during the same noopener navigation as the Network reply.
    if (entry.page || entry.type === 'iframe') {
      entry.policyPhase = 'file-chooser-interception'
      entry.chooserAcknowledgement = this.browser.send('Page.setInterceptFileChooserDialog', { enabled: (entry.page ?? this.pages(entry.task).get(entry.ownerPageId))?.interceptFileChooser !== false }, sessionId)
        .then(() => null, error => { entry.chooserError = error; return error })
    }
  }
  async resumeSession(entry) {
    if (this.targets.get(entry.targetId) !== entry) return false
    if (entry.bypassError) { entry.policyPhase = 'service-worker-acknowledgement'; throw entry.bypassError }
    if (entry.chooserError) { entry.policyPhase = 'file-chooser-interception'; throw entry.chooserError }
    if (entry.type === 'worker' && !this.sessions.get(entry.networkOwnerSessionId)?.interceptionReady) throw new Error('Dedicated worker frame policy was detached')
    entry.policyPhase = 'navigation-resume'
    await this.browser.send('Runtime.runIfWaitingForDebugger', {}, entry.sessionId)
    entry.policyPhase = 'service-worker-acknowledgement'
    const error = await entry.bypassAcknowledgement
    if (error) throw error
    entry.policyPhase = 'file-chooser-interception'
    const chooserError = await entry.chooserAcknowledgement
    if (chooserError) throw chooserError
    return this.targets.get(entry.targetId) === entry
  }
  targetPolicyDiagnostic(entry, reason) {
    return {
      targetId: /^[a-zA-Z0-9_-]{1,128}$/.test(entry.targetId ?? '') ? entry.targetId : 'unavailable',
      targetType: ['page', 'other', 'iframe', 'worker', 'service_worker', 'shared_worker'].includes(entry.reportedType ?? entry.type) ? entry.reportedType ?? entry.type : 'unsupported',
      phase: entry.policyPhase ?? 'classification', reason
    }
  }
  sessionTask(sessionId) {
    return this.sessions.get(sessionId)?.task ?? [...this.tasks.values()].find(task => [...this.pages(task).values()].some(page => !page.detached && page.sessionId === sessionId))
  }
  detachSession(sessionId) {
    const entry = this.sessions.get(sessionId)
    this.sessions.delete(sessionId)
    if (entry?.task) for (const page of this.pages(entry.task).values()) page.frames?.detachSession(sessionId)
    for (const child of [...this.sessions.values()]) if (child.parentSessionId === sessionId) this.detachSession(child.sessionId)
    if (entry && this.targets.get(entry.targetId) === entry) {
      this.targets.delete(entry.targetId)
      if (entry.page && this.pages(entry.task).get(entry.targetId) === entry.page) {
        entry.page.dispose(); entry.page.detached = true; entry.page.observation = null
      }
    }
  }
  opener(info) {
    if (!info.openerId && !info.openerFrameId) return null
    const entry = this.targets.get(info.openerId)
    if (entry?.page && !entry.page.detached) return { task: entry.task, page: entry.page }
    const frame = this.frameOwners.get(info.openerFrameId) ?? this.frameOwners.get(info.openerId)
    const framePage = frame && this.pages(frame.task).get(frame.pageId)
    if (framePage && !framePage.detached) return { task: frame.task, page: framePage }
    for (const task of this.tasks.values()) {
      const page = [...this.pages(task).values()].find(page => !page.detached && page.frameId === info.openerId)
      if (page) return { task, page }
    }
    return null
  }
  rememberFrame(frameId, entry, parentId) {
    if (!frameId || !entry?.task) return
    const prior = this.frameOwners.get(frameId)
    if (prior && prior.task !== entry.task) return
    this.frameOwners.set(frameId, { task: entry.task, pageId: entry.page?.pageId ?? entry.ownerPageId ?? prior?.pageId, sessionId: entry.sessionId, parentId: parentId ?? prior?.parentId })
  }
  deferAttachment(message) {
    const id = message.params.sessionId
    if (this.pendingAttachments.has(id)) return
    if (this.pendingAttachments.size >= 128) return this.rejectAttachment(message)
    const timer = setTimeout(() => {
      this.pendingAttachments.delete(id)
      void this.rejectAttachment(message).catch(() => {})
    }, 5000)
    timer.unref()
    this.pendingAttachments.set(id, { message, timer })
  }
  async drainAttachments(targetId) {
    for (const [id, pending] of [...this.pendingAttachments]) {
      if (pending.message.params.targetInfo.targetId !== targetId) continue
      this.pendingAttachments.delete(id); clearTimeout(pending.timer)
      await this.attach(pending.message)
    }
  }
  async rejectAttachment(message) {
    const info = message.params.targetInfo
    // A conflicting duplicate session must not close another task's target.
    if (this.targets.has(info.targetId) || info.type === 'worker') {
      await this.browser.send('Target.detachFromTarget', { sessionId: message.params.sessionId }, message.sessionId).catch(() => {})
    } else if (info.targetId) await this.browser.send('Target.closeTarget', { targetId: info.targetId }).catch(() => {})
  }
  async attachProfileWorker(message) {
    const { sessionId, targetInfo: info } = message.params
    if (this.sessions.has(sessionId)) return
    if (message.sessionId || this.targets.has(info.targetId)) {
      await this.browser.send('Target.detachFromTarget', { sessionId }, message.sessionId).catch(() => {})
      return
    }
    const entry = { profileOwned: true, targetId: info.targetId, type: info.type, sessionId }
    this.sessions.set(sessionId, entry); this.targets.set(info.targetId, entry)
    entry.ready = (async () => {
      try {
        await this.configureSession(sessionId, entry)
        await this.resumeSession(entry)
      } catch (error) {
        await this.browser.send('Target.closeTarget', { targetId: info.targetId }).catch(() => {})
        if (!this.stopping && this.targets.get(info.targetId) === entry) throw error
      }
    })()
    await entry.ready
  }
  async attach(message) {
    const p = message.params, info = p.targetInfo
    const parent = message.sessionId ? this.sessionTask(message.sessionId) : undefined
    const contextOwner = this.contexts.get(info.browserContextId)
    const opener = this.opener(info), openerOwner = opener?.task
    if (this.sharedProfile && info.browserContextId === this.profileContextId && this.webCompatibility && ['shared_worker', 'service_worker'].includes(info.type)) return this.attachProfileWorker(message)
    const frameOwner = this.frameOwners.get(info.targetId)?.task ?? this.frameOwners.get(info.parentFrameId)?.task
    const knownOwner = this.ownedTargets.get(info.targetId)
    const openerFrameOwner = this.frameOwners.get(info.openerFrameId)?.task
    const openerTombstone = this.ownedTargets.get(info.openerId) ?? this.frameOwners.get(info.openerId)?.task ?? openerFrameOwner
    const task = this.sharedProfile ? knownOwner ?? parent ?? openerOwner ?? openerTombstone ?? frameOwner : contextOwner ?? parent ?? openerOwner
    if (this.sharedProfile && !task && info.browserContextId === this.profileContextId &&
        ((this.creatingSharedRoot && ['page', 'other'].includes(info.type)) || info.type === 'iframe')) return this.deferAttachment(message)
    // Never infer ownership from another task's session when context disagrees.
    if (!task || (info.browserContextId && info.browserContextId !== (this.sharedProfile ? this.profileContextId : task.contextId)) ||
        (this.sharedProfile && [parent, openerOwner, openerTombstone, openerFrameOwner, frameOwner].some(owner => owner && owner !== task)) ||
        (parent && contextOwner && parent !== contextOwner) || (openerOwner && contextOwner && openerOwner !== contextOwner) || terminal.has(task.state)) {
      await this.rejectAttachment(message)
      return
    }
    // Native hidden WebContents are reported as "other" before createTarget
    // returns. Keep them paused until that response confirms the exact root ID.
    if (info.type === 'other' && task.creatingRoot && !message.sessionId) {
      task.pendingRootAttachments.set(p.sessionId, message)
      return
    }
    if (this.sessions.has(p.sessionId)) return
    const existing = this.targets.get(info.targetId)
    if (existing) {
      // An OOPIF/worker may also be announced by a related target autoattacher.
      if (existing.sessionId !== p.sessionId) {
        try { await this.browser.send('Target.detachFromTarget', { sessionId: p.sessionId }, message.sessionId) }
        catch (error) {
          if (terminal.has(task.state) || this.browser.closed) return
          if (!this.targets.has(info.targetId)) {
            const { targetInfos } = await this.browser.send('Target.getTargets')
            if (!targetInfos.some(target => target.targetId === info.targetId)) return
          }
          task.reason = 'Could not release a duplicate target session'
          await this.end(task, 'cancelled')
          throw error
        }
      }
      return
    }
    const ownedHiddenPage = info.type === 'other' && (this.sharedProfile || contextOwner === task) && (info.targetId === task.rootTargetId || openerOwner === task)
    const isPage = info.type === 'page' || ownedHiddenPage
    const priorPage = isPage ? this.pages(task).get(info.targetId) : undefined
    const supported = isPage || info.type === 'iframe' || (this.webCompatibility && ['worker', 'service_worker', 'shared_worker'].includes(info.type))
    const isPopup = isPage && !priorPage && this.pages(task).size > 0
    if (!supported || (isPopup && !this.webCompatibility) || (isPage && !priorPage && this.pages(task).size >= 16)) {
      task.reason = 'Additional target blocked by the task policy'
      this.event('target-policy-blocked', { taskId: task.taskId, ...this.targetPolicyDiagnostic({ targetId: info.targetId, type: info.type }, 'unsupported-target') })
      await this.browser.send('Target.closeTarget', { targetId: info.targetId })
      return
    }
    const frame = this.frameOwners.get(info.targetId) ?? this.frameOwners.get(info.parentFrameId)
    const parentEntry = this.sessions.get(message.sessionId) ?? this.targets.get(info.parentId) ?? this.sessions.get(frame?.sessionId) ?? [...this.targets.values()].find(entry => entry.task === task && entry.page?.frameId === info.parentFrameId && info.parentFrameId)
    const ownerPageId = parentEntry?.page?.pageId ?? parentEntry?.ownerPageId ?? (info.type === 'iframe' && this.pages(task).size === 1 ? this.pages(task).keys().next().value : undefined)
    const entry = { task, sessionId: p.sessionId, parentSessionId: message.sessionId, targetId: info.targetId, type: isPage ? 'page' : info.type, reportedType: info.type, ownerPageId,
      networkOwnerSessionId: parentEntry?.type === 'worker' ? parentEntry.networkOwnerSessionId : parentEntry?.sessionId }
    this.sessions.set(p.sessionId, entry); this.targets.set(info.targetId, entry)
    this.ownedTargets.set(info.targetId, task)
    if (isPage) {
      entry.page = new AgentPage(this.browser, info.targetId, p.sessionId)
      entry.page.frames = new PageFrames(entry.page, () => [...this.sessions.values()].filter(session => session.task === task && (!session.ownerPageId || session.ownerPageId === entry.page.pageId)), id => this.frameOwners.get(id))
      entry.page.interceptFileChooser = priorPage?.interceptFileChooser ?? opener?.page.interceptFileChooser ?? true
      Object.assign(entry.page, { openerId: opener?.page.pageId ?? info.openerId ?? priorPage?.openerId ?? (isPopup ? task.selectedPageId : null), url: info.url ?? priorPage?.url, title: info.title ?? priorPage?.title })
      priorPage?.dispose()
      this.pages(task).set(info.targetId, entry.page)
      if (!priorPage || task.selectedPageId === info.targetId) this.select(task, entry.page)
    }
    entry.ready = (async () => {
      try {
        // Browser-side interception and descendant attachment are acknowledged
        // before resume. Renderer-dependent initialization must follow resume.
        await this.configureSession(p.sessionId, entry)
        if (terminal.has(task.state) || !await this.resumeSession(entry)) return
        entry.policyPhase = 'page-initialization'
        if (entry.page) { await entry.page.init(); this.rememberFrame(entry.page.frameId, entry) }
        if (entry.type === 'iframe') {
          await this.browser.send('Page.enable', {}, entry.sessionId)
          await this.browser.send('Runtime.enable', {}, entry.sessionId)
        }
        entry.policyPhase = 'ready'
      } catch (error) {
        if (terminal.has(task.state)) return
        if (this.targets.get(info.targetId) !== entry) {
          const reason = this.targets.has(info.targetId) ? 'session-replaced' : entry.page && !this.pages(task).has(info.targetId) ? 'target-closed' : 'session-detached'
          this.event('target-policy-lifecycle', { taskId: task.taskId, ...this.targetPolicyDiagnostic(entry, reason) })
          return
        }
        const reason = error.code === 'CDP_TIMEOUT' ? 'command-timeout' : error.code === 'CDP_SESSION_CLOSED' ? 'session-closed' : error.protocolCode === -32601 ? 'unsupported-command' : 'enforcement-failed'
        const diagnostic = this.targetPolicyDiagnostic(entry, reason)
        task.targetPolicy = diagnostic
        this.event('target-policy-failure', { taskId: task.taskId, ...diagnostic })
        task.reason = `Could not enforce ${diagnostic.targetType} target policy: ${diagnostic.targetId}; ${diagnostic.phase}; ${reason}`
        await this.end(task, 'cancelled')
        throw new BrokerError(task.reason, 'TARGET_POLICY_FAILED')
      }
    })()
    if (entry.page) entry.page.ready = entry.ready
    await entry.ready
  }
  async onProtocol(message) {
    const p = message.params ?? {}
    if (message.method === 'Target.attachedToTarget') return this.attach(message)
    if (message.method === 'Target.detachedFromTarget') {
      this.detachSession(p.sessionId)
      return
    }
    if (message.method === 'Fetch.requestPaused') {
      const task = this.sessionTask(message.sessionId)
      const profileOwned = this.sessions.get(message.sessionId)?.profileOwned
      const send = async (method, params) => {
        try { return await this.browser.send(method, params, message.sessionId) }
        catch (error) { if (!this.stopping && !this.browser.closed && (profileOwned || (task && !terminal.has(task.state))) && this.sessions.has(message.sessionId)) throw error }
      }
      if (!task && !profileOwned) { await send('Fetch.failRequest', { requestId: p.requestId, errorReason: 'BlockedByClient' }).catch(() => {}); return }
      if (task && terminal.has(task.state)) { await send('Fetch.failRequest', { requestId: p.requestId, errorReason: 'Aborted' }).catch(() => {}); return }
      if (p.responseStatusCode) {
        const headers = [...(p.responseHeaders ?? []), { name: 'Content-Security-Policy', value: this.contentPolicy() }]
        await send('Fetch.continueResponse', { requestId: p.requestId, responseCode: p.responseStatusCode, responseHeaders: headers })
      } else {
        const allowed = this.allowed(p.request.url)
        if (!allowed) {
          let origin; try { origin = new URL(p.request.url).origin } catch { origin = 'invalid' }
          if (task && !task.blockedOrigins.includes(origin)) task.blockedOrigins.push(origin)
        }
        await send(allowed ? 'Fetch.continueRequest' : 'Fetch.failRequest', allowed ? { requestId: p.requestId } : { requestId: p.requestId, errorReason: 'BlockedByClient' })
      }
    } else if (message.method === 'Target.targetDestroyed') {
      const entry = this.targets.get(p.targetId)
      const task = entry?.task ?? [...this.tasks.values()].find(task => this.pages(task).has(p.targetId))
      if (entry) this.sessions.delete(entry.sessionId)
      this.targets.delete(p.targetId)
      if (task) await this.removePage(task, p.targetId)
    } else if (message.method === 'Target.targetInfoChanged') {
      const page = this.targets.get(p.targetInfo.targetId)?.page
      if (page) Object.assign(page, { url: p.targetInfo.url, title: p.targetInfo.title })
    } else if (message.method === 'Page.frameAttached' || message.method === 'Page.frameNavigated') {
      const frameId = p.frame?.id ?? p.frameId
      this.rememberFrame(frameId, this.sessions.get(message.sessionId), p.frame?.parentId ?? p.parentFrameId)
      await this.drainAttachments(frameId)
      if (message.method !== 'Page.frameNavigated' || p.frame.parentId) return
      const task = this.sessionTask(message.sessionId)
      const page = task && [...this.pages(task).values()].find(page => page.sessionId === message.sessionId)
      if (page) { page.url = p.frame.url; if (task.selectedPageId === page.pageId) task.url = p.frame.url }
    } else if (message.method === 'Page.frameDetached' && p.reason !== 'swap') {
      const owner = this.frameOwners.get(p.frameId), session = this.sessions.get(message.sessionId)
      if (owner && session?.task === owner.task) {
        const removed = new Set([p.frameId])
        for (let changed = true; changed;) {
          changed = false
          for (const [id, frame] of this.frameOwners) if (frame.task === owner.task && removed.has(frame.parentId) && !removed.has(id)) { removed.add(id); changed = true }
        }
        for (const id of removed) this.frameOwners.get(id).detached = true
      }
    } else if (message.method === 'Browser.downloadWillBegin') {
      if (!/^[a-zA-Z0-9-]{1,100}$/.test(p.guid) || this.downloadOwners.has(p.guid)) return
      const task = this.frameOwners.get(p.frameId)?.task ?? [...this.tasks.values()].find(task => [...this.pages(task).values()].some(page => page.frameId === p.frameId))
      if (task && !terminal.has(task.state)) {
        const item = { guid: p.guid, name: path.basename(p.suggestedFilename.replaceAll('\\', '/')), path: path.join(task.downloadDir, p.guid), state: 'inProgress' }
        task.downloads.push(item); this.downloadOwners.set(p.guid, { task, item })
      } else if (this.sharedProfile) {
        this.downloadOwners.set(p.guid, { task: null })
        await this.browser.send('Browser.cancelDownload', { guid: p.guid, browserContextId: this.profileContextId }).catch(() => {})
      }
    } else if (message.method === 'Browser.downloadProgress') {
      const owner = this.downloadOwners.get(p.guid)
      if (owner) owner.state = p.state
      const item = owner?.item
      if (item) {
        if (this.sharedProfile && p.state === 'completed') {
          // GUID names and a single profile-wide staging directory prevent
          // concurrent task download settings from stealing one another's files.
          if (!owner.move) owner.move = rename(path.join(this.downloadStagingDir, p.guid), item.path)
          try { await owner.move } catch (error) { item.state = 'failed'; throw error }
        }
        Object.assign(item, { state: p.state, receivedBytes: p.receivedBytes, totalBytes: p.totalBytes })
      }
    }
  }
  async create(owner, args, request) {
    this.assertAutomated()
    if (!this.allowed(args.url)) fail('Origin is not permitted by the local policy', 'ORIGIN_DENIED')
    if ([...this.tasks.values()].filter(task => !terminal.has(task.state)).length >= this.maxTasks) fail('Task limit reached', 'LIMIT_REACHED')
    let initialized
    const task = { taskId: randomUUID(), label: args.label || 'Browser task', owner, state: 'agent-active', reason: '', url: args.url, createdAt: new Date().toISOString(), downloads: [], blockedOrigins: [], pages: new Map(), pendingRootAttachments: new Map(), queue: new Promise(resolve => { initialized = resolve }) }
    if (args.sensitive) beginSensitive(task, [])
    this.tasks.set(task.taskId, task)
    if (request) { request.trace.taskId = task.taskId; request.dispatched = true }
    try {
      if (this.sharedProfile) task.contextId = this.profileContextId
      else {
        const context = await this.browser.send('Target.createBrowserContext', { disposeOnDetach: true })
        task.contextId = context.browserContextId; this.contexts.set(task.contextId, task)
      }
      task.downloadDir = path.join(this.stateDir, 'downloads', task.taskId)
      await mkdir(task.downloadDir, { recursive: true })
      if (!this.sharedProfile) await this.browser.send('Browser.setDownloadBehavior', { behavior: 'allowAndName', browserContextId: task.contextId, downloadPath: task.downloadDir, eventsEnabled: true })
      task.creatingRoot = true
      const createRoot = async () => {
        this.assertAutomated()
        this.creatingSharedRoot = this.sharedProfile
        try {
          const target = await this.browser.send('Target.createTarget', { url: 'about:blank', browserContextId: task.contextId, hidden: true, background: true })
          task.rootTargetId = target.targetId; task.creatingRoot = false
          this.ownedTargets.set(target.targetId, task)
          await this.drainAttachments(target.targetId)
          return target
        } finally {
          this.creatingSharedRoot = false
          if (this.sharedProfile) for (const [id, pending] of this.pendingAttachments) {
            if (!['page', 'other'].includes(pending.message.params.targetInfo.type)) continue
            this.pendingAttachments.delete(id); clearTimeout(pending.timer)
            await this.rejectAttachment(pending.message)
          }
        }
      }
      const creating = this.sharedProfile ? this.rootCreation.then(createRoot) : createRoot()
      if (this.sharedProfile) this.rootCreation = creating.catch(() => {})
      const target = await creating
      const pending = [...task.pendingRootAttachments.values()]
      task.pendingRootAttachments.clear()
      await Promise.all(pending.map(message => this.attach(message)))
      // Auto-attach normally arrives before createTarget returns. Explicit attach
      // is a fallback for native hidden targets omitted from discovery.
      if (!this.targets.has(target.targetId)) {
        const { sessionId } = await this.browser.send('Target.attachToTarget', { targetId: target.targetId, flatten: true })
        if (!this.targets.has(target.targetId)) await this.attach({ params: { sessionId, targetInfo: { targetId: target.targetId, type: 'page', browserContextId: task.contextId, url: 'about:blank' } } })
      }
      const page = this.page(task, target.targetId)
      if (request) request.trace.pageId = page.pageId
      await page.ready
      this.checkActive(task)
      const observation = await page.navigate(args.url)
      this.event('task-created', { taskId: task.taskId, owner })
      return { ...this.record(task), observation: this.decorate(task, observation) }
    } catch (error) { await this.end(task, 'cancelled'); throw error }
    finally { task.creatingRoot = false; initialized() }
  }
  async removePage(task, pageId) {
    const pages = this.pages(task), page = pages.get(pageId)
    if (!page) return
    page.dispose(); pages.delete(pageId)
    if (task.selectedPageId === pageId) {
      const next = pages.get(page.openerId) ?? [...pages.values()].at(-1)
      if (next) this.select(task, next)
      else { task.page = null; task.targetId = null; task.selectedPageId = null }
    }
    if (!pages.size && !terminal.has(task.state)) { task.reason = 'All task pages were closed'; await this.end(task, 'cancelled') }
  }
  async closePage(task, page) {
    try { await this.browser.send('Target.closeTarget', { targetId: page.targetId }) }
    catch (error) {
      if (!this.browser.closed) {
        const { targetInfos } = await this.browser.send('Target.getTargets')
        if (targetInfos.some(info => info.targetId === page.targetId)) throw error
      }
    }
    await this.removePage(task, page.pageId)
    return this.record(task)
  }
  async end(task, state, { retry = false } = {}) {
    this.privateInputs.discardTask(task.taskId)
    task.state = state
    task.handoff = null
    if (task.ending) return task.ending
    if (!retry) task.cleanupFailures = 0
    const ending = (async () => {
      const contextId = task.contextId
      const provisionalTargets = new Set([...(task.pendingRootAttachments?.values() ?? [])].map(message => message.params.targetInfo.targetId))
      task.closingPageIds ??= new Set()
      for (const targetId of [...this.pages(task).keys(), ...provisionalTargets, task.rootTargetId].filter(Boolean)) task.closingPageIds.add(targetId)
      for (const targetId of provisionalTargets) await this.closePage(task, { targetId, pageId: targetId })
      task.pendingRootAttachments?.clear()
      for (const { task: owner, item } of this.downloadOwners.values()) if (owner === task && item.state === 'inProgress') {
        await this.browser.send('Browser.cancelDownload', { guid: item.guid, browserContextId: contextId }).catch(() => {})
      }
      for (const page of this.pages(task).values()) page.dispose()
      // Close every WebContents before disposing the shared task context.
      for (const page of [...this.pages(task).values()]) await this.closePage(task, page)
      if (contextId && !this.browser.closed) {
        const deadline = Date.now() + 10000
        while (true) {
          const { targetInfos } = await this.browser.send('Target.getTargets')
          const remaining = targetInfos.filter(info => info.browserContextId === contextId && (this.sharedProfile
            ? (this.ownedTargets.get(info.targetId) === task || this.ownedTargets.get(info.openerId) === task) && ['page', 'other', 'iframe'].includes(info.type)
            : info.type === 'page' || task.closingPageIds.has(info.targetId)))
          if (!remaining.length) break
          if (Date.now() >= deadline) throw new Error('Task pages did not close; their profile was retained')
          for (const info of remaining) await this.closePage(task, { targetId: info.targetId, pageId: info.targetId })
          await new Promise(resolve => setTimeout(resolve, 50))
        }
        try { if (!this.sharedProfile) await this.browser.send('Target.disposeBrowserContext', { browserContextId: contextId }) }
        catch (error) {
          const { browserContextIds } = await this.browser.send('Target.getBrowserContexts')
          if (!Array.isArray(browserContextIds) || browserContextIds.includes(contextId)) throw error
        }
      }
      if (!this.sharedProfile) this.contexts.delete(contextId)
      task.contextId = null
      task.closingPageIds.clear()
      task.cleanupError = null; task.cleanupRetryAt = null; task.cleanupFailures = 0
      for (const [id, entry] of this.sessions) if (entry.task === task) this.sessions.delete(id)
      for (const [id, entry] of this.targets) if (entry.task === task) this.targets.delete(id)
      this.event('task-ended', { taskId: task.taskId, state })
      return this.record(task)
    })()
    task.ending = ending
    try { return await ending }
    catch (error) {
      task.cleanupError = error.message
      task.cleanupFailures = (task.cleanupFailures ?? 0) + 1
      // Four automatic retries after the first attempt, with backoff. A later
      // explicit cancel can retry a retained context after persistent failure.
      task.cleanupRetryAt = task.cleanupFailures < 5 ? Date.now() + 1000 * 2 ** (task.cleanupFailures - 1) : null
      this.scheduleLifecycle()
      throw error
    } finally { if (task.ending === ending) task.ending = null }
  }
  async control(task, action, request) {
    this.assertAutomated()
    if (terminal.has(task.state) && !(action === 'cancel' && task.contextId)) fail('Task already ended')
    if (!['show', 'resume', 'pause', 'cancel'].includes(action)) fail('Unknown control action', 'INVALID_ARGUMENTS')
    const shownPage = action === 'show' ? this.page(task) : null
    const shownSession = shownPage?.sessionId
    const checkShownPage = () => {
      if (shownPage && (this.pages(task).get(shownPage.pageId) !== shownPage || shownPage.detached || shownPage.sessionId !== shownSession)) fail('Page session changed before manual handoff; request the current page again', 'PAGE_DETACHED')
    }
    if (request) request.dispatched = true
    const generation = task.controlGeneration = (task.controlGeneration ?? 0) + 1
    task.state = action === 'cancel' ? 'cancelled' : 'paused'
    return this.serialize(task, async () => {
      if (generation !== task.controlGeneration || (terminal.has(task.state) && action !== 'cancel')) return this.record(task)
      if (action === 'cancel') return this.end(task, 'cancelled')
      checkShownPage()
      const page = shownPage ?? this.page(task)
      if (shownPage) this.select(task, shownPage)
      await page.send('Emulation.setFocusEmulationEnabled', { enabled: false })
      if (generation !== task.controlGeneration || terminal.has(task.state)) return this.record(task)
      if (action === 'show') {
        checkShownPage()
        await page.send('Page.setWebLifecycleState', { state: 'active' })
        if (generation !== task.controlGeneration || terminal.has(task.state)) return this.record(task)
        checkShownPage()
        await this.browser.send('Target.setTargetVisibility', { targetId: page.targetId, visible: true })
        if (generation !== task.controlGeneration || terminal.has(task.state)) return this.record(task)
        checkShownPage()
        await this.setPageFileChooserInterception(task, page, false)
        if (generation === task.controlGeneration) { checkShownPage(); this.select(task, page); task.state = 'human' }
      } else if (action === 'resume') {
        for (const current of this.pages(task).values()) {
          await this.setPageFileChooserInterception(task, current, true)
          await this.browser.send('Target.setTargetVisibility', { targetId: current.targetId, visible: false })
          await current.send('Page.setWebLifecycleState', { state: 'active' }); current.observation = null
        }
        if (generation === task.controlGeneration) { task.state = 'agent-active'; task.reason = ''; task.handoff = null }
      } else { task.state = 'paused'; task.reason = 'Paused by user' }
      this.event('task-control', { taskId: task.taskId, action })
      return this.record(task)
    }, request)
  }
  decorate(task, observation) {
    const page = this.pages(task).get(observation?.pageId) ?? task.page
    rememberSensitiveDocument(task, page)
    return { ...observation, ...(task.fileChooserNotice ? { fileChooserNotice: task.fileChooserNotice } : {}), taskId: task.taskId, state: task.state, profileMode: this.profileMode, sharedProfile: this.sharedProfile, pages: this.pageRecords(task), selectedPageId: task.selectedPageId, downloads: sanitizePublicResult(task.downloads, { sensitive: task.sensitiveHistory }), privacy: sensitiveStatus(task, page), contentTrust: 'untrusted' }
  }
  privateBinding(task, rootPage, page, ref, origin) {
    return { owner: task.owner, taskId: task.taskId, pageId: rootPage.pageId, frameId: page.frameId,
      observationId: page.observation?.id, ref, origin, topOrigin: new URL(rootPage.url).origin,
      documentId: page.documentId, topDocumentId: rootPage.documentId }
  }
  async waitPage(page, args, stillActive) {
    const started = performance.now(), timeoutMs = args.timeoutMs ?? 10000
    const elapsedMs = () => Math.max(0, Math.min(timeoutMs, Math.round(performance.now() - started)))
    const initial = { matched: false, lastObserved: { state: args.predicate?.state ?? 'text' }, pageId: page.pageId }
    const check = () => { if (!stillActive()) fail('Task state or page session changed; wait stopped') }
    let watchdog, deadline
    try {
      check()
      const cancelled = new Promise((_, reject) => {
        watchdog = setInterval(() => { try { check() } catch (error) { reject(error) } }, 25)
      })
      const timedOut = new Promise(resolve => { deadline = setTimeout(() => resolve(false), timeoutMs) })
      const ready = await Promise.race([Promise.resolve(page.ready).then(() => true), cancelled, timedOut])
      check()
      const remaining = Math.floor(timeoutMs - (performance.now() - started))
      if (!ready || remaining <= 0) return { ...initial, elapsedMs: elapsedMs() }
      clearInterval(watchdog); clearTimeout(deadline)
      const result = await page.wait({ ...args, timeoutMs: remaining }, stillActive)
      return { ...result, elapsedMs: elapsedMs() }
    } catch (error) {
      error.waitResult = { ...(sanitizeWaitResult(error.waitResult) ?? initial), elapsedMs: elapsedMs() }
      throw error
    } finally { clearInterval(watchdog); clearTimeout(deadline) }
  }
  async rpc(owner, method, args = {}) {
    const started = performance.now()
    const request = { dispatched: false, validated: false, trace: {
      requestId: randomUUID(), timestamp: new Date().toISOString(), method,
      taskQueueMs: 0, activeSlotQueueMs: 0,
      ...((owner === 'admin' || CLIENTS.includes(owner) || this.clients.has(owner)) ? { clientId: owner } : {})
    } }
    let outcome = 'error', actionResult
    try {
      const result = await this.dispatchRpc(owner, method, args, request)
      outcome = 'success'; actionResult = result?.actionResult
      // Credentials and locally staged capabilities never go through an agent
      // tool. Their dedicated handshakes return only their explicit contract.
      if (method === 'client_register' || method === 'task_private_input') return result
      const task = this.tasks.get(request.trace.taskId)
      const sensitive = task?.sensitive?.active === true
      return sanitizePublicResult(task && result && typeof result === 'object'
        ? { ...result, privacy: sensitiveStatus(task, this.pages(task).get(result.pageId ?? result.observation?.pageId ?? args.pageId ?? task.selectedPageId)) } : result, { sensitive })
    } catch (error) {
      actionResult = sanitizeActionResult(error?.actionResult)
      if (!actionResult && mutations.has(method)) {
        const failedIndex = !request.dispatched && request.validated && method === 'task_act' ? 0 : null
        actionResult = {
          completed: request.dispatched ? null : 0, failedIndex,
          delivery: request.dispatched ? 'unknown' : 'not_delivered', results: [],
          recovery: { retry: failedIndex === 0 ? 'failed_action_only' : 'none', observe: true,
            reason: request.dispatched ? 'transport_unknown' : 'not_dispatched' }
        }
      }
      if (actionResult) error.actionResult = actionResult
      const clean = sanitizePublicError(error, { sensitive: this.tasks.get(request.trace.taskId)?.sensitive?.active === true })
      throw new BrokerError(clean.error, clean.code, clean.actionResult, clean.waitResult)
    } finally {
      try { this.trace?.record({ ...request.trace, outcome, durationMs: performance.now() - started, actionResult }) } catch {}
    }
  }
  async dispatchRpc(owner, method, args, request) {
    if (this.stopping) fail('Broker is stopping')
    const caller = this.clients.get(owner)
    if (caller?.released && method !== 'client_release') fail('Client credential was released', 'UNAUTHORIZED')
    if (caller?.leaseMs && !caller.released && caller.expiresAt <= Date.now()) {
      await this.releaseClient(owner)
      if (method !== 'client_release') fail('Client lease expired', 'UNAUTHORIZED')
    }
    if (owner === 'admin') {
      if (method === 'client_register') {
        if (Object.keys(args).some(key => !['label', 'policyIdentity', 'leaseMs'].includes(key)) || typeof args.label !== 'string' || !args.label.trim() || args.label.length > 200) fail('A client label of 1 to 200 characters is required', 'INVALID_ARGUMENTS')
        if (args.policyIdentity !== undefined && args.policyIdentity !== this.policyIdentity) fail('Broker policy does not match the requested policy', 'POLICY_MISMATCH')
        if (args.leaseMs !== undefined && (args.leaseMs !== 30000 || args.policyIdentity !== this.policyIdentity)) fail('Managed registration requires matching policyIdentity and leaseMs 30000', 'INVALID_ARGUMENTS')
        const clientId = randomUUID(), token = randomBytes(32).toString('base64url')
        this.clients.set(clientId, { token, label: args.label, ...(args.leaseMs ? { leaseMs: 30000, expiresAt: Date.now() + 30000 } : {}) })
        request.trace.clientId = clientId
        if (args.leaseMs) { this.managedMode = true; this.idleSince = null; this.scheduleLifecycle() }
        return { clientId, token, ...(args.leaseMs ? { leaseMs: 30000 } : {}) }
      }
      if (method === 'broker_status') return { agentProtocol: AGENT_PROTOCOL, tasks: [...this.tasks.values()].map(task => this.record(task)), browserVersion: this.browser.version, browserHealthy: this.profileLogin.phase === 'automated' && !this.browser.closed, profileLogin: this.profileLoginView(), policyIdentity: this.policyIdentity, profileMode: this.profileMode, sharedProfile: this.sharedProfile, activeActions: this.slots.active, maxTasks: this.maxTasks, maxActiveActions: this.slots.max, allowedOrigins: this.allowedOrigins ?? [this.allowWeb ? 'http(s)' : 'loopback only'], webCompatibility: this.webCompatibility, webSocketPolicy: this.webSocketPolicy }
      if (method === 'task_control') {
        this.assertAutomated()
        const task = this.task(args.taskId, owner); request.trace.taskId = task.taskId
        return this.control(task, args.action, request)
      }
      if (method === 'shutdown') { this.assertAutomated(); setTimeout(() => { if (this.profileLogin.phase === 'automated') this.onShutdown?.() }, 20); return { stopping: true } }
    }
    validateArguments(method, args)
    request.validated = true
    if (method === 'agent_protocol') return { agentProtocol: AGENT_PROTOCOL }
    if (method === 'profile_login_status') return this.profileLoginStatus()
    if (method === 'profile_login_start') return this.startProfileLogin(owner, args)
    if (method === 'profile_login_finish') return this.finishProfileLogin(owner, args)
    if (method === 'client_release') return this.releaseClient(owner)
    if (method === 'client_heartbeat') {
      if (!caller?.leaseMs || caller.released) fail('No active managed client lease', 'UNAUTHORIZED')
      caller.expiresAt = Date.now() + caller.leaseMs
      return { leaseMs: caller.leaseMs }
    }
    if (method === 'task_list') return { tasks: [...this.tasks.values()].filter(task => owner === 'admin' || task.owner === owner).map(task => this.record(task)) }
    this.assertAutomated()
    if (method === 'task_create') return this.slots.run(() => {
      this.assertAutomated()
      if (this.stopping) fail('Broker is stopping')
      // A request queued before disconnect must not create an unowned context.
      if (caller && (this.clients.get(owner) !== caller || caller.released || (caller.leaseMs && caller.expiresAt <= Date.now()))) fail('Client credential was released or expired', 'UNAUTHORIZED')
      return this.create(owner, args, request)
    }, request)
    const task = this.task(args.taskId, owner)
    request.trace.taskId = task.taskId
    if (method === 'task_private_input' && args.action === 'revoke') return this.privateInputs.revoke(args.secretRef, task.owner, task.taskId)
    if (method === 'task_cancel') { request.dispatched = true; task.controlGeneration = (task.controlGeneration ?? 0) + 1; task.state = 'cancelled'; return this.serialize(task, () => this.end(task, 'cancelled'), request) }
    if (method === 'task_request_human') return requestHuman(this, task, args, request)
    if (method === 'task_resume') return resumeHuman(this, task, args, request)
    if (method === 'task_list_pages') return { pages: this.pageRecords(task), selectedPageId: task.selectedPageId }
    const controlGeneration = task.controlGeneration, taskOwner = task.owner
    return this.serialize(task, () => {
      const run = async () => {
        this.assertAutomated()
        if (terminal.has(task.state)) fail('Task already ended')
        const humanRead = owner === 'admin' && ['task_observe', 'task_screenshot', 'task_select_page', 'task_handle_dialog'].includes(method)
        if (!humanRead) this.checkActive(task)
        if (this.stopping || this.tasks.get(task.taskId) !== task || task.owner !== taskOwner || task.controlGeneration !== controlGeneration ||
            this.clients.get(owner) !== caller || caller?.released || (caller?.leaseMs && caller.expiresAt <= Date.now())) fail('Task or client state changed; observe again')
        if (method === 'task_finish') { request.dispatched = true; return this.end(task, 'completed') }
        const rootPage = this.page(task, args.pageId)
        request.trace.pageId = rootPage.pageId
        const rootSessionId = rootPage.sessionId
        let page = rootPage
        if (args.frameId !== undefined || method === 'task_list_frames') {
          await rootPage.ready
          if (!rootPage.frames) fail('Frames are unavailable for this page', 'NOT_FOUND')
          await rootPage.frames.refresh()
          page = rootPage.frames.select(args.frameId)
        }
        const sessionId = page.sessionId
        const stillActive = () => this.profileLogin.phase === 'automated' && !this.stopping && task.state === 'agent-active' && task.controlGeneration === controlGeneration && task.owner === taskOwner &&
          this.tasks.get(task.taskId) === task && this.pages(task).get(rootPage.pageId) === rootPage && !rootPage.detached && rootPage.sessionId === rootSessionId && !page.detached && page.sessionId === sessionId &&
          (!rootPage.frames || rootPage.frames.current(page)) &&
          this.clients.get(owner) === caller && (!caller || (!caller.released && (!caller.leaseMs || caller.expiresAt > Date.now())))
        if (method === 'task_wait') return this.waitPage(page, args, stillActive)
        await page.ready
        if (terminal.has(task.state)) fail('Task already ended')
        if (!humanRead) this.checkActive(task)
        if (this.pages(task).get(rootPage.pageId) !== rootPage || rootPage.detached || rootPage.sessionId !== rootSessionId || page.detached || page.sessionId !== sessionId || (rootPage.frames && !rootPage.frames.current(page))) fail('Page or frame session changed; observe again', 'PAGE_DETACHED')
        if (!humanRead && !stillActive()) fail('Task state or page session changed; observe again')
        if (method === 'task_sensitive') {
          if (args.action === 'begin') {
            beginSensitive(task, this.pages(task).values())
            return this.decorate(task, await rootPage.observe())
          }
          validateSensitiveEnd(task, [...this.pages(task).values()], rootPage, args)
          clearSensitiveObservations(this.pages(task).values())
          const observation = await rootPage.observe()
          if (!stillActive()) fail('Task or client state changed; observe again')
          // The approval binds the exact new document through the final read.
          // Failed reads and navigation/dialog races must leave protection on.
          endSensitive(task, [...this.pages(task).values()], rootPage, args, { freshObservation: true })
          return this.decorate(task, observation)
        }
        if (method === 'task_private_input') {
          if (args.action === 'provide') return this.privateInputs.provide(args.secretRef, task.owner, task.taskId, args.value)
          const target = await page.preparePrivateInput(args.observationId, args.ref, args.origin)
          if (!stillActive() || new URL(rootPage.url).origin !== args.topOrigin) fail('Private input destination changed', 'PRIVATE_INPUT_BINDING_CHANGED')
          beginSensitive(task, this.pages(task).values(), { input: true })
          return this.privateInputs.prepare(this.privateBinding(task, rootPage, page, args.ref, target.origin))
        }
        if (method === 'task_select_page') this.select(task, page)
        if (method === 'task_list_frames') return { pageId: rootPage.pageId, mainFrameId: rootPage.frameId, frames: rootPage.frames.records() }
        if (['task_observe', 'task_select_page'].includes(method)) return this.decorate(task, await page.observe(owner === 'admin', args))
        if (method === 'task_list_options') return page.listOptions(args)
        if (method === 'task_close_page') { request.dispatched = true; return this.closePage(task, page) }
        if (method === 'task_handle_dialog') { request.dispatched = true; return this.decorate(task, await page.handleDialog(args.accept, args.promptText)) }
        if (method === 'task_upload_files') {
          if (!stillActive()) fail('Task state or page session changed; observe again')
          const files = await inspectUploadFiles(args.files)
          if (!stillActive()) fail('Task state or page session changed during file validation; observe again')
          request.dispatched = true
          const result = await page.uploadFiles(args, files, stillActive)
          return { ...result, observation: this.decorate(task, result.observation) }
        }
        if (method === 'task_act') {
          if (args.actions.some(action => action.secretRef !== undefined || action.sensitive === true)) beginSensitive(task, this.pages(task).values(), { input: true })
          request.dispatched = true
          const result = await page.act(args.observationId, args.actions, stillActive, {
            begin: () => beginSensitive(task, this.pages(task).values(), { input: true }),
            consume: (secretRef, target, ref, deliver) => this.privateInputs.consume(secretRef,
              this.privateBinding(task, rootPage, page, ref, target.origin), deliver)
          })
          return { ...result, observation: this.decorate(task, result.observation) }
        }
        if (method === 'task_navigate') {
          if (!this.allowed(args.url)) fail('Origin is not permitted by the local policy', 'ORIGIN_DENIED')
          request.dispatched = true
          return this.decorate(task, await page.navigate(args.url))
        }
        if (method === 'task_screenshot') {
          if (task.sensitive?.active) fail('Screenshots are unavailable during the sensitive phase', 'SENSITIVE_SCREENSHOT_BLOCKED')
          return page.screenshot()
        }
        fail('Unknown method', 'UNKNOWN_METHOD')
      }
      // A blocked network/page wait cannot monopolize another client's slot.
      return method === 'task_wait' ? run() : this.slots.run(run, request)
    }, request)
  }
  async close() {
    this.assertAutomated()
    if (this.stopping) return
    this.stopping = true
    this.privateInputs.close()
    clearInterval(this.lifecycleTimer)
    for (const pending of this.pendingAttachments.values()) clearTimeout(pending.timer)
    this.pendingAttachments.clear()
    // Explicitly close task WebContents before clean session shutdown so the
    // cookie restore switch cannot restore task or handoff windows on restart.
    for (const task of this.tasks.values()) {
      task.state = terminal.has(task.state) ? task.state : 'cancelled'
      if (this.sharedProfile) await this.end(task, task.state).catch(error => this.event('task-cleanup-error', { message: error.message }))
      else for (const page of this.pages(task).values()) page.dispose()
    }
    try { await this.browser.close() }
    finally { this.unbindBrowser(); await this.trace?.close() }
  }
}

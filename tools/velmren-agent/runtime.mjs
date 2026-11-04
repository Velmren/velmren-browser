import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir, lstat, realpath } from 'node:fs/promises'
import path from 'node:path'
import { AgentPage } from './page.mjs'
import { validateArguments, BrokerError, CLIENTS } from './client.mjs'
import { effectivePolicyIdentity } from './policy-identity.mjs'
import { RequestTrace } from './trace.mjs'
import { sanitizeActionResult, sanitizeWaitResult } from './action-result.mjs'

const terminal = new Set(['completed', 'cancelled'])
const fail = (message, code = 'INVALID_STATE') => { throw new BrokerError(message, code) }
const autoAttach = { autoAttach: true, waitForDebuggerOnStart: true, flatten: true, filter: [{ type: 'browser', exclude: true }, { type: 'tab', exclude: true }, {}] }
const mutations = new Set(['task_create', 'task_act', 'task_navigate', 'task_upload_files', 'task_handle_dialog', 'task_close_page', 'task_finish', 'task_cancel', 'task_request_human', 'task_control'])
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
  constructor(browser, stateDir, policy = {}, { trace } = {}) {
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
    browser.setMaxListeners(this.maxTasks * 16 + maxActions + 4)
    this.policyIdentity = effectivePolicyIdentity(policy)
    this.listener = message => { void this.onProtocol(message).catch(error => this.event('protocol-error', { message: error.message })) }
    browser.on('protocol', this.listener)
    browser.on('closed', () => {
      for (const task of this.tasks.values()) if (!terminal.has(task.state)) { task.state = 'cancelled'; task.reason = 'Browser stopped' }
      if (!this.stopping) setTimeout(() => this.onShutdown?.(), 20).unref()
    })
  }
  event(type, fields = {}) { this.onEvent?.({ type, ...fields, time: new Date().toISOString() }) }
  allowed(url) { return originAllowed(url, this.allowedOrigins, this.allowWeb) }
  pages(task) {
    // Keep compatibility with embedders that supplied the original single page.
    if (!task.pages) {
      task.pages = new Map()
      if (task.page) { task.page.pageId ??= task.targetId; task.page.targetId ??= task.targetId; task.pages.set(task.targetId, task.page); task.selectedPageId = task.targetId }
    }
    return task.pages
  }
  pageRecords(task) { return [...this.pages(task).values()].map(page => ({ pageId: page.pageId, openerId: page.openerId ?? null, url: page.url ?? task.url, title: page.title ?? '', attached: !page.detached, ...(page.dialog ? { dialog: page.dialog } : {}) })) }
  record(task) {
    const { taskId, label, owner, state, reason, url, createdAt, downloads, blockedOrigins, selectedPageId } = task
    return { taskId, label, owner, state, reason, url, createdAt, downloads, blockedOrigins, pages: this.pageRecords(task), selectedPageId: selectedPageId ?? task.selectedPageId, ...(task.cleanupError ? { cleanupPending: true, cleanupError: task.cleanupError } : {}) }
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
    const result = task.queue.then(() => { addQueueTime(request, 'taskQueueMs', started); return fn() })
    task.queue = result.catch(() => {})
    return result
  }
  checkActive(task) { if (task.state !== 'agent-active') fail(`Task is ${task.state}; agent actions are paused`) }
  async init() {
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
    if (!this.managedMode || this.stopping || this.retirementRequested) return
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
      const owner = this.sessions.get(entry.networkOwnerSessionId)
      if (!owner?.interceptionReady || owner.task !== entry.task || !['page', 'iframe'].includes(owner.type)) throw new Error('Dedicated worker has no verified frame network policy')
      await this.browser.send('Target.setAutoAttach', autoAttach, sessionId)
      return
    }
    await this.browser.send('Network.setBypassServiceWorker', { bypass: !this.webCompatibility }, sessionId)
    const patterns = [{ urlPattern: '*', requestStage: 'Request' }, { urlPattern: '*', resourceType: 'Document', requestStage: 'Response' }]
    // Chromium classifies worker main scripts as Other, imports as Script.
    // Their response CSP covers WebSockets, which Fetch cannot intercept.
    if (this.webCompatibility) for (const resourceType of ['Script', 'Other']) patterns.push({ urlPattern: '*', resourceType, requestStage: 'Response' })
    await this.browser.send('Fetch.enable', { patterns }, sessionId)
    if (entry) entry.interceptionReady = true
    await this.browser.send('Target.setAutoAttach', autoAttach, sessionId)
  }
  sessionTask(sessionId) {
    return this.sessions.get(sessionId)?.task ?? [...this.tasks.values()].find(task => [...this.pages(task).values()].some(page => !page.detached && page.sessionId === sessionId))
  }
  detachSession(sessionId) {
    const entry = this.sessions.get(sessionId)
    this.sessions.delete(sessionId)
    for (const child of [...this.sessions.values()]) if (child.parentSessionId === sessionId) this.detachSession(child.sessionId)
    if (entry && this.targets.get(entry.targetId) === entry) {
      this.targets.delete(entry.targetId)
      if (entry.page && this.pages(entry.task).get(entry.targetId) === entry.page) {
        entry.page.dispose(); entry.page.detached = true; entry.page.observation = null
      }
    }
  }
  opener(info) {
    if (!info.openerId) return null
    const entry = this.targets.get(info.openerId)
    if (entry?.page && !entry.page.detached) return { task: entry.task, page: entry.page }
    for (const task of this.tasks.values()) {
      const page = [...this.pages(task).values()].find(page => !page.detached && page.frameId === info.openerId)
      if (page) return { task, page }
    }
    return null
  }
  async attach(message) {
    const p = message.params, info = p.targetInfo
    const parent = message.sessionId ? this.sessionTask(message.sessionId) : undefined
    const contextOwner = this.contexts.get(info.browserContextId)
    const opener = this.opener(info), openerOwner = opener?.task
    const task = contextOwner ?? parent ?? openerOwner
    // Never infer ownership from another task's session when context disagrees.
    if (!task || (info.browserContextId && info.browserContextId !== task.contextId) || (parent && contextOwner && parent !== contextOwner) || (openerOwner && contextOwner && openerOwner !== contextOwner) || terminal.has(task.state)) {
      if (info.targetId) await this.browser.send('Target.closeTarget', { targetId: info.targetId }).catch(() => {})
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
    const ownedHiddenPage = info.type === 'other' && contextOwner === task && (info.targetId === task.rootTargetId || openerOwner === task)
    const isPage = info.type === 'page' || ownedHiddenPage
    const priorPage = isPage ? this.pages(task).get(info.targetId) : undefined
    const supported = isPage || info.type === 'iframe' || (this.webCompatibility && ['worker', 'service_worker', 'shared_worker'].includes(info.type))
    const isPopup = isPage && !priorPage && this.pages(task).size > 0
    if (!supported || (isPopup && !this.webCompatibility) || (isPage && !priorPage && this.pages(task).size >= 16)) {
      task.reason = 'Additional target blocked by the task policy'
      await this.browser.send('Target.closeTarget', { targetId: info.targetId })
      return
    }
    const parentEntry = this.sessions.get(message.sessionId) ?? this.targets.get(info.parentId) ?? [...this.targets.values()].find(entry => entry.task === task && entry.page?.frameId === info.parentFrameId && info.parentFrameId)
    const ownerPageId = parentEntry?.page?.pageId ?? parentEntry?.ownerPageId ?? (info.type === 'iframe' && this.pages(task).size === 1 ? this.pages(task).keys().next().value : undefined)
    const entry = { task, sessionId: p.sessionId, parentSessionId: message.sessionId, targetId: info.targetId, type: isPage ? 'page' : info.type, ownerPageId,
      networkOwnerSessionId: parentEntry?.type === 'worker' ? parentEntry.networkOwnerSessionId : parentEntry?.sessionId }
    this.sessions.set(p.sessionId, entry); this.targets.set(info.targetId, entry)
    if (isPage) {
      entry.page = new AgentPage(this.browser, info.targetId, p.sessionId)
      entry.page.interceptFileChooser = priorPage?.interceptFileChooser ?? opener?.page.interceptFileChooser ?? true
      Object.assign(entry.page, { openerId: opener?.page.pageId ?? info.openerId ?? priorPage?.openerId ?? (isPopup ? task.selectedPageId : null), url: info.url ?? priorPage?.url, title: info.title ?? priorPage?.title })
      priorPage?.dispose()
      this.pages(task).set(info.targetId, entry.page)
      if (!priorPage || task.selectedPageId === info.targetId) this.select(task, entry.page)
    }
    entry.ready = (async () => {
      try {
        // All targets remain paused until interception and descendant attachment
        // are active; page code cannot race setup via a popup or worker.
        await this.configureSession(p.sessionId, entry)
        if (this.targets.get(info.targetId) !== entry) return
        if (entry.page) await entry.page.init()
        if (entry.type === 'iframe') {
          await this.browser.send('Page.enable', {}, entry.sessionId)
          await this.browser.send('Page.setInterceptFileChooserDialog', { enabled: this.pages(task).get(entry.ownerPageId)?.interceptFileChooser !== false }, entry.sessionId)
        }
        if (terminal.has(task.state) || this.targets.get(info.targetId) !== entry) return
        if (entry.type === 'worker' && !this.sessions.get(entry.networkOwnerSessionId)?.interceptionReady) throw new Error('Dedicated worker frame policy was detached')
        await this.browser.send('Runtime.runIfWaitingForDebugger', {}, p.sessionId)
      } catch (error) {
        if (terminal.has(task.state) || this.targets.get(info.targetId) !== entry) return
        task.reason = `Could not enforce ${info.type} target policy`
        await this.end(task, 'cancelled')
        throw error
      }
    })()
    if (entry.page) entry.page.ready = entry.ready
    await entry.ready
  }
  async onProtocol(message) {
    const p = message.params ?? {}
    if (message.method === 'Page.fileChooserOpened' && this.sessions.get(message.sessionId)?.type === 'iframe') {
      const entry = this.sessions.get(message.sessionId)
      const page = this.pages(entry.task).get(entry.ownerPageId)
      const unsupported = 'File chooser belongs to a child-frame session; uploads support only the selected page main frame'
      if (page?.interceptFileChooser) page.chooser = { id: randomUUID(), epoch: page.epoch, mode: p.mode, unsupported }
      else if (!page) entry.task.fileChooserNotice = 'File chooser was intercepted in a child frame whose page owner is unavailable; observe the main page upload control'
      return
    }
    if (message.method === 'Target.attachedToTarget') return this.attach(message)
    if (message.method === 'Target.detachedFromTarget') {
      this.detachSession(p.sessionId)
      return
    }
    if (message.method === 'Fetch.requestPaused') {
      const task = this.sessionTask(message.sessionId)
      const send = async (method, params) => {
        try { return await this.browser.send(method, params, message.sessionId) }
        catch (error) { if (!this.stopping && !this.browser.closed && task && !terminal.has(task.state) && this.sessionTask(message.sessionId)) throw error }
      }
      if (!task) { await send('Fetch.failRequest', { requestId: p.requestId, errorReason: 'BlockedByClient' }).catch(() => {}); return }
      if (terminal.has(task.state)) { await send('Fetch.failRequest', { requestId: p.requestId, errorReason: 'Aborted' }).catch(() => {}); return }
      if (p.responseStatusCode) {
        const headers = [...(p.responseHeaders ?? []), { name: 'Content-Security-Policy', value: this.contentPolicy() }]
        await send('Fetch.continueResponse', { requestId: p.requestId, responseCode: p.responseStatusCode, responseHeaders: headers })
      } else {
        const allowed = this.allowed(p.request.url)
        if (!allowed) {
          let origin; try { origin = new URL(p.request.url).origin } catch { origin = 'invalid' }
          if (!task.blockedOrigins.includes(origin)) task.blockedOrigins.push(origin)
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
    } else if (message.method === 'Page.frameNavigated' && !p.frame.parentId) {
      const task = this.sessionTask(message.sessionId)
      const page = task && [...this.pages(task).values()].find(page => page.sessionId === message.sessionId)
      if (page) { page.url = p.frame.url; if (task.selectedPageId === page.pageId) task.url = p.frame.url }
    } else if (message.method === 'Browser.downloadWillBegin') {
      const task = [...this.tasks.values()].find(task => [...this.pages(task).values()].some(page => page.frameId === p.frameId))
      if (task) task.downloads.push({ guid: p.guid, name: path.basename(p.suggestedFilename.replaceAll('\\', '/')), path: path.join(task.downloadDir, p.guid), state: 'inProgress' })
    } else if (message.method === 'Browser.downloadProgress') {
      for (const task of this.tasks.values()) { const item = task.downloads.find(item => item.guid === p.guid); if (item) Object.assign(item, { state: p.state, receivedBytes: p.receivedBytes, totalBytes: p.totalBytes }) }
    }
  }
  async create(owner, args, request) {
    if (!this.allowed(args.url)) fail('Origin is not permitted by the local policy', 'ORIGIN_DENIED')
    if ([...this.tasks.values()].filter(task => !terminal.has(task.state)).length >= this.maxTasks) fail('Task limit reached', 'LIMIT_REACHED')
    let initialized
    const task = { taskId: randomUUID(), label: args.label || 'Browser task', owner, state: 'agent-active', reason: '', url: args.url, createdAt: new Date().toISOString(), downloads: [], blockedOrigins: [], pages: new Map(), pendingRootAttachments: new Map(), queue: new Promise(resolve => { initialized = resolve }) }
    this.tasks.set(task.taskId, task)
    if (request) { request.trace.taskId = task.taskId; request.dispatched = true }
    try {
      const context = await this.browser.send('Target.createBrowserContext', { disposeOnDetach: true })
      task.contextId = context.browserContextId; this.contexts.set(task.contextId, task)
      task.downloadDir = path.join(this.stateDir, 'downloads', task.taskId)
      await mkdir(task.downloadDir, { recursive: true })
      await this.browser.send('Browser.setDownloadBehavior', { behavior: 'allowAndName', browserContextId: task.contextId, downloadPath: task.downloadDir, eventsEnabled: true })
      task.creatingRoot = true
      const target = await this.browser.send('Target.createTarget', { url: 'about:blank', browserContextId: task.contextId, hidden: true, background: true })
      task.rootTargetId = target.targetId; task.creatingRoot = false
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
    task.state = state
    if (task.ending) return task.ending
    if (!retry) task.cleanupFailures = 0
    const ending = (async () => {
      const contextId = task.contextId
      const provisionalTargets = new Set([...(task.pendingRootAttachments?.values() ?? [])].map(message => message.params.targetInfo.targetId))
      task.closingPageIds ??= new Set()
      for (const targetId of [...this.pages(task).keys(), ...provisionalTargets, task.rootTargetId].filter(Boolean)) task.closingPageIds.add(targetId)
      for (const targetId of provisionalTargets) await this.closePage(task, { targetId, pageId: targetId })
      task.pendingRootAttachments?.clear()
      for (const page of this.pages(task).values()) page.dispose()
      // Close every WebContents before disposing the shared task context.
      for (const page of [...this.pages(task).values()]) await this.closePage(task, page)
      if (contextId && !this.browser.closed) {
        const deadline = Date.now() + 10000
        while (true) {
          const { targetInfos } = await this.browser.send('Target.getTargets')
          const remaining = targetInfos.filter(info => info.browserContextId === contextId && (info.type === 'page' || task.closingPageIds.has(info.targetId)))
          if (!remaining.length) break
          if (Date.now() >= deadline) throw new Error('Task pages did not close; their profile was retained')
          for (const info of remaining) await this.closePage(task, { targetId: info.targetId, pageId: info.targetId })
          await new Promise(resolve => setTimeout(resolve, 50))
        }
        try { await this.browser.send('Target.disposeBrowserContext', { browserContextId: contextId }) }
        catch (error) {
          const { browserContextIds } = await this.browser.send('Target.getBrowserContexts')
          if (!Array.isArray(browserContextIds) || browserContextIds.includes(contextId)) throw error
        }
      }
      this.contexts.delete(contextId); task.contextId = null
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
    if (terminal.has(task.state) && !(action === 'cancel' && task.contextId)) fail('Task already ended')
    if (!['show', 'resume', 'pause', 'cancel'].includes(action)) fail('Unknown control action', 'INVALID_ARGUMENTS')
    if (request) request.dispatched = true
    const generation = task.controlGeneration = (task.controlGeneration ?? 0) + 1
    task.state = action === 'cancel' ? 'cancelled' : 'paused'
    return this.serialize(task, async () => {
      if (generation !== task.controlGeneration || (terminal.has(task.state) && action !== 'cancel')) return this.record(task)
      if (action === 'cancel') return this.end(task, 'cancelled')
      const page = this.page(task)
      await page.send('Emulation.setFocusEmulationEnabled', { enabled: false })
      if (generation !== task.controlGeneration || terminal.has(task.state)) return this.record(task)
      if (action === 'show') {
        await page.send('Page.setWebLifecycleState', { state: 'active' })
        if (generation !== task.controlGeneration || terminal.has(task.state)) return this.record(task)
        await this.browser.send('Target.setTargetVisibility', { targetId: page.targetId, visible: true })
        if (generation !== task.controlGeneration || terminal.has(task.state)) return this.record(task)
        await this.setPageFileChooserInterception(task, page, false)
        if (generation === task.controlGeneration) task.state = 'human'
      } else if (action === 'resume') {
        for (const current of this.pages(task).values()) {
          await this.setPageFileChooserInterception(task, current, true)
          await this.browser.send('Target.setTargetVisibility', { targetId: current.targetId, visible: false })
          await current.send('Page.setWebLifecycleState', { state: 'active' }); current.observation = null
        }
        if (generation === task.controlGeneration) { task.state = 'agent-active'; task.reason = '' }
      } else { task.state = 'paused'; task.reason = 'Paused by user' }
      this.event('task-control', { taskId: task.taskId, action })
      return this.record(task)
    }, request)
  }
  decorate(task, observation) { return { ...observation, ...(task.fileChooserNotice ? { fileChooserNotice: task.fileChooserNotice } : {}), taskId: task.taskId, state: task.state, pages: this.pageRecords(task), selectedPageId: task.selectedPageId, downloads: task.downloads, contentTrust: 'untrusted' } }
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
      return result
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
      throw error
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
      if (method === 'broker_status') return { tasks: [...this.tasks.values()].map(task => this.record(task)), browserVersion: this.browser.version, browserHealthy: !this.browser.closed, policyIdentity: this.policyIdentity, activeActions: this.slots.active, maxTasks: this.maxTasks, maxActiveActions: this.slots.max, allowedOrigins: this.allowedOrigins ?? [this.allowWeb ? 'http(s)' : 'loopback only'], webCompatibility: this.webCompatibility, webSocketPolicy: this.webSocketPolicy }
      if (method === 'task_control') {
        const task = this.task(args.taskId, owner); request.trace.taskId = task.taskId
        return this.control(task, args.action, request)
      }
      if (method === 'shutdown') { setTimeout(() => this.onShutdown?.(), 20); return { stopping: true } }
    }
    validateArguments(method, args)
    request.validated = true
    if (method === 'client_release') return this.releaseClient(owner)
    if (method === 'client_heartbeat') {
      if (!caller?.leaseMs || caller.released) fail('No active managed client lease', 'UNAUTHORIZED')
      caller.expiresAt = Date.now() + caller.leaseMs
      return { leaseMs: caller.leaseMs }
    }
    if (method === 'task_list') return { tasks: [...this.tasks.values()].filter(task => owner === 'admin' || task.owner === owner).map(task => this.record(task)) }
    if (method === 'task_create') return this.slots.run(() => {
      if (this.stopping) fail('Broker is stopping')
      // A request queued before disconnect must not create an unowned context.
      if (caller && (this.clients.get(owner) !== caller || caller.released || (caller.leaseMs && caller.expiresAt <= Date.now()))) fail('Client credential was released or expired', 'UNAUTHORIZED')
      return this.create(owner, args, request)
    }, request)
    const task = this.task(args.taskId, owner)
    request.trace.taskId = task.taskId
    if (method === 'task_cancel') { request.dispatched = true; task.controlGeneration = (task.controlGeneration ?? 0) + 1; task.state = 'cancelled'; return this.serialize(task, () => this.end(task, 'cancelled'), request) }
    if (method === 'task_request_human') {
      if (terminal.has(task.state)) fail('Task already ended')
      request.dispatched = true
      task.controlGeneration = (task.controlGeneration ?? 0) + 1; task.state = 'needs-human'; task.reason = args.reason
      for (const page of this.pages(task).values()) page.observation = null
      return this.serialize(task, async () => { if (!terminal.has(task.state)) await this.page(task).send('Emulation.setFocusEmulationEnabled', { enabled: false }); return this.record(task) }, request)
    }
    if (method === 'task_list_pages') return { pages: this.pageRecords(task), selectedPageId: task.selectedPageId }
    const controlGeneration = task.controlGeneration, taskOwner = task.owner
    return this.serialize(task, () => {
      const run = async () => {
        if (terminal.has(task.state)) fail('Task already ended')
        const humanRead = owner === 'admin' && ['task_observe', 'task_screenshot', 'task_select_page', 'task_handle_dialog'].includes(method)
        if (!humanRead) this.checkActive(task)
        if (this.stopping || this.tasks.get(task.taskId) !== task || task.owner !== taskOwner || task.controlGeneration !== controlGeneration ||
            this.clients.get(owner) !== caller || caller?.released || (caller?.leaseMs && caller.expiresAt <= Date.now())) fail('Task or client state changed; observe again')
        if (method === 'task_finish') { request.dispatched = true; return this.end(task, 'completed') }
        const page = this.page(task, args.pageId)
        request.trace.pageId = page.pageId
        const sessionId = page.sessionId
        const stillActive = () => !this.stopping && task.state === 'agent-active' && task.controlGeneration === controlGeneration && task.owner === taskOwner &&
          this.tasks.get(task.taskId) === task && this.pages(task).get(page.pageId) === page && !page.detached && page.sessionId === sessionId &&
          this.clients.get(owner) === caller && (!caller || (!caller.released && (!caller.leaseMs || caller.expiresAt > Date.now())))
        if (method === 'task_wait') return this.waitPage(page, args, stillActive)
        await page.ready
        if (terminal.has(task.state)) fail('Task already ended')
        if (!humanRead) this.checkActive(task)
        if (this.pages(task).get(page.pageId) !== page || page.detached || page.sessionId !== sessionId) fail('Page session changed; observe again', 'PAGE_DETACHED')
        if (!humanRead && !stillActive()) fail('Task state or page session changed; observe again')
        if (method === 'task_select_page') this.select(task, page)
        if (['task_observe', 'task_select_page'].includes(method)) return this.decorate(task, await page.observe(owner === 'admin'))
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
          request.dispatched = true
          const result = await page.act(args.observationId, args.actions, stillActive)
          return { ...result, observation: this.decorate(task, result.observation) }
        }
        if (method === 'task_navigate') {
          if (!this.allowed(args.url)) fail('Origin is not permitted by the local policy', 'ORIGIN_DENIED')
          request.dispatched = true
          return this.decorate(task, await page.navigate(args.url))
        }
        if (method === 'task_screenshot') return page.screenshot()
        fail('Unknown method', 'UNKNOWN_METHOD')
      }
      // A blocked network/page wait cannot monopolize another client's slot.
      return method === 'task_wait' ? run() : this.slots.run(run, request)
    }, request)
  }
  async close() {
    if (this.stopping) return
    this.stopping = true
    clearInterval(this.lifecycleTimer)
    for (const task of this.tasks.values()) { task.state = terminal.has(task.state) ? task.state : 'cancelled'; for (const page of this.pages(task).values()) page.dispose() }
    try { await this.browser.close() }
    finally { this.browser.off('protocol', this.listener); await this.trace?.close() }
  }
}

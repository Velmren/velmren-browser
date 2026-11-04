import { randomUUID } from 'node:crypto'
import { installCaptchaBridge } from './captcha-renderer.mjs'

const managers = new WeakMap()
const failure = code => Object.assign(new Error(code), { code })
const rendererCodes = new Set(['CAPTCHA_STALE', 'CAPTCHA_ALREADY_SOLVED', 'CAPTCHA_UNSUPPORTED'])

function managerFor(browser) {
  let manager = managers.get(browser)
  if (manager) return manager
  manager = { browser, key: `__velmrenCaptcha_${randomUUID().replaceAll('-', '')}`, contexts: new Map(), sessions: new Map(), pages: new Set() }
  manager.listener = message => {
    const sessionId = message.sessionId
    if (message.method === 'Runtime.executionContextCreated') {
      const context = message.params.context
      if (context.auxData?.isDefault && context.auxData.frameId) {
        let values = manager.contexts.get(sessionId)
        if (!values) { values = new Map(); manager.contexts.set(sessionId, values) }
        values.set(context.id, { ...context, sessionId })
      }
    } else if (message.method === 'Runtime.executionContextDestroyed') manager.contexts.get(sessionId)?.delete(message.params.executionContextId)
    else if (message.method === 'Runtime.executionContextsCleared') manager.contexts.delete(sessionId)
    else if (message.method === 'Target.detachedFromTarget') {
      manager.contexts.delete(message.params.sessionId); manager.sessions.delete(message.params.sessionId)
    }
  }
  browser.on('protocol', manager.listener)
  managers.set(browser, manager)
  return manager
}

// Enqueue before resuming an auto-attached OOPIF when the user enabled CapSolver,
// then await the returned promise AFTER Runtime.runIfWaitingForDebugger. New
// target renderer commands can remain pending until that resume command arrives.
// Runtime context events are collected without installing page hooks when disabled.
export async function installCaptchaSession(browser, sessionId) {
  const manager = managerFor(browser)
  if (!manager.sessions.has(sessionId)) {
    const source = `(${installCaptchaBridge.toString()})(${JSON.stringify(manager.key)})`
    // All three commands reach the pipe synchronously, before the caller resumes.
    const ready = Promise.all([
      browser.send('Page.enable', {}, sessionId),
      browser.send('Runtime.enable', {}, sessionId),
      browser.send('Page.addScriptToEvaluateOnNewDocument', { source, runImmediately: true }, sessionId),
    ]).then(([, , script]) => script)
    manager.sessions.set(sessionId, ready)
    ready.catch(() => { if (manager.sessions.get(sessionId) === ready) manager.sessions.delete(sessionId) })
  }
  await manager.sessions.get(sessionId)
}

export class CaptchaPage {
  constructor(page) {
    this.page = page
    this.manager = managerFor(page.browser)
    this.manager.pages.add(this)
    this.challenges = new Map()
    this.ids = new Map()
    this.bindings = new WeakMap()
    this.disposed = false
  }
  current() {
    const page = this.page, frames = page.rootPage?.frames
    return !this.disposed && !page.disposed && !page.detached && !page.rootPage?.disposed && !page.rootPage?.detached && (!frames || frames.current(page))
  }
  async install() {
    if (!this.current()) throw failure('CAPTCHA_STALE')
    await installCaptchaSession(this.page.browser, this.page.sessionId)
  }
  context() {
    if (!this.current()) throw failure('CAPTCHA_STALE')
    const values = [...(this.manager.contexts.get(this.page.sessionId)?.values() || [])]
    const context = values.findLast(value => value.auxData.frameId === this.page.frameId)
    if (!context) throw failure('CAPTCHA_CONTEXT_UNAVAILABLE')
    return context
  }
  same(context, documentId) {
    if (!this.current() || this.page.documentId !== documentId || context.sessionId !== this.page.sessionId) return false
    return this.manager.contexts.get(context.sessionId)?.get(context.id) === context && context.auxData.frameId === this.page.frameId
  }
  async call(context, operation, args = [], beforeDispatch) {
    const page = this.page
    const found = await page.send('Runtime.evaluate', {
      expression: `globalThis[${JSON.stringify(this.manager.key)}]`,
      ...(context.uniqueId ? { uniqueContextId: context.uniqueId } : { contextId: context.id }), returnByValue: false,
    })
    if (found.exceptionDetails || !found.result?.objectId) throw failure('CAPTCHA_CONTEXT_UNAVAILABLE')
    const objectId = found.result.objectId
    try {
      beforeDispatch?.()
      const response = await page.send('Runtime.callFunctionOn', { objectId,
        functionDeclaration: 'function(operation, args) { return this[operation](...args) }',
        arguments: [{ value: operation }, { value: args }], returnByValue: true, awaitPromise: false })
      if (response.exceptionDetails) {
        const text = response.exceptionDetails.exception?.description || response.exceptionDetails.text || ''
        const code = String(text).split('\n')[0].replace(/^Error:\s*/, '')
        throw failure(rendererCodes.has(code) ? code : 'CAPTCHA_PAGE_FAILED')
      }
      return response.result.value
    } finally { await page.send('Runtime.releaseObject', { objectId }).catch(() => {}) }
  }
  async inspect() {
    await this.install()
    const context = this.context(), documentId = this.page.documentId
    const descriptions = await this.call(context, 'inspect')
    if (!this.same(context, documentId)) throw failure('CAPTCHA_STALE')
    const present = new Set()
    const result = descriptions.map(description => {
      const localKey = `${context.uniqueId || context.id}:${description.id}:${description.generation}`
      let challengeId = this.ids.get(localKey)
      if (!challengeId) { challengeId = randomUUID(); this.ids.set(localKey, challengeId) }
      present.add(challengeId)
      this.challenges.set(challengeId, { context, documentId, widgetId: description.id, generation: description.generation })
      return { challengeId, provider: description.provider, supported: description.supported,
        reason: description.reason, alreadySolved: description.alreadySolved }
    })
    for (const id of this.challenges.keys()) if (!present.has(id)) this.challenges.delete(id)
    return result
  }
  async prepare(challengeId) {
    const challenge = this.challenges.get(challengeId)
    if (!challenge || !this.same(challenge.context, challenge.documentId)) throw failure('CAPTCHA_STALE')
    const bindingId = randomUUID()
    const prepared = await this.call(challenge.context, 'prepare', [challenge.widgetId, challenge.generation, bindingId])
    if (!this.same(challenge.context, challenge.documentId)) throw failure('CAPTCHA_STALE')
    const binding = Object.freeze({ challengeId })
    this.bindings.set(binding, { ...challenge, bindingId, consumed: false })
    return { task: prepared.task, binding }
  }
  async apply(binding, token, stillActive = () => true) {
    const state = this.bindings.get(binding)
    if (!state || state.consumed) throw failure('CAPTCHA_STALE')
    state.consumed = true
    if (!this.same(state.context, state.documentId)) throw failure('CAPTCHA_STALE')
    if (!stillActive()) throw failure('CAPTCHA_CANCELLED')
    if (typeof token !== 'string' || !token || token.length > 65536) throw failure('CAPTCHA_INVALID_TOKEN')
    // Once dispatched, navigation or transport failure can hide the receipt.
    // Preserve uncertainty so a caller cannot silently charge or deliver again.
    try { return await this.call(state.context, 'apply', [state.bindingId, token], () => {
      if (!this.same(state.context, state.documentId)) throw failure('CAPTCHA_STALE')
      if (!stillActive()) throw failure('CAPTCHA_CANCELLED')
    }) }
    catch (error) {
      if (rendererCodes.has(error.code) || ['CAPTCHA_CONTEXT_UNAVAILABLE', 'CAPTCHA_CANCELLED'].includes(error.code)) throw error
      return { applied: false, callbackInvoked: false, deliveryUncertain: true }
    }
  }
  dispose() {
    if (this.disposed) return
    this.disposed = true; this.challenges.clear(); this.ids.clear(); this.bindings = new WeakMap()
    this.manager.pages.delete(this)
    if (!this.manager.pages.size) {
      this.page.browser.off('protocol', this.manager.listener)
      managers.delete(this.page.browser)
    }
  }
}

import { randomUUID } from 'node:crypto'
import { actionResult } from './action-result.mjs'
import * as formControls from './form-controls.mjs'
import * as documentObservation from './document-observation.mjs'
import * as sensitiveRenderer from './sensitive-renderer.mjs'
import { sanitizePublicError } from './privacy.mjs'
import { CaptchaPage } from './captcha-page.mjs'
import { annotateOperationError } from './operation-error.mjs'

const { prepareElement, applyFormValue, verifyElementValue } = formControls
const { observeDocument, listSelectOptions, validateObservedRefs } = documentObservation
const formPrelude = Object.values(formControls).map(fn => fn.toString()).join('\n')
const rendererPrelude = formPrelude + '\n' + Object.values(documentObservation).map(fn => fn.toString()).join('\n') + '\n' + Object.values(sensitiveRenderer).map(fn => fn.toString()).join('\n')

class DialogOpened extends Error {}

function validatePreparedAction(action) {
  validatePreparedElement(action)
  return action.type === 'fill' && isSensitiveTarget({ ref: action.ref })
}

function waitForCondition({ text, predicate, timeoutMs }) {
  const state = globalThis.__velmrenAgent
  const el = predicate ? state?.refs.get(predicate.ref) : null
  if (predicate && !el) throw new Error('Unknown element reference; observe again')
  return new Promise((resolve, reject) => {
    let observer, timer, interval, done = false, lastObserved
    const finish = (matched, error) => {
      if (done) return
      done = true; clearTimeout(timer); clearInterval(interval); observer?.disconnect()
      error ? reject(error) : resolve({ matched, lastObserved })
    }
    const check = () => {
      if (!predicate) {
        lastObserved = { state: 'text', textMatches: visibleDocumentText().includes(text) }
        return lastObserved.textMatches
      }
      if (globalThis.__velmrenAgent !== state || state.refs.get(predicate.ref) !== el) throw new Error('Stale observation; observe again')
      if (!el.isConnected || el.ownerDocument !== document) throw new Error('Element reference is stale; observe again')
      const { hidden, disabled } = elementCapabilities(el)
      lastObserved = { state: predicate.state, exists: true }
      if (predicate.state === 'exists') return true
      if (predicate.state === 'visible') return (lastObserved.visible = !hidden)
      if (predicate.state === 'enabled') return (lastObserved.enabled = !disabled)
      // Password and ordinary values never leave the renderer during comparison.
      return (lastObserved.valueMatches = String(el.isContentEditable ? el.innerText : el.value ?? '') === predicate.value)
    }
    const tick = () => { try { if (check()) finish(true) } catch (error) { finish(false, error) } }
    observer = new MutationObserver(tick)
    observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true })
    timer = setTimeout(() => { tick(); finish(false) }, timeoutMs)
    interval = setInterval(tick, Math.min(50, timeoutMs))
    tick()
  })
}

export class AgentPage {
  constructor(browser, targetId, sessionId, { frameId = null, rootPage = null, parentFrameId = null, automationActive = null } = {}) {
    this.documentId = randomUUID()
    Object.assign(this, { browser, targetId, pageId: targetId, sessionId, epoch: 0, frameId, rootPage, parentFrameId, world: null, observation: null, dialog: null, chooser: null, interceptFileChooser: true, url: 'about:blank', title: '' })
    this.captcha = new CaptchaPage(this)
    this.dialogWaiters = new Set()
    this.pendingCommands = new Set()
    this.automationActive = automationActive
    this.focusReady = false
    this.focusQueue = Promise.resolve()
    this.focusEmulation = undefined
    if (rootPage) {
      Object.defineProperty(this, 'dialog', { get: () => rootPage.dialog, set: value => { rootPage.dialog = value } })
      this.dialogWaiters = rootPage.dialogWaiters
    }
    this.listener = message => {
      if (message.sessionId !== this.sessionId) return
      if (message.method === 'Page.frameNavigated' && (this.rootPage ? message.params.frame.id === this.frameId : !message.params.frame.parentId)) {
        this.frameId = message.params.frame.id
        this.documentId = randomUUID()
        this.loaderId = message.params.frame.loaderId
        this.url = message.params.frame.url
        this.epoch++; this.world = null; this.observation = null; this.chooser = null
        this.onDocumentChanged?.()
      }
      if (message.method === 'Page.navigatedWithinDocument' && message.params.frameId === this.frameId) { this.observation = null; this.chooser = null }
      if (message.method === 'Runtime.executionContextsCleared') { this.world = null; this.observation = null; this.chooser = null }
      if (message.method === 'Runtime.executionContextDestroyed' && message.params.executionContextId === this.world) { this.epoch++; this.world = null; this.observation = null; this.chooser = null }
      if (message.method === 'Page.fileChooserOpened' && this.interceptFileChooser && message.params.frameId === this.frameId) {
        const { frameId, backendNodeId, mode } = message.params
        this.chooser = { id: randomUUID(), epoch: this.epoch, frameId, backendNodeId, mode,
          ...(frameId !== this.frameId ? { unsupported: 'File chooser belongs to a child frame; only the selected page main frame is supported' } :
            !Number.isInteger(backendNodeId) || backendNodeId <= 0 ? { unsupported: 'File chooser has no supported file input' } : {}) }
      }
      if (message.method === 'Page.javascriptDialogOpening') {
        const { type, message: text, defaultPrompt, url } = message.params
        this.dialog = { type, message: text, defaultPrompt, url, contentTrust: 'untrusted' }
        for (const wake of this.dialogWaiters) wake()
      }
      if (message.method === 'Page.javascriptDialogClosed') this.dialog = null
    }
    browser.on('protocol', this.listener)
  }
  async send(method, params = {}, timeout) {
    const sessionId = this.rootPage && (method.startsWith('Input.') || method === 'Emulation.setFocusEmulationEnabled') ? this.rootPage.sessionId : this.sessionId
    try { return await this.browser.send(method, params, sessionId, timeout) }
    catch (error) { error.deliveryUncertain = true; throw error }
  }
  async syncFocusEmulation(transient = false) {
    if (this.rootPage) return this.rootPage.syncFocusEmulation(transient)
    const desired = () => !this.disposed && !this.detached && (this.automationActive ? this.automationActive() : transient)
    const apply = async () => {
      if (this.disposed || this.detached) return
      // Hidden native targets still need frames. Recheck ownership after every
      // acknowledgement so pause, handoff or replacement wins an in-flight enable.
      do {
        const enabled = desired()
        if (this.focusEmulation !== enabled) {
          try { await this.send('Emulation.setFocusEmulationEnabled', { enabled }); this.focusEmulation = enabled }
          catch (error) { this.focusEmulation = undefined; throw error }
        }
      } while (this.focusEmulation !== desired())
    }
    const pending = this.focusQueue.then(apply, apply)
    this.focusQueue = pending.catch(() => {})
    return pending
  }
  async init() {
    await this.send('Page.enable')
    await this.setFileChooserInterception(this.interceptFileChooser)
    await this.send('Runtime.enable')
    this.focusReady = true
    if (this.automationActive) await this.syncFocusEmulation()
    await this.send('Emulation.setDeviceMetricsOverride', { width:1280,height:800,deviceScaleFactor:1,mobile:false })
    const tree = await this.send('Page.getFrameTree')
    this.frameId = tree.frameTree.frame.id
    this.url = tree.frameTree.frame.url ?? this.url
  }
  async setFileChooserInterception(enabled) {
    await this.send('Page.setInterceptFileChooserDialog', { enabled })
    this.interceptFileChooser = enabled
    this.chooser = null
    this.frames?.invalidateObservations()
  }
  chooserObservation() {
    if (!this.chooser) return {}
    const { id: chooserId, mode, unsupported } = this.chooser
    return { fileChooser: { chooserId, mode, ...(unsupported ? { unsupported } : {}) } }
  }
  async interruptOnDialog(command) {
    this.pendingCommands.add(command)
    command.then(() => this.pendingCommands.delete(command), () => this.pendingCommands.delete(command))
    if (this.dialog) throw new DialogOpened('Page has an open dialog')
    let wake
    const opened = new Promise((_, reject) => {
      wake = () => reject(new DialogOpened('Page opened a dialog'))
      this.dialogWaiters.add(wake)
    })
    try { return await Promise.race([command, opened]) }
    finally { this.dialogWaiters.delete(wake) }
  }
  dialogObservation() {
    return { url: this.url, title: this.title, text: this.lastObservation?.text ?? '', elements: [], pageId: this.pageId, dialog: this.dialog, contentTrust: 'untrusted', observationId: this.observation?.id,
      complete: false, truncated: true, coverage: { scope: 'main_frame', blocked: 'dialog', text: 'previous_observation' } }
  }
  async evaluate(fn, args, returnByValue = true) {
    if (this.dialog) throw new DialogOpened('Page has an open dialog')
    if (!this.world) {
      let result
      try { result = await this.send('Page.createIsolatedWorld', { frameId:this.frameId,worldName:'velmren-agent',grantUniveralAccess:false }) }
      catch (error) { error.deliveryUncertain = true; throw error }
      this.world = result.executionContextId
    }
    let result
    try {
      result = await this.interruptOnDialog(this.send('Runtime.evaluate', { expression:`(()=>{${rendererPrelude};return (${fn.toString()})(${JSON.stringify(args) ?? ''})})()`, contextId:this.world, awaitPromise:true, returnByValue }))
    } catch (error) { if (!(error instanceof DialogOpened)) error.deliveryUncertain = true; throw error }
    if (result.exceptionDetails) {
      const firstLine = String(result.exceptionDetails.exception?.description || result.exceptionDetails.text).split('\n')[0].replace(/^Error:\s*/, '').trim()
      const code = /^(?:Element|Frame) is obscured$/.test(firstLine) ? 'ELEMENT_OBSCURED'
        : firstLine === 'Element is disabled' ? 'ELEMENT_DISABLED'
        : firstLine === 'Element is not visible' ? 'ELEMENT_HIDDEN'
        : firstLine === 'Private input target is unavailable' ? 'ELEMENT_UNAVAILABLE'
        : /^Private input (?:target|observation|origin|document) changed$/.test(firstLine) ? 'PRIVATE_INPUT_BINDING_CHANGED'
        : /^(?:Stale observation|Unknown element reference|Element reference is stale|Page changed since observation)/.test(firstLine) ? 'STALE_OBSERVATION' : 'ACTION_FAILED'
      const error = annotateOperationError(Object.assign(new Error(firstLine), { code }))
      error.message = sanitizePublicError(error).error
      throw error
    }
    return returnByValue ? result.result.value : result.result
  }
  async observe(readOnly = false, options = {}) {
    if (this.dialog) return this.dialogObservation()
    let result
    try { result = await this.evaluate(observeDocument, { ...options, readOnly }) }
    catch (error) { if (error instanceof DialogOpened) return this.dialogObservation(); throw annotateOperationError(error, 'observe') }
    this.url = result.url; this.title = result.title
    result.frameId = this.frameId
    result.parentFrameId = this.parentFrameId
    if (this.frames) result.frames = await this.frames.refresh()
    else if (this.rootPage?.frames) result.frames = this.rootPage.frames.records()
    if (this.rootPage && result.coverage) result.coverage.scope = 'selected_frame'
    if (readOnly) { delete result.revision; return { ...result, ...this.chooserObservation(), pageId: this.pageId, contentTrust: 'untrusted' } }
    this.observation = { id:randomUUID(), epoch:this.epoch, revision:result.revision }
    delete result.revision
    this.lastObservation = { ...result, ...this.chooserObservation(), observationId:this.observation.id, pageId: this.pageId, contentTrust: 'untrusted' }
    return this.lastObservation
  }
  async listOptions(args) {
    const observation = this.observation, epoch = this.epoch
    if (this.dialog) throw new Error('Handle the open dialog before reading options')
    if (!observation || args.observationId !== observation.id || observation.epoch !== epoch) throw new Error('Stale observation; observe the page again')
    const result = await this.evaluate(listSelectOptions, { ...args, revision: observation.revision })
    if (this.observation !== observation || this.epoch !== epoch || this.disposed) throw new Error('Stale observation; observe the page again')
    return { ...result, observationId: observation.id, pageId: this.pageId, frameId: this.frameId }
  }
  async navigate(url) {
    this.observation = null; this.chooser = null
    let cancel
    const loaded = new Promise((resolve, reject) => {
      const listener = message => { if(message.sessionId===this.sessionId && ['Page.loadEventFired', 'Page.javascriptDialogOpening'].includes(message.method)) done() }
      const timer=setTimeout(()=>done(annotateOperationError(new Error('Page load timed out'), 'navigate')),20000)
      const done=error=>{clearTimeout(timer);this.browser.off('protocol',listener);error?reject(error):resolve()}
      cancel=done
      this.browser.on('protocol',listener)
    })
    // Attach the rejection handler before navigation can fail.
    loaded.catch(()=>{})
    let result
    try {
      result = await this.interruptOnDialog(this.send('Page.navigate', {url}))
      if (result.errorText) throw new Error(`Navigation failed: ${result.errorText}`)
      if (!result.loaderId) cancel()
    } catch (error) {
      if (error instanceof DialogOpened) { cancel(); return this.observe() }
      cancel(error); throw annotateOperationError(error, 'navigate')
    }
    await loaded
    return this.observe()
  }
  async act(observationId, actions, stillActive = () => true, privateInput) {
    const epoch = this.epoch, results = []
    let completed = 0, current = 0, dispatched = false, focusEnabled = false, phase = 'validation', diagnostic
    const record = (action, delivery, verification) => ({ index: current, type: action.type,
      ...(/^e[1-9][0-9]{0,8}$/.test(action.ref ?? '') ? { ref: action.ref } : {}), delivery, ...(verification ? { verification } : {}) })
    const fillSensitive = async action => {
      phase = 'prepare'
      if (!privateInput) throw new Error('Private input context is unavailable')
      privateInput.begin()
      const target = await this.preparePrivateInput(observationId, action.ref, undefined, true)
      if (!stillActive() || epoch !== this.epoch) throw new Error('Task paused during private input preparation')
      const deliver = async value => {
        if (!stillActive() || epoch !== this.epoch) throw new Error('Task paused before private input')
        dispatched = true
        phase = 'input'
        return this.evaluate(sensitiveRenderer.applyPrivateValue, { ref: action.ref, revision: this.observation.revision, origin: target.origin, value })
      }
      const verification = action.secretRef !== undefined
        ? await privateInput.consume(action.secretRef, target, action.ref, deliver)
        : await deliver(action.value)
      completed++
      results.push(record(action, verification.status === 'matched' ? 'delivered_verified' : 'delivered_unverified', verification))
    }
    try {
      if (actions.length === 1 && actions[0].type === 'handleDialog') {
        if (!stillActive()) throw new Error('Task is paused')
        if (!this.dialog) throw new Error('Page has no open dialog')
        dispatched = true
        const observation = await this.handleDialog(actions[0].accept, actions[0].promptText)
        delete observation.actionResult
        completed = 1; results.push(record(actions[0], 'delivered_unverified'))
        return { completed, observation, actionResult: actionResult(completed, null, results, 'delivered_unverified', 'verify_outcome') }
      }
      if (this.dialog) throw new Error('Handle the open dialog before page actions')
      if (!this.interceptFileChooser) throw new Error('Page is in manual file picker mode; resume agent control first')
      if (!this.observation || observationId !== this.observation.id || this.observation.epoch !== this.epoch) throw new Error('Stale observation; observe the page again')
      const revision = await this.evaluate(()=>globalThis.__velmrenAgent?.revision)
      if (revision !== this.observation?.revision) await this.evaluate(validateObservedRefs, {
        revision: this.observation?.revision, refs: actions.every(action => action.ref) ? actions.map(action => action.ref) : [],
      })
      phase = 'prepare'
      try { await this.syncFocusEmulation(true); focusEnabled = true }
      catch (error) { error.deliveryUncertain = true; throw error }
      for (current = 0; current < actions.length; current++) {
        const action = actions[current]
        let verificationAction = action
        dispatched = false
        phase = 'prepare'
        try {
          if (!stillActive() || epoch !== this.epoch) throw new Error('Task state or document changed; remaining actions stopped')
          const sensitiveFill = action.type === 'fill' && (action.secretRef !== undefined || action.sensitive === true ||
            privateInput && await this.evaluate(sensitiveRenderer.isSensitiveTarget, { ref: action.ref }))
          if (sensitiveFill) {
            await fillSensitive(action)
            continue
          }
          if (action.type === 'press') {
            const keys = { Enter:13, Tab:9, Escape:27, ArrowDown:40, ArrowUp:38, ArrowLeft:37, ArrowRight:39, Backspace:8, Delete:46, Home:36, End:35, PageUp:33, PageDown:34, Space:32, Spacebar:32 }
            if (!Object.hasOwn(keys, action.key)) throw new Error('Unsupported key')
            if (action.ref) {
              await this.prepareFrame(); await this.evaluate(prepareElement, action)
              if (!stillActive() || epoch !== this.epoch) throw new Error('Task paused during action preparation')
              await this.evaluate(validatePreparedAction, action)
            }
            if (!stillActive() || epoch !== this.epoch) throw new Error('Task paused during action preparation')
            dispatched = true
            phase = 'input'
            const space = keys[action.key] === 32
            const key = { key: space ? ' ' : action.key, code: space ? 'Space' : action.key, windowsVirtualKeyCode: keys[action.key] }
            await this.interruptOnDialog(this.send('Input.dispatchKeyEvent', { type:'keyDown', ...key, ...(space ? { text:' ' } : action.key === 'Enter' ? { text:'\r' } : {}) }))
            await this.interruptOnDialog(this.send('Input.dispatchKeyEvent', { type:'keyUp', ...key }))
          } else {
            if (!['click', 'fill', 'select', 'setChecked'].includes(action.type)) throw new Error('Unsupported action')
            await this.prepareFrame()
            let point = await this.evaluate(prepareElement, action)
            const preparedPoint = point
            const clicking = ['click', 'setChecked'].includes(action.type) && !point.noOp
            if (clicking) point = await this.toRootPoint(point)
            if (!stillActive() || epoch !== this.epoch) throw new Error('Task paused during action preparation')
            const sensitiveAfterPreparation = await this.evaluate(validatePreparedAction, {
              ...action, ...(clicking ? { point: { x: preparedPoint.x, y: preparedPoint.y } } : {}), ...(preparedPoint.noOp ? { noOp: true } : {}),
            })
            if (!stillActive() || epoch !== this.epoch) throw new Error('Task paused during action preparation')
            // Scroll/focus handlers can turn an ordinary text field into a
            // password or OTP. Reclassify the prepared node before delivery.
            if (action.type === 'fill' && privateInput && sensitiveAfterPreparation) {
              await fillSensitive(action)
              continue
            }
            if (action.type === 'select' || action.type === 'fill' && point.inputMode === 'native') {
              dispatched = true
              phase = 'input'
              const { expectedValue } = await this.evaluate(applyFormValue, action)
              verificationAction = { ...action, value: expectedValue }
            } else if (action.type === 'fill') {
              dispatched = true
              phase = 'input'
              await this.interruptOnDialog(this.send('Input.insertText', { text: action.value }))
            } else if (clicking) {
              dispatched = true
              phase = 'input'
              const { x, y } = point
              await this.interruptOnDialog(this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 }))
              await this.interruptOnDialog(this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 }))
            }
          }
          completed++
          phase = 'verify'
          if (action.type === 'fill' && privateInput) {
            try {
              if (epoch !== this.epoch || await this.evaluate(sensitiveRenderer.isSensitiveTarget, { ref: action.ref })) privateInput.begin()
            } catch (error) { privateInput.begin(); throw error }
          }
          const verification = ['fill', 'select', 'setChecked'].includes(action.type)
            ? epoch === this.epoch ? await this.evaluate(verifyElementValue, verificationAction) : { scope: 'element', status: 'unavailable' }
            : undefined
          results.push(record(action, verification?.status === 'matched' ? 'delivered_verified' : 'delivered_unverified', verification))
        } catch (error) {
          if (action.type === 'fill' && privateInput && dispatched) privateInput.begin()
          if (completed > current) {
            // Input was acknowledged; a failed readback must not change its delivery.
            diagnostic = annotateOperationError(error, 'verify').diagnostic
            results.push(record(action, 'delivered_unverified', { scope: 'element', status: 'unavailable' }))
            break
          }
          if (!(error instanceof DialogOpened) || !dispatched) throw error
          if (completed <= current) completed++
          results.push(record(action, 'delivery_uncertain'))
          break
        }
      }
      let observation, observationUnavailable = false
      try { observation = await this.observe() }
      catch (error) {
        // A failed follow-up read cannot change acknowledged input delivery.
        diagnostic = annotateOperationError(error, 'observe').diagnostic
        this.observation = null
        observationUnavailable = true
        observation = { pageId: this.pageId, text: '', elements: [], complete: false, truncated: true,
          coverage: { scope: 'main_frame', blocked: 'observation_unavailable' }, contentTrust: 'untrusted' }
      }
      const delivery = results.some(result => result.delivery === 'delivery_uncertain') ? 'delivery_uncertain'
        : results.every(result => result.delivery === 'delivered_verified') ? 'delivered_verified' : 'delivered_unverified'
      return { completed, ...(observationUnavailable ? { stopped: 'observation_unavailable' } : this.dialog ? { stopped: 'dialog' } : {}), observation,
        ...(diagnostic ? { diagnostic } : {}),
        actionResult: actionResult(completed, null, results, delivery, delivery === 'delivery_uncertain' ? 'delivery_uncertain' : observationUnavailable ? 'observation_unavailable' : delivery === 'delivered_verified' ? 'completed' : 'verify_outcome') }
    } catch (error) {
      annotateOperationError(error, phase)
      this.observation = null
      const delivery = dispatched || error.deliveryUncertain ? 'delivery_uncertain' : 'not_delivered'
      const failedIndex = current < actions.length ? current : null
      if (failedIndex !== null && !results.some(result => result.index === failedIndex)) results.push(record(actions[failedIndex], delivery))
      const reason = delivery === 'not_delivered' ? 'not_dispatched' : 'delivery_uncertain'
      error.actionResult = actionResult(completed, failedIndex, results, delivery, reason)
      if (delivery === 'delivery_uncertain') error.message = 'Action delivery or outcome is uncertain; observe before continuing'
      error.message = `${error.message} (completed ${completed}/${actions.length}; do not blindly replay)`
      throw error
    } finally { if (focusEnabled && !this.dialog) await this.syncFocusEmulation().catch(()=>{}) }
  }
  async preparePrivateInput(observationId, ref, origin, focusAlreadyEnabled = false) {
    if (!this.observation || this.observation.id !== observationId || this.observation.epoch !== this.epoch) throw new Error('Private input observation changed')
    if (this.dialog) throw new Error('Handle the open dialog before private input')
    const observation = this.observation, epoch = this.epoch
    let focusEnabled = false
    try {
      if (!focusAlreadyEnabled) { await this.syncFocusEmulation(true); focusEnabled = true }
      await this.prepareFrame()
      const target = await this.evaluate(sensitiveRenderer.preparePrivateTarget, { ref, revision: observation.revision, origin })
      if (this.observation !== observation || this.epoch !== epoch) throw new Error('Private input document changed')
      return target
    } finally { if (focusEnabled && !this.dialog) await this.syncFocusEmulation().catch(() => {}) }
  }
  async uploadFiles({ observationId, ref, chooserId }, files, stillActive) {
    const observation = this.observation, epoch = this.epoch
    if (!observation || observation.id !== observationId || observation.epoch !== epoch) throw new Error('Stale observation; observe the page again')
    if (this.dialog) throw new Error('Handle the open dialog before selecting files')
    const chooser = chooserId === undefined ? null : this.chooser
    const check = () => {
      if (!stillActive() || !this.interceptFileChooser) throw new Error('Task state or page session changed; file selection stopped')
      if (this.epoch !== epoch || this.observation !== observation) throw new Error('Stale observation; observe the page again')
      if (chooserId !== undefined && (!chooser || chooser.id !== chooserId || chooser.epoch !== epoch || this.chooser !== chooser)) throw new Error('Stale file chooser; observe and open the control again')
      if (chooser?.unsupported) throw new Error(chooser.unsupported)
    }
    check()
    let objectId, selectionStarted = false
    try {
      const revision = await this.evaluate(() => globalThis.__velmrenAgent?.revision)
      check()
      if (revision !== observation.revision) throw new Error('Page changed since observation; observe again')
      if (chooser) {
        const resolved = await this.send('DOM.resolveNode', { backendNodeId: chooser.backendNodeId, executionContextId: this.world })
        objectId = resolved.object?.objectId
      } else {
        const resolved = await this.evaluate(({ ref, revision }) => {
          const state = globalThis.__velmrenAgent
          if (state?.revision !== revision) throw new Error('Page changed since observation; observe again')
          const el = state.refs.get(ref)
          if (!el?.isConnected) throw new Error('Element reference is stale; observe again')
          if (el.tagName !== 'INPUT' || el.type !== 'file') throw new Error('Element reference is not a file input')
          return el
        }, { ref, revision }, false)
        objectId = resolved.objectId
      }
      check()
      if (!objectId) throw new Error('File input is no longer available; observe again')
      const prepared = await this.send('Runtime.callFunctionOn', {
        objectId, returnByValue: true,
        functionDeclaration: `function(...args) { ${formPrelude}; return (${function(revision, count, requireConnected) {
          if (globalThis.__velmrenAgent?.revision !== revision) return { error: 'Page changed since observation; observe again' }
          if ((requireConnected && !this.isConnected) || this.ownerDocument !== document || this.tagName !== 'INPUT' || this.type !== 'file') return { error: 'File input is no longer available in this page' }
          if (elementCapabilities(this, false).disabled) return { error: 'File input is disabled' }
          if (this.webkitdirectory) return { error: 'Directory uploads are not supported; choose a file input' }
          if (count > 1 && !this.multiple) return { error: 'File input accepts only one file' }
          return { ready: true }
        }.toString()}).apply(this, args) }`, arguments: [{ value: revision }, { value: files.length }, { value: !chooser }]
      })
      check()
      if (prepared.exceptionDetails || prepared.result?.value?.ready !== true) throw new Error(prepared.result?.value?.error ?? 'File input could not be prepared')
      selectionStarted = true
      // Paths travel only to the owned browser, never through page JavaScript.
      await this.interruptOnDialog(this.send('DOM.setFileInputFiles', { objectId, files: files.map(file => file.path) }))
      check()
      const selected = await this.send('Runtime.callFunctionOn', {
        objectId, returnByValue: true,
        functionDeclaration: function() { return [...this.files].map(file => ({ name: file.name, size: file.size })) }.toString()
      })
      check()
      const actual = selected.result?.value
      if (selected.exceptionDetails || !Array.isArray(actual) || actual.length !== files.length || actual.some((file, index) => file.name !== files[index].name || file.size !== files[index].size)) throw new Error('Selected files could not be verified')
      this.chooser = null
      this.observation = null
      return { files: files.map(({ name, size }) => ({ name, size })), verified: true, observation: await this.observe(),
        actionResult: actionResult(1, null, [{ index: 0, type: 'uploadFiles', ...(/^e[1-9][0-9]{0,8}$/.test(ref ?? '') ? { ref } : {}), delivery: 'delivered_verified', verification: { scope: 'element', status: 'matched' } }], 'delivered_verified', 'completed') }
    } catch (error) {
      if (selectionStarted) {
        this.observation = null; this.chooser = null
        error.message = 'File selection may already have reached the page but could not be verified. Observe the page before retrying; do not blindly replay.'
      }
      const delivery = selectionStarted || error.deliveryUncertain ? 'delivery_uncertain' : 'not_delivered'
      error.actionResult = actionResult(0, 0, [{ index: 0, type: 'uploadFiles', ...(/^e[1-9][0-9]{0,8}$/.test(ref ?? '') ? { ref } : {}), delivery }], delivery, delivery === 'not_delivered' ? 'not_dispatched' : 'delivery_uncertain')
      throw error
    } finally { if (objectId) await this.send('Runtime.releaseObject', { objectId }).catch(() => {}) }
  }
  async handleDialog(accept, promptText) {
    let dispatched = false, completed = 0
    try {
      if (!this.dialog) throw new Error('Page has no open dialog')
      const handled = this.dialog
      dispatched = true
      await this.send('Page.handleJavaScriptDialog', { accept, ...(promptText === undefined ? {} : { promptText }) })
      completed = 1
      if (this.dialog === handled) this.dialog = null
      if (!this.dialog) await this.syncFocusEmulation()
      this.observation = null
      return { ...await this.observe(), actionResult: actionResult(1, null, [{ index: 0, type: 'handleDialog', delivery: 'delivered_unverified' }], 'delivered_unverified', 'verify_outcome') }
    } catch (error) {
      const delivery = dispatched || error.deliveryUncertain ? 'delivery_uncertain' : 'not_delivered'
      error.actionResult = actionResult(completed, 0, [{ index: 0, type: 'handleDialog', delivery }], delivery, delivery === 'not_delivered' ? 'not_dispatched' : 'delivery_uncertain')
      if (dispatched) error.message = 'Dialog response may already have reached the page; observe before continuing'
      throw error
    }
  }
  async wait(args, stillActive = () => true) {
    // Keep direct callers of the original wait(text, timeoutMs) working.
    if (typeof args === 'string') { args = { text: args, timeoutMs: typeof stillActive === 'number' ? stillActive : undefined }; stillActive = () => true }
    const { text, predicate } = args, timeoutMs = args.timeoutMs ?? 10000
    const started = performance.now(), epoch = this.epoch, observation = this.observation
    let world = this.world
    let lastObserved = { state: predicate?.state ?? 'text' }, watchdog, deadline, initial = true
    const elapsedMs = () => Math.max(0, Math.min(timeoutMs, Math.round(performance.now() - started)))
    const check = () => {
      if (!stillActive() || this.disposed) throw new Error('Task state or page session changed; wait stopped')
      if (this.epoch !== epoch || world !== null && this.world !== world) throw new Error('Document changed during wait; observe again')
      if (predicate && (!observation || this.observation !== observation || observation.id !== predicate.observationId || observation.epoch !== epoch)) throw new Error('Stale observation; observe the page again')
    }
    const cancellation = new Promise((_, reject) => {
      watchdog = setInterval(() => { try { check() } catch (error) { reject(error) } }, 50)
    })
    const timedOut = new Promise(resolve => { deadline = setTimeout(() => resolve({ matched: false, lastObserved, timedOut: true }), timeoutMs) })
    try {
      check()
      do {
        const remaining = timeoutMs - (performance.now() - started)
        const chunkMs = Math.max(1, Math.min(initial ? 1 : 100, remaining)); initial = false
        const result = await Promise.race([this.evaluate(waitForCondition, { text, predicate, timeoutMs: chunkMs }), cancellation, timedOut])
        check(); lastObserved = result.lastObserved
        if (world === null) world = this.world
        if (result.timedOut) break
        if (result.matched) return { matched: true, elapsedMs: elapsedMs(), lastObserved, pageId: this.pageId }
      } while (performance.now() - started < timeoutMs)
      return { matched: false, elapsedMs: elapsedMs(), lastObserved, pageId: this.pageId }
    } catch (error) {
      try { check() } catch (stateError) { error = stateError }
      if (error instanceof DialogOpened) return { matched: false, elapsedMs: elapsedMs(), lastObserved, pageId: this.pageId, dialog: this.dialog }
      error.waitResult = { matched: false, elapsedMs: elapsedMs(), lastObserved, pageId: this.pageId }
      throw error
    } finally { clearInterval(watchdog); clearTimeout(deadline) }
  }
  async screenshot() { return {mimeType:'image/png',...(await this.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false}))} }
  async prepareFrame() { if (this.rootPage?.frames) await this.rootPage.frames.prepare(this) }
  async toRootPoint(point) { return this.rootPage?.frames ? this.rootPage.frames.toRootPoint(this, point) : point }
  dispose() { this.disposed = true; this.captcha.dispose(); this.chooser = null; this.observation = null; this.frames?.dispose(); this.browser.off('protocol',this.listener) }
}

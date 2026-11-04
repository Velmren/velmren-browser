import { randomUUID } from 'node:crypto'
import { actionResult } from './action-result.mjs'

class DialogOpened extends Error {}

function elementCapabilities(el, measure = true) {
  const box = measure ? el.getBoundingClientRect() : null, style = measure ? getComputedStyle(el) : null
  const hidden = measure && (!box.width || !box.height || ['hidden', 'collapse'].includes(style.visibility) || style.display === 'none')
  const disabled = !!el.disabled || el.matches(':disabled') || el.getAttribute('aria-disabled') === 'true' || !!el.closest?.('[inert]')
  const fileInput = el.tagName === 'INPUT' && el.type === 'file'
  const textInput = el.tagName === 'INPUT' && ['text', 'search', 'email', 'url', 'tel', 'password', 'number'].includes(el.type)
  const availableActions = []
  if (!disabled) {
    if (fileInput && !el.webkitdirectory) availableActions.push('uploadFiles')
    if (!hidden) {
      availableActions.push('click', 'press')
      if ((textInput || el.tagName === 'TEXTAREA' || el.isContentEditable) && !el.readOnly) availableActions.push('fill')
      if (el.tagName === 'SELECT' && [...el.options].some(option => !option.disabled && !(option.parentElement?.tagName === 'OPTGROUP' && option.parentElement.disabled))) availableActions.push('select')
    }
  }
  return { hidden, disabled, fileInput, availableActions }
}

function observeDocument({ readOnly = false } = {}) {
  const prior = globalThis.__velmrenAgent
  if (!readOnly) prior?.observer?.disconnect()
  const state = { refs: new Map(), revision: 0 }
  if (!readOnly) {
    state.observer = new MutationObserver(() => state.revision++)
    state.observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true })
    globalThis.__velmrenAgent = state
  }
  const elements = [], limits = { elements: 150, text: 10000, name: 200, value: 300, options: 50, files: 10 }
  const counts = { eligibleElements: 0, returnedElements: 0, hiddenElements: 0, truncatedNames: 0, truncatedValues: 0, omittedOptions: 0, truncatedOptionLabels: 0, truncatedOptionValues: 0, omittedFiles: 0 }
  for (const el of document.querySelectorAll('a,button,input,select,textarea,label,[role],[contenteditable="true"]')) {
    const { hidden, disabled, fileInput, availableActions } = elementCapabilities(el)
    if (el.tagName === 'LABEL' && el.control?.type !== 'file') continue
    if (hidden && !fileInput) { counts.hiddenElements++; continue }
    counts.eligibleElements++
    if (elements.length >= limits.elements) continue
    const ref = `e${elements.length + 1}`
    state.refs.set(ref, el)
    const name = (el.getAttribute('aria-label') || [...(el.labels || [])].map(label => {
      const copy=label.cloneNode(true)
      for(const control of copy.querySelectorAll('input,textarea,select'))control.remove()
      return copy.textContent
    }).join(' ') || el.getAttribute('placeholder') || el.innerText || el.getAttribute('name') || '').replace(/\s+/g,' ').trim()
    const value = el.type === 'password' ? '[redacted]' : fileInput ? '' : String(el.value ?? '')
    const truncation = { name: name.length > limits.name, value: value.length > limits.value }
    counts.truncatedNames += Number(truncation.name); counts.truncatedValues += Number(truncation.value)
    const entry = { ref, tag: el.tagName.toLowerCase(), role: el.getAttribute('role') || '', name: name.slice(0, limits.name), type: el.type || '', value: value.slice(0, limits.value), disabled, hidden, availableActions, truncation }
    if (fileInput) {
      const files = [...el.files]
      Object.assign(entry, { accept: el.accept, multiple: el.multiple, directory: el.webkitdirectory, files: files.slice(0, limits.files).map(file => ({ name: file.name, size: file.size })), fileCount: files.length })
      truncation.files = files.length > limits.files; counts.omittedFiles += Math.max(0, files.length - limits.files)
    }
    if (el.tagName === 'SELECT') {
      const options = [...el.options]
      entry.optionCount = options.length; truncation.options = options.length > limits.options
      counts.omittedOptions += Math.max(0, options.length - limits.options)
      entry.options = options.slice(0, limits.options).map(option => {
        const truncated = { label: option.label.length > limits.name, value: option.value.length > limits.value }
        counts.truncatedOptionLabels += Number(truncated.label); counts.truncatedOptionValues += Number(truncated.value)
        return { value: option.value.slice(0, limits.value), label: option.label.slice(0, limits.name), disabled: option.disabled || option.parentElement?.tagName === 'OPTGROUP' && option.parentElement.disabled, truncation: truncated }
      })
    }
    elements.push(entry)
  }
  const text = document.body?.innerText || ''
  counts.returnedElements = elements.length; counts.text = text.length; counts.returnedText = Math.min(text.length, limits.text)
  const truncated = counts.eligibleElements > elements.length || text.length > limits.text || counts.truncatedNames > 0 || counts.truncatedValues > 0 || counts.omittedOptions > 0 || counts.truncatedOptionLabels > 0 || counts.truncatedOptionValues > 0 || counts.omittedFiles > 0
  return { url: location.href, title: document.title, text: text.slice(0, limits.text), elements, revision: state.revision,
    complete: !truncated, truncated, limits, counts,
    coverage: { scope: 'main_frame', childFrames: 'excluded', shadowRoots: 'excluded', hiddenElements: 'excluded_except_file_inputs', completeness: 'eligible_elements_and_visible_text' } }
}

async function prepareElement({ ref, type, value }) {
  const el = globalThis.__velmrenAgent?.refs.get(ref)
  if (!el?.isConnected) throw new Error('Element reference is stale; observe again')
  if (elementCapabilities(el, false).disabled) throw new Error('Element is disabled')
  const validate = () => {
    const capabilities = elementCapabilities(el)
    if (capabilities.disabled) throw new Error('Element is disabled')
    if (capabilities.hidden) throw new Error('Element is not visible')
    if (!capabilities.availableActions.includes(type)) throw new Error('Element does not support this action')
  }
  validate()
  el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
  // DOM layout can precede the hidden compositor's hit-test data. Let a frame
  // commit before dispatching trusted input at the element's final position.
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  if (!el.isConnected) throw new Error('Element reference is stale; observe again')
  validate()
  const box = el.getBoundingClientRect()
  const style = getComputedStyle(el)
  if (!box.width || !box.height || style.visibility === 'hidden' || style.display === 'none') throw new Error('Element is not visible')
  const x = Math.max(0, Math.min(innerWidth - 1, box.x + box.width / 2))
  const y = Math.max(0, Math.min(innerHeight - 1, box.y + box.height / 2))
  const hit = document.elementFromPoint(x, y)
  if (hit !== el && !el.contains(hit)) throw new Error('Element is obscured')
  if (type === 'fill') {
    el.focus({ preventScroll: true })
    if (el.isContentEditable) {
      const range = document.createRange(); range.selectNodeContents(el)
      const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range)
    } else el.select()
  }
  if (type === 'select') {
    if (![...el.options].some(o=>o.value===value && !o.disabled && !(o.parentElement?.tagName === 'OPTGROUP' && o.parentElement.disabled))) throw new Error('Select option is unavailable')
  }
  if (type === 'press') el.focus({ preventScroll: true })
  return { x, y }
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
        lastObserved = { state: 'text', textMatches: !!document.body?.innerText.includes(text) }
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

function verifyElementValue({ ref, value }) {
  const el = globalThis.__velmrenAgent?.refs.get(ref)
  if (!el?.isConnected || el.ownerDocument !== document) return { scope: 'element', status: 'unavailable' }
  return { scope: 'element', status: String(el.isContentEditable ? el.innerText : el.value ?? '') === value ? 'matched' : 'mismatch' }
}

export class AgentPage {
  constructor(browser, targetId, sessionId) {
    Object.assign(this, { browser, targetId, pageId: targetId, sessionId, epoch: 0, frameId: null, world: null, observation: null, dialog: null, chooser: null, interceptFileChooser: true, url: 'about:blank', title: '' })
    this.dialogWaiters = new Set()
    this.pendingCommands = new Set()
    this.listener = message => {
      if (message.sessionId !== this.sessionId) return
      if (message.method === 'Page.frameNavigated' && !message.params.frame.parentId) {
        this.frameId = message.params.frame.id
        this.url = message.params.frame.url
        this.epoch++; this.world = null; this.observation = null; this.chooser = null
      }
      if (message.method === 'Page.navigatedWithinDocument') { this.observation = null; this.chooser = null }
      if (message.method === 'Runtime.executionContextsCleared') { this.world = null; this.observation = null; this.chooser = null }
      if (message.method === 'Page.fileChooserOpened' && this.interceptFileChooser) {
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
    try { return await this.browser.send(method, params, this.sessionId, timeout) }
    catch (error) { error.deliveryUncertain = true; throw error }
  }
  async init() {
    await this.send('Page.enable')
    await this.setFileChooserInterception(this.interceptFileChooser)
    await this.send('Runtime.enable')
    await this.send('Emulation.setDeviceMetricsOverride', { width:1280,height:800,deviceScaleFactor:1,mobile:false })
    const tree = await this.send('Page.getFrameTree')
    this.frameId = tree.frameTree.frame.id
    this.url = tree.frameTree.frame.url ?? this.url
  }
  async setFileChooserInterception(enabled) {
    await this.send('Page.setInterceptFileChooserDialog', { enabled })
    this.interceptFileChooser = enabled
    this.chooser = null
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
      result = await this.interruptOnDialog(this.send('Runtime.evaluate', { expression:`(()=>{const elementCapabilities=${elementCapabilities.toString()};return (${fn.toString()})(${JSON.stringify(args) ?? ''})})()`, contextId:this.world, awaitPromise:true, returnByValue }))
    } catch (error) { if (!(error instanceof DialogOpened)) error.deliveryUncertain = true; throw error }
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text)
    return returnByValue ? result.result.value : result.result
  }
  async observe(readOnly = false) {
    if (this.dialog) return this.dialogObservation()
    let result
    try { result = await this.evaluate(observeDocument, { readOnly }) }
    catch (error) { if (error instanceof DialogOpened) return this.dialogObservation(); throw error }
    this.url = result.url; this.title = result.title
    if (readOnly) { delete result.revision; return { ...result, ...this.chooserObservation(), pageId: this.pageId, contentTrust: 'untrusted' } }
    this.observation = { id:randomUUID(), epoch:this.epoch, revision:result.revision }
    delete result.revision
    this.lastObservation = { ...result, ...this.chooserObservation(), observationId:this.observation.id, pageId: this.pageId, contentTrust: 'untrusted' }
    return this.lastObservation
  }
  async navigate(url) {
    this.observation = null; this.chooser = null
    let cancel
    const loaded = new Promise((resolve, reject) => {
      const listener = message => { if(message.sessionId===this.sessionId && ['Page.loadEventFired', 'Page.javascriptDialogOpening'].includes(message.method)) done() }
      const timer=setTimeout(()=>done(new Error('Page load timed out')),20000)
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
      cancel(error); throw error
    }
    await loaded
    return this.observe()
  }
  async act(observationId, actions, stillActive = () => true) {
    const epoch = this.epoch, results = []
    let completed = 0, current = 0, dispatched = false, focusEnabled = false
    const record = (action, delivery, verification) => ({ index: current, type: action.type,
      ...(/^e[1-9][0-9]{0,8}$/.test(action.ref ?? '') ? { ref: action.ref } : {}), delivery, ...(verification ? { verification } : {}) })
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
      if (revision !== this.observation?.revision) throw new Error('Page changed since observation; observe again')
      try { await this.send('Emulation.setFocusEmulationEnabled', { enabled: true }); focusEnabled = true }
      catch (error) { error.deliveryUncertain = true; throw error }
      for (current = 0; current < actions.length; current++) {
        const action = actions[current]
        dispatched = false
        try {
          if (!stillActive() || epoch !== this.epoch) throw new Error('Task state or document changed; remaining actions stopped')
          if (action.type === 'press') {
            const keys = { Enter:13, Tab:9, Escape:27, ArrowDown:40, ArrowUp:38, Backspace:8 }
            if (!Object.hasOwn(keys, action.key)) throw new Error('Unsupported key')
            if (action.ref) await this.evaluate(prepareElement, action)
            if (!stillActive() || epoch !== this.epoch) throw new Error('Task paused during action preparation')
            dispatched = true
            await this.interruptOnDialog(this.send('Input.dispatchKeyEvent', { type:'keyDown', key:action.key, windowsVirtualKeyCode:keys[action.key], ...(action.key === 'Enter' ? { text:'\r' } : {}) }))
            await this.interruptOnDialog(this.send('Input.dispatchKeyEvent', { type:'keyUp', key:action.key, windowsVirtualKeyCode:keys[action.key] }))
          } else {
            if (!['click', 'fill', 'select'].includes(action.type)) throw new Error('Unsupported action')
            const point = await this.evaluate(prepareElement, action)
            if (!stillActive() || epoch !== this.epoch) throw new Error('Task paused during action preparation')
            dispatched = true
            if (action.type === 'fill') await this.interruptOnDialog(this.send('Input.insertText', { text:action.value }))
            else if (action.type === 'click') {
              await this.interruptOnDialog(this.send('Input.dispatchMouseEvent', { type:'mousePressed', ...point, button:'left', clickCount:1 }))
              await this.interruptOnDialog(this.send('Input.dispatchMouseEvent', { type:'mouseReleased', ...point, button:'left', clickCount:1 }))
            } else {
              await this.evaluate(({ ref, value }) => {
                const el = globalThis.__velmrenAgent?.refs.get(ref)
                if (!el?.isConnected || !elementCapabilities(el).availableActions.includes('select')) throw new Error('Select reference changed')
                el.value = value; el.dispatchEvent(new Event('input', { bubbles:true })); el.dispatchEvent(new Event('change', { bubbles:true }))
              }, action)
            }
          }
          completed++
          const verification = ['fill', 'select'].includes(action.type)
            ? epoch === this.epoch ? await this.evaluate(verifyElementValue, action) : { scope: 'element', status: 'unavailable' }
            : undefined
          results.push(record(action, verification?.status === 'matched' ? 'delivered_verified' : 'delivered_unverified', verification))
        } catch (error) {
          if (!(error instanceof DialogOpened) || !dispatched) throw error
          if (completed <= current) completed++
          results.push(record(action, 'delivery_uncertain'))
          break
        }
      }
      const observation = await this.observe()
      const delivery = results.some(result => result.delivery === 'delivery_uncertain') ? 'delivery_uncertain'
        : results.every(result => result.delivery === 'delivered_verified') ? 'delivered_verified' : 'delivered_unverified'
      return { completed, ...(this.dialog ? { stopped: 'dialog' } : {}), observation,
        actionResult: actionResult(completed, null, results, delivery, delivery === 'delivered_verified' ? 'completed' : delivery === 'delivery_uncertain' ? 'delivery_uncertain' : 'verify_outcome') }
    } catch (error) {
      this.observation = null
      const delivery = dispatched || error.deliveryUncertain ? 'delivery_uncertain' : 'not_delivered'
      const failedIndex = current < actions.length ? current : null
      if (failedIndex !== null && !results.some(result => result.index === failedIndex)) results.push(record(actions[failedIndex], delivery))
      const reason = delivery === 'not_delivered' ? 'not_dispatched' : 'delivery_uncertain'
      error.actionResult = actionResult(completed, failedIndex, results, delivery, reason)
      if (delivery === 'delivery_uncertain') error.message = 'Action delivery or outcome is uncertain; observe before continuing'
      error.message = `${error.message} (completed ${completed}/${actions.length}; do not blindly replay)`
      throw error
    } finally { if (focusEnabled && !this.dialog) await this.send('Emulation.setFocusEmulationEnabled', { enabled:false }).catch(()=>{}) }
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
        functionDeclaration: `function(...args) { const elementCapabilities = ${elementCapabilities.toString()}; return (${function(revision, count, requireConnected) {
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
      if (!this.dialog) await this.send('Emulation.setFocusEmulationEnabled', { enabled: false })
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
  dispose() { this.disposed = true; this.chooser = null; this.observation = null; this.browser.off('protocol',this.listener) }
}

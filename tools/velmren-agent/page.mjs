import { randomUUID } from 'node:crypto'

function observeDocument({ readOnly = false } = {}) {
  const prior = globalThis.__velmrenAgent
  if (!readOnly) prior?.observer.disconnect()
  const state = { refs: new Map(), revision: 0 }
  if (!readOnly) {
    state.observer = new MutationObserver(() => state.revision++)
    state.observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true })
    globalThis.__velmrenAgent = state
  }
  const elements = []
  for (const el of document.querySelectorAll('a,button,input,select,textarea,[role],[contenteditable="true"]')) {
    const box = el.getBoundingClientRect()
    const style = getComputedStyle(el)
    if (!box.width || !box.height || style.visibility === 'hidden' || style.display === 'none') continue
    const ref = `e${elements.length + 1}`
    state.refs.set(ref, el)
    const name = el.getAttribute('aria-label') || [...(el.labels || [])].map(label => {
      const copy=label.cloneNode(true)
      for(const control of copy.querySelectorAll('input,textarea,select'))control.remove()
      return copy.textContent
    }).join(' ') || el.getAttribute('placeholder') || el.innerText || el.getAttribute('name') || ''
    elements.push({ ref, tag: el.tagName.toLowerCase(), role: el.getAttribute('role') || '', name: name.replace(/\s+/g,' ').trim().slice(0,200), type: el.type || '', value: el.type === 'password' ? '[redacted]' : String(el.value || '').slice(0,300), disabled: !!el.disabled, ...(el.tagName === 'SELECT' ? {options:[...el.options].slice(0,50).map(o=>({value:o.value,label:o.label}))}: {}) })
    if (elements.length >= 150) break
  }
  return { url: location.href, title: document.title, text: (document.body?.innerText || '').slice(0,10000), elements, revision: state.revision }
}

function prepareElement({ ref, type, value }) {
  const el = globalThis.__velmrenAgent?.refs.get(ref)
  if (!el?.isConnected) throw new Error('Element reference is stale; observe again')
  if (el.disabled || el.getAttribute('aria-disabled') === 'true') throw new Error('Element is disabled')
  el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
  const box = el.getBoundingClientRect()
  const style = getComputedStyle(el)
  if (!box.width || !box.height || style.visibility === 'hidden' || style.display === 'none') throw new Error('Element is not visible')
  const x = Math.max(0, Math.min(innerWidth - 1, box.x + box.width / 2))
  const y = Math.max(0, Math.min(innerHeight - 1, box.y + box.height / 2))
  const hit = document.elementFromPoint(x, y)
  if (hit !== el && !el.contains(hit)) throw new Error('Element is obscured')
  if (type === 'fill') {
    if (!['INPUT','TEXTAREA'].includes(el.tagName) && !el.isContentEditable) throw new Error('Element cannot accept text')
    if (el.readOnly || el.type === 'file') throw new Error('Element cannot be filled')
    el.focus({ preventScroll: true })
    if (el.isContentEditable) {
      const range = document.createRange(); range.selectNodeContents(el)
      const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range)
    } else el.select()
  }
  if (type === 'select') {
    if (el.tagName !== 'SELECT' || ![...el.options].some(o=>o.value===value && !o.disabled)) throw new Error('Select option is unavailable')
  }
  if (type === 'press') el.focus({ preventScroll: true })
  return { x, y }
}

function waitForText({ text, timeoutMs }) {
  return new Promise(resolve => {
    const check = () => document.body?.innerText.includes(text)
    if (check()) return resolve({ matched: true })
    const observer = new MutationObserver(() => { if (check()) finish(true) })
    const timer = setTimeout(() => finish(false), timeoutMs)
    const finish = matched => { clearTimeout(timer); observer.disconnect(); resolve({matched}) }
    observer.observe(document, { subtree: true, childList: true, characterData: true })
  })
}

export class AgentPage {
  constructor(browser, targetId, sessionId) {
    Object.assign(this, { browser, targetId, sessionId, epoch: 0, frameId: null, world: null, observation: null })
    this.listener = message => {
      if (message.sessionId !== this.sessionId) return
      if (message.method === 'Page.frameNavigated' && !message.params.frame.parentId) {
        this.frameId = message.params.frame.id
        this.epoch++; this.world = null; this.observation = null
      }
      if (message.method === 'Runtime.executionContextsCleared') this.world = null
    }
    browser.on('protocol', this.listener)
  }
  send(method, params = {}, timeout) { return this.browser.send(method, params, this.sessionId, timeout) }
  async init() {
    await this.send('Page.enable')
    await this.send('Runtime.enable')
    await this.send('Emulation.setDeviceMetricsOverride', { width:1280,height:800,deviceScaleFactor:1,mobile:false })
    const tree = await this.send('Page.getFrameTree')
    this.frameId = tree.frameTree.frame.id
  }
  async evaluate(fn, args) {
    if (!this.world) {
      const result = await this.send('Page.createIsolatedWorld', { frameId:this.frameId,worldName:'velmren-agent',grantUniveralAccess:false })
      this.world = result.executionContextId
    }
    const result = await this.send('Runtime.evaluate', { expression:`(${fn.toString()})(${JSON.stringify(args) ?? ''})`, contextId:this.world, awaitPromise:true, returnByValue:true })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text)
    return result.result.value
  }
  async observe(readOnly = false) {
    const result = await this.evaluate(observeDocument, { readOnly })
    if (readOnly) { delete result.revision; return result }
    this.observation = { id:randomUUID(), epoch:this.epoch, revision:result.revision }
    delete result.revision
    return { ...result, observationId:this.observation.id }
  }
  async navigate(url) {
    this.observation = null
    let cancel
    const loaded = new Promise((resolve, reject) => {
      const listener = message => { if(message.sessionId===this.sessionId && message.method==='Page.loadEventFired') done() }
      const timer=setTimeout(()=>done(new Error('Page load timed out')),20000)
      const done=error=>{clearTimeout(timer);this.browser.off('protocol',listener);error?reject(error):resolve()}
      cancel=done
      this.browser.on('protocol',listener)
    })
    // Attach the rejection handler before navigation can fail.
    loaded.catch(()=>{})
    let result
    try {
      result = await this.send('Page.navigate', {url})
      if (result.errorText) throw new Error(`Navigation failed: ${result.errorText}`)
      if (!result.loaderId) cancel()
    } catch (error) { cancel(error); throw error }
    await loaded
    return this.observe()
  }
  async act(observationId, actions, stillActive) {
    if (!this.observation || observationId !== this.observation.id || this.observation.epoch !== this.epoch) throw new Error('Stale observation; observe the page again')
    const revision = await this.evaluate(()=>globalThis.__velmrenAgent?.revision)
    if (revision !== this.observation.revision) throw new Error('Page changed since observation; observe again')
    const epoch=this.epoch
    let completed=0
    await this.send('Emulation.setFocusEmulationEnabled', {enabled:true})
    try {
      for (const action of actions) {
        if (!stillActive() || epoch!==this.epoch) throw new Error('Task state or document changed; remaining actions stopped')
        if (action.type==='press') {
          const keys={Enter:13,Tab:9,Escape:27,ArrowDown:40,ArrowUp:38,Backspace:8}
          if (!Object.hasOwn(keys,action.key)) throw new Error('Unsupported key')
          if (action.ref) await this.evaluate(prepareElement,action)
          if (!stillActive() || epoch!==this.epoch) throw new Error('Task paused during action preparation')
          await this.send('Input.dispatchKeyEvent',{type:'keyDown',key:action.key,windowsVirtualKeyCode:keys[action.key],...(action.key==='Enter'?{text:'\r'}:{})})
          await this.send('Input.dispatchKeyEvent',{type:'keyUp',key:action.key,windowsVirtualKeyCode:keys[action.key]})
        } else {
          const point=await this.evaluate(prepareElement,action)
          if (!stillActive() || epoch!==this.epoch) throw new Error('Task paused during action preparation')
          if (action.type==='fill') await this.send('Input.insertText',{text:action.value})
          else if (action.type==='click') {
            await this.send('Input.dispatchMouseEvent',{type:'mousePressed',...point,button:'left',clickCount:1})
            await this.send('Input.dispatchMouseEvent',{type:'mouseReleased',...point,button:'left',clickCount:1})
          } else if (action.type==='select') {
            await this.evaluate(({ref,value})=>{
              const el=globalThis.__velmrenAgent?.refs.get(ref)
              if(!el?.isConnected || el.disabled)throw new Error('Select reference changed')
              el.value=value;el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}))
            },action)
          } else throw new Error('Unsupported action')
        }
        completed++
      }
      return { completed, observation:await this.observe() }
    } catch(error) { this.observation=null; error.message=`${error.message} (completed ${completed}/${actions.length}; do not blindly replay)`; throw error }
    finally { await this.send('Emulation.setFocusEmulationEnabled',{enabled:false}).catch(()=>{}) }
  }
  wait(text,timeoutMs) { return this.evaluate(waitForText,{text,timeoutMs}) }
  async screenshot() { return {mimeType:'image/png',...(await this.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false}))} }
  dispose() { this.browser.off('protocol',this.listener) }
}

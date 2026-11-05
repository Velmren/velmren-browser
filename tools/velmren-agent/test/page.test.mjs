import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import vm from 'node:vm'
import { AgentPage } from '../page.mjs'

for (const phase of ['verify', 'observe']) test(`acknowledged input keeps delivery when ${phase} fails`, async () => {
  const browser = new EventEmitter()
  browser.send = async () => ({})
  const page = new AgentPage(browser, 'target', 'session')
  page.observation = { id: 'obs', epoch: 0, revision: 0 }
  const failure = () => Object.assign(new Error('Browser connection closed'), { code: 'CONNECTION_ERROR' })
  page.evaluate = async fn => {
    if (!fn.name) return 0
    if (fn.name === 'prepareElement') return { inputMode: 'text' }
    if (fn.name === 'verifyElementValue') {
      if (phase === 'verify') throw failure()
      return { scope: 'element', status: 'matched' }
    }
  }
  page.observe = async () => { if (phase === 'observe') throw failure(); return { pageId: 'target' } }
  const result = await page.act('obs', [{ type: 'fill', ref: 'e1', value: 'synthetic' }])
  assert.equal(result.actionResult.completed, 1)
  assert.equal(result.actionResult.failedIndex, null)
  assert.equal(result.actionResult.recovery.retry, 'none')
  assert.deepEqual(result.diagnostic, { reason: 'transport', phase })
  assert.equal(result.actionResult.results[0].delivery, phase === 'observe' ? 'delivered_verified' : 'delivered_unverified')
  page.dispose()
})

for (const transition of ['preparation', 'delivery', 'delivery-error']) {
  test(`ordinary fill enables protection when sensitivity changes during ${transition}`, async () => {
    const browser = new EventEmitter(), calls = []
    let protectedPhase = false, sensitive = false
    browser.send = async method => {
      calls.push(method)
      if (method === 'Input.insertText') {
        sensitive = true
        if (transition === 'delivery-error') throw new Error('Synthetic delivery interrupted')
      }
      return {}
    }
    const page = new AgentPage(browser, 'target', 'session')
    page.observation = { id: 'obs', epoch: 0, revision: 0 }
    page.preparePrivateInput = async () => ({ origin: 'http://localhost' })
    page.evaluate = async fn => {
      if (!fn.name) return 0
      if (fn.name === 'isSensitiveTarget') return sensitive
      if (fn.name === 'validatePreparedAction') return sensitive
      if (fn.name === 'prepareElement') { if (transition === 'preparation') sensitive = true; return { inputMode: 'text' } }
      if (fn.name === 'applyPrivateValue') { assert.equal(protectedPhase, true); calls.push('bound-delivery') }
      return { scope: 'element', status: 'matched' }
    }
    page.observe = async () => ({ pageId: 'target' })
    const action = page.act('obs', [{ type: 'fill', ref: 'e1', value: 'SyntheticPrivateFixture' }], () => true, { begin() { protectedPhase = true } })
    if (transition === 'delivery-error') await assert.rejects(action)
    else assert.equal((await action).completed, 1)
    assert.equal(protectedPhase, true)
    if (transition === 'preparation') { assert.equal(calls.includes('Input.insertText'), false); assert.equal(calls.includes('bound-delivery'), true) }
    page.dispose()
  })
}

test('ordinary navigation keys and Space aliases dispatch normalized trusted key events', async () => {
  for (const [key, code] of [['Space', 32], ['Spacebar', 32], ['End', 35], ['Home', 36], ['ArrowLeft', 37], ['ArrowRight', 39], ['Delete', 46], ['PageUp', 33], ['PageDown', 34]]) {
    const browser = new EventEmitter(), calls = []
    browser.send = async (method, params) => { calls.push({ method, params }); return {} }
    const page = new AgentPage(browser, 'target', 'session')
    page.observation = { id: 'obs', epoch: 0, revision: 0 }
    page.evaluate = async () => 0; page.observe = async () => ({ pageId: 'target' })
    await page.act('obs', [{ type: 'press', key }])
    const events = calls.filter(call => call.method === 'Input.dispatchKeyEvent').map(call => call.params)
    assert.equal(events.length, 2)
    assert.deepEqual(events.map(event => event.type), ['keyDown', 'keyUp'])
    for (const event of events) {
      assert.equal(event.windowsVirtualKeyCode, code)
      assert.equal(event.key, code === 32 ? ' ' : key)
      assert.equal(event.code, code === 32 ? 'Space' : key)
    }
    if (code === 32) assert.equal(events[0].text, ' ')
    page.dispose()
  }
})

test('trusted input waits for frame commits and uses the final element geometry', async () => {
  const browser = new EventEmitter(), calls = [], frames = []
  let firstFrame, secondFrame, x = 10
  const scheduled = [new Promise(resolve => { firstFrame = resolve }), new Promise(resolve => { secondFrame = resolve })]
  const signals = [firstFrame, secondFrame]
  const element = { isConnected: true, disabled: false, matches: () => false, getAttribute: () => null, scrollIntoView() {}, getBoundingClientRect: () => ({ x, y: 20, width: 20, height: 10 }) }
  const context = vm.createContext({
    __velmrenAgent: { refs: new Map([['e1', element]]), revision: 0 },
    requestAnimationFrame: callback => { frames.push(callback); signals.shift()() },
    document: { elementFromPoint: () => element },
    getComputedStyle: () => ({ visibility: 'visible', display: 'block' }), innerWidth: 1280, innerHeight: 800
  })
  browser.send = async (method, params) => {
    calls.push({ method, params })
    if (method === 'Runtime.evaluate') return { result: { value: await vm.runInContext(params.expression, context) } }
    return {}
  }
  const page = new AgentPage(browser, 'target', 'session')
  page.world = 1; page.observation = { id: 'obs', epoch: 0, revision: 0 }
  page.observe = async () => ({ pageId: 'target' })
  const acting = page.act('obs', [{ type: 'click', ref: 'e1' }], () => true)
  await scheduled[0]
  assert.ok(!calls.some(call => call.method.startsWith('Input.')))
  frames.shift()()
  await scheduled[1]
  assert.ok(!calls.some(call => call.method.startsWith('Input.')))
  x = 80; frames.shift()()
  assert.equal((await acting).completed, 1)
  for (const call of calls.filter(call => call.method === 'Input.dispatchMouseEvent')) assert.equal(call.params.x, 90)
  assert.deepEqual(calls.filter(call => call.method === 'Emulation.setFocusEmulationEnabled').map(call => call.params.enabled), [true, false])
  page.dispose()
})

for(const type of ['fill','click','select','press']) {
  test(`pause during ${type} preparation prevents the input from being dispatched`,async()=>{
    const browser=new EventEmitter(),calls=[]
    browser.send=async(method)=>{calls.push(method);return {}}
    const page=new AgentPage(browser,'target','session')
    page.observation={id:'obs',epoch:0,revision:0}
    let active=true,evaluations=0
    page.evaluate=async()=>{
      evaluations++
      if(evaluations===1)return 0
      active=false
      return {x:20,y:20}
    }
    await assert.rejects(page.act('obs',[{type,ref:'e1',value:'fixture',key:'Enter'}],()=>active),/paused during action preparation/)
    assert.equal(calls.filter(method=>method.startsWith('Input.')).length,0)
    assert.equal(evaluations,2)
    assert.equal(page.observation,null)
    page.dispose()
  })
}

test('a prompt interrupts a pending click, stays observable, and is explicitly answered', { timeout: 1000 }, async () => {
  const browser = new EventEmitter(), calls = []
  let releaseClick, evaluationAtDialog
  browser.send = async (method, params) => {
    calls.push({ method, params })
    if (method === 'Input.dispatchMouseEvent' && params.type === 'mouseReleased') {
      const pending = new Promise(resolve => { releaseClick = resolve })
      evaluationAtDialog = evaluation
      browser.emit('protocol', { sessionId: 's', method: 'Page.javascriptDialogOpening', params: { type: 'prompt', message: 'Untrusted page message', defaultPrompt: '' } })
      return pending
    }
    if (method === 'Page.handleJavaScriptDialog') {
      browser.emit('protocol', { sessionId: 's', method: 'Page.javascriptDialogClosed', params: {} })
      releaseClick({})
    }
    return {}
  }
  const page = new AgentPage(browser, 'p', 's')
  page.observation = { id: 'o', epoch: 0, revision: 0 }
  let evaluation = 0
  page.evaluate = async () => {
    evaluation++
    if (evaluation === 1) return 0
    if (evaluation === 2) return { x: 10, y: 10 }
    return { url: 'http://localhost/', title: 'Done', text: 'Dialog result: accepted', elements: [], revision: 0 }
  }
  const result = await page.act('o', [{ type: 'click', ref: 'e1' }, { type: 'click', ref: 'e2' }], () => true)
  assert.equal(result.completed, 1)
  assert.equal(result.stopped, 'dialog')
  assert.equal(result.observation.dialog.type, 'prompt')
  assert.equal(result.observation.contentTrust, 'untrusted')
  assert.equal((await page.observe()).dialog.message, 'Untrusted page message')
  assert.equal(evaluation, evaluationAtDialog, 'Observing a dialog must not issue a blocked DOM evaluation')
  const answered = await page.handleDialog(true, 'accepted')
  assert.equal(answered.text, 'Dialog result: accepted')
  assert.equal(page.dialog, null)
  assert.deepEqual(calls.find(call => call.method === 'Page.handleJavaScriptDialog').params, { accept: true, promptText: 'accepted' })
  assert.equal(calls.filter(call => call.method === 'Input.dispatchMouseEvent').length, 2)
  page.dispose()
})

test('owned page actions and private preparation retain active rendering through a child frame', async () => {
  const browser = new EventEmitter(), focus = []
  let active = true
  browser.send = async (method, params, sessionId) => { if (method === 'Emulation.setFocusEmulationEnabled') focus.push({ enabled: params.enabled, sessionId }); return {} }
  const root = new AgentPage(browser, 'root', 'root-session', { automationActive: () => active })
  const child = new AgentPage(browser, 'child', 'child-session', { rootPage: root, frameId: 'child' })
  await root.syncFocusEmulation()
  child.observation = { id: 'obs', epoch: 0, revision: 0 }
  child.evaluate = async fn => fn.name === 'preparePrivateTarget' ? { origin: 'http://localhost' } : 0
  child.observe = async () => ({ pageId: 'child' })
  await child.act('obs', [{ type: 'press', key: 'Escape' }])
  await child.preparePrivateInput('obs', 'e1', 'http://localhost')
  assert.deepEqual(focus, [{ enabled: true, sessionId: 'root-session' }])
  active = false
  await child.syncFocusEmulation()
  assert.deepEqual(focus.at(-1), { enabled: false, sessionId: 'root-session' })
  child.dispose(); root.dispose()
})

test('pause wins an in-flight focus enable and an obsolete action cannot re-enable it', async () => {
  const browser = new EventEmitter(), focus = []
  let active = true, release, entered
  const started = new Promise(resolve => { entered = resolve })
  const gate = new Promise(resolve => { release = resolve })
  browser.send = async (method, params) => {
    if (method !== 'Emulation.setFocusEmulationEnabled') return {}
    focus.push(params.enabled)
    if (params.enabled) { entered(); await gate }
    return {}
  }
  const page = new AgentPage(browser, 'page', 'session', { automationActive: () => active })
  const enabling = page.syncFocusEmulation()
  await started; active = false
  const paused = page.syncFocusEmulation()
  release(); await Promise.all([enabling, paused])
  await page.syncFocusEmulation(true)
  assert.deepEqual(focus, [true, false])
  page.dispose()
})

test('disposed page cannot reacquire rendering after a pending focus acknowledgement', async () => {
  const browser = new EventEmitter(), focus = []
  let release, entered
  const started = new Promise(resolve => { entered = resolve })
  browser.send = async (method, params) => {
    if (method !== 'Emulation.setFocusEmulationEnabled') return {}
    focus.push(params.enabled)
    if (params.enabled) { entered(); await new Promise(resolve => { release = resolve }) }
    return {}
  }
  const page = new AgentPage(browser, 'page', 'session', { automationActive: () => true })
  const enabling = page.syncFocusEmulation()
  await started; page.dispose(); release(); await enabling
  await page.syncFocusEmulation(true)
  assert.deepEqual(focus, [true, false])
})

test('private preparation failure and dialog cleanup preserve an active rendering baseline', async () => {
  const browser = new EventEmitter(), focus = []
  browser.send = async (method, params) => { if (method === 'Emulation.setFocusEmulationEnabled') focus.push(params.enabled); return {} }
  const page = new AgentPage(browser, 'page', 'session', { automationActive: () => true })
  await page.syncFocusEmulation()
  page.observation = { id: 'obs', epoch: 0, revision: 0 }
  page.evaluate = async () => { throw new Error('Target changed') }
  await assert.rejects(page.preparePrivateInput('obs', 'e1', 'http://localhost'), /Target changed/)
  page.dialog = { type: 'alert' }; page.observe = async () => ({ pageId: 'page' })
  await page.handleDialog(true)
  assert.deepEqual(focus, [true])
  page.dispose()
})

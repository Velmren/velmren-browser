import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import vm from 'node:vm'
import { AgentPage } from '../page.mjs'

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
  let releaseClick
  browser.send = async (method, params) => {
    calls.push({ method, params })
    if (method === 'Input.dispatchMouseEvent' && params.type === 'mouseReleased') {
      const pending = new Promise(resolve => { releaseClick = resolve })
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
  assert.equal(evaluation, 2, 'Observing a dialog must not issue a blocked DOM evaluation')
  const answered = await page.handleDialog(true, 'accepted')
  assert.equal(answered.text, 'Dialog result: accepted')
  assert.equal(page.dialog, null)
  assert.deepEqual(calls.find(call => call.method === 'Page.handleJavaScriptDialog').params, { accept: true, promptText: 'accepted' })
  assert.equal(calls.filter(call => call.method === 'Input.dispatchMouseEvent').length, 2)
  page.dispose()
})

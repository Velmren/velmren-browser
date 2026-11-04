import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { AgentBroker } from '../broker.mjs'
import { validateArguments } from '../client.mjs'
import { effectivePolicyIdentity, normalizeEffectivePolicy } from '../policy-identity.mjs'

const deferred = () => { let resolve, reject; const promise = new Promise((done, fail) => { resolve = done; reject = fail }); return { promise, resolve, reject } }

function fixture(policy = {}, { rootType = 'page' } = {}) {
  const browser = new EventEmitter(), infos = new Map(), contexts = new Set(), calls = []
  browser.version = { product: 'fake' }; browser.closed = false
  browser.send = async (method, params = {}, sessionId) => {
    calls.push({ method, params, sessionId })
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: `frame-${sessionId}`, url: 'about:blank' } } }
    if (method === 'Target.closeTarget') { infos.delete(params.targetId); browser.emit('protocol', { method: 'Target.targetDestroyed', params: { targetId: params.targetId } }); return { success: true } }
    if (method === 'Target.getTargets') return { targetInfos: [...infos.values()] }
    if (method === 'Target.createBrowserContext') { contexts.add('created-context'); return { browserContextId: 'created-context' } }
    if (method === 'Target.getBrowserContexts') return { browserContextIds: [...contexts] }
    if (method === 'Target.disposeBrowserContext') {
      contexts.delete(params.browserContextId)
      for (const [id, info] of infos) if (info.browserContextId === params.browserContextId) infos.delete(id)
      return {}
    }
    if (method === 'Target.createTarget') {
      const targetInfo = { targetId: 'created-root', type: rootType, browserContextId: params.browserContextId, url: 'about:blank' }
      infos.set(targetInfo.targetId, targetInfo)
      browser.emit('protocol', { method: 'Target.attachedToTarget', params: { sessionId: 'created-session', targetInfo, waitingForDebugger: true } })
      return { targetId: targetInfo.targetId }
    }
    if (method === 'Page.navigate') {
      browser.emit('protocol', { sessionId, method: 'Page.frameNavigated', params: { frame: { id: `frame-${sessionId}`, url: params.url } } })
      browser.emit('protocol', { sessionId, method: 'Page.loadEventFired', params: {} })
      return { loaderId: 'loader' }
    }
    if (method === 'Page.createIsolatedWorld') return { executionContextId: 1 }
    if (method === 'Runtime.evaluate') return { result: { value: { url: 'http://localhost/', title: 'Fake page', text: 'ready', elements: [], revision: 0 } } }
    return {}
  }
  browser.close = async () => { browser.closed = true }
  const broker = new AgentBroker(browser, 'unused', policy, { trace: null })
  const addTask = (id, owner = id) => {
    const task = { taskId: id, owner, state: 'agent-active', contextId: `context-${id}`, pages: new Map(), queue: Promise.resolve(), downloads: [], blockedOrigins: [] }
    broker.tasks.set(id, task); broker.contexts.set(task.contextId, task); contexts.add(task.contextId)
    return task
  }
  const attach = async (task, id, openerId, type = 'page', parentSession) => {
    const targetInfo = { targetId: id, type, browserContextId: task.contextId, url: 'about:blank', openerId }
    infos.set(id, targetInfo)
    await broker.onProtocol({ sessionId: parentSession, method: 'Target.attachedToTarget', params: { sessionId: `session-${id}`, targetInfo, waitingForDebugger: true } })
    return task.pages.get(id)
  }
  return { browser, broker, calls, infos, addTask, attach }
}

test('browser autoattach pauses targets before any page executes', async () => {
  const f = fixture({ webCompatibility: true })
  await f.broker.init()
  assert.equal(f.calls[1].method, 'Target.setAutoAttach')
  assert.equal(f.calls[1].params.waitForDebuggerOnStart, true)
  const task = f.addTask('one')
  await f.attach(task, 'main')
  await f.attach(task, 'popup', 'main')
  const calls = f.calls.filter(call => call.sessionId === 'session-popup')
  assert.ok(calls.findIndex(call => call.method === 'Fetch.enable') < calls.findIndex(call => call.method === 'Runtime.runIfWaitingForDebugger'))
  assert.ok(calls.findIndex(call => call.method === 'Target.setAutoAttach') < calls.findIndex(call => call.method === 'Runtime.runIfWaitingForDebugger'))
  assert.equal(task.selectedPageId, 'popup')
})

test('queued manual Show remains bound to its requested page when a popup becomes selected', async () => {
  const f = fixture({ webCompatibility: true }), task = f.addTask('one'), gate = deferred()
  const main = await f.attach(task, 'main')
  task.queue = gate.promise
  const showing = f.broker.rpc('one', 'task_request_human', { taskId: 'one', pageId: 'main', reason: 'Sign in', showWindow: true })
  await f.attach(task, 'popup', 'main')
  assert.equal(task.selectedPageId, 'popup')
  gate.resolve()
  const result = await showing
  assert.equal(result.handoff.pageId, 'main'); assert.equal(result.handoff.shown, true)
  assert.equal(result.selectedPageId, 'main')
  assert.deepEqual(f.calls.filter(x => x.method === 'Target.setTargetVisibility' && x.params.visible).map(x => x.params.targetId), ['main'])
  assert.equal(main.interceptFileChooser, false)
  assert.equal(task.pages.get('popup').interceptFileChooser, true)
  await f.broker.close()
})

test('queued manual Show rejects a replaced page session before making it visible', async () => {
  const f = fixture({ webCompatibility: true }), task = f.addTask('one'), gate = deferred()
  const main = await f.attach(task, 'main')
  task.queue = gate.promise
  const showing = f.broker.rpc('one', 'task_request_human', { taskId: 'one', pageId: 'main', reason: 'Sign in', showWindow: true })
  const rejected = assert.rejects(showing, /Page session changed/)
  main.sessionId = 'replaced-session'
  gate.resolve(); await rejected
  assert.equal(task.handoff.shown, false)
  assert.equal(f.calls.filter(x => x.method === 'Target.setTargetVisibility' && x.params.visible).length, 0)
  await f.broker.close()
})

test('file picker handoff affects only the shown page and its frames; hidden siblings and their popups stay intercepted', async () => {
  const f = fixture({ webCompatibility: true }), task = f.addTask('one')
  const main = await f.attach(task, 'main')
  const hidden = await f.attach(task, 'hidden', 'main')
  await f.attach(task, 'main-frame', undefined, 'iframe', 'session-main')
  await f.attach(task, 'hidden-frame', undefined, 'iframe', 'session-hidden')
  const frameSetup = f.calls.filter(call => call.sessionId === 'session-hidden-frame')
  assert.ok(frameSetup.findIndex(call => call.method === 'Page.setInterceptFileChooserDialog' && call.params.enabled) < frameSetup.findIndex(call => call.method === 'Runtime.runIfWaitingForDebugger'))
  await f.broker.rpc('one', 'task_request_human', { taskId: 'one', reason: 'Complete the manual step' })
  assert.equal(main.interceptFileChooser, true); assert.equal(hidden.interceptFileChooser, true)
  f.broker.select(task, main)
  await f.broker.rpc('admin', 'task_control', { taskId: 'one', action: 'show' })
  assert.equal(main.interceptFileChooser, false); assert.equal(hidden.interceptFileChooser, true)
  assert.ok(f.calls.some(call => call.sessionId === 'session-main-frame' && call.method === 'Page.setInterceptFileChooserDialog' && !call.params.enabled))
  assert.ok(!f.calls.some(call => call.sessionId === 'session-hidden-frame' && call.method === 'Page.setInterceptFileChooserDialog' && !call.params.enabled))
  const humanPopup = await f.attach(task, 'human-popup', 'main')
  const hiddenPopup = await f.attach(task, 'hidden-popup', 'hidden')
  const unknownPopup = await f.attach(task, 'unknown-popup')
  assert.equal(humanPopup.interceptFileChooser, false)
  assert.equal(hiddenPopup.interceptFileChooser, true); assert.equal(unknownPopup.interceptFileChooser, true)
  await f.broker.rpc('admin', 'task_control', { taskId: 'one', action: 'pause' })
  assert.equal(main.interceptFileChooser, false, 'Pause preserves manual access on the visible page')
  await f.broker.rpc('admin', 'task_control', { taskId: 'one', action: 'resume' })
  assert.ok([...task.pages.values()].every(page => page.interceptFileChooser))
  await f.broker.onProtocol({ sessionId: 'session-main-frame', method: 'Page.fileChooserOpened', params: { frameId: 'child', backendNodeId: 17, mode: 'selectSingle' } })
  assert.equal(main.chooser, null, 'A child-frame chooser cannot become the main-frame chooser')
  assert.equal(hidden.chooser, null)
  await f.broker.close()
})

test('root attachment arriving before createTarget response is adopted once', async () => {
  const f = fixture({ webCompatibility: true })
  const root = fileURLToPath(new URL('../test-results/', import.meta.url))
  await mkdir(root, { recursive: true })
  f.broker.stateDir = await mkdtemp(`${root}root-race-`)
  const result = await f.broker.rpc('client', 'task_create', { url: 'http://localhost/' })
  assert.equal(result.pages.length, 1)
  assert.equal(result.observation.pageId, 'created-root')
  assert.equal(f.calls.filter(call => call.method === 'Target.attachToTarget').length, 0)
  assert.equal(f.calls.filter(call => call.method === 'Runtime.runIfWaitingForDebugger').length, 1)
  await f.broker.rpc('client', 'task_finish', { taskId: result.taskId })
})

test('native hidden root type other remains paused until createTarget confirms its exact ID', async () => {
  const f = fixture({ webCompatibility: true }, { rootType: 'other' }), announced = deferred(), release = deferred(), send = f.browser.send
  const root = fileURLToPath(new URL('../test-results/', import.meta.url))
  await mkdir(root, { recursive: true }); f.broker.stateDir = await mkdtemp(`${root}hidden-root-`)
  f.browser.send = async (method, params, sessionId) => {
    if (method !== 'Target.createTarget') return send(method, params, sessionId)
    const result = await send(method, params, sessionId)
    announced.resolve(); await release.promise
    return result
  }
  const creating = f.broker.rpc('client', 'task_create', { url: 'http://localhost/' })
  await announced.promise
  assert.equal(f.calls.filter(call => ['Target.closeTarget', 'Runtime.runIfWaitingForDebugger', 'Target.attachToTarget'].includes(call.method)).length, 0)
  release.resolve()
  const result = await creating
  assert.equal(result.observation.pageId, 'created-root'); assert.equal(result.pages.length, 1)
  assert.equal(f.broker.targets.get('created-root').type, 'page')
  assert.equal(f.calls.filter(call => call.method === 'Target.attachToTarget').length, 0)
  assert.equal(f.calls.filter(call => call.method === 'Runtime.runIfWaitingForDebugger').length, 1)
  await f.broker.rpc('client', 'task_finish', { taskId: result.taskId })
})

test('an unrelated type other target during root creation is never adopted or resumed', async () => {
  const f = fixture({}, { rootType: 'other' }), send = f.browser.send
  const root = fileURLToPath(new URL('../test-results/', import.meta.url))
  await mkdir(root, { recursive: true }); f.broker.stateDir = await mkdtemp(`${root}hidden-root-`)
  f.browser.send = async (method, params, sessionId) => {
    if (method === 'Target.createTarget') {
      const targetInfo = { targetId: 'unrelated', type: 'other', browserContextId: params.browserContextId }
      f.infos.set('unrelated', targetInfo)
      await f.broker.onProtocol({ method: 'Target.attachedToTarget', params: { sessionId: 'unrelated-session', targetInfo } })
    }
    return send(method, params, sessionId)
  }
  const result = await f.broker.rpc('client', 'task_create', { url: 'http://localhost/' })
  assert.deepEqual(result.pages.map(page => page.pageId), ['created-root'])
  assert.equal(f.infos.has('unrelated'), false)
  assert.ok(!f.calls.some(call => call.sessionId === 'unrelated-session' && call.method === 'Runtime.runIfWaitingForDebugger'))
  await f.broker.rpc('client', 'task_finish', { taskId: result.taskId })
})

test('failed root creation closes provisional native WebContents before disposing the context', async () => {
  const f = fixture({}, { rootType: 'other' }), send = f.browser.send
  const root = fileURLToPath(new URL('../test-results/', import.meta.url))
  await mkdir(root, { recursive: true }); f.broker.stateDir = await mkdtemp(`${root}hidden-root-`)
  f.browser.send = async (method, params, sessionId) => {
    const result = await send(method, params, sessionId)
    if (method === 'Target.createTarget') throw new Error('Create response interrupted')
    return result
  }
  await assert.rejects(f.broker.rpc('client', 'task_create', { url: 'http://localhost/' }), /Create response interrupted/)
  const close = f.calls.findIndex(call => call.method === 'Target.closeTarget' && call.params.targetId === 'created-root')
  assert.ok(close >= 0 && close < f.calls.findIndex(call => call.method === 'Target.disposeBrowserContext'))
  assert.equal(f.infos.size, 0)
})

test('native hidden popups require a same-context known opener target or native opener frame token', async () => {
  const f = fixture({ webCompatibility: true }), task = f.addTask('one'), peer = f.addTask('two')
  const main = await f.attach(task, 'main'); await f.attach(peer, 'peer')
  await f.attach(task, 'popup', 'main', 'other')
  assert.equal(task.pages.get('popup').openerId, 'main')
  await f.attach(task, 'noopener', main.frameId, 'other')
  assert.equal(task.pages.get('noopener').openerId, 'main')
  assert.equal(task.selectedPageId, 'noopener')
  await f.attach(task, 'unknown', undefined, 'other')
  await f.attach(task, 'foreign-opener', 'peer', 'other')
  assert.equal(task.pages.has('unknown'), false); assert.equal(task.pages.has('foreign-opener'), false)
  assert.equal(peer.pages.size, 1)
  await f.broker.rpc('one', 'task_close_page', { taskId: 'one', pageId: 'noopener' })
  assert.equal(task.selectedPageId, 'main'); assert.equal(task.state, 'agent-active')
})

test('cleanup waits for adopted native other popups even after removing their page wrappers', async () => {
  const f = fixture({ webCompatibility: true }), task = f.addTask('one')
  await f.attach(task, 'main'); await f.attach(task, 'popup', 'main', 'other')
  const send = f.browser.send
  let popupCloses = 0
  f.browser.send = async (method, params, sessionId) => {
    if (method === 'Target.closeTarget' && params.targetId === 'popup' && ++popupCloses === 1) return { success: true }
    return send(method, params, sessionId)
  }
  await f.broker.rpc('one', 'task_finish', { taskId: 'one' })
  assert.equal(popupCloses, 2)
  assert.equal(task.contextId, null)
  assert.equal(f.infos.size, 0)
})

test('cleanup tolerates a target disappearing after enumeration but before a repeated close', async () => {
  const f = fixture({ webCompatibility: true }), task = f.addTask('one')
  await f.attach(task, 'main')
  const send = f.browser.send
  let closes = 0
  f.browser.send = async (method, params, sessionId) => {
    if (method === 'Target.closeTarget') {
      if (++closes === 1) return { success: true }
      f.infos.delete(params.targetId)
      throw new Error('No target with given id found')
    }
    return send(method, params, sessionId)
  }
  await f.broker.rpc('one', 'task_finish', { taskId: 'one' })
  assert.equal(closes, 2)
  assert.equal(task.contextId, null)
  assert.equal(task.cleanupError, null)
})

test('nested and noopener pages stay in their context; closing a popup selects its opener', async () => {
  const f = fixture({ webCompatibility: true })
  const one = f.addTask('one'), two = f.addTask('two')
  await f.attach(one, 'one-main'); await f.attach(two, 'two-main')
  await f.attach(one, 'popup', 'one-main')
  await f.attach(one, 'nested', 'popup')
  await f.attach(one, 'noopener')
  assert.equal(one.selectedPageId, 'noopener')
  assert.equal(one.pages.get('noopener').openerId, 'nested')
  for (const method of ['task_select_page', 'task_close_page', 'task_observe']) {
    await assert.rejects(f.broker.rpc('one', method, { taskId: 'one', pageId: 'two-main' }), /Page not found/)
  }
  assert.equal(two.pages.size, 1)
  await f.broker.rpc('one', 'task_close_page', { taskId: 'one', pageId: 'noopener' })
  assert.equal(one.selectedPageId, 'nested')
  await f.broker.rpc('one', 'task_close_page', { taskId: 'one', pageId: 'nested' })
  assert.equal(one.selectedPageId, 'popup')
  assert.equal(one.state, 'agent-active')
  await f.broker.rpc('one', 'task_finish', { taskId: 'one' })
  const disposeIndex = f.calls.findIndex(call => call.method === 'Target.disposeBrowserContext')
  assert.ok(f.calls.filter(call => call.method === 'Target.closeTarget' && ['popup', 'one-main'].includes(call.params.targetId)).every(call => f.calls.indexOf(call) < disposeIndex))
  assert.equal(one.pages.size, 0)
  assert.equal(two.pages.size, 1)
})

test('unexpected context/session combinations fail closed without altering either task', async () => {
  const f = fixture({ webCompatibility: true }), one = f.addTask('one'), two = f.addTask('two')
  await f.attach(one, 'main')
  await f.broker.onProtocol({ sessionId: 'session-main', method: 'Target.attachedToTarget', params: { sessionId: 'wrong', targetInfo: { targetId: 'foreign', type: 'page', browserContextId: two.contextId } } })
  assert.equal(f.calls.at(-1).method, 'Target.closeTarget')
  assert.equal(one.state, 'agent-active'); assert.equal(two.state, 'agent-active')
  assert.equal(one.pages.size, 1); assert.equal(two.pages.size, 0)
})

test('duplicate nested autoattach sessions are detached through their owning parent', async () => {
  const f = fixture({ webCompatibility: true }), task = f.addTask('one')
  await f.attach(task, 'main'); await f.attach(task, 'worker', undefined, 'worker', 'session-main')
  const send = f.browser.send
  f.browser.send = async (method, params, sessionId) => {
    if (method === 'Target.detachFromTarget') assert.equal(sessionId, 'session-main', 'Nested session IDs belong to the parent Target handler')
    return send(method, params, sessionId)
  }
  await f.broker.onProtocol({ sessionId: 'session-main', method: 'Target.attachedToTarget', params: { sessionId: 'nested-duplicate', waitingForDebugger: true, targetInfo: { targetId: 'worker', browserContextId: task.contextId, type: 'worker' } } })
  assert.deepEqual(f.calls.at(-1), { method: 'Target.detachFromTarget', params: { sessionId: 'nested-duplicate' }, sessionId: 'session-main' })
  assert.equal(f.broker.targets.get('worker').sessionId, 'session-worker')
  assert.equal(task.state, 'agent-active')
})

test('a duplicate detach failure closes its context instead of silently leaving a paused worker', async () => {
  const f = fixture({ webCompatibility: true }), task = f.addTask('one'), peer = f.addTask('two')
  await f.attach(task, 'main'); await f.attach(task, 'worker', undefined, 'worker', 'session-main'); await f.attach(peer, 'peer')
  const send = f.browser.send, contextId = task.contextId
  f.browser.send = async (method, params, sessionId) => {
    if (method === 'Target.detachFromTarget') throw new Error('Cannot detach nested session')
    return send(method, params, sessionId)
  }
  await assert.rejects(f.broker.onProtocol({ sessionId: 'session-main', method: 'Target.attachedToTarget', params: { sessionId: 'duplicate', waitingForDebugger: true, targetInfo: { targetId: 'worker', browserContextId: contextId, type: 'worker' } } }), /Cannot detach/)
  assert.equal(task.state, 'cancelled'); assert.equal(task.contextId, null)
  assert.ok(![...f.infos.values()].some(info => info.browserContextId === contextId))
  assert.equal(peer.state, 'agent-active'); assert.equal(peer.pages.size, 1)
})

test('a canonical detach racing failed duplicate detach cannot leave the live target paused', async () => {
  const f = fixture({ webCompatibility: true }), task = f.addTask('one')
  await f.attach(task, 'main'); await f.attach(task, 'worker', undefined, 'worker', 'session-main')
  const send = f.browser.send, contextId = task.contextId
  f.browser.send = async (method, params, sessionId) => {
    if (method === 'Target.detachFromTarget') {
      await f.broker.onProtocol({ method: 'Target.detachedFromTarget', params: { sessionId: 'session-worker' } })
      throw new Error('Duplicate detach failed after canonical detach')
    }
    return send(method, params, sessionId)
  }
  await assert.rejects(f.broker.onProtocol({ sessionId: 'session-main', method: 'Target.attachedToTarget', params: { sessionId: 'duplicate', waitingForDebugger: true, targetInfo: { targetId: 'worker', browserContextId: contextId, type: 'worker' } } }), /Duplicate detach failed/)
  assert.equal(task.state, 'cancelled'); assert.equal(task.contextId, null)
  assert.equal(f.infos.size, 0)
})

test('canonical page detach permits replacement while preserving page identity, opener, and selection', async () => {
  const f = fixture({ webCompatibility: true }), task = f.addTask('one')
  await f.attach(task, 'main')
  const oldPage = await f.attach(task, 'popup', 'main')
  await f.broker.onProtocol({ method: 'Target.detachedFromTarget', params: { sessionId: 'session-popup' } })
  assert.equal(task.state, 'agent-active'); assert.equal(task.selectedPageId, 'popup')
  assert.equal(f.broker.targets.has('popup'), false); assert.equal(f.broker.sessionTask('session-popup'), undefined)
  assert.equal(f.broker.pageRecords(task).find(page => page.pageId === 'popup').attached, false)
  await assert.rejects(f.broker.rpc('one', 'task_observe', { taskId: 'one' }), { code: 'PAGE_DETACHED' })
  await f.broker.onProtocol({ method: 'Target.attachedToTarget', params: { sessionId: 'replacement', targetInfo: { targetId: 'popup', type: 'page', browserContextId: task.contextId, url: 'http://localhost/' } } })
  assert.notEqual(task.pages.get('popup'), oldPage)
  assert.equal(task.pages.get('popup').openerId, 'main'); assert.equal(task.selectedPageId, 'popup')
  assert.equal((await f.broker.rpc('one', 'task_observe', { taskId: 'one' })).pageId, 'popup')
  await f.broker.onProtocol({ method: 'Target.detachedFromTarget', params: { sessionId: 'session-popup' } })
  assert.equal(f.broker.targets.get('popup').sessionId, 'replacement')
  await f.broker.onProtocol({ method: 'Target.targetDestroyed', params: { targetId: 'popup' } })
  await f.broker.onProtocol({ method: 'Target.detachedFromTarget', params: { sessionId: 'replacement' } })
  assert.equal(task.selectedPageId, 'main'); assert.equal(task.state, 'agent-active')
})

test('detaching a parent invalidates its nested sessions and destroying the last detached page disposes once', async () => {
  const f = fixture({ webCompatibility: true }), task = f.addTask('one')
  await f.attach(task, 'main'); await f.attach(task, 'worker', undefined, 'worker', 'session-main')
  await f.broker.onProtocol({ method: 'Target.detachedFromTarget', params: { sessionId: 'session-main' } })
  assert.equal(f.broker.sessions.size, 0); assert.equal(f.broker.targets.size, 0)
  assert.equal(task.state, 'agent-active')
  f.infos.delete('main')
  await f.broker.onProtocol({ method: 'Target.targetDestroyed', params: { targetId: 'main' } })
  await f.broker.onProtocol({ method: 'Target.detachedFromTarget', params: { sessionId: 'session-main' } })
  assert.equal(task.state, 'cancelled'); assert.equal(task.contextId, null)
  assert.equal(f.calls.filter(call => call.method === 'Target.disposeBrowserContext').length, 1)
})

test('late setup failure from a detached session cannot cancel its replacement', async () => {
  const f = fixture(), task = f.addTask('one'), gate = deferred(), send = f.browser.send
  f.browser.send = (method, params, sessionId) => method === 'Network.setBypassServiceWorker' && sessionId === 'session-main' ? gate.promise : send(method, params, sessionId)
  const attaching = f.attach(task, 'main')
  await f.broker.onProtocol({ method: 'Target.detachedFromTarget', params: { sessionId: 'session-main' } })
  await f.broker.onProtocol({ method: 'Target.attachedToTarget', params: { sessionId: 'replacement', targetInfo: { targetId: 'main', type: 'page', browserContextId: task.contextId } } })
  gate.reject(new Error('Old session gone')); await attaching
  assert.equal(task.state, 'agent-active')
  assert.equal(f.broker.targets.get('main').sessionId, 'replacement')
  assert.equal(task.pages.get('main').sessionId, 'replacement')
  assert.ok(!f.calls.some(call => call.sessionId === 'session-main' && call.method === 'Runtime.runIfWaitingForDebugger'))
})

test('compatibility preserves site CSP and permits workers without widening HTTP origins', async () => {
  const f = fixture({ webCompatibility: true, webSocketPolicy: 'csp-secure-upgrades', allowWeb: true, allowedOrigins: ['https://example.test'] }), task = f.addTask('one')
  await f.attach(task, 'main')
  await f.attach(task, 'worker', 'main', 'worker', 'session-main')
  assert.ok(f.calls.some(call => call.sessionId === 'session-worker' && call.method === 'Runtime.runIfWaitingForDebugger'))
  assert.equal(f.broker.allowed('https://example.test/form'), true)
  assert.equal(f.broker.allowed('https://other.test/form'), false)
  await f.broker.onProtocol({ sessionId: 'session-main', method: 'Fetch.requestPaused', params: { requestId: 'r', responseStatusCode: 200, responseHeaders: [{ name: 'Content-Security-Policy', value: "script-src 'self'" }] } })
  const headers = f.calls.at(-1).params.responseHeaders
  assert.equal(headers[0].value, "script-src 'self'")
  assert.doesNotMatch(headers[1].value, /sandbox|worker-src 'none'/)
  assert.equal(f.calls.find(call => call.method === 'Network.setBypassServiceWorker').params.bypass, false)
  assert.match(headers[1].value, /connect-src https:\/\/example\.test wss:\/\/example\.test;/)
  assert.ok(!f.calls.some(call => call.sessionId === 'session-worker' && ['Fetch.enable', 'Network.setBypassServiceWorker'].includes(call.method)))
  const frameFetch = f.calls.find(call => call.sessionId === 'session-main' && call.method === 'Fetch.enable')
  for (const resourceType of ['Script', 'Other']) assert.ok(frameFetch.params.patterns.some(pattern => pattern.resourceType === resourceType && pattern.requestStage === 'Response'))
  await f.broker.onProtocol({ sessionId: 'session-main', method: 'Fetch.requestPaused', params: { requestId: 'worker-script', resourceType: 'Other', responseStatusCode: 200, responseHeaders: [{ name: 'Content-Security-Policy', value: "default-src 'self'" }] } })
  assert.equal(f.calls.at(-1).params.responseHeaders[0].value, "default-src 'self'")
  assert.match(f.calls.at(-1).params.responseHeaders[1].value, /connect-src https:\/\/example\.test wss:\/\/example\.test;/)
})

test('WebSocket CSP requires explicit secure-upgrade opt-in while HTTP origins remain exact', () => {
  const restricted = fixture({ webCompatibility: true, webSocketPolicy: 'csp-secure-upgrades', allowedOrigins: ['http://localhost:8123', 'https://chat.test:8443'] }).broker.contentPolicy()
  assert.match(restricted, /connect-src http:\/\/localhost:8123 https:\/\/chat\.test:8443 ws:\/\/localhost:8123 wss:\/\/chat\.test:8443;/)
  assert.doesNotMatch(restricted, /wss:\/\/localhost|ws:\/\/chat|connect-src .*\*/)
  const unrestricted = fixture({ webCompatibility: true, webSocketPolicy: 'csp-secure-upgrades', allowWeb: true }).broker.contentPolicy()
  assert.match(unrestricted, /connect-src http: https: ws: wss:;/)
  for (const policy of [{}, { webCompatibility: true }, { webCompatibility: true, allowWeb: true }, { webCompatibility: true, allowedOrigins: ['http://chat.test'] }]) assert.doesNotMatch(fixture(policy).broker.contentPolicy(), /wss?:/)
  assert.match(fixture({ webCompatibility: true, allowedOrigins: [] }).broker.contentPolicy(), /connect-src 'none';/)
  assert.equal(normalizeEffectivePolicy({}).webSocketPolicy, 'disabled')
  assert.equal(effectivePolicyIdentity({ webCompatibility: true }), effectivePolicyIdentity({ webCompatibility: true, webSocketPolicy: 'disabled' }))
  assert.notEqual(effectivePolicyIdentity({ webCompatibility: true }), effectivePolicyIdentity({ webCompatibility: true, webSocketPolicy: 'csp-secure-upgrades' }))
  for (const webSocketPolicy of [null, false, 'exact', 'enabled']) assert.throws(() => fixture({ webCompatibility: true, webSocketPolicy }), /webSocketPolicy/)
  assert.throws(() => fixture({ webSocketPolicy: 'csp-secure-upgrades' }), /webCompatibility/)
  const explicit = fixture({ webCompatibility: true, webSocketPolicy: 'csp-secure-upgrades', allowedOrigins: ['http://chat.test'] }).broker
  assert.equal(explicit.allowed('http://chat.test/path'), true)
  assert.equal(explicit.allowed('https://chat.test/path'), false)
})

test('disabled WebSocket mode applies to both document and worker script response CSP', async () => {
  const f = fixture({ webCompatibility: true, allowWeb: true }), task = f.addTask('one')
  await f.attach(task, 'main'); await f.attach(task, 'worker', 'main', 'worker', 'session-main')
  for (const [sessionId, resourceType] of [['session-main', 'Document'], ['session-main', 'Other']]) {
    await f.broker.onProtocol({ sessionId, method: 'Fetch.requestPaused', params: { requestId: resourceType, resourceType, responseStatusCode: 200, responseHeaders: [] } })
    assert.match(f.calls.at(-1).params.responseHeaders[0].value, /connect-src http: https:;/)
    assert.doesNotMatch(f.calls.at(-1).params.responseHeaders[0].value, /wss?:/)
  }
})

test('dedicated workers require a verified ancestor frame and nested workers retain that owner', async () => {
  const f = fixture({ webCompatibility: true }), task = f.addTask('one')
  await f.attach(task, 'main')
  await f.attach(task, 'worker', undefined, 'worker', 'session-main')
  await f.attach(task, 'nested', undefined, 'worker', 'session-worker')
  assert.equal(f.broker.targets.get('nested').networkOwnerSessionId, 'session-main')
  assert.ok(f.calls.some(call => call.sessionId === 'session-nested' && call.method === 'Runtime.runIfWaitingForDebugger'))
  const unowned = f.addTask('unowned')
  await assert.rejects(f.attach(unowned, 'orphan', undefined, 'worker'), /no verified frame network policy/)
  assert.equal(unowned.state, 'cancelled')
  assert.ok(!f.calls.some(call => call.sessionId === 'session-orphan' && call.method === 'Runtime.runIfWaitingForDebugger'))
  assert.equal(task.state, 'agent-active')
})

test('shared and service workers keep their own Fetch interceptors before execution', async () => {
  const f = fixture({ webCompatibility: true }), task = f.addTask('one')
  await f.attach(task, 'main')
  for (const type of ['shared_worker', 'service_worker']) {
    await f.attach(task, type, undefined, type)
    const calls = f.calls.filter(call => call.sessionId === `session-${type}`)
    const enable = calls.findIndex(call => call.method === 'Fetch.enable')
    assert.ok(enable >= 0 && enable < calls.findIndex(call => call.method === 'Runtime.runIfWaitingForDebugger'))
    assert.ok(calls[enable].params.patterns.some(pattern => pattern.resourceType === 'Other' && pattern.requestStage === 'Response'))
  }
})

test('five waiting tasks hold no action slots and a different task can act', async () => {
  const f = fixture({ maxActiveActions: 1 }), gates = [], entered = deferred()
  let count = 0
  for (let index = 0; index < 6; index++) {
    const task = f.addTask(`task-${index}`), page = await f.attach(task, `page-${index}`)
    const gate = deferred(); gates.push(gate)
    page.wait = async () => { if (++count === 5) entered.resolve(); await gate.promise; return { matched: true } }
    page.act = async () => ({ completed: 1, observation: { pageId: page.pageId } })
  }
  const waits = Array.from({ length: 5 }, (_, index) => f.broker.rpc(`task-${index}`, 'task_wait', { taskId: `task-${index}`, text: 'ready' }))
  await entered.promise
  assert.equal(f.broker.slots.active, 0)
  const acted = await f.broker.rpc('task-5', 'task_act', { taskId: 'task-5', observationId: 'o', actions: [{ type: 'click', ref: 'e1' }] })
  assert.equal(acted.completed, 1)
  gates.forEach(gate => gate.resolve())
  assert.equal((await Promise.all(waits)).length, 5)
})

for (const method of ['task_act', 'task_wait']) {
  test(`${method} uses the exact task, page, client, and control generation throughout the request`, async t => {
    const f = fixture(), client = await f.broker.rpc('admin', 'client_register', { label: 'Guard test' })
    t.after(() => f.broker.close())
    const task = f.addTask('guarded', client.clientId), page = await f.attach(task, 'main')
    const entered = deferred(), release = deferred()
    let active, received
    const run = async (args, guard) => { received = args; active = guard; entered.resolve(); await release.promise; return { observation: {} } }
    page.wait = run
    page.act = (observationId, actions, guard) => run({ observationId, actions }, guard)
    const args = { taskId: task.taskId, ...(method === 'task_wait' ? { predicate: { observationId: 'o', ref: 'e1', state: 'enabled' }, timeoutMs: 50 } : { observationId: 'o', actions: [{ type: 'click', ref: 'e1' }] }) }
    const pending = f.broker.rpc(client.clientId, method, args)
    await entered.promise
    if (method === 'task_wait') {
      assert.deepEqual(received.predicate, args.predicate)
      assert.equal(received.taskId, args.taskId)
      assert.ok(received.timeoutMs > 0 && received.timeoutMs <= args.timeoutMs)
      assert.equal(f.broker.slots.active, 0)
    }
    assert.equal(active(), true)
    task.controlGeneration = 1; assert.equal(active(), false); task.controlGeneration = undefined
    const originalSession = page.sessionId; page.sessionId = 'replacement'; assert.equal(active(), false); page.sessionId = originalSession
    task.pages.set(page.pageId, {}); assert.equal(active(), false); task.pages.set(page.pageId, page)
    const credential = f.broker.clients.get(client.clientId)
    credential.released = true; assert.equal(active(), false); credential.released = false
    f.broker.clients.set(client.clientId, { ...credential }); assert.equal(active(), false); f.broker.clients.set(client.clientId, credential)
    task.owner = 'another-owner'; assert.equal(active(), false); task.owner = client.clientId
    f.broker.tasks.set(task.taskId, { ...task }); assert.equal(active(), false); f.broker.tasks.set(task.taskId, task)
    assert.equal(active(), true)
    release.resolve(); await pending
  })
}

test('wait readiness shares the deadline, releases queued control, and leaves only the remaining condition budget', async t => {
  const f = fixture(), pages = []
  t.after(() => f.broker.close())
  for (const id of ['timeout', 'pause', 'cancel', 'condition']) {
    const task = f.addTask(id), page = await f.attach(task, `${id}-page`), ready = deferred()
    page.ready = ready.promise
    pages.push({ task, page, ready })
  }
  let clock = 0, conditionCalls = 0
  t.mock.method(performance, 'now', () => clock)
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  const advance = ms => { clock += ms; t.mock.timers.tick(ms) }
  const settle = () => new Promise(resolve => setImmediate(resolve))
  for (const { page } of pages) page.wait = async () => { conditionCalls++; return { matched: true } }

  const expired = f.broker.rpc('timeout', 'task_wait', { taskId: 'timeout', text: 'ready', timeoutMs: 20 })
  await settle(); advance(20)
  assert.deepEqual(await expired, { matched: false, elapsedMs: 20, lastObserved: { state: 'text' }, pageId: 'timeout-page' })
  assert.equal(conditionCalls, 0)
  pages[0].ready.resolve(); await settle()
  assert.equal(conditionCalls, 0, 'Late readiness must not start renderer work after timeout')

  for (const action of ['pause', 'cancel']) {
    const waiting = f.broker.rpc(action, 'task_wait', { taskId: action, text: 'ready', timeoutMs: 1000 })
    const rejected = assert.rejects(waiting, error => {
      assert.match(error.message, /wait stopped/)
      assert.deepEqual(error.waitResult, { matched: false, elapsedMs: 25, lastObserved: { state: 'text' }, pageId: `${action}-page` })
      return true
    })
    await settle()
    const controlling = f.broker.rpc('admin', 'task_control', { taskId: action, action })
    advance(25); await rejected; await controlling
    assert.equal(conditionCalls, 0)
  }

  const { page, ready } = pages[3], entered = deferred(), complete = deferred()
  let conditionTimeout
  page.wait = async args => { conditionCalls++; conditionTimeout = args.timeoutMs; entered.resolve(); return complete.promise }
  const waiting = f.broker.rpc('condition', 'task_wait', { taskId: 'condition', text: 'ready', timeoutMs: 100 })
  await settle(); advance(40); ready.resolve(); await entered.promise
  assert.equal(conditionTimeout, 60)
  advance(30); complete.resolve({ matched: true, elapsedMs: 30, lastObserved: { state: 'text', textMatches: true }, pageId: page.pageId })
  assert.deepEqual(await waiting, { matched: true, elapsedMs: 70, lastObserved: { state: 'text', textMatches: true }, pageId: page.pageId })
  assert.equal(conditionCalls, 1)
})

test('page methods and explicit dialog responses reject ambiguous input before dispatch', () => {
  assert.throws(() => validateArguments('task_select_page', { taskId: 't' }))
  assert.throws(() => validateArguments('task_handle_dialog', { taskId: 't', accept: 'yes' }))
  assert.throws(() => validateArguments('task_handle_dialog', { taskId: 't', accept: true, script: 'unsafe' }))
  assert.doesNotThrow(() => validateArguments('task_handle_dialog', { taskId: 't', pageId: 'p', accept: false, promptText: '' }))
  assert.doesNotThrow(() => validateArguments('task_act', { taskId: 't', pageId: 'p', observationId: 'o', actions: [{ type: 'handleDialog', accept: true, promptText: 'test' }] }))
})

test('managed leases enforce policy identity and release/expiry cancel only their owner', async t => {
  const f = fixture(), identity = effectivePolicyIdentity({})
  t.after(() => f.broker.close())
  await assert.rejects(f.broker.rpc('admin', 'client_register', { label: 'Wrong', policyIdentity: 'different', leaseMs: 30000 }), /policy/)
  const one = await f.broker.rpc('admin', 'client_register', { label: 'One', policyIdentity: identity, leaseMs: 30000 })
  const two = await f.broker.rpc('admin', 'client_register', { label: 'Two', policyIdentity: identity, leaseMs: 30000 })
  assert.notEqual(one.clientId, two.clientId); assert.notEqual(one.token, two.token)
  assert.equal(one.leaseMs, 30000)
  const first = f.addTask('first', one.clientId), second = f.addTask('second', two.clientId)
  await f.attach(first, 'first-page'); await f.attach(second, 'second-page')
  assert.equal((await f.broker.rpc(two.clientId, 'client_heartbeat')).leaseMs, 30000)
  await f.broker.rpc(one.clientId, 'client_release')
  assert.equal(first.state, 'cancelled'); assert.equal(second.state, 'agent-active')
  await assert.rejects(f.broker.rpc(one.clientId, 'task_list'), /released/)
  assert.deepEqual(await f.broker.rpc(one.clientId, 'client_release'), { released: true })
  const now = Date.now() + 30001
  await f.broker.expireClients(now)
  assert.equal(second.state, 'cancelled')
  let shutdowns = 0; f.broker.onShutdown = () => shutdowns++
  f.broker.checkIdle(now + 29999); assert.equal(shutdowns, 0)
  f.broker.checkIdle(now + 30000); assert.equal(shutdowns, 1)
})

for (const failingMethod of ['Target.closeTarget', 'Target.disposeBrowserContext']) {
  test(`released terminal tasks retry a transient ${failingMethod} failure without affecting peers`, async t => {
    const f = fixture(), identity = effectivePolicyIdentity({})
    t.after(() => f.broker.close())
    const owner = await f.broker.rpc('admin', 'client_register', { label: 'Release', policyIdentity: identity, leaseMs: 30000 })
    const task = f.addTask('one', owner.clientId), peer = f.addTask('two')
    await f.attach(task, 'main'); await f.attach(peer, 'peer')
    const send = f.browser.send
    let attempts = 0
    f.browser.send = async (method, params, sessionId) => {
      if (method === failingMethod && ++attempts === 1) throw new Error('Transient cleanup failure')
      return send(method, params, sessionId)
    }
    await assert.rejects(f.broker.rpc(owner.clientId, 'client_release'), /Transient cleanup failure/)
    assert.equal(task.state, 'cancelled'); assert.equal(task.ending, null)
    assert.ok(task.contextId); assert.equal(f.broker.record(task).cleanupPending, true)
    const due = task.cleanupRetryAt
    await f.broker.expireClients(due - 1); assert.equal(attempts, 1, 'Cleanup must respect its backoff')
    await f.broker.expireClients(due)
    assert.equal(attempts, 2); assert.equal(task.contextId, null); assert.equal(task.cleanupError, null)
    assert.equal(peer.state, 'agent-active'); assert.equal(peer.pages.size, 1)
    assert.equal(f.broker.idleSince, null)
    await f.broker.rpc('two', 'task_finish', { taskId: 'two' })
    let shutdowns = 0; f.broker.onShutdown = () => shutdowns++
    f.broker.checkIdle(due); f.broker.checkIdle(due + 30000)
    assert.equal(shutdowns, 1, 'A recovered cleanup must no longer prevent managed idle shutdown')
  })
}

test('persistent cleanup failures have a bounded retry budget and support explicit retry', async t => {
  const f = fixture(), task = f.addTask('one')
  t.after(() => f.broker.close())
  await f.attach(task, 'main')
  const send = f.browser.send
  let attempts = 0, failDisposal = true
  f.browser.send = async (method, params, sessionId) => {
    if (method === 'Target.disposeBrowserContext') { attempts++; if (failDisposal) throw new Error('Persistent cleanup failure') }
    return send(method, params, sessionId)
  }
  await assert.rejects(f.broker.rpc('one', 'task_cancel', { taskId: 'one' }), /Persistent/)
  for (let index = 0; index < 8; index++) await f.broker.retryCleanup(Number.POSITIVE_INFINITY)
  assert.equal(attempts, 5); assert.equal(task.ending, null); assert.equal(task.cleanupRetryAt, null)
  assert.ok(task.contextId)
  failDisposal = false
  await f.broker.rpc('admin', 'task_control', { taskId: 'one', action: 'cancel' })
  assert.equal(attempts, 6); assert.equal(task.contextId, null)
})

test('permanently retained contexts retire with the idle owned browser after all peers finish', async t => {
  const f = fixture(), identity = effectivePolicyIdentity({}), events = []
  t.after(() => f.broker.close())
  f.broker.onEvent = event => events.push(event)
  const owner = await f.broker.rpc('admin', 'client_register', { label: 'Release', policyIdentity: identity, leaseMs: 30000 })
  const task = f.addTask('one', owner.clientId), peer = f.addTask('two')
  await f.attach(task, 'main'); await f.attach(peer, 'peer')
  const send = f.browser.send, retainedContext = task.contextId
  f.browser.send = async (method, params, sessionId) => {
    if (method === 'Target.disposeBrowserContext' && params.browserContextId === retainedContext) throw new Error('Persistent context failure')
    return send(method, params, sessionId)
  }
  await assert.rejects(f.broker.rpc(owner.clientId, 'client_release'), /Persistent context/)
  for (let index = 0; index < 4; index++) await f.broker.retryCleanup(Number.POSITIVE_INFINITY)
  assert.equal(task.cleanupRetryAt, null); assert.ok(task.contextId)
  let shutdowns = 0, closing
  f.broker.onShutdown = () => { shutdowns++; closing = f.broker.close() }
  const now = Date.now()
  f.broker.checkIdle(now); f.broker.checkIdle(now + 60000)
  assert.equal(shutdowns, 0); assert.equal(peer.state, 'agent-active')
  await f.broker.rpc('two', 'task_finish', { taskId: 'two' })
  f.broker.checkIdle(now + 60000); f.broker.checkIdle(now + 89999)
  assert.equal(shutdowns, 0)
  f.broker.checkIdle(now + 90000); await closing
  assert.equal(shutdowns, 1); assert.equal(f.browser.closed, true)
  assert.deepEqual(events.find(event => event.type === 'retained-context-cleanup').taskIds, ['one'])
})

test('a lost context-disposal response is verified before retrying an already completed operation', async () => {
  const f = fixture(), task = f.addTask('one'), send = f.browser.send
  await f.attach(task, 'main')
  f.browser.send = async (method, params, sessionId) => {
    const result = await send(method, params, sessionId)
    if (method === 'Target.disposeBrowserContext') throw new Error('Lost disposal acknowledgement')
    return result
  }
  await f.broker.rpc('one', 'task_finish', { taskId: 'one' })
  assert.equal(task.contextId, null); assert.equal(task.cleanupError, null)
  assert.equal(f.calls.filter(call => call.method === 'Target.disposeBrowserContext').length, 1)
})

test('a creation queued behind the action limit cannot outlive its client lease', async t => {
  const f = fixture({ maxActiveActions: 1 })
  t.after(() => f.broker.close())
  const identity = effectivePolicyIdentity({ maxActiveActions: 1 })
  const owner = await f.broker.rpc('admin', 'client_register', { label: 'Queued', policyIdentity: identity, leaseMs: 30000 })
  const gate = deferred()
  const blocking = f.broker.slots.run(() => gate.promise)
  const creating = f.broker.rpc(owner.clientId, 'task_create', { url: 'http://localhost/' })
  const denied = assert.rejects(creating, { code: 'UNAUTHORIZED' })
  await f.broker.rpc(owner.clientId, 'client_release')
  gate.resolve(); await blocking; await denied
  assert.equal(f.broker.tasks.size, 0)
  assert.equal(f.calls.filter(call => call.method === 'Target.createBrowserContext').length, 0)
})

for (const method of ['task_navigate', 'task_handle_dialog']) {
  test(`pause while a popup initializes prevents queued ${method} dispatch`, async () => {
    const f = fixture({ webCompatibility: true }), task = f.addTask('one')
    const page = await f.attach(task, 'popup')
    const gate = deferred(), entered = deferred()
    Object.defineProperty(page, 'ready', { get() { entered.resolve(); return gate.promise } })
    let dispatched = false
    page.navigate = page.handleDialog = async () => { dispatched = true }
    const pending = f.broker.rpc('one', method, { taskId: 'one', ...(method === 'task_navigate' ? { url: 'http://localhost/' } : { accept: true }) })
    const denied = assert.rejects(pending, /paused/)
    await entered.promise
    const paused = f.broker.rpc('admin', 'task_control', { taskId: 'one', action: 'pause' })
    gate.resolve(); await denied; await paused
    assert.equal(dispatched, false)
    assert.equal(task.state, 'paused')
  })
}

test('browser failure is unhealthy and schedules broker shutdown', async () => {
  const f = fixture(), ended = deferred()
  f.broker.onShutdown = ended.resolve
  f.browser.closed = true; f.browser.emit('closed')
  assert.equal((await f.broker.rpc('admin', 'broker_status')).browserHealthy, false)
  const keepAlive = setTimeout(() => {}, 100)
  await ended.promise; clearTimeout(keepAlive)
})

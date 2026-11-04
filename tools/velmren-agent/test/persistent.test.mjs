import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { AgentBroker } from '../runtime.mjs'
import { bindProfilePolicy, persistentBrowserArgs } from '../profile-state.mjs'
import { effectivePolicyIdentity } from '../policy-identity.mjs'

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const scratch = async () => {
  const root = fileURLToPath(new URL('../test-results/', import.meta.url))
  await mkdir(root, { recursive: true })
  return mkdtemp(path.join(root, 'persistent-'))
}

async function fixture() {
  const browser = new EventEmitter(), calls = [], infos = new Map()
  let created = 0
  browser.closed = false
  browser.close = async () => { browser.closed = true }
  const broker = new AgentBroker(browser, await scratch(), { profileMode: 'persistent', webCompatibility: true }, { trace: null })
  const attach = async (id, { type = 'page', openerId, parent, contextId = 'default' } = {}) => {
    const targetInfo = { targetId: id, type, openerId, browserContextId: contextId, url: 'about:blank' }
    infos.set(id, targetInfo)
    await broker.onProtocol({ method: 'Target.attachedToTarget', sessionId: parent, params: { sessionId: `session-${id}`, targetInfo } })
  }
  browser.send = async (method, params = {}, sessionId) => {
    calls.push({ method, params, sessionId })
    if (method === 'Target.getBrowserContexts') return { defaultBrowserContextId: 'default', browserContextIds: [] }
    if (method === 'Target.getTargets') return { targetInfos: [...infos.values()] }
    if (method === 'Target.createTarget') {
      const targetId = `root-${++created}`
      await attach(targetId, { type: created % 2 ? 'other' : 'page' })
      return { targetId }
    }
    if (method === 'Target.closeTarget') {
      infos.delete(params.targetId)
      browser.emit('protocol', { method: 'Target.targetDestroyed', params: { targetId: params.targetId } })
      return { success: true }
    }
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: `frame-${sessionId}`, url: 'about:blank' } } }
    if (method === 'Page.createIsolatedWorld') return { executionContextId: 1 }
    if (method === 'Page.navigate') {
      browser.emit('protocol', { method: 'Page.frameNavigated', sessionId, params: { frame: { id: `frame-${sessionId}`, url: params.url } } })
      browser.emit('protocol', { method: 'Page.loadEventFired', sessionId, params: {} })
      return { loaderId: 'loaded' }
    }
    if (method === 'Runtime.evaluate') return { result: { value: { title: 'Ready', url: 'http://localhost/', text: 'Ready', elements: [], revision: 0 } } }
    return {}
  }
  await broker.init()
  const create = owner => broker.rpc(owner, 'task_create', { url: 'http://localhost/' })
  return { broker, browser, calls, infos, attach, create }
}

test('persistent binding is immutable, canonical, and rejects unbound existing profiles', async () => {
  const directory = await scratch(), policy = { profileMode: 'persistent', allowedOrigins: ['http://localhost'] }
  await bindProfilePolicy(directory, policy)
  const first = await readFile(path.join(directory, 'profile-policy.json'), 'utf8')
  await bindProfilePolicy(directory, { ...policy, allowedOrigins: ['http://localhost', 'http://localhost'] })
  assert.equal(await readFile(path.join(directory, 'profile-policy.json'), 'utf8'), first)
  assert.equal(JSON.parse(first).identity, effectivePolicyIdentity(policy))
  await assert.rejects(bindProfilePolicy(directory, { ...policy, allowWeb: true, allowedOrigins: undefined }), /mismatch/)
  await assert.rejects(bindProfilePolicy(directory, {}), /mismatch/)
  const unbound = await scratch()
  await mkdir(path.join(unbound, 'browser-profile'))
  await writeFile(path.join(unbound, 'browser-profile', 'Local State'), '{}')
  await assert.rejects(bindProfilePolicy(unbound, policy), /unbound/)
})

test('profile mode validates and changes the policy identity; cookie switches preserve other flags', () => {
  assert.equal(effectivePolicyIdentity({}), effectivePolicyIdentity({ profileMode: 'isolated' }))
  assert.notEqual(effectivePolicyIdentity({}), effectivePolicyIdentity({ profileMode: 'persistent' }))
  assert.throws(() => effectivePolicyIdentity({ profileMode: 'personal' }), /profileMode/)
  assert.deepEqual(persistentBrowserArgs(['--headless=new', '--disable-features=One,Two', '--disable-features=Two,Three']), [
    '--headless=new', '--restore-last-session', '--disable-features=BraveCleanupSessionCookiesOnSessionRestore,One,Two,Three'
  ])
})

test('default context remains shared but only exact create results own early page and other attachments', async () => {
  const f = await fixture(), send = f.browser.send, announced = deferred(), release = deferred()
  let once = true
  f.browser.send = async (method, params, sessionId) => {
    if (method !== 'Target.createTarget' || !once) return send(method, params, sessionId)
    once = false
    await f.attach('stranger')
    const result = await send(method, params, sessionId)
    announced.resolve(); await release.promise
    return result
  }
  const aPromise = f.create('A')
  await announced.promise
  assert.ok(f.broker.pendingAttachments.size >= 2)
  assert.equal(f.calls.filter(call => call.method === 'Runtime.runIfWaitingForDebugger').length, 0)
  const bPromise = f.create('B')
  release.resolve()
  const [a, b] = await Promise.all([aPromise, bPromise])
  assert.deepEqual(a.pages.map(page => page.pageId), ['root-1'])
  assert.deepEqual(b.pages.map(page => page.pageId), ['root-2'])
  assert.equal(f.broker.targets.has('stranger'), false)
  assert.equal(f.infos.has('stranger'), false)
  assert.ok(!f.calls.some(call => call.method === 'Runtime.runIfWaitingForDebugger' && call.sessionId === 'session-stranger'))
  assert.equal(f.calls.filter(call => call.method === 'Browser.setDownloadBehavior').length, 1)
  assert.ok(!f.calls.some(call => call.method === 'Target.createBrowserContext'))
  await f.broker.rpc('A', 'task_finish', { taskId: a.taskId })
  assert.equal(f.infos.has('root-2'), true)
  assert.ok(!f.calls.some(call => call.method === 'Target.disposeBrowserContext'))
  await f.broker.close()
})

test('unmatched attachments are bounded and failed creation closes only its provisional unknown roots', async () => {
  const f = await fixture(), peer = await f.create('B'), send = f.browser.send
  f.browser.send = async (method, params, sessionId) => {
    if (method !== 'Target.createTarget') return send(method, params, sessionId)
    await f.attach('failed-root', { type: 'other' })
    throw new Error('Create failed')
  }
  await assert.rejects(f.create('A'), /Create failed/)
  assert.equal(f.infos.has('failed-root'), false)
  assert.equal(f.infos.has(peer.selectedPageId), true)
  for (let index = 0; index < 129; index++) await f.attach(`unmatched-frame-${index}`, { type: 'iframe' })
  assert.equal(f.broker.pendingAttachments.size, 128)
  assert.equal(f.infos.has('unmatched-frame-128'), false)
  await f.broker.close()
})

test('unknown same-context targets and conflicting parent attachments cannot acquire ownership', async () => {
  const f = await fixture(), a = await f.create('A'), b = await f.create('B')
  await f.attach('unrelated')
  assert.equal(f.infos.has('unrelated'), false)
  await f.attach('conflict', { openerId: a.selectedPageId, parent: `session-${b.selectedPageId}` })
  assert.equal(f.infos.has('conflict'), false)
  await f.broker.onProtocol({ method: 'Target.attachedToTarget', sessionId: `session-${b.selectedPageId}`, params: {
    sessionId: 'conflicting-duplicate', targetInfo: { targetId: a.selectedPageId, type: 'page', browserContextId: 'default' }
  } })
  assert.equal(f.infos.has(a.selectedPageId), true)
  assert.equal(f.broker.targets.get(a.selectedPageId).task.taskId, a.taskId)
  await f.broker.close()
})

test('late popups retain terminal task ownership tombstones without closing peer pages', async () => {
  const f = await fixture(), a = await f.create('A'), b = await f.create('B')
  await f.broker.rpc('A', 'task_finish', { taskId: a.taskId })
  await f.attach('late-popup', { openerId: a.selectedPageId, type: 'other' })
  assert.equal(f.infos.has('late-popup'), false)
  assert.equal(f.infos.has(b.selectedPageId), true)
  assert.ok(!f.broker.tasks.get(b.taskId).pages.has('late-popup'))
  await f.broker.close()
})

test('child frame opener tokens resolve to their owning page and unverifiable frame notifications stay bounded', async () => {
  const f = await fixture(), a = await f.create('A')
  await f.broker.onProtocol({ method: 'Page.frameAttached', sessionId: `session-${a.selectedPageId}`, params: { frameId: 'child-frame', parentFrameId: 'parent' } })
  await f.attach('child-popup', { type: 'other', openerId: 'child-frame' })
  assert.equal(f.broker.targets.get('child-popup').task.taskId, a.taskId)
  assert.equal(f.broker.targets.get('child-popup').page.openerId, a.selectedPageId)
  await f.attach('unknown-child', { type: 'iframe' })
  await f.broker.onProtocol({ method: 'Page.frameAttached', sessionId: 'unknown-session', params: { frameId: 'unknown-child', parentFrameId: 'unknown-parent' } })
  assert.equal(f.broker.pendingAttachments.size, 1)
  await f.broker.close()
})

test('profile workers retain canonical Fetch sessions after the initiating task ends', async () => {
  const f = await fixture(), a = await f.create('A')
  await f.attach('shared', { type: 'shared_worker' })
  const worker = f.broker.targets.get('shared')
  assert.equal(worker.profileOwned, true); assert.equal(worker.task, undefined)
  await f.broker.onProtocol({ method: 'Target.attachedToTarget', sessionId: `session-${a.selectedPageId}`, params: {
    sessionId: 'duplicate-shared', targetInfo: { targetId: 'shared', type: 'shared_worker', browserContextId: 'default' }
  } })
  assert.equal(f.broker.targets.get('shared'), worker)
  await f.broker.rpc('A', 'task_finish', { taskId: a.taskId })
  assert.equal(f.broker.targets.get('shared'), worker)
  await f.broker.onProtocol({ method: 'Fetch.requestPaused', sessionId: worker.sessionId, params: { requestId: 'allowed', request: { url: 'http://localhost/' } } })
  await f.broker.onProtocol({ method: 'Fetch.requestPaused', sessionId: worker.sessionId, params: { requestId: 'blocked', request: { url: 'https://unlisted.example/' } } })
  assert.ok(f.calls.some(call => call.method === 'Fetch.continueRequest' && call.params.requestId === 'allowed'))
  assert.ok(f.calls.some(call => call.method === 'Fetch.failRequest' && call.params.requestId === 'blocked'))
  const pageAttach = f.calls.find(call => call.method === 'Target.setAutoAttach' && call.sessionId === `session-${a.selectedPageId}`)
  assert.ok(pageAttach.params.filter.some(filter => filter.type === 'shared_worker' && filter.exclude))
  await f.broker.close()
})

test('child-frame download GUID ownership cannot change and unknown GUIDs are canceled', async () => {
  const f = await fixture(), a = await f.create('A'), b = await f.create('B')
  await f.broker.onProtocol({ method: 'Page.frameAttached', sessionId: `session-${a.selectedPageId}`, params: { frameId: 'child-a', parentFrameId: 'parent' } })
  const download = (guid, frameId) => f.broker.onProtocol({ method: 'Browser.downloadWillBegin', params: { guid, frameId, suggestedFilename: '../fixture.txt' } })
  await download('guid-a', 'child-a')
  await download('guid-a', `frame-session-${b.selectedPageId}`)
  await download('guid-unknown', 'unrelated')
  assert.equal(f.broker.tasks.get(a.taskId).downloads.length, 1)
  assert.equal(f.broker.tasks.get(a.taskId).downloads[0].name, 'fixture.txt')
  assert.equal(f.broker.tasks.get(b.taskId).downloads.length, 0)
  assert.ok(f.calls.some(call => call.method === 'Browser.cancelDownload' && call.params.guid === 'guid-unknown'))
  await download('guid-b', `frame-session-${b.selectedPageId}`)
  await f.broker.rpc('A', 'task_finish', { taskId: a.taskId })
  assert.ok(f.calls.some(call => call.method === 'Browser.cancelDownload' && call.params.guid === 'guid-a'))
  assert.ok(!f.calls.some(call => call.method === 'Browser.cancelDownload' && call.params.guid === 'guid-b'))
  await f.broker.close()
})

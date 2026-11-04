import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { AgentPage } from '../page.mjs'
import { PageFrames } from '../frames.mjs'

function fixture() {
  const browser = new EventEmitter(), calls = []
  const root = new AgentPage(browser, 'page', 'root-session'); root.frameId = 'root'
  const entries = [{ type: 'iframe', targetId: 'child', sessionId: 'child-session', ready: Promise.resolve() }, { type: 'iframe', targetId: 'foreign', sessionId: 'foreign-session', ready: Promise.resolve() }]
  const owners = new Map([['child', { parentId: 'root' }], ['foreign', { parentId: 'other-page' }]])
  const trees = new Map([
    ['root-session', { frame: { id: 'root', url: 'http://localhost/' }, childFrames: [{ frame: { id: 'same', parentId: 'root', loaderId: 'same-1', url: 'http://localhost/inner' } }] }],
    ['child-session', { frame: { id: 'child', loaderId: 'child-1', url: 'http://127.0.0.1/child' } }]
  ])
  browser.send = async (method, params, sessionId) => {
    calls.push({ method, params, sessionId })
    if (method === 'Page.getFrameTree') return { frameTree: trees.get(sessionId) }
    return {}
  }
  root.frames = new PageFrames(root, () => entries, id => owners.get(id))
  return { browser, root, calls, entries, owners, trees }
}

test('frame membership needs ancestry in the selected page, including when profiles are shared', async () => {
  const f = fixture()
  const frames = await f.root.frames.refresh()
  assert.deepEqual(frames.map(frame => frame.frameId), ['root', 'same', 'child'])
  assert.throws(() => f.root.frames.select('foreign'), /Frame not found/)
  assert.ok(!f.calls.some(call => call.sessionId === 'foreign-session'))
  assert.equal(f.root.frames.select('same').sessionId, 'root-session')
  assert.equal(f.root.frames.select('child').sessionId, 'child-session')
  f.root.dispose(); assert.equal(f.browser.listenerCount('protocol'), 0)
})

test('frame navigation and session replacement cannot retain observations or world references', async () => {
  const f = fixture(); await f.root.frames.refresh()
  const child = f.root.frames.select('child'); child.world = 19; child.observation = { id: 'old' }
  f.browser.emit('protocol', { sessionId: 'child-session', method: 'Page.frameNavigated', params: { frame: { id: 'child', url: 'http://127.0.0.1/next' } } })
  assert.equal(child.observation, null); assert.equal(child.world, null); assert.equal(child.epoch, 1)
  f.entries[0] = { ...f.entries[0], sessionId: 'replacement-session' }
  f.trees.set('replacement-session', { frame: { id: 'child', loaderId: 'child-2', url: 'http://127.0.0.1/next' } })
  await f.root.frames.refresh()
  assert.equal(child.disposed, true); assert.equal(f.root.frames.current(child), false)
  assert.notEqual(f.root.frames.select('child'), child)
  f.root.dispose()
})

test('detached OOPIF ownership tombstones never resurrect a still-detaching session', async () => {
  const f = fixture(); await f.root.frames.refresh()
  const child = f.root.frames.select('child')
  f.browser.emit('protocol', { sessionId: 'root-session', method: 'Page.frameDetached', params: { frameId: 'child', reason: 'remove' } })
  f.owners.get('child').detached = true
  await f.root.frames.refresh()
  assert.equal(child.disposed, true); assert.throws(() => f.root.frames.select('child'), /Frame not found/)
  f.root.dispose()
})

test('OOPIF trusted input uses the root input session while DOM operations use the child session', async () => {
  const f = fixture(); await f.root.frames.refresh()
  const child = f.root.frames.select('child')
  await child.send('Input.insertText', { text: 'synthetic' })
  await child.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  await child.send('DOM.setFileInputFiles', { objectId: 'owned', files: [] })
  assert.deepEqual(f.calls.slice(-3).map(call => call.sessionId), ['root-session', 'root-session', 'child-session'])
  f.root.dispose()
})

test('manual handoff invalidates child observations and intercepted chooser identities', async () => {
  const f = fixture(); await f.root.frames.refresh()
  const child = f.root.frames.select('child'); child.observation = { id: 'old' }; child.chooser = { id: 'old-chooser' }
  await f.root.setFileChooserInterception(false)
  assert.equal(child.observation, null); assert.equal(child.chooser, null); assert.equal(child.interceptFileChooser, false)
  await f.root.setFileChooserInterception(true)
  assert.equal(child.interceptFileChooser, true)
  f.root.dispose()
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { AgentBroker } from '../runtime.mjs'

test('recovery journal failure cannot skip cancellation of an explicitly released owner', async () => {
  const browser = new EventEmitter(), closed = []
  browser.send = async (method, params) => { if (method === 'Target.closeTarget') closed.push(params.targetId); return {} }
  browser.close = async () => {}
  const unavailable = () => Promise.reject(Object.assign(new Error('Storage unavailable'), { code: 'EACCES' }))
  const broker = new AgentBroker(browser, 'unused', {}, { trace: null, recoveryStore: { revoke: unavailable, record: unavailable } })
  const page = { pageId: 'page', targetId: 'target', dispose() {} }
  const task = { taskId: 'task', owner: 'owner', state: 'human', handoff: { id: 'handoff' }, pages: new Map([['page', page]]), page, selectedPageId: 'page', queue: Promise.resolve(), downloads: [], blockedOrigins: [] }
  broker.tasks.set(task.taskId, task)
  broker.clients.set('owner', { token: 'scoped', leaseMs: 30000, expiresAt: Date.now() + 30000 })
  await assert.rejects(broker.releaseClient('owner'), { code: 'EACCES' })
  assert.equal(broker.clients.get('owner').released, true)
  assert.equal(task.state, 'cancelled'); assert.equal(task.handoff, null)
  assert.deepEqual(closed, ['target']); assert.equal(task.pages.size, 0)
  clearInterval(broker.lifecycleTimer); broker.unbindBrowser(); broker.captcha.close()
})

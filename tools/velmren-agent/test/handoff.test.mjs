import test from 'node:test'
import assert from 'node:assert/strict'
import { requestHuman, resumeHuman } from '../handoff.mjs'

function fixture() {
  const calls = []
  const pages = new Map(['a', 'b'].map(id => [id, { pageId: id, observation: { old: true }, send: async (...args) => calls.push([id, ...args]) }]))
  const task = { state: 'agent-active', selectedPageId: 'a', controlGeneration: 0, queue: Promise.resolve() }
  const broker = {
    page: (t, id = t.selectedPageId) => { const page = pages.get(id); assert.ok(page); return page },
    pages: () => pages,
    select: (t, page) => { t.selectedPageId = page.pageId },
    serialize: (t, fn) => { const result = t.queue.then(fn); t.queue = result.catch(() => {}); return result },
    syncTaskFocus: async () => { for (const page of pages.values()) await page.send('Emulation.setFocusEmulationEnabled', { enabled: false }) },
    record: t => ({ state: t.state, selectedPageId: t.selectedPageId, reason: t.reason, handoff: t.handoff ? { ...t.handoff } : null }),
    control: async (t, action) => { calls.push([action, t.selectedPageId]); t.controlGeneration++; t.state = action === 'show' ? 'human' : 'agent-active' }
  }
  return { broker, task, pages, calls }
}

test('manual show keeps the chosen page and invalidates old observations', async () => {
  const f = fixture()
  const result = await requestHuman(f.broker, f.task, { pageId: 'b', reason: 'Complete sign-in', showWindow: true })
  assert.equal(result.state, 'human'); assert.equal(result.selectedPageId, 'b')
  assert.equal(result.handoff.pageId, 'b'); assert.equal(result.handoff.shown, true)
  assert.deepEqual(f.calls, [['show', 'b']])
  assert.ok([...f.pages.values()].every(page => page.observation === null))
  const resumed = await resumeHuman(f.broker, f.task, { handoffId: result.handoff.id, userConfirmed: true })
  assert.equal(resumed.state, 'agent-active'); assert.equal(resumed.handoff, null)
  assert.deepEqual(f.calls.at(-1), ['resume', 'b'])
  await assert.rejects(resumeHuman(f.broker, f.task, { handoffId: result.handoff.id, userConfirmed: true }), /no longer current/)
})

test('a newer handoff invalidates old confirmation and unconfirmed resume cannot change state', async () => {
  const f = fixture()
  const first = await requestHuman(f.broker, f.task, { reason: 'First step' })
  const second = await requestHuman(f.broker, f.task, { reason: 'Second step' })
  assert.notEqual(first.handoff.id, second.handoff.id)
  const before = f.calls.length
  await assert.rejects(resumeHuman(f.broker, f.task, { handoffId: first.handoff.id, userConfirmed: true }), /no longer current/)
  await assert.rejects(resumeHuman(f.broker, f.task, { handoffId: second.handoff.id, userConfirmed: false }), /confirm/)
  assert.equal(f.calls.length, before); assert.equal(f.task.state, 'needs-human')
})

test('queued human request does not restore an obsolete state after cancellation', async () => {
  const f = fixture()
  let release
  f.task.queue = new Promise(resolve => { release = resolve })
  const pending = requestHuman(f.broker, f.task, { reason: 'Manual step' })
  assert.equal(f.task.state, 'needs-human')
  f.task.state = 'cancelled'; f.task.controlGeneration++
  release()
  assert.equal((await pending).state, 'cancelled'); assert.equal(f.calls.length, 0)
  await assert.rejects(requestHuman(f.broker, f.task, { reason: 'Again' }), /already ended/)
})

test('pending resume cannot erase a new manual handoff or accept a duplicate resume', async () => {
  const f = fixture()
  const first = await requestHuman(f.broker, f.task, { reason: 'First step' })
  let release
  f.broker.control = async () => { await new Promise(resolve => { release = resolve }) }
  const pending = resumeHuman(f.broker, f.task, { handoffId: first.handoff.id, userConfirmed: true })
  await assert.rejects(resumeHuman(f.broker, f.task, { handoffId: first.handoff.id, userConfirmed: true }), /not waiting/)
  const second = await requestHuman(f.broker, f.task, { reason: 'New manual step' })
  release(); await pending
  assert.equal(f.task.handoff.id, second.handoff.id); assert.equal(f.task.state, 'needs-human')
})

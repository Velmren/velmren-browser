import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { RequestTrace } from '../trace.mjs'
import { AgentBroker } from '../runtime.mjs'

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const root = fileURLToPath(new URL('../test-results/', import.meta.url))
async function directory() { await mkdir(root, { recursive: true }); return mkdtemp(path.join(root, 'trace-')) }
async function records(dir) {
  const text = await readFile(path.join(dir, 'requests.jsonl'), 'utf8')
  return { text, rows: text.trim().split('\n').map(line => JSON.parse(line)) }
}
function fixture(dir) {
  const browser = new EventEmitter()
  browser.send = async () => ({}); browser.close = async () => {}
  const broker = new AgentBroker(browser, dir, { maxActiveActions: 1 })
  const page = { pageId: 'owned-page', targetId: 'owned-page', sessionId: 'owned-session', dispose() {}, observe: async () => ({ text: 'private-page-content' }) }
  const task = { taskId: 'owned-task', owner: 'codex', state: 'agent-active', queue: Promise.resolve(), pages: new Map([[page.pageId, page]]), selectedPageId: page.pageId }
  broker.tasks.set(task.taskId, task)
  return { broker, page, task }
}
const entry = index => ({ requestId: `request-${index}`, timestamp: new Date(0).toISOString(), method: 'task_observe', outcome: 'success', durationMs: 1 })

test('direct RPC trace redacts request/result/error data and resolves ownership before recording IDs', async () => {
  const dir = await directory(), { broker, page } = fixture(dir)
  await broker.rpc('codex', 'task_observe', { taskId: 'owned-task' })
  await assert.rejects(broker.rpc('claude', 'task_observe', { taskId: 'owned-task', pageId: 'owned-page' }))
  await assert.rejects(broker.rpc('unknown-client-secret', 'private-method-secret', { taskId: 'private-task-secret' }))
  page.act = async () => { throw Object.assign(new Error('private-error-secret'), { actionResult: {
    completed: 0, failedIndex: 0, delivery: 'delivery_uncertain',
    results: [{ index: 0, type: 'click', ref: 'e1', delivery: 'delivery_uncertain', value: 'private-value-secret' }],
    recovery: { retry: 'none', observe: true, reason: 'delivery_uncertain', text: 'private-recovery-secret' },
    token: 'private-token-secret'
  } }) }
  await assert.rejects(broker.rpc('codex', 'task_act', { taskId: 'owned-task', observationId: 'private-observation-secret', actions: [{ type: 'fill', ref: 'e1', value: 'private-input-secret' }] }))
  const registration = await broker.rpc('admin', 'client_register', { label: 'private-label-secret' })
  await broker.close()
  const { text, rows } = await records(dir)
  assert.doesNotMatch(text, /private-|unknown-client-secret/)
  assert.equal(text.includes(registration.token), false)
  assert.equal(rows.length, 5)
  assert.equal(new Set(rows.map(row => row.requestId)).size, 5)
  assert.equal(rows[0].taskId, 'owned-task'); assert.equal(rows[0].pageId, 'owned-page')
  assert.equal(rows[1].clientId, 'claude'); assert.equal(rows[1].taskId, undefined); assert.equal(rows[1].pageId, undefined)
  assert.equal(rows[2].method, 'unknown'); assert.equal(rows[2].clientId, undefined)
  assert.equal(rows[3].outcome, 'error'); assert.equal(rows[3].actionResult.delivery, 'delivery_uncertain')
  assert.equal(rows[4].clientId, registration.clientId)
})

test('task queue and active-slot waits are measured independently from execution', async t => {
  const dir = await directory(), { broker, page, task } = fixture(dir)
  let clock = 100
  t.mock.method(performance, 'now', () => clock)
  const taskGate = deferred(), slotGate = deferred(), executing = deferred(), actionGate = deferred()
  task.queue = taskGate.promise
  const occupying = broker.slots.run(() => slotGate.promise)
  page.observe = async () => { executing.resolve(); await actionGate.promise; return {} }
  const pending = broker.rpc('codex', 'task_observe', { taskId: task.taskId })
  clock = 200; taskGate.resolve()
  await new Promise(resolve => setImmediate(resolve))
  clock = 500; slotGate.resolve(); await occupying; await executing.promise
  clock = 800; actionGate.resolve(); await pending; await broker.close()
  const { rows: [row] } = await records(dir)
  assert.equal(row.taskQueueMs, 100)
  assert.equal(row.activeSlotQueueMs, 300)
  assert.equal(row.durationMs, 700)
})

test('trace rotates within two byte-bounded files and flushes every accepted record', async () => {
  const dir = await directory(), trace = new RequestTrace(dir, { maxBytes: 700 })
  for (let index = 0; index < 30; index++) { assert.equal(trace.record(entry(index)), true); await trace.flush() }
  await trace.close()
  const files = (await readdir(dir)).sort()
  assert.deepEqual(files, ['requests.1.jsonl', 'requests.jsonl'])
  for (const file of files) {
    assert.ok((await stat(path.join(dir, file))).size <= 700)
    const rows = (await readFile(path.join(dir, file), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    assert.ok(rows.length > 0)
  }
  assert.equal((await records(dir)).rows.at(-1).requestId, 'request-29')
  assert.equal(trace.record(entry(31)), false)
})

test('trace backpressure drops overflow instead of building an unbounded queue', async () => {
  const dir = await directory(), trace = new RequestTrace(dir, { maxPending: 2, maxPendingBytes: 700 })
  const accepted = Array.from({ length: 1000 }, (_, index) => trace.record(entry(index))).filter(Boolean).length
  assert.equal(accepted, 2)
  await trace.close()
  assert.equal((await records(dir)).rows.length, accepted)
})

test('unwritable trace storage does not fail a successful RPC or broker shutdown', async () => {
  const dir = await directory(), blocked = path.join(dir, 'existing-file')
  await writeFile(blocked, 'fixture')
  const { broker } = fixture(blocked)
  const result = await broker.rpc('codex', 'task_observe', { taskId: 'owned-task' })
  assert.equal(result.text, 'private-page-content')
  await broker.close()
  assert.equal(broker.trace.disabled, true)
})

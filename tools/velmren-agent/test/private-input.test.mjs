import test from 'node:test'
import assert from 'node:assert/strict'
import { PrivateInputs, stagePrivateInput } from '../private-input.mjs'
import { beginSensitive, endSensitive, rememberSensitiveDocument } from '../sensitive-state.mjs'
import { isSensitiveTarget } from '../sensitive-renderer.mjs'

const binding = () => ({ owner: 'owner-a', taskId: 'task-a', pageId: 'page-a', frameId: 'frame-a', observationId: 'obs-a', ref: 'e1', origin: 'https://fixture.test', topOrigin: 'https://fixture.test', documentId: 'doc-a', topDocumentId: 'doc-a' })

test('automatic sensitivity covers password and tokenized OTP on native text controls', t => {
  const previous = globalThis.__velmrenAgent
  t.after(() => { if (previous === undefined) delete globalThis.__velmrenAgent; else globalThis.__velmrenAgent = previous })
  for (const [element, sensitive] of [
    [{ tagName: 'INPUT', type: 'password', autocomplete: '' }, true],
    [{ tagName: 'INPUT', type: 'text', autocomplete: 'section-login one-time-code' }, true],
    [{ tagName: 'TEXTAREA', autocomplete: 'SECTION-login\tONE-TIME-CODE' }, true],
    [{ tagName: 'INPUT', type: 'text', autocomplete: 'one-time-code-other' }, false],
    [{ tagName: 'INPUT', type: 'text', autocomplete: 'given-name' }, false]
  ]) {
    globalThis.__velmrenAgent = { refs: new Map([['e1', element]]) }
    assert.equal(isSensitiveTarget({ ref: 'e1' }), sensitive)
  }
})
test('private capability is bound, one-use and consumed before delivery settles', async () => {
  const store = new PrivateInputs(), bound = binding(), { secretRef } = store.prepare(bound)
  store.provide(secretRef, bound.owner, bound.taskId, 'SyntheticPrivateFixture')
  let settle
  const pending = store.consume(secretRef, bound, value => { assert.equal(value.length, 23); return new Promise(resolve => { settle = resolve }) })
  await assert.rejects(store.consume(secretRef, bound, () => {}), { code: 'PRIVATE_INPUT_UNAVAILABLE' })
  settle({ delivered: true }); assert.deepEqual(await pending, { delivered: true }); assert.equal(store.entries.size, 0)
})
test('foreign ownership and changed node/document/origin cannot consume intended input', async () => {
  const store = new PrivateInputs(), bound = binding(), { secretRef } = store.prepare(bound)
  store.provide(secretRef, bound.owner, bound.taskId, 'SyntheticPrivateFixture')
  for (const field of Object.keys(bound)) await assert.rejects(store.consume(secretRef, { ...bound, [field]: 'different' }, () => { throw new Error('must not deliver') }))
  assert.equal(store.entries.size, 1)
  await store.consume(secretRef, bound, () => true)
})
test('expired, revoked, failed and discarded inputs cannot be replayed; memory is cleared', async () => {
  let now = 0
  const store = new PrivateInputs({ now: () => now, ttlMs: 10 }), bound = binding()
  const a = store.prepare(bound); store.provide(a.secretRef, bound.owner, bound.taskId, 'Fixture')
  const bytes = store.entries.get(a.secretRef).bytes
  now = 11; await assert.rejects(store.consume(a.secretRef, bound, () => {})); assert.ok(bytes.every(value => value === 0))
  const b = store.prepare(bound); store.provide(b.secretRef, bound.owner, bound.taskId, 'Fixture')
  await assert.rejects(store.consume(b.secretRef, bound, () => { throw new Error('Synthetic delivery failure') }))
  assert.equal(store.entries.size, 0)
  const c = store.prepare(bound); store.revoke(c.secretRef, bound.owner, bound.taskId)
  const d = store.prepare(bound); store.discardTask(bound.taskId); assert.equal(store.entries.size, 0)
  assert.notEqual(c.secretRef, d.secretRef)
})
test('trusted adapter validates destination before reading and never forwards callback errors', async () => {
  const calls = [], client = { async call(method, args) { calls.push(args.action); if (args.action === 'prepare') return { secretRef: 'opaque' }; return { secretRef: args.secretRef, ready: true } } }
  const result = await stagePrivateInput({ client, ...binding(), readSecret: async () => { calls.push('read'); return 'Fixture' } })
  assert.deepEqual(calls, ['prepare', 'read', 'provide']); assert.equal(result.ready, true)
  calls.length = 0
  await assert.rejects(stagePrivateInput({ client, ...binding(), readSecret: async () => { throw new Error('Private callback details') } }), { message: 'Private input preparation failed' })
  assert.deepEqual(calls, ['prepare', 'revoke'])
  let read = false
  await assert.rejects(stagePrivateInput({ client: { call: async () => { throw new Error('Denied') } }, ...binding(), readSecret: async () => { read = true } }))
  assert.equal(read, false)
})
test('sensitive phase survives same document, intermediate pages, stale IDs and popup closure', () => {
  const task = {}, page = { pageId: 'page-a', documentId: 'doc-a', url: 'https://fixture.test/auth' }
  const phase = beginSensitive(task, [page])
  const args = { phaseId: phase.phaseId, documentId: 'doc-a', safeToReveal: true, expectedOrigin: 'https://fixture.test' }
  page.url = 'https://fixture.test/done#spa'
  assert.throws(() => endSensitive(task, [page], page, args), { code: 'SENSITIVE_TRANSITION_REQUIRED' })
  page.documentId = 'doc-b'
  assert.throws(() => endSensitive(task, [page], page, args), { code: 'SENSITIVE_DOCUMENT_CHANGED' })
  args.documentId = 'doc-b'
  assert.throws(() => endSensitive(task, [page, { pageId: 'popup' }], page, args), { code: 'SENSITIVE_DOCUMENTS_REMAIN' })
  assert.throws(() => endSensitive(task, [page], page, { ...args, expectedOrigin: 'https://other.test' }), { code: 'SENSITIVE_ORIGIN_MISMATCH' })
  assert.equal(task.sensitive.active, true)
  assert.equal(endSensitive(task, [page], page, args).active, false)
  assert.equal(task.sensitiveHistory, true)
  assert.throws(() => endSensitive(task, [page], page, args), { code: 'SENSITIVE_PHASE_STALE' })
})
test('another secret step updates the required document transition without dropping protection', () => {
  const task = {}, page = { pageId: 'page-a', documentId: 'doc-a', url: 'https://fixture.test/auth' }
  const before = beginSensitive(task, [page])
  page.documentId = 'doc-b'
  const after = beginSensitive(task, [page], { input: true })
  assert.equal(after.phaseId, before.phaseId)
  assert.throws(() => endSensitive(task, [page], page, { phaseId: after.phaseId, documentId: 'doc-b', safeToReveal: true, expectedOrigin: 'https://fixture.test' }), { code: 'SENSITIVE_TRANSITION_REQUIRED' })
})

test('pages created after the phase begins require an observed baseline and a new document', () => {
  const task = {}, phase = beginSensitive(task, [])
  const page = { pageId: 'new-page', documentId: 'first-document', url: 'https://fixture.test/activation' }
  const args = { phaseId: phase.phaseId, documentId: page.documentId, expectedOrigin: 'https://fixture.test', safeToReveal: true }
  assert.throws(() => endSensitive(task, [page], page, args), { code: 'SENSITIVE_TRANSITION_REQUIRED' })
  rememberSensitiveDocument(task, page)
  assert.throws(() => endSensitive(task, [page], page, args), { code: 'SENSITIVE_TRANSITION_REQUIRED' })
  page.documentId = 'second-document'; page.url = 'https://fixture.test/safe'
  rememberSensitiveDocument(task, page)
  assert.equal(endSensitive(task, [page], page, { ...args, documentId: page.documentId }).active, false)
})

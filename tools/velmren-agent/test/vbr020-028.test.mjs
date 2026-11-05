import test from 'node:test'
import assert from 'node:assert/strict'
import { sanitizePublicResult, sanitizePublicError, safePublicUrl } from '../privacy.mjs'
import { PrivateInputs, stagePrivateInput } from '../private-input.mjs'
import { beginSensitive, endSensitive, rememberSensitiveDocument } from '../sensitive-state.mjs'
import { annotateOperationError, sanitizeDiagnostic } from '../operation-error.mjs'

const marker = 'VBR020_028_PRIVATE_CANARY'
const binding = { owner: 'scripts', taskId: 'task', pageId: 'page', observationId: 'obs', frameId: 'frame', ref: 'e1', origin: 'https://example.test', topOrigin: 'https://example.test', documentId: 'doc', topDocumentId: 'doc' }
const absent = output => assert.ok(!JSON.stringify(output).includes(marker))

test('VBR-020 schemeless OAuth URL tails vanish in all recursive metadata and keys', () => {
  for (const host of ['forum.open.mp', 'login.olx.pt', 'example.test:8443', 'example.test.', 'пример.рф', '127.0.0.1:8080', '[::1]:8080', 'localhost:8080']) for (const tail of [`/member.php?code=${marker}&state=${marker}#${marker}`, `?client_id=${marker}`, `#${marker}`]) {
    for (const prefix of ['', '//', 'https://']) {
      const raw = `${prefix}${host}${tail}`, origin = new URL(`https://${host}`).origin
      for (const url of [raw, encodeURIComponent(raw), encodeURIComponent(encodeURIComponent(raw)), raw.replaceAll('.', '&#46;').replaceAll('/', '&sol;').replaceAll('?', '&quest;')]) {
        const input = { title: url, pages: [{ title: `Continue ${url}` }], reason: url, dialog: { message: url }, metadata: [{ nested: { [url]: url } }] }
        const clean = sanitizePublicResult(input)
        absent(clean); assert.equal(clean.title, origin); assert.equal(clean.pages[0].title, `Continue ${origin}`)
        assert.equal(clean.metadata[0].nested[origin], origin); assert.equal(safePublicUrl(url), origin)
        assert.deepEqual(sanitizePublicResult(clean), clean)
      }
    }
  }
})

test('VBR-020 preserves safe names, emails and versions and ignores arbitrary image exceptions', () => {
  const safe = ['Alice.Smith', 'Velmren Kimovich', 'first.last@example.test', 'version 0.1.0.14', 'Node.js', '12:30', 'example.test', '2026.11.05', 'v1.2.3/path', 'release-v1.2.3?ready=true']
  for (const text of safe) assert.equal(sanitizePublicResult({ text }).text, text)
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAEElEQVR4AQEFAPr/AP////8J+wP9o9FJCgAAAABJRU5ErkJggg=='
  assert.equal(sanitizePublicResult({ mimeType: 'image/png', data: png, title: `example.test/${marker}` }).data, png)
  absent(sanitizePublicResult({ mimeType: 'image/png', data: `example.test/${marker}` }))
  absent(sanitizePublicResult({ mimeType: 'image/jpeg', data: `example.test/${marker}` }))
})

test('VBR-021 prepare/provide retain safe codes and exact stage, while reader failures lose all supplied content', async () => {
  for (const stage of ['prepare', 'provide', 'read']) {
    const calls = [], error = Object.assign(new Error(marker), { code: 'ELEMENT_OBSCURED', secretRef: marker, diagnostic: { phase: 'prepare', reason: 'obscured', stage: marker, unknown: marker } })
    const client = { async call(method, args) { calls.push(args.action); if (args.action === stage) throw error; return { secretRef: 'opaque', ready: true } } }
    await assert.rejects(stagePrivateInput({ ...binding, client, readSecret: async () => { calls.push('read'); if (stage === 'read') throw error; return marker } }), caught => {
      const clean = sanitizePublicError(caught, { sensitive: true }); absent(clean)
      assert.equal(clean.code, stage === 'read' ? 'PRIVATE_INPUT_UNAVAILABLE' : 'ELEMENT_OBSCURED')
      assert.deepEqual(clean.diagnostic, { phase: 'prepare', reason: stage === 'read' ? 'reader-failed' : 'obscured', stage: `private_${stage}` })
      return true
    })
    assert.equal(calls.includes('read'), stage !== 'prepare')
    assert.equal(calls.includes('revoke'), stage !== 'prepare')
  }
  for (const rejection of [null, marker, { code: marker, message: marker }]) await assert.rejects(stagePrivateInput({ ...binding, client: { call: async () => { throw rejection } }, readSecret: async () => marker }), error => {
    const clean = sanitizePublicError(error); absent(clean); assert.equal(clean.code, 'PRIVATE_INPUT_UNAVAILABLE'); assert.equal(clean.diagnostic.stage, 'private_prepare'); return true
  })
})

test('VBR-021 consume diagnostics retain one-use, complete binding and opaque capability policy', async () => {
  const store = new PrivateInputs(), prepared = store.prepare(binding)
  store.provide(prepared.secretRef, binding.owner, binding.taskId, marker)
  const changed = { ...binding, documentId: 'different' }
  await assert.rejects(store.consume(prepared.secretRef, changed, () => { throw new Error('must not deliver') }), error => {
    const clean = sanitizePublicError(error); absent(clean); assert.equal(clean.code, 'PRIVATE_INPUT_BINDING_CHANGED')
    assert.deepEqual(clean.diagnostic, { reason: 'binding-changed', phase: 'input', stage: 'private_consume' }); return true
  })
  await store.consume(prepared.secretRef, binding, () => true)
  await assert.rejects(store.consume(prepared.secretRef, binding, () => true), error => {
    absent(sanitizePublicError(error)); assert.equal(error.diagnostic.reason, 'capability-unavailable'); return true
  })
  assert.equal(store.entries.size, 0)
})

test('VBR-021 renderer guard messages have distinct bounded reasons', () => {
  for (const [message, reason] of [
    ['Private input observation changed', 'observation-changed'], ['Private input document changed', 'document-changed'],
    ['Private input target changed', 'target-changed'], ['Private input origin changed', 'origin-mismatch'],
    ['Private input needs a native text control', 'unsupported-control'], ['Private input target is unavailable', 'target-unavailable']
  ]) {
    const error = annotateOperationError(Object.assign(new Error(message), { code: 'PRIVATE_INPUT_BINDING_CHANGED' }), 'prepare')
    assert.equal(sanitizePublicError(error).diagnostic.reason, reason)
  }
  assert.deepEqual(sanitizeDiagnostic({ reason: 'stale', phase: 'prepare', stage: marker, capability: marker }), { reason: 'stale', phase: 'prepare' })
})

test('VBR-028 tracks first committed popup document and gives precise required transition reasons', () => {
  const task = {}, opener = { pageId: 'opener', documentId: 'mail', url: 'https://mail.test/inbox' }
  const phase = beginSensitive(task, [opener]), popup = { pageId: 'popup', documentId: 'activation', url: 'https://example.test/activate' }
  const args = { phaseId: phase.phaseId, documentId: popup.documentId, expectedOrigin: 'https://example.test', safeToReveal: true }
  assert.throws(() => endSensitive(task, [popup], popup, args), error => error.diagnostic.reason === 'baseline-unavailable')
  rememberSensitiveDocument(task, popup)
  assert.throws(() => endSensitive(task, [popup], popup, args), error => error.diagnostic.reason === 'new-document-required')
  popup.documentId = 'intermediate'; rememberSensitiveDocument(task, popup)
  popup.documentId = 'safe'; popup.url = 'https://example.test/'; rememberSensitiveDocument(task, popup)
  assert.throws(() => endSensitive(task, [popup], popup, args), error => error.diagnostic.reason === 'document-changed')
  assert.equal(endSensitive(task, [popup], popup, { ...args, documentId: 'safe' }).active, false)
})

test('safe recovery and visibility receipts survive protected projection without new text channels', () => {
  const input = { state: 'recovery-needed', reason: 'broker_restart', recoveryRequired: true, domRestored: false,
    recovered: true, replayAllowed: false, outcomeEvidence: 'interrupted',
    handoff: { shown: true, visibility: { requested: true, targetVisible: true, nativeWindowVerified: false, foregroundVerified: false, foregroundRequested: true, windowState: 'normal' } } }
  assert.deepEqual(sanitizePublicResult(input, { sensitive: true }), input)
  absent(sanitizePublicResult({ ...input, reason: marker, outcomeEvidence: marker, handoff: { visibility: { requested: marker, windowState: marker } } }, { sensitive: true }))
  for (const code of ['RECOVERY_NEEDED', 'LEASE_EXPIRED', 'LEASE_RECOVERY_NEEDED']) assert.equal(sanitizePublicError({ code, message: marker }).code, code)
})

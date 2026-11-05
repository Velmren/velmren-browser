import test from 'node:test'
import assert from 'node:assert/strict'
import { annotateOperationError, sanitizeDiagnostic, sanitizeErrorContext } from '../operation-error.mjs'
import { BrokerError } from '../client.mjs'
import { sanitizePublicError, sanitizePublicResult } from '../privacy.mjs'
import { BrowserPipe } from '../cdp.mjs'

for (const [message, reason, code] of [
  ['Element is disabled', 'disabled', 'ELEMENT_DISABLED'],
  ['Element is not visible', 'hidden', 'ELEMENT_HIDDEN'],
  ['Element is obscured', 'obscured', 'ELEMENT_OBSCURED'],
  ['Element reference is stale; observe again', 'stale', 'STALE_OBSERVATION'],
  ['Page.createIsolatedWorld: No frame with given id found', 'detached', 'PAGE_DETACHED'],
  ['Navigation failed: net::ERR_CONNECTION_CLOSED', 'navigation', 'NAVIGATION_FAILED'],
  ['Page load timed out', 'timeout', 'NAVIGATION_TIMEOUT'],
  ['Browser connection closed', 'transport', 'CONNECTION_ERROR'],
  ['Task paused during action preparation', 'state', 'INVALID_STATE'],
  ['Unsupported key', 'unsupported', 'INVALID_ARGUMENTS']
]) test(`operation error distinguishes ${reason}`, () => {
  const error = annotateOperationError(new Error(message), 'navigate')
  assert.equal(error.code, code)
  const result = sanitizePublicError(error)
  assert.equal(result.diagnostic.reason, reason)
  assert.equal(result.diagnostic.phase, 'navigate')
  assert.notEqual(result.code, 'BROKER_ERROR')
})

test('diagnostics expose only enums and validated context IDs in all privacy phases', () => {
  const taskId = '951df064-4e2e-4ac0-8c45-3759cc10fcc7'
  const error = Object.assign(new Error('private fixture https://example.test/callback?code=DIAGNOSTIC_MARKER'), {
    code: 'NAVIGATION_FAILED', taskId, pageId: 'f'.repeat(32), frameId: 'https://example.test/private',
    diagnostic: { reason: 'navigation', phase: 'navigate', networkError: 'ERR_CONNECTION_CLOSED', content: 'DIAGNOSTIC_MARKER' }
  })
  for (const sensitive of [false, true]) {
    const result = sanitizePublicError(error, { sensitive })
    assert.equal(result.taskId, taskId)
    assert.equal(result.pageId, 'f'.repeat(32))
    assert.equal(result.frameId, undefined)
    assert.deepEqual(result.diagnostic, { reason: 'navigation', phase: 'navigate', networkError: 'ERR_CONNECTION_CLOSED' })
    assert.equal(JSON.stringify(result).includes('DIAGNOSTIC_MARKER'), false)
    assert.deepEqual(sanitizePublicResult({ diagnostic: error.diagnostic }, { sensitive }).diagnostic, result.diagnostic)
  }
})

test('untrusted diagnostic getters and network names are not forwarded', () => {
  assert.equal(sanitizeDiagnostic({ get reason() { throw Error('getter evaluated') }, phase: 'input' }), undefined)
  assert.deepEqual(sanitizeDiagnostic({ reason: 'transport', phase: 'input', networkError: 'ERR_SECRET_MARKER' }), { reason: 'transport', phase: 'input' })
  assert.deepEqual(sanitizeErrorContext({ taskId: 'private-text', diagnostic: { reason: 'raw text', phase: 'input' } }), {})
  assert.equal(sanitizePublicError(new Error('arbitrary site error')).code, 'BROKER_ERROR')
})

test('error copies retain safe categories without changing delivery receipts', () => {
  const receipt = { completed: 0, failedIndex: 0, delivery: 'delivery_uncertain', results: [], recovery: { retry: 'none', observe: true, reason: 'delivery_uncertain' } }
  const source = annotateOperationError(Object.assign(new Error('Browser connection closed'), { code: 'CONNECTION_ERROR' }), 'input')
  const copy = new BrokerError('safe failure', source.code, receipt, undefined, source)
  assert.deepEqual(copy.diagnostic, { reason: 'transport', phase: 'input' })
  assert.deepEqual(copy.actionResult, receipt)
})

test('native protocol detachment is categorized before an outer operation assigns its phase', async () => {
  const pipe = new BrowserPipe()
  let rejected
  const rejection = new Promise(resolve => { rejected = resolve })
  const timer = setTimeout(() => assert.fail('native protocol failure was not dispatched'), 1000)
  pipe.pending.set(1, { reject: rejected, timer, method: 'Runtime.evaluate' })
  pipe.receive(Buffer.from(JSON.stringify({ id: 1, error: { code: -32000, message: 'Execution context was destroyed. private fixture' } }) + '\0'))
  const error = await rejection
  assert.deepEqual(error.diagnostic, { reason: 'detached', phase: 'protocol' })
  annotateOperationError(error, 'prepare')
  assert.deepEqual(sanitizePublicError(error).diagnostic, { reason: 'detached', phase: 'prepare' })
})

test('obstruction categories distinguish modal scope from geometry through protected error copies', () => {
  for (const [message, obstruction] of [
    ['Element is outside active modal', 'modal-scope'],
    ['Modal interaction scope is ambiguous', 'ambiguous-modal-scope'],
    ['Element is obscured', 'hit-test'],
    ['Frame is obscured', 'frame-hit-test']
  ]) {
    const source = annotateOperationError(Object.assign(new Error(message), { code: 'ELEMENT_OBSCURED' }), 'prepare')
    source.message = 'Browser operation failed.'
    annotateOperationError(source, 'validation')
    const copy = new BrokerError('safe failure', source.code, undefined, undefined, source)
    for (const sensitive of [false, true]) {
      const result = sanitizePublicError(copy, { sensitive })
      assert.equal(result.code, 'ELEMENT_OBSCURED')
      assert.deepEqual(result.diagnostic, { reason: 'obscured', phase: 'validation', obstruction })
    }
  }
})

test('obstruction detail permits only the enum on obscured failures', () => {
  assert.deepEqual(sanitizeDiagnostic({ reason: 'obscured', phase: 'prepare', obstruction: 'secret https://example.test/private' }), { reason: 'obscured', phase: 'prepare' })
  assert.deepEqual(sanitizeDiagnostic({ reason: 'disabled', phase: 'prepare', obstruction: 'modal-scope' }), { reason: 'disabled', phase: 'prepare' })
  assert.deepEqual(sanitizeDiagnostic({ reason: 'obscured', phase: 'prepare', get obstruction() { throw Error('getter evaluated') } }), { reason: 'obscured', phase: 'prepare' })
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { safePublicUrl, sanitizePublicResult, sanitizePublicError } from '../privacy.mjs'

const id = 'c66d2cdc-96bc-42c7-b211-4e0da2ce08a6'
const pageId = 'AABBCCDDEEFF00112233445566778899'
const marker = 'synthetic-private-marker'
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAEElEQVR4AQEFAPr/AP////8J+wP9o9FJCgAAAABJRU5ErkJggg=='
const actionResult = { completed: 1, failedIndex: null, delivery: 'delivered_verified',
  results: [{ index: 0, type: 'fill', ref: 'e1', delivery: 'delivered_verified', verification: { scope: 'element', status: 'matched' } }],
  recovery: { retry: 'none', observe: false, reason: 'completed' } }
const waitResult = { matched: true, elapsedMs: 5, pageId, lastObserved: { state: 'value', exists: true, valueMatches: true } }
const absent = (value, strings = [marker]) => {
  const serialized = JSON.stringify(value)
  for (const item of strings) assert.equal(serialized.includes(item), false, 'Private synthetic content escaped the projection')
}

test('normal PNG bytes survive every projection while protected images remain suppressed', () => {
  const screenshot = { mimeType: 'image/png', data: png }
  assert.ok(png.includes('//'))
  const once = sanitizePublicResult(screenshot)
  assert.deepEqual(once, screenshot)
  assert.deepEqual(sanitizePublicResult(once), screenshot)
  assert.deepEqual(sanitizePublicResult(screenshot, { sensitive: true }), {})
  absent(sanitizePublicResult({ mimeType: 'image/png', data: `https://example.test/${marker}` }))
  assert.equal(sanitizePublicResult({ data: '//example.test/private' }).data, '[invalid URL]')
})

test('URL metadata exposes origins without unknown token paths, credentials, query or fragments', () => {
  for (const value of [`https://example.test/${marker}?key=${marker}#${marker}`, `https://user:${marker}@example.test:8443/unknown/${marker}`]) {
    const result = safePublicUrl(value)
    absent(result)
    assert.ok(['https://example.test', 'https://example.test:8443'].includes(result))
  }
  assert.equal(safePublicUrl('about:blank'), 'about:blank')
  assert.equal(safePublicUrl('about:srcdoc'), 'about:srcdoc')
  for (const value of [`about:blank#${marker}`, `data:text/plain,${marker}`, `file:///tmp/${marker}`, `javascript:${marker}`]) assert.equal(safePublicUrl(value), '[redacted URL]')
  for (const value of [null, {}, marker, '/relative/path']) assert.equal(safePublicUrl(value), '[invalid URL]')
})

test('normal projection sanitizes nested URL fields and text while retaining useful form values', () => {
  const url = `https://example.test/unclassified/${marker}?other=${marker}`
  const input = { url, pages: [{ url, title: `Continue at ${url}` }], frames: [{ url }],
    dialog: { message: `Open ${url}`, url }, elements: [{ name: 'Display name', value: 'Alex', helperText: `See ${url}`, href: url, options: [{ value: 'dark', label: 'Dark theme' }] }],
    previewSrc: `data:text/plain,${marker}`, nextURL: url, label: 'Account settings', nested: { text: `Link (${url})` } }
  const output = sanitizePublicResult(input)
  absent(output)
  assert.equal(output.url, 'https://example.test')
  assert.equal(output.nextURL, 'https://example.test')
  assert.equal(output.previewSrc, '[redacted URL]')
  assert.equal(output.elements[0].value, 'Alex')
  assert.deepEqual(output.elements[0].options, [{ value: 'dark', label: 'Dark theme' }])
  assert.equal(output.label, 'Account settings')
  assert.equal(output.dialog.message, 'Open https://example.test')
  absent(sanitizePublicResult({ text: `Go https:example.test/${marker} or //example.test/${marker}` }))
})

test('sensitive projection removes transformed content and all page-controlled string channels', () => {
  const separated = '7 2 9 4 6 1', reversed = '164927'
  const input = { taskId: id, pageId, observationId: id, phaseId: id, documentId: id, state: 'agent-active', sensitive: true,
    text: separated, title: reversed, label: marker, reason: marker, unknown: { enabled: true, text: marker },
    elements: [{ ref: 'e1', tag: 'input', type: 'text', role: marker, name: separated, value: reversed, placeholder: marker,
      helperText: marker, errorText: marker, validationMessage: marker, pattern: marker, min: marker, max: marker, step: marker,
      disabled: false, availableActions: ['fill', marker], options: [{ value: marker, label: marker }] }],
    dialog: { type: 'prompt', message: marker, defaultPrompt: marker, url: `https://example.test/${marker}` },
    frames: [{ frameId: pageId, parentFrameId: null, name: separated, url: `https://example.test/${marker}` }],
    downloads: [{ guid: id, name: reversed, path: marker, state: 'completed', totalBytes: 12 }],
    counts: { returnedElements: 1, text: 12 }, pagination: { offset: 0, nextOffset: null, query: marker } }
  const output = sanitizePublicResult(input, { sensitive: true })
  absent(output, [marker, separated, reversed])
  assert.deepEqual(output.elements, [{ ref: 'e1', tag: 'input', type: 'text', disabled: false, availableActions: ['fill'] }])
  assert.equal(output.phaseId, id)
  assert.equal(output.documentId, id)
  assert.deepEqual(output.dialog, { type: 'prompt', url: 'https://example.test' })
  assert.deepEqual(output.counts, { returnedElements: 1, text: 12 })
  assert.equal(output.unknown, undefined)
})

test('sensitive identifiers, enum values and unknown keys cannot become text escape hatches', () => {
  const input = { taskId: marker, observationId: marker, phaseId: marker, documentId: marker, pageId: marker,
    ref: marker, state: marker, type: marker, role: marker, owner: marker, [marker]: true,
    text: 729461, value: 729461, name: 729461, custom: false, customCount: 729461 }
  const output = sanitizePublicResult(input, { sensitive: true })
  absent(output)
  assert.deepEqual(output, {})
})

test('value-free action and wait receipts survive with extra fields removed', () => {
  const input = { actionResult: { ...actionResult, value: marker }, waitResult: { ...waitResult, value: marker, lastObserved: { ...waitResult.lastObserved, actual: marker } } }
  const output = sanitizePublicResult(input, { sensitive: true })
  assert.deepEqual(output, { actionResult, waitResult })
  absent(output)
  assert.deepEqual(sanitizePublicResult({ waitResult: { ...waitResult, pageId: marker } }, { sensitive: true }), {})
})

test('errors use only fixed messages and codes in both modes, retaining safe delivery receipts', () => {
  for (const sensitive of [false, true]) {
    const output = sanitizePublicError(Object.assign(new Error(marker), { code: 'ACTION_FAILED', actionResult: { ...actionResult, secret: marker }, waitResult, stack: marker, secretRef: marker }), { sensitive })
    absent(output)
    assert.equal(output.code, 'ACTION_FAILED')
    assert.deepEqual(output.actionResult, actionResult)
    assert.deepEqual(output.waitResult, waitResult)
    const unknown = sanitizePublicError({ message: marker, code: marker, details: marker }, { sensitive })
    absent(unknown)
    assert.deepEqual(unknown, { error: 'Browser operation failed.', code: 'BROKER_ERROR' })
  }
})

test('projection is detached from inputs, handles cycles, and does not invoke property getters', () => {
  let read = false
  const input = { pages: [{ pageId, title: 'Normal title' }], actionResult: structuredClone(actionResult), secretRef: marker }
  Object.defineProperty(input, 'injected', { enumerable: true, get() { read = true; return marker } })
  input.cycle = input
  const output = sanitizePublicResult(input)
  assert.equal(read, false)
  assert.equal(output.cycle, undefined)
  assert.equal(output.secretRef, undefined)
  output.pages[0].title = 'Changed'
  output.actionResult.results[0].verification.status = 'mismatch'
  assert.equal(input.pages[0].title, 'Normal title')
  assert.equal(input.actionResult.results[0].verification.status, 'matched')
})

test('ordinary images survive and sensitive projections never carry image data', () => {
  const input = { mimeType: 'image/png', data: png, screenshot: { mimeType: 'image/png', data: marker } }
  assert.equal(sanitizePublicResult(input).data, input.data)
  const output = sanitizePublicResult(input, { sensitive: true })
  absent(output)
  assert.deepEqual(output, {})
})

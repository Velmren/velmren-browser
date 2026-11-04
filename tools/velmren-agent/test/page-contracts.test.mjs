import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import vm from 'node:vm'
import { AgentPage } from '../page.mjs'
import { sanitizeActionResult, sanitizeWaitResult, unknownActionResult } from '../action-result.mjs'

function fixture(specs = [{}], text = '') {
  const browser = new EventEmitter(), calls = [], observers = new Set()
  const document = { body: { innerText: text }, elementFromPoint: () => elements.find(el => el === document.point) ?? elements[0] }
  const elements = specs.map(spec => {
    const el = { tagName: 'INPUT', type: 'text', value: '', innerText: '', isConnected: true, ownerDocument: document,
      labels: [], options: [], files: [], hidden: false, disabled: false, readOnly: false,
      getAttribute(name) { return name === 'aria-label' ? this.name ?? '' : null },
      matches() { return this.disabled }, closest() { return null },
      getBoundingClientRect() { return { x: 0, y: 0, width: this.hidden ? 0 : 20, height: 20 } },
      scrollIntoView() { document.point = this }, contains() { return false },
      focus() { document.focused = this }, select() {}, dispatchEvent() { this.onChange?.() }, ...spec }
    return el
  })
  document.querySelectorAll = () => elements
  const context = vm.createContext({ document, location: { href: 'http://fixture.test/' },
    getComputedStyle: el => ({ visibility: el.hidden ? 'hidden' : 'visible', display: 'block' }),
    innerWidth: 1280, innerHeight: 800, requestAnimationFrame: queueMicrotask,
    setTimeout, clearTimeout, setInterval, clearInterval, Event: class {},
    MutationObserver: class { constructor(callback) { this.callback = callback } observe() { observers.add(this) } disconnect() { observers.delete(this) } }
  })
  browser.send = async (method, params) => {
    calls.push({ method, params })
    if (method === 'Page.createIsolatedWorld') return { executionContextId: 1 }
    if (method === 'Runtime.evaluate') {
      try { return { result: { value: await vm.runInContext(params.expression, context) } } }
      catch (error) { return { exceptionDetails: { text: error.message } } }
    }
    if (method === 'Input.insertText') { document.focused.value = params.text; document.focused.onChange?.() }
    return {}
  }
  const page = new AgentPage(browser, 'page', 'session')
  return { page, browser, document, elements, calls, observers, context }
}

test('observation exact limits are complete and overflow is explicit without fabricated refs', async () => {
  const f = fixture(Array.from({ length: 150 }, () => ({ name: 'n'.repeat(200), value: 'v'.repeat(300) })), 't'.repeat(10000))
  const exact = await f.page.observe()
  assert.equal(exact.complete, true); assert.equal(exact.truncated, false)
  assert.equal(exact.elements.length, 150); assert.equal(exact.counts.eligibleElements, 150)
  assert.equal(exact.coverage.scope, 'main_frame'); assert.equal(exact.coverage.childFrames, 'excluded')
  f.elements.push({ ...f.elements[0] }); f.elements[0].name += 'n'; f.elements[0].value += 'v'; f.document.body.innerText += 't'
  const overflow = await f.page.observe()
  assert.equal(overflow.complete, false); assert.equal(overflow.truncated, true)
  assert.equal(overflow.counts.eligibleElements, 151); assert.equal(overflow.counts.returnedElements, 150)
  assert.equal(overflow.counts.truncatedNames, 1); assert.equal(overflow.counts.truncatedValues, 1)
  assert.equal(overflow.counts.text, 10001); assert.equal(overflow.text.length, 10000)
  assert.equal(f.context.__velmrenAgent.refs.size, 150)
  assert.equal(f.context.__velmrenAgent.refs.get('e150'), f.elements[149]); assert.equal(f.context.__velmrenAgent.refs.has('e151'), false)
})

test('options, files, and password redaction report bounded observation coverage', async () => {
  const f = fixture([{ tagName: 'SELECT', options: Array.from({ length: 51 }, (_, i) => ({ value: 'v'.repeat(i === 0 ? 301 : 1), label: 'n'.repeat(i === 0 ? 201 : 1) })) },
    { type: 'file', hidden: true, files: Array.from({ length: 11 }, () => ({ name: 'a.txt', size: 4 })) }, { type: 'password', value: 'sensitive'.repeat(100) }])
  const result = await f.page.observe()
  assert.equal(result.truncated, true); assert.equal(result.counts.omittedOptions, 1); assert.equal(result.counts.omittedFiles, 1)
  assert.equal(result.counts.truncatedOptionLabels, 1); assert.equal(result.counts.truncatedOptionValues, 1)
  assert.equal(result.elements[0].optionCount, 51); assert.equal(result.elements[0].options.length, 50)
  assert.deepEqual(Array.from(result.elements[1].availableActions), ['uploadFiles'])
  assert.equal(result.elements[2].value, '[redacted]'); assert.equal(JSON.stringify(result).includes('sensitive'), false)
})

test('advertised capabilities and validation reject buttons, files, readonly, disabled, and hidden fields for fill', async () => {
  for (const spec of [{ tagName: 'BUTTON', type: 'submit' }, { type: 'button' }, { type: 'file' }, { readOnly: true }, { disabled: true }, { type: 'file', hidden: true }]) {
    const f = fixture([spec]), observation = await f.page.observe()
    assert.equal(observation.elements[0].availableActions.includes('fill'), false)
    await assert.rejects(f.page.act(observation.observationId, [{ type: 'fill', ref: 'e1', value: 'secret' }]), error => {
      assert.equal(error.actionResult.delivery, 'not_delivered'); assert.equal(error.actionResult.failedIndex, 0)
      assert.equal(error.actionResult.recovery.retry, 'failed_action_only'); return true
    })
    assert.equal(f.calls.some(call => call.method.startsWith('Input.')), false)
  }
})

test('a partially completed batch permits only the known undelivered failed action', async () => {
  const f = fixture([{}, { tagName: 'BUTTON', type: 'submit' }]), observation = await f.page.observe()
  await assert.rejects(f.page.act(observation.observationId, [{ type: 'fill', ref: 'e1', value: 'private-value' }, { type: 'fill', ref: 'e2', value: 'private-value' }]), error => {
    const result = error.actionResult
    assert.equal(result.completed, 1); assert.equal(result.failedIndex, 1); assert.equal(result.delivery, 'not_delivered')
    assert.equal(result.results[0].delivery, 'delivered_verified'); assert.equal(result.results[1].delivery, 'not_delivered')
    assert.equal(result.recovery.retry, 'failed_action_only'); assert.equal(JSON.stringify(result).includes('private-value'), false)
    assert.deepEqual(sanitizeActionResult(result), JSON.parse(JSON.stringify(result))); return true
  })
  assert.equal(f.calls.filter(call => call.method === 'Input.insertText').length, 1)
})

test('dispatch exception is uncertain, never replayed, and does not leak a supplied value', async () => {
  const f = fixture(), observation = await f.page.observe(), send = f.browser.send
  f.browser.send = async (method, params) => {
    if (method === 'Input.insertText') { f.calls.push({ method }); throw new Error('Disconnected with private-value') }
    return send(method, params)
  }
  await assert.rejects(f.page.act(observation.observationId, [{ type: 'fill', ref: 'e1', value: 'private-value' }]), error => {
    assert.equal(error.actionResult.delivery, 'delivery_uncertain'); assert.equal(error.actionResult.recovery.retry, 'none')
    assert.equal(error.message.includes('private-value'), false); assert.equal(JSON.stringify(error.actionResult).includes('private-value'), false); return true
  })
  assert.equal(f.calls.filter(call => call.method === 'Input.insertText').length, 1)
})

test('a transport failure during preparation is uncertain even before trusted input starts', async () => {
  const f = fixture(), observation = await f.page.observe(), send = f.browser.send
  let evaluations = 0
  f.browser.send = async (method, params) => {
    if (method === 'Runtime.evaluate' && ++evaluations === 2) throw new Error('Protocol request timed out')
    return send(method, params)
  }
  await assert.rejects(f.page.act(observation.observationId, [{ type: 'fill', ref: 'e1', value: 'private' }]), error => {
    assert.equal(error.actionResult.completed, 0); assert.equal(error.actionResult.delivery, 'delivery_uncertain')
    assert.equal(error.actionResult.recovery.retry, 'none'); return true
  })
  assert.equal(f.calls.some(call => call.method.startsWith('Input.')), false)
})

test('fill/select readback is element-only and reports mismatch or replacement without replay', async () => {
  for (const [type, spec, status] of [['fill', { type: 'password' }, 'matched'], ['fill', { onChange() { this.value = 'normalized' } }, 'mismatch'],
    ['fill', { onChange() { this.isConnected = false } }, 'unavailable'], ['select', { tagName: 'SELECT', options: [{ value: 'expected', label: 'Expected' }] }, 'matched'],
    ['select', { tagName: 'SELECT', options: [{ value: 'expected', label: 'Expected' }], onChange() { this.value = '' } }, 'mismatch']]) {
    const f = fixture([spec]), observation = await f.page.observe()
    const result = await f.page.act(observation.observationId, [{ type, ref: 'e1', value: 'expected' }])
    const action = result.actionResult.results[0]
    assert.equal(action.verification.scope, 'element'); assert.equal(action.verification.status, status)
    assert.equal(action.delivery, status === 'matched' ? 'delivered_verified' : 'delivered_unverified')
    assert.equal(result.completed, 1); assert.equal(result.actionResult.recovery.retry, 'none')
    assert.equal(JSON.stringify(result.actionResult).includes('expected'), false)
    if (spec.type === 'password') assert.equal(JSON.stringify(result.observation).includes('expected'), false)
  }
})

test('wait supports text, retained states, and property-only password changes without exposing values', async () => {
  const f = fixture([{ type: 'password', value: 'initial' }], 'Ready'), observation = await f.page.observe()
  const predicate = { observationId: observation.observationId, ref: 'e1', state: 'value', value: 'private-value' }
  setTimeout(() => { f.elements[0].value = 'private-value' }, 10)
  const result = await f.page.wait({ predicate, timeoutMs: 500 })
  assert.equal(result.matched, true); assert.equal(result.lastObserved.valueMatches, true)
  assert.equal(JSON.stringify(result).includes('private-value'), false); assert.ok(result.elapsedMs <= 500)
  for (const state of ['exists', 'enabled', 'visible']) assert.equal((await f.page.wait({ predicate: { ...predicate, state, value: undefined }, timeoutMs: 100 })).matched, true)
  assert.equal((await f.page.wait('Ready', 100)).matched, true)
  assert.equal(f.observers.size, 1, 'only the observation revision watcher remains')
})

test('wait timeout has bounded boolean diagnostics and does not dispatch input', async () => {
  const f = fixture(), observation = await f.page.observe()
  const result = await f.page.wait({ predicate: { observationId: observation.observationId, ref: 'e1', state: 'value', value: 'absent-secret' }, timeoutMs: 180 })
  assert.equal(result.matched, false); assert.equal(result.lastObserved.valueMatches, false); assert.ok(result.elapsedMs <= 180)
  assert.equal(JSON.stringify(result).includes('absent-secret'), false)
  assert.equal(f.calls.some(call => call.method.startsWith('Input.')), false)
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.equal(f.observers.size, 1)
})

test('wait refuses unknown/replaced refs, stale observations and changed documents', async () => {
  for (const change of ['unknown', 'detached', 'observation', 'document']) {
    const f = fixture(), observation = await f.page.observe()
    const predicate = { observationId: observation.observationId, ref: change === 'unknown' ? 'e99' : 'e1', state: 'value', value: 'future' }
    if (change === 'detached') f.elements[0].isConnected = false
    if (change === 'observation') predicate.observationId = 'stale'
    if (change === 'document') setTimeout(() => { f.page.epoch++ }, 10)
    await assert.rejects(f.page.wait({ predicate, timeoutMs: 500 }), /reference|observation|Document changed/)
  }
})

test('pause and timeout stop waits promptly even when the transport stops answering', async () => {
  for (const cancel of [true, false]) {
    const f = fixture(); await f.page.observe()
    let active = true
    f.browser.send = () => new Promise(() => {})
    const started = performance.now()
    if (cancel) setTimeout(() => { active = false }, 10)
    const waiting = f.page.wait({ text: 'future', timeoutMs: cancel ? 500 : 100 }, () => active)
    if (cancel) await assert.rejects(waiting, /state or page session changed/)
    else assert.equal((await waiting).matched, false)
    assert.ok(performance.now() - started < 400)
  }
})

test('action metadata sanitizer whitelists fields and rejects unsafe retry or unbounded payloads', () => {
  const unknown = unknownActionResult()
  assert.deepEqual(sanitizeActionResult({ ...unknown, value: 'private', error: 'private' }), unknown)
  assert.equal(sanitizeActionResult({ ...unknown, completed: -1 }), undefined)
  assert.equal(sanitizeActionResult({ ...unknown, results: Array(21).fill({}) }), undefined)
  assert.equal(sanitizeActionResult({ ...unknown, recovery: { retry: 'failed_action_only', observe: true, reason: 'transport_unknown' } }), undefined)
  assert.equal(sanitizeActionResult({ ...unknown, results: [{ index: 0, type: 'fill', ref: 'secret', delivery: 'unknown' }] }), undefined)
  const waited = { matched: false, elapsedMs: 123, lastObserved: { state: 'value', exists: true, valueMatches: false }, pageId: 'page' }
  assert.deepEqual(sanitizeWaitResult({ ...waited, value: 'secret', lastObserved: { ...waited.lastObserved, value: 'secret' } }), waited)
  assert.equal(sanitizeWaitResult({ ...waited, elapsedMs: 15001 }), undefined)
  assert.equal(sanitizeWaitResult({ ...waited, lastObserved: { state: 'value', valueMatches: 'secret' } }), undefined)
})

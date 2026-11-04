import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import * as helpers from '../form-controls.mjs'

const definitions = Object.values(helpers).map(fn => fn.toString()).join('\n')

function fixture(spec = {}) {
  const events = [], document = { getElementById: id => descriptions[id], elementFromPoint: () => element }
  const descriptions = { help: { textContent: 'h'.repeat(1500) }, error: { textContent: 'e'.repeat(1500) } }
  const element = { tagName: 'INPUT', type: 'text', value: '', isConnected: true, ownerDocument: document,
    attributes: {}, disabled: false, checked: false, indeterminate: false,
    getAttribute(name) { return this.attributes[name] ?? null },
    hasAttribute(name) { return Object.hasOwn(this.attributes, name) },
    matches() { return !!this.disabled }, getRootNode() { return document },
    getBoundingClientRect() { return { x: 10, y: 20, width: 30, height: 40 } },
    scrollIntoView() { events.push('scroll') }, focus() { events.push('focus') }, select() { events.push('select') },
    contains() { return false }, dispatchEvent(event) { events.push(event.type); this.onEvent?.(event) }, ...spec }
  class Input {
    set value(value) { this.assigned = value; this._value = value === '2024-02-30' ? '' : value.replace(/T12:00:00$/, 'T12:00') }
    get value() { return this._value || '' }
  }
  class Select { set value(value) { this.assigned = value; this._value = value } get value() { return this._value || '' } }
  element.cloneNode = () => Object.assign(new Input(), { validity: { valid: true }, ...element.probe })
  const context = vm.createContext({ document, HTMLInputElement: Input, HTMLSelectElement: Select,
    Event: class { constructor(type, options) { Object.assign(this, { type }, options) } },
    __velmrenAgent: { refs: new Map([['e1', element]]) },
    getComputedStyle: () => ({ visibility: 'visible', display: 'block' }),
    innerWidth: 1280, innerHeight: 800, requestAnimationFrame: queueMicrotask })
  vm.runInContext(definitions, context)
  const call = (fn, arg = { ref: 'e1' }) => {
    context.arg = arg
    return vm.runInContext(`${fn}(arg)`, context)
  }
  return { element, document, descriptions, context, events, call }
}

test('serialized helpers advertise native temporal fill and explicit checked actions', () => {
  for (const type of ['date', 'time', 'datetime-local', 'month', 'week']) {
    const f = fixture({ type })
    assert.equal(f.call('elementCapabilities', f.element).nativeValueInput, true)
    assert.ok(f.call('elementCapabilities', f.element).availableActions.includes('fill'))
    f.element.readOnly = true
    assert.ok(!f.call('elementCapabilities', f.element).availableActions.includes('fill'))
  }
  for (const spec of [{ type: 'checkbox' }, { type: 'radio' }, ...['checkbox', 'switch', 'radio'].map(role => ({ tagName: 'DIV', attributes: { role, 'aria-checked': 'false' } }))]) {
    const f = fixture(spec)
    assert.ok(f.call('elementCapabilities', f.element).availableActions.includes('setChecked'))
  }
  const f = fixture({ attributes: { 'aria-selected': 'true' } })
  assert.equal(f.call('controlState', f.element).ariaSelected, true)
  assert.ok(!f.call('elementCapabilities', f.element).availableActions.includes('setChecked'))
})

test('checked preparation is idempotent and never mutates other controls', async () => {
  const f = fixture({ type: 'checkbox', checked: true, indeterminate: true })
  const unrelated = { checked: false }
  f.context.__velmrenAgent.refs.set('marketing', unrelated)
  assert.equal((await f.call('prepareElement', { ref: 'e1', type: 'setChecked', checked: true })).noOp, true)
  assert.equal(f.element.indeterminate, true)
  assert.equal(unrelated.checked, false)
  assert.equal(f.call('verifyElementValue', { ref: 'e1', type: 'setChecked', checked: true }).status, 'matched')
  assert.equal((await f.call('prepareElement', { ref: 'e1', type: 'setChecked', checked: false })).noOp, undefined)
  assert.equal(f.element.checked, true, 'Preparation must not click or assign checked')
})

test('radio refusal and malformed checked state happen before side effects', async () => {
  const f = fixture({ type: 'radio', checked: true })
  await assert.rejects(f.call('prepareElement', { ref: 'e1', type: 'setChecked', checked: false }), /Cannot unset/)
  await assert.rejects(f.call('prepareElement', { ref: 'e1', type: 'setChecked', checked: 'true' }), /boolean/)
  assert.deepEqual(f.events, [])
})

test('ARIA mixed state must change and verification returns status only', async () => {
  const f = fixture({ tagName: 'DIV', attributes: { role: 'checkbox', 'aria-checked': 'mixed' } })
  const state = f.call('controlState', f.element)
  assert.equal(state.checked, 'mixed'); assert.equal(state.indeterminate, true)
  assert.equal((await f.call('prepareElement', { ref: 'e1', type: 'setChecked', checked: false })).noOp, undefined)
  assert.deepEqual(JSON.parse(JSON.stringify(f.call('verifyElementValue', { ref: 'e1', type: 'setChecked', checked: false }))), { scope: 'element', status: 'mismatch' })
  f.element.attributes['aria-checked'] = 'false'
  assert.equal(f.call('verifyElementValue', { ref: 'e1', type: 'setChecked', checked: false }).status, 'matched')
  f.element.isConnected = false
  assert.equal(f.call('verifyElementValue').status, 'unavailable')
})

test('deep shadow and assigned-slot hit testing accepts descendants and rejects overlays', async () => {
  const f = fixture({ tagName: 'BUTTON' })
  const host = { shadowRoot: { elementFromPoint: () => nestedHost } }
  const nestedHost = { shadowRoot: { elementFromPoint: () => child } }
  const slot = { parentElement: f.element }
  const child = { assignedSlot: slot }
  f.document.elementFromPoint = () => host
  assert.equal((await f.call('prepareElement', { ref: 'e1', type: 'click' })).x, 25)
  nestedHost.shadowRoot.elementFromPoint = () => ({})
  await assert.rejects(f.call('prepareElement', { ref: 'e1', type: 'click' }), /obscured/)
})

test('inert ancestry crosses shadow hosts and slots', async () => {
  for (const ancestry of [
    { getRootNode: () => ({ host: { inert: true } }) },
    { assignedSlot: { parentElement: { inert: true } } },
  ]) {
    const f = fixture(ancestry)
    assert.equal(f.call('elementCapabilities', f.element).disabled, true)
    await assert.rejects(f.call('prepareElement', { ref: 'e1', type: 'fill', value: 'text' }), /disabled/)
    assert.deepEqual(f.events, [])
  }
})

test('malformed, sanitized-away, and constraint-invalid dates never mutate or focus', async () => {
  for (const [value, probe] of [['02/29/2024'], ['2024-02-30'], ['2024-02-29', { validity: { valid: false } }]]) {
    const f = fixture({ type: 'date', value: '2024-01-01', probe })
    await assert.rejects(f.call('prepareElement', { ref: 'e1', type: 'fill', value }), /Date\/time value/)
    assert.throws(() => f.call('applyFormValue', { ref: 'e1', type: 'fill', value }), /Date\/time value/)
    assert.equal(f.element.value, '2024-01-01'); assert.deepEqual(f.events, [])
  }
})

test('native date preparation avoids select and returns normalized verification target', async () => {
  const f = fixture({ type: 'datetime-local' })
  const prepared = await f.call('prepareElement', { ref: 'e1', type: 'fill', value: '2024-02-29T12:00:00' })
  assert.equal(prepared.inputMode, 'native'); assert.equal(prepared.expectedValue, '2024-02-29T12:00')
  assert.deepEqual(f.events, ['scroll', 'focus'])
  const result = f.call('applyFormValue', { ref: 'e1', type: 'fill', value: '2024-02-29T12:00:00' })
  assert.equal(result.expectedValue, '2024-02-29T12:00'); assert.equal(f.element.assigned, result.expectedValue)
  assert.deepEqual(f.events, ['scroll', 'focus', 'input', 'change'])
})

test('explicit empty fill clears a required temporal field without hiding valueMissing', async () => {
  const f = fixture({ type: 'date', required: true, probe: { validity: { valid: false, valueMissing: true } } })
  assert.equal((await f.call('prepareElement', { ref: 'e1', type: 'fill', value: '' })).expectedValue, '')
  assert.equal(f.call('applyFormValue', { ref: 'e1', type: 'fill', value: '' }).expectedValue, '')
  assert.equal(f.element.assigned, '')
})

test('ordinary text keeps trusted insertText preparation and cannot enter native setter path', async () => {
  const f = fixture()
  assert.equal((await f.call('prepareElement', { ref: 'e1', type: 'fill', value: 'text' })).inputMode, undefined)
  assert.deepEqual(f.events, ['scroll', 'focus', 'select'])
  assert.throws(() => f.call('applyFormValue', { ref: 'e1', type: 'fill', value: 'text' }), /does not support native/)
  assert.equal(f.element.value, '')
})

test('select validates disabled options and revalidates before applying', async () => {
  const f = fixture({ tagName: 'SELECT', options: [{ value: 'allowed' }, { value: 'blocked', disabled: true }, { value: 'grouped', parentElement: { tagName: 'OPTGROUP', disabled: true } }] })
  for (const value of ['blocked', 'grouped', 'missing']) await assert.rejects(f.call('prepareElement', { ref: 'e1', type: 'select', value }), /unavailable/)
  await f.call('prepareElement', { ref: 'e1', type: 'select', value: 'allowed' })
  f.element.options[0].disabled = true
  assert.throws(() => f.call('applyFormValue', { ref: 'e1', type: 'select', value: 'allowed' }), /does not support/)
  assert.ok(!f.events.includes('input'))
})

test('metadata bounds descriptions, retains constraints, and never reads password value', () => {
  const f = fixture({ type: 'password', required: true, readOnly: true, minLength: 8, maxLength: 64,
    pattern: '[A-Z]{2}  [0-9]{2}', validationMessage: 'private password value', validity: { valid: false, customError: true },
    attributes: { 'aria-describedby': 'help', 'aria-errormessage': 'error', 'aria-invalid': 'true' } })
  Object.defineProperty(f.element, 'value', { get() { throw new Error('Password must not be read for metadata') } })
  const metadata = f.call('fieldMetadata', f.element)
  assert.equal(metadata.validationMessage, '[redacted]'); assert.equal(metadata.helperText, '[redacted]'); assert.equal(metadata.errorText, '[redacted]')
  assert.equal(metadata.validity.customError, true); assert.equal(metadata.pattern, '[A-Z]{2}  [0-9]{2}')
  assert.equal(metadata.minLength, 8); assert.equal(metadata.required, true)
  assert.ok(!JSON.stringify(metadata).includes('private'))
  f.element.type = 'text'; f.element.validationMessage = 'x'.repeat(500)
  const ordinary = f.call('fieldMetadata', f.element)
  assert.equal(ordinary.validationMessage.length, 300); assert.equal(ordinary.helperText.length, 1000); assert.equal(ordinary.errorText.length, 1000)
  assert.equal(ordinary.metadataTruncation.validationMessage, true); assert.equal(ordinary.metadataTruncation.helperText, true); assert.equal(ordinary.metadataTruncation.errorText, true)
  assert.equal(ordinary.metadataTruncation.pattern, false)
  f.element.pattern = 'x'.repeat(301)
  assert.equal(f.call('fieldMetadata', f.element).metadataTruncation.pattern, true)
})

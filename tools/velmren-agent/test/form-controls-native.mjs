import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { BrowserPipe } from '../cdp.mjs'
import * as helpers from '../form-controls.mjs'

const [executable, output] = process.argv.slice(2)
if (!executable || !output) throw new Error('Usage: node test/form-controls-native.mjs BROWSER_EXE NEW_OUTPUT_DIR')
const directory = path.resolve(output)
await mkdir(path.dirname(directory), { recursive: true })
await mkdir(directory, { recursive: false })
const definitions = Object.values(helpers).map(fn => fn.toString()).join('\n')
const checks = [], report = { checks }
let browser
try {
  browser = await BrowserPipe.launch({ executable: path.resolve(executable), profile: path.join(directory, 'owned-profile'), args: ['--headless=new'] })
  report.browser = browser.version
  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true })
  const send = (method, params) => browser.send(method, params, sessionId)
  await send('Page.enable')
  const { frameTree } = await send('Page.getFrameTree')
  await send('Page.setDocumentContent', { frameId: frameTree.frame.id, html: `<!doctype html><meta charset="utf-8">
    <style>body{padding:20px}input,select,button,[role]{margin:8px;min-width:30px;min-height:24px} [role]{display:inline-block;border:1px solid;padding:8px}</style>
    <input id="date" type="date" value="2024-01-01" min="2024-01-01" max="2024-12-31">
    <input id="time" type="time" step="any"><input id="datetime" type="datetime-local" step="any">
    <input id="month" type="month"><input id="week" type="week"><input id="stepdate" type="date" value="2024-01-01" step="2">
    <input id="terms" type="checkbox"><input id="marketing" type="checkbox">
    <input id="radio1" type="radio" name="choice" checked><input id="radio2" type="radio" name="choice">
    <span id="switch" role="switch" aria-checked="false">Switch</span><span id="mixed" role="checkbox" aria-checked="mixed">Mixed</span>
    <select id="choice"><option value="one">One</option><option value="two">Two</option><option value="bad" disabled>Bad</option><optgroup disabled><option value="grouped">Grouped</option></optgroup></select>
    <input id="password" type="password" required minlength="8" maxlength="64" aria-describedby="help" aria-errormessage="error">
    <span id="help"></span><span id="error"></span><div id="shadow"></div>` })
  const { executionContextId } = await send('Page.createIsolatedWorld', { frameId: frameTree.frame.id, worldName: 'form-controls-native-test' })
  const evaluate = async (fn, args) => {
    const response = await send('Runtime.evaluate', { contextId: executionContextId,
      expression: `(()=>{${definitions};return (${fn.toString()})(${JSON.stringify(args) ?? ''})})()`, awaitPromise: true, returnByValue: true })
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text)
    return response.result.value
  }
  const call = (name, args) => evaluate(({ name, args }) => ({ prepareElement, applyFormValue, verifyElementValue, fieldMetadata, elementCapabilities })[name](args), { name, args })
  const pass = name => { checks.push({ name, passed: true }); console.log(`PASS ${name}`) }
  await evaluate(() => {
    globalThis.__velmrenAgent = { refs: new Map([...document.querySelectorAll('[id]')].map(el => [el.id, el])) }
    globalThis.events = []
    for (const name of ['input', 'change', 'invalid']) document.addEventListener(name, event => events.push({ type: name, id: event.target.id, trusted: event.isTrusted }), true)
    for (const id of ['switch', 'mixed']) document.getElementById(id).addEventListener('click', event => event.currentTarget.setAttribute('aria-checked', event.currentTarget.getAttribute('aria-checked') === 'true' ? 'false' : 'true'))
    const host = document.getElementById('shadow'), root = host.attachShadow({ mode: 'open' })
    root.innerHTML = '<div id="inner"></div>'
    const inner = root.getElementById('inner'), nested = inner.attachShadow({ mode: 'open' })
    nested.innerHTML = '<style>input{margin:16px;width:30px;height:30px}</style><input type="checkbox" id="deep">'
    __velmrenAgent.refs.set('deep', nested.getElementById('deep'))
  })
  for (const [ref, value] of [['date', '2024-02-29'], ['time', '12:34:56.123'], ['datetime', '2024-02-29T12:00:00'], ['month', '2024-12'], ['week', '2020-W53']]) {
    const action = { ref, type: 'fill', value }
    const prepared = await call('prepareElement', action)
    assert.equal(prepared.inputMode, 'native')
    const applied = await call('applyFormValue', action)
    assert.equal(applied.expectedValue, prepared.expectedValue)
    assert.equal((await call('verifyElementValue', { ...action, value: applied.expectedValue })).status, 'matched')
  }
  assert.equal(await evaluate(() => document.getElementById('datetime').value), '2024-02-29T12:00')
  pass('all five temporal controls use native parsing and normalized verification')

  const beforeInvalid = await evaluate(() => ({ events: events.length, value: document.getElementById('date').value }))
  for (const value of ['2024-02-30', '2023-02-29', '29/02/2024', '2024-13-01', '2025-01-01']) {
    await assert.rejects(call('prepareElement', { ref: 'date', type: 'fill', value }), /Date\/time value/)
    await assert.rejects(call('applyFormValue', { ref: 'date', type: 'fill', value }), /Date\/time value/)
  }
  assert.deepEqual(await evaluate(() => ({ events: events.length, value: document.getElementById('date').value })), beforeInvalid)
  for (const [ref, value] of [['time', '24:00'], ['datetime', '2024-02-29T12:00Z'], ['month', '2024-13'], ['week', '2021-W53'], ['stepdate', '2024-01-02']]) await assert.rejects(call('applyFormValue', { ref, type: 'fill', value }), /Date\/time value/)
  pass('invalid calendar values, locale strings, min/max, week and step mismatches leave fields unchanged')

  await evaluate(() => { document.getElementById('date').required = true })
  assert.equal((await call('applyFormValue', { ref: 'date', type: 'fill', value: '' })).expectedValue, '')
  assert.equal(await evaluate(() => fieldMetadata(document.getElementById('date')).validity.valueMissing), true)
  pass('explicit empty date fill clears a required field while retaining valueMissing metadata')

  const setChecked = async (ref, checked) => {
    const action = { ref, type: 'setChecked', checked }, prepared = await call('prepareElement', action)
    if (!prepared.noOp) for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x: prepared.x, y: prepared.y, button: 'left', clickCount: 1 })
    assert.equal((await call('verifyElementValue', action)).status, 'matched')
    return prepared
  }
  await setChecked('terms', true)
  const once = await evaluate(() => events.filter(event => event.id === 'terms'))
  assert.equal((await setChecked('terms', true)).noOp, true)
  assert.deepEqual(await evaluate(() => events.filter(event => event.id === 'terms')), once)
  assert.ok(once.every(event => event.trusted))
  assert.equal(await evaluate(() => document.getElementById('marketing').checked), false)
  await setChecked('terms', false)
  pass('trusted checkbox click is idempotent and leaves unrelated marketing checkbox unchanged')

  await assert.rejects(call('prepareElement', { ref: 'radio1', type: 'setChecked', checked: false }), /Cannot unset/)
  await setChecked('radio2', true)
  assert.equal(await evaluate(() => document.getElementById('radio1').checked), false)
  assert.equal((await setChecked('radio2', true)).noOp, true)
  pass('native radios use browser group semantics and reject explicit unsetting')

  await setChecked('switch', true)
  assert.equal((await setChecked('switch', true)).noOp, true)
  await setChecked('mixed', true)
  await setChecked('mixed', false)
  pass('ARIA switch and mixed checkbox verify their resulting checked state')

  await setChecked('deep', true)
  await evaluate(() => { document.getElementById('shadow').inert = true })
  await assert.rejects(call('prepareElement', { ref: 'deep', type: 'setChecked', checked: false }), /disabled/)
  pass('nested shadow hit testing and composed inert ancestry work in native Chromium')

  await call('prepareElement', { ref: 'choice', type: 'select', value: 'two' })
  assert.equal((await call('applyFormValue', { ref: 'choice', type: 'select', value: 'two' })).expectedValue, 'two')
  for (const value of ['bad', 'grouped']) await assert.rejects(call('applyFormValue', { ref: 'choice', type: 'select', value }), /unavailable/)
  const selected = await evaluate(() => ({ value: document.getElementById('choice').value, events: events.filter(event => event.id === 'choice').map(event => event.type) }))
  assert.deepEqual(selected, { value: 'two', events: ['input', 'change'] })
  pass('select uses the native setter and emits input/change after validation')

  const passwordMetadata = await evaluate(() => {
    const password = document.getElementById('password')
    password.value = 'SYNTHETIC_PRIVATE_PASSWORD'
    password.setCustomValidity(`Invalid: ${password.value}`)
    document.getElementById('help').textContent = password.value
    document.getElementById('error').textContent = password.value
    return fieldMetadata(password)
  })
  assert.equal(passwordMetadata.validity.customError, true)
  assert.equal(passwordMetadata.minLength, 8); assert.equal(passwordMetadata.maxLength, 64)
  assert.equal(passwordMetadata.validationMessage, '[redacted]'); assert.equal(passwordMetadata.helperText, '[redacted]'); assert.equal(passwordMetadata.errorText, '[redacted]')
  assert.ok(!JSON.stringify(passwordMetadata).includes('SYNTHETIC_PRIVATE_PASSWORD'))
  pass('password metadata retains validity and constraints while redacting site-echoed secrets')
  report.passed = true
} catch (error) {
  report.passed = false; report.error = error.stack
  throw error
} finally {
  await browser?.close()
  await writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2))
}

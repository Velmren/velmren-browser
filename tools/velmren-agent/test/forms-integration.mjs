// node test/forms-integration.mjs BROWSER_EXE NEW_OUTPUT_DIR [--agent-directory=DIR] [--lang=en-US]
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { startFormsFixture } from './forms-fixture.mjs'

const args = process.argv.slice(2), positions = args.filter(x => !x.startsWith('--'))
assert.equal(positions.length, 2)
assert.ok(args.every(x => !x.startsWith('--') || x.startsWith('--agent-directory=') || x.startsWith('--lang=')))
const [executable, outputArgument] = positions
const directory = path.resolve(args.find(x => x.startsWith('--agent-directory='))?.slice(18) ?? fileURLToPath(new URL('../', import.meta.url)))
const language = args.find(x => x.startsWith('--lang='))?.slice(7) ?? 'en-US'
const output = path.resolve(outputArgument)
await mkdir(path.dirname(output), { recursive: true }); await mkdir(output)
const report = { passed: false, language, checks: [], cleanup: {} }
let fixture, app, client, task, failure
const check = name => { report.checks.push(name); console.log(`PASS ${name}`) }
async function call(name, values = {}, expectError = false) {
  const response = await client.callTool({ name: `velmren_${name}`, arguments: { ...(task ? { taskId: task.taskId } : {}), ...values } }, undefined, { timeout: 40000 })
  const value = JSON.parse(response.content.find(x => x.type === 'text').text)
  assert.equal(!!response.isError, expectError, JSON.stringify(value))
  return value
}
async function observe(name, values = {}) {
  const value = await call('observe', { query: name, ...values })
  const element = value.elements.find(x => x.name === name)
  assert.ok(element, `Missing ${name}`)
  return { observation: value, element }
}
async function action(name, values) {
  const { observation, element } = await observe(name)
  return call('act', { observationId: observation.observationId, actions: [{ ref: element.ref, ...values }] })
}
try {
  fixture = await startFormsFixture()
  const { startBroker } = await import(pathToFileURL(path.join(directory, 'broker.mjs')))
  app = await startBroker({ executable: path.resolve(executable), stateDir: path.join(output, 'state'), policy: { profileMode: 'persistent', allowedOrigins: [fixture.origin, fixture.crossOrigin], webCompatibility: true }, browserArgs: ['--headless=new', `--lang=${language}`, `--accept-lang=${language}`] })
  const registration = await app.broker.rpc('admin', 'client_register', { label: 'Ordinary form acceptance' })
  const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('./multi-agent-mcp-entry.mjs', import.meta.url)), directory], env: { VELMREN_ACCEPTANCE_CONNECTION: JSON.stringify({ endpoint: app.descriptor.endpoint, token: registration.token, client: registration.clientId }) }, stderr: 'pipe' })
  transport.stderr?.resume()
  client = new Client({ name: 'ordinary-form-acceptance', version: '1' }); await client.connect(transport)
  task = await call('create_task', { url: `${fixture.origin}/controls` })
  assert.equal(task.profileMode, 'persistent')
  report.actualLanguage = await app.broker.tasks.get(task.taskId).page.evaluate(() => navigator.language)
  assert.equal((await observe('Required consent')).element.checked, true)
  await action('Required consent', { type: 'setChecked', checked: true })
  await action('Required consent', { type: 'setChecked', checked: true })
  assert.match((await call('observe')).text, /Consent changes: 0/)
  assert.equal((await observe('Optional marketing')).element.checked, false)
  await action('Required consent', { type: 'setChecked', checked: false })
  assert.equal((await observe('Required consent')).element.checked, false)
  await action('Required consent', { type: 'setChecked', checked: true })
  assert.match((await call('observe')).text, /Consent changes: 2/)
  check('Explicit checkbox state is idempotent and leaves optional marketing untouched')

  await action('Plan B', { type: 'setChecked', checked: true })
  assert.equal((await observe('Plan A')).element.checked, false)
  assert.equal((await observe('Plan B')).element.checked, true)
  const selectedRadio = await observe('Plan B')
  const rejectedRadio = await call('act', { observationId: selectedRadio.observation.observationId, actions: [{ type: 'setChecked', ref: selectedRadio.element.ref, checked: false }] }, true)
  assert.equal(rejectedRadio.actionResult.delivery, 'not_delivered')
  await action('Notification switch', { type: 'setChecked', checked: true })
  assert.match((await call('observe')).text, /switch changes: 0/)
  await action('Notification switch', { type: 'setChecked', checked: false })
  assert.equal((await observe('Notification switch')).element.checked, false)
  check('Native radio and ARIA switch state is observed and set without blind toggling')

  const constrained = (await observe('Constrained name')).element
  assert.equal(constrained.required, true); assert.equal(constrained.maxLength, 20); assert.equal(constrained.minLength, 4)
  assert.equal(constrained.pattern, '[A-Z]+')
  assert.match(JSON.stringify(constrained), /uppercase letters/)
  await action('Constrained name', { type: 'fill', value: 'lowercase' })
  const invalid = (await observe('Constrained name')).element
  assert.equal(invalid.validity.patternMismatch, true); assert.ok(invalid.validationMessage)
  const number = (await observe('Constrained number')).element
  assert.equal(number.min, '1'); assert.equal(number.max, '11'); assert.equal(number.step, '2')
  const privateField = (await observe('Private field')).element
  assert.equal(privateField.value, '[redacted]')
  check('Field constraints, helper text and validation flags are visible while password values stay redacted')

  const dates = { 'Birth date': '1996-05-17', 'Meeting time': '08:45:12', 'Local meeting': '1996-05-17T08:45:12', 'Start month': '1996-05', 'Start week': '1996-W20' }
  for (const [name, value] of Object.entries(dates)) {
    const result = await action(name, { type: 'fill', value })
    assert.equal(result.actionResult.delivery, 'delivered_verified')
    assert.equal((await observe(name)).element.value, value)
  }
  const birth = await observe('Birth date')
  const invalidDate = await call('act', { observationId: birth.observation.observationId, actions: [{ type: 'fill', ref: birth.element.ref, value: '1996-02-31' }] }, true)
  assert.equal(invalidDate.actionResult.delivery, 'not_delivered')
  assert.equal((await observe('Birth date')).element.value, '1996-05-17')
  check(`Canonical native date/time values are verified under ${language}; invalid dates preserve the previous value`)

  let offset = 0
  const names = []
  do {
    const page = await call('observe', { query: 'Extra control', offset, limit: 80, textLimit: 0 })
    names.push(...page.elements.map(x => x.name)); offset = page.pagination.nextOffset
  } while (offset !== null)
  assert.equal(names.length, 220); assert.equal(new Set(names).size, 220)
  await action('Extra control 180', { type: 'click' })
  assert.match((await call('observe')).text, /Extra selected 180/)
  const textStart = await call('observe', { limit: 1, textLimit: 1000 })
  assert.ok(textStart.textPagination.nextOffset > 0)
  const tail = await call('observe', { limit: 1, textOffset: Math.max(0, textStart.textPagination.total - 2000), textLimit: 2000 })
  assert.match(tail.text, /END OF LONG PAGE/)
  check('Search and pagination reach all 220 controls and the end of visible page text')

  const country = await observe('Country list')
  const end = await call('list_options', { observationId: country.observation.observationId, ref: country.element.ref, offset: 150, limit: 100 })
  assert.equal(end.options.length, 50); assert.equal(end.pagination.nextOffset, null)
  const found = await call('list_options', { observationId: country.observation.observationId, ref: country.element.ref, query: 'Country 200' })
  assert.equal(found.options.length, 1); assert.equal(found.options[0].value, fixture.longOption)
  const selection = await call('act', { observationId: country.observation.observationId, actions: [{ type: 'select', ref: country.element.ref, value: found.options[0].value }] })
  assert.equal(selection.actionResult.delivery, 'delivered_verified')
  await action('Submit synthetic form', { type: 'click' })
  await call('wait', { text: 'Synthetic form accepted', timeoutMs: 5000 })
  const submitted = fixture.records.find(x => x.kind === 'controls')
  assert.ok(submitted); assert.equal(submitted.values.country, fixture.longOption)
  assert.equal(submitted.values.birth, dates['Birth date']); assert.equal(submitted.values.time, dates['Meeting time'])
  assert.equal(submitted.values.local, dates['Local meeting']); assert.equal(submitted.values.month, dates['Start month']); assert.equal(submitted.values.week, dates['Start week'])
  assert.ok(!Object.hasOwn(submitted.values, 'marketing'))
  check('The last of 200 options retains its full value; the submitted form preserves canonical dates and consent')

  await call('navigate', { url: `${fixture.origin}/shadows` })
  assert.ok(!(await call('observe')).text.includes('Concealed shadow success'))
  assert.equal((await call('wait', { text: 'Concealed shadow success', timeoutMs: 100 })).matched, false)
  await action('Reveal shadow status', { type: 'click' })
  assert.equal((await call('wait', { text: 'Concealed shadow success', timeoutMs: 1000 })).matched, true)
  await action('Shadow name', { type: 'fill', value: 'Nested User' })
  await action('Slotted name', { type: 'fill', value: 'Projected User' })
  await action('Nested shadow date', { type: 'fill', value: '1996-05-17' })
  await action('Shadow consent', { type: 'setChecked', checked: true })
  assert.equal((await observe('Shadow consent')).element.checked, true)
  assert.equal((await observe('Slotted name')).element.value, 'Projected User')
  const absent = await call('observe', { query: 'Closed secret control' })
  assert.equal(absent.elements.length, 0)
  await action('Submit shadow form', { type: 'click' })
  await call('wait', { text: 'Shadow form accepted', timeoutMs: 5000 })
  assert.deepEqual(fixture.records.find(x => x.kind === 'shadow'), { kind: 'shadow', name: 'Nested User', checked: true })
  check('Open and nested shadow controls, slotted fields, checked state and form submission work')
  // Password input protects the entire task, so exercise it after ordinary controls.
  await call('navigate', { url: `${fixture.origin}/controls` })
  const passwordResult = await action('Private field', { type: 'fill', value: 'SyntheticPrivate123' })
  assert.equal(passwordResult.actionResult.delivery, 'delivered_verified')
  assert.equal(passwordResult.observation.privacy.active, true)
  const protectedObservation = await call('observe')
  assert.equal(protectedObservation.privacy.active, true)
  assert.ok(!protectedObservation.text && protectedObservation.elements.every(element => !element.name && !element.value))
  assert.ok(!JSON.stringify([passwordResult, protectedObservation]).includes('SyntheticPrivate123'))
  assert.equal(await app.broker.page(app.broker.tasks.get(task.taskId)).evaluate(() => document.querySelector('#password').value === 'SyntheticPrivate123'), true)
  check('Password fill is independently verified and suppresses page values and names for the entire task')
  await call('finish'); task = null
  report.passed = true
} catch (error) { failure = error; report.error = error.message; report.stack = error.stack }
finally {
  if (task && client) await call('cancel').catch(() => {})
  if (client) await client.close().catch(() => {})
  if (app) { await app.close(); report.cleanup.browserClosed = app.broker.browser.closed }
  if (fixture) { await fixture.close(); report.cleanup.fixtureClosed = true }
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2))
}
if (failure) throw failure

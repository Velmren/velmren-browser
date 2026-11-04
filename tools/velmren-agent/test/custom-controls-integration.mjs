// node test/custom-controls-integration.mjs BROWSER_EXE NEW_OUTPUT_DIR [--tom-select-assets=DIR] [--agent-directory=DIR]
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const args = process.argv.slice(2), positions = args.filter(arg => !arg.startsWith('--'))
const [executable, outputArgument] = positions
assert.ok(executable && outputArgument, 'Usage: BROWSER_EXE NEW_OUTPUT_DIR')
assert.ok(args.every(arg => !arg.startsWith('--') || arg.startsWith('--tom-select-assets=') || arg.startsWith('--agent-directory=')))
const directory = path.resolve(args.find(arg => arg.startsWith('--agent-directory='))?.slice(18) ?? fileURLToPath(new URL('../', import.meta.url)))
const { startBroker } = await import(pathToFileURL(path.join(directory, 'broker.mjs')).href)
const assetDirectory = args.find(arg => arg.startsWith('--tom-select-assets='))?.slice('--tom-select-assets='.length)
const assets = new Map()
if (assetDirectory) for (const file of ['tom-select.js', 'tom-select.css']) assets.set(`/${file}`, await readFile(path.join(assetDirectory, file)))
const output = path.resolve(outputArgument)
await mkdir(path.dirname(output), { recursive: true }); await mkdir(output)
const report = { passed: false, checks: [], cleanup: {} }
if (assets.size) report.publicWidgetAssets = [...assets].map(([file, bytes]) => ({ file, sha256: createHash('sha256').update(bytes).digest('hex') }))
const check = name => { report.checks.push(name); console.log(`PASS ${name}`) }
const html = `<!doctype html><meta charset="utf-8"><title>VBR-011 synthetic controls</title>
<style>
body{font:16px sans-serif;padding:24px;max-width:700px} .row{margin:20px 0;position:relative}
label{display:inline-block;padding:12px;border:1px solid #aaa} input[type=text]{height:28px}
.covered{position:relative;padding-left:50px}.covered input{position:absolute;left:10px;top:10px;width:25px;height:25px;pointer-events:none}
.covered .decoration{position:absolute;left:10px;top:10px;width:25px;height:25px;background:#ccc}
.blocked{width:330px;height:50px}.blocked label{box-sizing:border-box;width:100%;height:100%}
.blocker{position:absolute;inset:0;box-sizing:border-box;width:100%;height:100%!important;z-index:2}
.styled{position:relative;width:330px;height:40px}.styled select{width:100%;height:100%}
.styled .decoration{position:absolute;inset:0;background:#eee;border:1px solid;padding:10px;box-sizing:border-box}
</style>
${assets.size ? '<link rel="stylesheet" href="/tom-select.css"><script src="/tom-select.js"></script>' : ''}
<form id=profile>
<div class=row><input id=agreement type=checkbox hidden><label for=agreement>Hidden agreement <a id=terms href="#terms">Terms and conditions</a></label></div>
<div class=row><label><input id=wrapped type=checkbox style="display:none">Wrapped agreement</label></div>
<div class=row><label class=covered><input id=covered type=checkbox><span class=decoration></span>Decorated agreement</label></div>
<div class=row><input id=employer type=radio name=kind hidden checked><label for=employer>Employer</label>
<input id=freelancer type=radio name=kind hidden><label for=freelancer>Freelancer</label></div>
<div class=row><input id=disabled type=checkbox hidden disabled><label for=disabled>Disabled agreement</label></div>
<div class="row blocked"><input id=blocked type=checkbox hidden><label for=blocked>Blocked agreement</label><input class=blocker aria-label="Unrelated overlay" type=text value="untouched"></div>
<div class=row><label for=keyboard>Keyboard agreement</label><input id=keyboard type=checkbox></div>
<div class=row><div role=checkbox aria-checked=false aria-label="Unfocusable widget">Unfocusable widget</div></div>
<div class=row><label for=city>City</label><div class=styled><select id=city required><option value="">Choose</option><option value=Local>Local</option><option value=Abroad503>Abroad</option><option disabled value=Blocked>Blocked</option></select><span class=decoration aria-hidden=true id=cityText>Choose</span></div></div>
<div class=row><label for=ambiguousCity>Ambiguous city</label><div class=styled><select id=ambiguousCity><option value=Local>Local</option><option value=Abroad503>Abroad</option></select><span class=decoration>Unrelated covering text</span></div></div>
<div class=row><label for=unsafeCity>Covered city</label><div class=styled><select id=unsafeCity><option value=Local>Local</option><option value=Abroad503>Abroad</option></select><input class=blocker aria-label="Other city field" type=text value="unchanged"></div></div>
<div class=row><select id=hiddenCity hidden><option>Local</option></select><div role=combobox tabindex=0 aria-label="Unsupported city">Unsupported city</div></div>
<div class=row><label for=first>First name</label><input id=first type=text value=Velmren><label for=last>Last name</label><input id=last type=text value=Kimovich></div>
<div class=row><label for=edit>Keyboard text</label><input id=edit type=text value=abcd></div>
${assets.size ? `<div class=row><label for=tomCity>CVbankas city</label><select id=tomCity name=tom_city required><option value="">Pasirinkite</option>${Array.from({length: 60}, (_, index) => `<option value="city-${index}">City ${index}</option>`).join('')}<option value=503>Užsienis</option></select></div>
<div class="row blocked" style="margin-bottom:100px"><label for=blockedTomCity>Blocked custom city</label><select id=blockedTomCity><option value="">Pasirinkite</option><option value=503>Užsienis</option></select><input class=blocker type=text aria-label="Custom city overlay" value="unrelated"></div>` : ''}
<button type=submit>Save profile</button></form><output id=status></output>
<script>
const $ = id => document.getElementById(id); window.events=[]; window.linkClicks=0;
for(const type of ['click','input','change','keydown','keyup']) document.addEventListener(type, event => {events.push({type,id:event.target.id,trusted:event.isTrusted,key:event.key,code:event.code,option:event.target.closest('[role=option]')?.getAttribute('data-value')});document.documentElement.dataset.eventLog=JSON.stringify(events)},true);
$('terms').onclick=event=>{event.preventDefault();document.documentElement.dataset.linkClicks=String(++linkClicks)};
$('city').onchange=()=>{$('cityText').textContent=$('city').selectedOptions[0].textContent};
const saved=JSON.parse(localStorage.getItem('profile')||'null');
const savedIds=['city','first','last',...($('tomCity')?['tomCity']:[])];
if(saved){for(const id of savedIds) $(id).value=saved[id];$('city').onchange();$('status').textContent='Restored profile'}
for(const id of ['tomCity','blockedTomCity']) if($(id)) new TomSelect($(id),{create:false,maxOptions:null,loadThrottle:null,allowEmptyOption:true});
$('profile').onsubmit=event=>{event.preventDefault();localStorage.setItem('profile',JSON.stringify(Object.fromEntries(savedIds.map(id=>[id,$(id).value]))));$('status').textContent='Saved profile'};
</script>`
const server = createServer((request, response) => {
  const asset = assets.get(request.url)
  response.writeHead(200, { 'content-type': asset ? request.url.endsWith('.js') ? 'text/javascript' : 'text/css' : 'text/html; charset=utf-8' })
  response.end(asset ?? html)
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`
let app, client, task, failure
async function call(name, values = {}, expectError = false) {
  const response = await client.callTool({ name: `velmren_${name}`, arguments: { ...(task ? { taskId: task.taskId } : {}), ...values } }, undefined, { timeout: 40000 })
  const result = JSON.parse(response.content.find(item => item.type === 'text').text)
  assert.equal(!!response.isError, expectError, JSON.stringify(result))
  return result
}
async function observe(name) {
  const observation = await call('observe', { query: name })
  const element = observation.elements.find(item => item.name === name)
  assert.ok(element, `Missing ${name}`)
  return { observation, element }
}
async function action(name, action, expectError = false) {
  const { observation, element } = await observe(name)
  return call('act', { observationId: observation.observationId, actions: [{ ref: element.ref, ...action }] }, expectError)
}
async function nativeCity() {
  const observation = await call('observe', { query: 'tom_city' })
  const element = observation.elements.find(item => item.tag === 'select')
  assert.ok(element, 'Missing native Tom Select state')
  return { observation, element }
}
try {
  app = await startBroker({ executable: path.resolve(executable), stateDir: path.join(output, 'state'), policy: { profileMode: 'persistent', allowedOrigins: [origin], webCompatibility: true }, browserArgs: ['--headless=new'] })
  const registration = await app.broker.rpc('admin', 'client_register', { label: 'Synthetic styled-control acceptance' })
  const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('./multi-agent-mcp-entry.mjs', import.meta.url)), directory], env: { VELMREN_ACCEPTANCE_CONNECTION: JSON.stringify({ endpoint: app.descriptor.endpoint, token: registration.token, client: registration.clientId }) }, stderr: 'pipe' })
  transport.stderr?.resume()
  client = new Client({ name: 'styled-control-acceptance', version: '1' }); await client.connect(transport)
  task = await call('create_task', { url: origin })
  const page = app.broker.tasks.get(task.taskId).page
  report.browser = page.browser.version

  for (const name of ['Hidden agreement Terms and conditions', 'Wrapped agreement', 'Decorated agreement']) {
    const initial = (await observe(name)).element
    assert.equal(initial.checked, false); assert.ok(initial.availableActions.includes('setChecked'))
    if (name !== 'Decorated agreement') {
      assert.equal(initial.hidden, true); assert.equal(initial.interactionTarget, 'associated_label')
      assert.ok(!initial.availableActions.includes('press'))
    }
    assert.equal((await action(name, { type: 'setChecked', checked: true })).actionResult.delivery, 'delivered_verified')
    const count = await page.evaluate(() => JSON.parse(document.documentElement.dataset.eventLog || '[]').filter(event => event.type === 'change').length)
    assert.equal((await action(name, { type: 'setChecked', checked: true })).actionResult.delivery, 'delivered_verified')
    assert.equal(await page.evaluate(() => JSON.parse(document.documentElement.dataset.eventLog || '[]').filter(event => event.type === 'change').length), count)
    assert.equal((await observe(name)).element.checked, true)
  }
  assert.equal(await page.evaluate(() => Number(document.documentElement.dataset.linkClicks || 0)), 0)
  assert.equal(await page.evaluate(() => JSON.parse(document.documentElement.dataset.eventLog || '[]').filter(event => event.type === 'change' && ['agreement', 'wrapped', 'covered'].includes(event.id)).every(event => event.trusted)), true)
  check('Hidden, wrapped and decorated checkboxes receive trusted label activation with verified idempotent state; links stay untouched')

  await action('Freelancer', { type: 'setChecked', checked: true })
  assert.equal((await observe('Freelancer')).element.checked, true)
  assert.equal((await observe('Employer')).element.checked, false)
  const radioCount = await page.evaluate(() => JSON.parse(document.documentElement.dataset.eventLog || '[]').filter(event => event.id === 'freelancer' && event.type === 'change').length)
  await action('Freelancer', { type: 'setChecked', checked: true })
  assert.equal(await page.evaluate(() => JSON.parse(document.documentElement.dataset.eventLog || '[]').filter(event => event.id === 'freelancer' && event.type === 'change').length), radioCount)
  assert.equal((await action('Freelancer', { type: 'setChecked', checked: false }, true)).actionResult.delivery, 'not_delivered')
  assert.equal((await action('Disabled agreement', { type: 'setChecked', checked: true }, true)).actionResult.delivery, 'not_delivered')
  check('Hidden radios preserve native grouping and idempotency; disabled controls and radio unsetting are rejected')

  for (const key of ['Space', 'Spacebar']) await action('Keyboard agreement', { type: 'press', key })
  assert.equal((await observe('Keyboard agreement')).element.checked, false)
  const keys = await page.evaluate(() => JSON.parse(document.documentElement.dataset.eventLog || '[]').filter(event => event.id === 'keyboard' && event.type === 'keydown'))
  assert.equal(keys.length, 2); assert.ok(keys.every(event => event.trusted && event.key === ' ' && event.code === 'Space'))
  assert.equal((await action('Unfocusable widget', { type: 'press', key: 'Space' }, true)).actionResult.delivery, 'not_delivered')
  await action('Keyboard text', { type: 'press', key: 'Home' })
  assert.equal(await page.evaluate(() => document.getElementById('edit').selectionStart), 0)
  await action('Keyboard text', { type: 'press', key: 'End' })
  assert.equal(await page.evaluate(() => document.getElementById('edit').selectionStart), 4)
  check('Space aliases toggle the focused native checkbox and End moves the caret; an unfocusable widget receives no key')

  const city = await observe('City')
  const options = await call('list_options', { observationId: city.observation.observationId, ref: city.element.ref, query: 'Abroad' })
  assert.equal(options.options[0].value, 'Abroad503')
  assert.equal((await action('City', { type: 'select', value: options.options[0].value })).actionResult.delivery, 'delivered_verified')
  assert.equal((await observe('City')).element.value, 'Abroad503')
  assert.equal(await page.evaluate(() => document.getElementById('cityText').textContent), 'Abroad')
  assert.equal((await action('City', { type: 'select', value: 'Blocked' }, true)).actionResult.delivery, 'not_delivered')
  assert.equal((await observe('First name')).element.value, 'Velmren')
  assert.equal((await observe('Last name')).element.value, 'Kimovich')
  if (assets.size) {
    const combo = (await observe('CVbankas city')).element
    assert.equal(combo.role, 'combobox'); assert.equal(combo.interactionTarget, 'associated_label')
    report.publicWidgetContract = await page.evaluate(() => {
      const native = document.getElementById('tomCity'), input = document.querySelector('[role=combobox][aria-labelledby=tomCity-ts-label]')
      const listbox = document.getElementById(input.getAttribute('aria-controls'))
      return { nativeClipPath: getComputedStyle(native).clipPath, inputX: input.getBoundingClientRect().x, inputOpacity: getComputedStyle(input).opacity,
        labelled: [...input.labels].some(label => label.control === input), listboxRole: listbox.getAttribute('role') }
    })
    assert.ok(report.publicWidgetContract.inputX < 0); assert.equal(report.publicWidgetContract.inputOpacity, '0')
    assert.equal(report.publicWidgetContract.labelled, true); assert.equal(report.publicWidgetContract.listboxRole, 'listbox')
    const native = await nativeCity()
    assert.equal((await call('act', { observationId: native.observation.observationId, actions: [{ type: 'select', ref: native.element.ref, value: '503' }] }, true)).actionResult.delivery, 'not_delivered')
    await action('CVbankas city', { type: 'click' })
    await action('CVbankas city', { type: 'fill', value: 'Užsienis' })
    const option = (await observe('Užsienis')).element
    assert.equal(option.role, 'option')
    await action('Užsienis', { type: 'click' })
    assert.equal((await nativeCity()).element.value, '503')
    assert.equal(await page.evaluate(() => document.querySelector('#tomCity-ts-control').parentElement.querySelector('[data-ts-item]').textContent), 'Užsienis')
    const delivered = await page.evaluate(() => JSON.parse(document.documentElement.dataset.eventLog || '[]'))
    assert.ok(delivered.some(event => event.id === 'tomCity-ts-control' && event.type === 'input' && event.trusted))
    assert.ok(delivered.some(event => event.option === '503' && event.type === 'click' && event.trusted))
    for (const values of [{ type: 'click' }, { type: 'fill', value: 'Užsienis' }]) assert.equal((await action('Blocked custom city', values, true)).actionResult.delivery, 'not_delivered')
    assert.equal((await observe('Custom city overlay')).element.value, 'unrelated')
    assert.equal(await page.evaluate(() => document.getElementById('blockedTomCity').value), '')
    check('CVbankas public Tom Select assets: label activation, trusted search and observed option click synchronize the clipped native select to 503')
  }
  await action('Save profile', { type: 'click' })
  assert.match((await call('observe')).text, /Saved profile/)
  await call('navigate', { url: `${origin}/restored` })
  for (const [name, value] of [['City', 'Abroad503'], ['First name', 'Velmren'], ['Last name', 'Kimovich']]) assert.equal((await observe(name)).element.value, value)
  if (assets.size) assert.equal((await nativeCity()).element.value, '503')
  check('Decorated native select accepts the observed Abroad503 option, updates its display and preserves both names across save/navigation')

  for (const [name, values] of [['Blocked agreement', { type: 'setChecked', checked: true }], ['Covered city', { type: 'select', value: 'Abroad503' }], ['Ambiguous city', { type: 'select', value: 'Abroad503' }], ['Unsupported city', { type: 'select', value: 'Abroad503' }]]) {
    const result = await action(name, values, true)
    assert.equal(result.actionResult.delivery, 'not_delivered')
  }
  assert.equal((await observe('Blocked agreement')).element.checked, false)
  assert.equal((await observe('Unrelated overlay')).element.value, 'untouched')
  assert.equal((await observe('Other city field')).element.value, 'unchanged')
  assert.equal((await observe('Covered city')).element.value, 'Local')
  assert.equal((await observe('Ambiguous city')).element.value, 'Local')
  const stale = await observe('Keyboard agreement')
  await call('observe')
  assert.equal((await call('act', { observationId: stale.observation.observationId, actions: [{ ref: stale.element.ref, type: 'setChecked', checked: true }] }, true)).actionResult.delivery, 'not_delivered')
  check('Unrelated overlays, unsupported custom comboboxes and stale refs are rejected without changing neighboring fields')
  await call('finish'); task = null; report.cleanup.taskFinished = true
  report.passed = true
} catch (error) { failure = error; report.error = error.stack }
finally {
  try { if (task) { await call('cancel'); report.cleanup.taskCancelled = true } } catch (error) { report.cleanup.taskError = error.message; failure ??= error; report.passed = false }
  await client?.close().catch(() => {})
  try { await app?.close(); report.cleanup.browserClosed = app?.broker.browser.closed === true } catch (error) { report.cleanup.brokerError = error.message; failure ??= error; report.passed = false }
  await new Promise(resolve => server.close(resolve))
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2))
}
if (failure) throw failure

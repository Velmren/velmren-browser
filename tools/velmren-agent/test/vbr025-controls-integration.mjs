// node test/vbr025-controls-integration.mjs BROWSER_EXE NEW_OUTPUT_DIR [--agent-directory=DIR]
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const args = process.argv.slice(2), [executable, outputArgument] = args.filter(arg => !arg.startsWith('--'))
assert.ok(executable && outputArgument, 'Usage: BROWSER_EXE NEW_OUTPUT_DIR')
assert.ok(args.every(arg => !arg.startsWith('--') || arg.startsWith('--agent-directory=')))
const directory = path.resolve(args.find(arg => arg.startsWith('--agent-directory='))?.slice(18) ?? fileURLToPath(new URL('../', import.meta.url)))
const { startBroker } = await import(pathToFileURL(path.join(directory, 'broker.mjs')).href)
const output = path.resolve(outputArgument)
await mkdir(path.dirname(output), { recursive: true }); await mkdir(output)
const report = { passed: false, checks: [], cleanup: {} }
const html = `<!doctype html><meta charset=utf-8><title>Control geometry and observation contracts</title>
<style>
body{font:16px sans-serif;padding:24px} .mail{width:440px;height:140px;overflow:auto;border:1px solid}.message{padding-top:200px;padding-bottom:200px;line-height:54px}a{overflow-wrap:anywhere}
.field{position:relative;width:280px;height:36px}.field input{width:100%;height:100%;box-sizing:border-box}.decoration{position:absolute;left:40%;right:40%;top:0;bottom:0;background:#bbb}.cover{position:absolute;inset:0;background:#bbb;z-index:2}
.menu{cursor:pointer;width:180px}.menu>div{padding:10px}.contents{display:contents}.contents>span{display:inline-block;padding:10px}.disabled{pointer-events:none}
</style>
<div class=mail role=region><div class=message role=region><div role=group><a id=activation href=/activated>www.example.test/activate/a-long-wrapped-synthetic-link-with-several-lines-of-visible-label</a></div></div></div>
<div class=field><input id=skills aria-label=Skills required placeholder="Type to search"><span class=decoration aria-hidden=true></span></div>
<div class=field><input id=blocked aria-label="Blocked Skills"><span class=cover>Loading</span></div>
<div class=field><a id=coveredLink href=/wrong>Covered activation</a><span class=cover>Loading</span></div>
<div inert><button id=inert>Inert control</button></div>
<span id=staffName hidden>View/Edit Profile</span><a id=staff aria-labelledby=staffName href=/profile>View/Edit Profile</a><output id=clock>0</output>
<button id=lateName aria-labelledby=lateLabel>Preview invoice</button><button id=lateControl aria-controls=latePanel>Open panel</button>
<input id=lateFor placeholder="Initial field name"><button id=focusModal>Focus modal submit</button><input id=focusFillModal aria-label="Focus modal field">
<div class=field><input id=focusCovered aria-label="Focus covered field"><span id=focusCover class=cover style="display:none">Loading</span></div>
<div role=menu tabindex=-1 class=menu><div id=account>Account</div><div id=logout>Logout</div></div>
<div role=tooltip tabindex=-1 class=menu><div id=moncompte>Mon compte</div><div>Other menu entry</div></div>
<div role=menu tabindex=-1 class=menu inert><div>Inert menu entry</div></div>
<div role=menu tabindex=-1 class=menu style="display:none"><div>Hidden menu entry</div></div>
<div role=menu tabindex=-1 class=menu aria-disabled=true><div>Disabled menu entry</div></div>
<a class=contents id=login href=/login><span>Login</span></a>
<button class=contents id=continue><span>Jatka</span></button>
<div id=modal role=dialog aria-modal=true style="display:none;position:fixed;right:0;top:0;background:white;padding:20px">Modal <button>Close</button><button aria-controls=ownedList aria-expanded=true>Choose</button></div>
<div id=ownedList role=listbox style="display:none"><button id=ownedOption>Owned option</button></div>
<script>
document.documentElement.dataset.events='[]';
for(const type of ['click','input','keydown'])document.addEventListener(type,event=>{const list=JSON.parse(document.documentElement.dataset.events);list.push({type,id:event.target.closest('[id]')?.id,trusted:event.isTrusted,key:event.key});document.documentElement.dataset.events=JSON.stringify(list)},true);
for(const id of ['account','logout','moncompte','continue','ownedOption'])document.getElementById(id).addEventListener('click',event=>event.currentTarget.dataset.clicked=String(event.isTrusted));
for(const id of ['focusModal','focusFillModal'])document.getElementById(id).addEventListener('focus',()=>document.getElementById('modal').style.display='block');
document.getElementById('focusCovered').addEventListener('focus',()=>document.getElementById('focusCover').style.display='block');
</script>`
const server = createServer((request, response) => {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  response.end(request.url === '/' ? html : `<!doctype html><title>Destination</title><p id=destination>${request.url}</p>`)
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`
let app, client, task, page, failure
async function call(name, values = {}, expectError = false) {
  const response = await client.callTool({ name: `velmren_${name}`, arguments: { ...(task ? { taskId: task.taskId } : {}), ...values } }, undefined, { timeout: 40000 })
  const result = JSON.parse(response.content.find(item => item.type === 'text').text)
  assert.equal(!!response.isError, expectError, JSON.stringify(result)); return result
}
async function observe(name) {
  const observation = await call('observe', { query: name })
  const matches = observation.elements.filter(item => item.name === name)
  const element = matches.find(item => ['a', 'button', 'input'].includes(item.tag)) ?? matches[0]
  assert.ok(element, `Missing ${name}`); return { observation, element }
}
async function action(name, values, expectError = false) {
  const { observation, element } = await observe(name)
  return call('act', { observationId: observation.observationId, actions: [{ ref: element.ref, ...values }] }, expectError)
}
async function scenario(name, callback) {
  try { await page.navigate(origin); await callback(); report.checks.push({ name, passed: true }); console.log(`PASS ${name}`) }
  catch (error) { report.checks.push({ name, passed: false, error: error.stack }); console.log(`FAIL ${name}: ${error.message}`); failure ??= error }
}
try {
  app = await startBroker({ executable: path.resolve(executable), stateDir: path.join(output, 'state'), policy: { profileMode: 'persistent', allowedOrigins: [origin], webCompatibility: true }, browserArgs: ['--headless=new'] })
  const registration = await app.broker.rpc('admin', 'client_register', { label: 'VBR-025 control acceptance' })
  const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('./multi-agent-mcp-entry.mjs', import.meta.url)), directory], env: { VELMREN_ACCEPTANCE_CONNECTION: JSON.stringify({ endpoint: app.descriptor.endpoint, token: registration.token, client: registration.clientId }) }, stderr: 'pipe' })
  transport.stderr?.resume(); client = new Client({ name: 'vbr025-control-acceptance', version: '1' }); await client.connect(transport)
  task = await call('create_task', { url: origin }); page = app.broker.tasks.get(task.taskId).page; report.browser = page.browser.version
  for (const type of ['click', 'press']) await scenario(`wrapped_scrolled_anchor_${type}`, async () => {
    report.anchorGeometry = await page.evaluate(() => {
      const element = document.getElementById('activation')
      return { name: elementName(element), box: element.getBoundingClientRect().toJSON(), rects: [...element.getClientRects()].map(rect => rect.toJSON()), hidden: elementCapabilities(element).hidden }
    })
    assert.equal(report.anchorGeometry.rects.length, 2, 'The center falls between two line fragments')
    const observation = await call('observe', { query: 'www.example.test/activate/' })
    assert.equal(observation.elements.length, 4)
    const anchors = observation.elements.filter(element => element.tag === 'a')
    assert.equal(anchors.length, 1)
    const result = await call('act', { observationId: observation.observationId, actions: [{ ref: anchors[0].ref, type, ...(type === 'press' ? { key: 'Enter' } : {}) }] })
    assert.equal(result.actionResult.completed, 1)
    assert.equal(await page.evaluate(() => location.pathname), '/activated')
  })
  await scenario('partially_decorated_skills_field', async () => {
    assert.equal((await observe('Skills')).element.required, true)
    assert.equal((await action('Skills', { type: 'fill', value: 'Python' })).actionResult.delivery, 'delivered_verified')
    assert.equal(await page.evaluate(() => document.getElementById('skills').value), 'Python')
    assert.ok(await page.evaluate(() => JSON.parse(document.documentElement.dataset.events).some(event => event.type === 'input' && event.id === 'skills' && event.trusted)))
  })
  await scenario('unrelated_mutation_keeps_connected_target_valid', async () => {
    const { observation, element } = await observe('View/Edit Profile')
    await page.evaluate(() => { document.getElementById('clock').textContent = '1' })
    const result = await call('act', { observationId: observation.observationId, actions: [{ type: 'click', ref: element.ref }] })
    assert.equal(result.actionResult.completed, 1); assert.equal(await page.evaluate(() => location.pathname), '/profile')
  })
  for (const mutation of ['replace', 'href', 'text', 'ancestor', 'external-label']) await scenario(`changed_target_${mutation}_stays_stale`, async () => {
    const { observation, element } = await observe('View/Edit Profile')
    await page.evaluate(kind => {
      const target = document.getElementById('staff')
      if (kind === 'replace') target.replaceWith(target.cloneNode(true))
      if (kind === 'href') target.href = '/wrong'
      if (kind === 'text') target.textContent = 'Delete profile'
      if (kind === 'ancestor') target.parentElement.setAttribute('aria-disabled', 'true')
      if (kind === 'external-label') document.getElementById('staffName').textContent = 'Delete profile'
    }, mutation)
    const result = await call('act', { observationId: observation.observationId, actions: [{ type: 'click', ref: element.ref }] }, true)
    assert.equal(result.code, 'STALE_OBSERVATION'); assert.equal(result.actionResult.delivery, 'not_delivered')
  })
  for (const [name, kind] of [['Preview invoice', 'name'], ['Open panel', 'control'], ['Initial field name', 'label']]) await scenario(`late_related_${kind}_stays_stale`, async () => {
    const { observation, element } = await observe(name)
    await page.evaluate(kind => {
      const node = document.createElement(kind === 'label' ? 'label' : 'span')
      if (kind === 'label') node.htmlFor = 'lateFor'
      else node.id = kind === 'name' ? 'lateLabel' : 'latePanel'
      node.textContent = 'Delete all invoices'; document.body.append(node)
    }, kind)
    const result = await call('act', { observationId: observation.observationId, actions: [{ type: 'click', ref: element.ref }] }, true)
    assert.equal(result.code, 'STALE_OBSERVATION'); assert.equal(result.actionResult.delivery, 'not_delivered')
    assert.equal(await page.evaluate(() => JSON.parse(document.documentElement.dataset.events).length), 0)
  })
  for (const [name, id] of [['Account', 'account'], ['Logout', 'logout'], ['Mon compte', 'moncompte'], ['Jatka', 'continue']]) await scenario(`child_control_${id}`, async () => {
    await action(name, { type: 'click' }); assert.equal(await page.evaluate(id => document.getElementById(id).dataset.clicked, id), 'true')
  })
  await scenario('contents_header_link', async () => {
    await action('Login', { type: 'click' }); assert.equal(await page.evaluate(() => location.pathname), '/login')
  })
  await scenario('closed_and_disabled_menu_entries', async () => {
    assert.equal((await call('observe', { query: 'Hidden menu entry' })).elements.length, 0)
    for (const name of ['Inert menu entry', 'Disabled menu entry']) {
      assert.deepEqual((await observe(name)).element.availableActions, [])
      assert.equal((await action(name, { type: 'click' }, true)).actionResult.delivery, 'not_delivered')
    }
  })
  for (const [name, type] of [['Blocked Skills', 'fill'], ['Covered activation', 'click'], ['Covered activation', 'press'], ['Inert control', 'click']]) await scenario(`blocked_${name}_${type}`, async () => {
    const result = await action(name, { type, ...(type === 'fill' ? { value: 'must not arrive' } : type === 'press' ? { key: 'Enter' } : {}) }, true)
    assert.equal(result.actionResult.delivery, 'not_delivered')
    assert.equal(await page.evaluate(() => JSON.parse(document.documentElement.dataset.events).length), 0)
  })
  await scenario('aria_modal_blocks_keyboard_background', async () => {
    await page.evaluate(() => { document.getElementById('modal').style.display = 'block' })
    const result = await action('View/Edit Profile', { type: 'press', key: 'Enter' }, true)
    assert.equal(result.actionResult.delivery, 'not_delivered')
  })
  await scenario('aria_modal_keeps_explicit_owned_popup_actionable', async () => {
    await page.evaluate(() => { document.getElementById('modal').style.display = 'block'; document.getElementById('ownedList').style.display = 'block' })
    await action('Owned option', { type: 'click' })
    assert.equal(await page.evaluate(() => document.getElementById('ownedOption').dataset.clicked), 'true')
    await page.evaluate(() => document.querySelector('[aria-controls=ownedList]').setAttribute('aria-expanded', 'false'))
    assert.equal((await action('Owned option', { type: 'click' }, true)).actionResult.delivery, 'not_delivered')
  })
  for (const [name, type] of [['Focus modal submit', 'press'], ['Focus modal field', 'fill'], ['Focus covered field', 'fill']]) await scenario(`focus_changes_${name}_blocks_input`, async () => {
    const result = await action(name, { type, ...(type === 'press' ? { key: 'Enter' } : { value: 'Must stay undelivered' }) }, true)
    assert.equal(result.code, 'ELEMENT_OBSCURED'); assert.equal(result.actionResult.delivery, 'not_delivered')
    assert.equal(await page.evaluate(() => JSON.parse(document.documentElement.dataset.events).length), 0)
  })
  await scenario('modal_between_pointer_preparation_and_dispatch_blocks_input', async () => {
    const original = page.toRootPoint
    page.toRootPoint = async function(point) {
      const result = await original.call(this, point)
      await this.evaluate(() => { document.getElementById('modal').style.display = 'block' })
      return result
    }
    try {
      const result = await action('Jatka', { type: 'click' }, true)
      assert.equal(result.code, 'ELEMENT_OBSCURED'); assert.equal(result.actionResult.delivery, 'not_delivered')
      assert.equal(await page.evaluate(() => JSON.parse(document.documentElement.dataset.events).length), 0)
    } finally { page.toRootPoint = original }
  })
  await call('finish'); task = null; report.cleanup.taskFinished = true; report.passed = !failure
} catch (error) { failure ??= error; report.error = error.stack }
finally {
  try { if (task) { await call('cancel'); report.cleanup.taskCancelled = true } } catch (error) { report.cleanup.taskError = error.message; failure ??= error; report.passed = false }
  await client?.close().catch(() => {})
  try { await app?.close(); report.cleanup.browserClosed = app?.broker.browser.closed === true } catch (error) { report.cleanup.brokerError = error.message; failure ??= error; report.passed = false }
  await new Promise(resolve => server.close(resolve)); await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2))
}
if (failure) process.exitCode = 1

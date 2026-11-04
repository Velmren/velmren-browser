// node test/vbr014-controls-integration.mjs BROWSER_EXE NEW_OUTPUT_DIR [--agent-directory=DIR]
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
const check = name => { report.checks.push(name); console.log(`PASS ${name}`) }
const foreign = createServer((request, response) => {
  response.writeHead(200, { 'content-type': 'text/html' })
  response.end('<div style="cursor:pointer" onclick="this.textContent=\'changed\'">Foreign Google action</div>')
})
await new Promise(resolve => foreign.listen(0, '127.0.0.1', resolve))
const foreignOrigin = `http://127.0.0.1:${foreign.address().port}`
const card = (id, name, extra = '') => `<div class="card" id="${id}" ${extra}><div class="check"><input type=checkbox id="${id}Input"><label></label></div><strong>${name}</strong><p>(I am looking for Work)</p></div>`
const html = `<!doctype html><meta charset=utf-8><title>VBR-014 control contracts</title>
<style>
body{font:16px sans-serif;padding:24px} .row{margin:12px 0}.pointer{cursor:pointer;padding:12px;border:1px solid;display:inline-block}
.card{border:2px solid #ccc;padding:16px;position:relative;cursor:pointer;width:220px;height:90px;margin:12px 0}
.check{position:absolute;top:-3px;right:0}.check input{opacity:0;position:absolute;width:22px;height:22px;margin:0}
.check label:before{content:'';display:block;width:22px;height:22px;border:1px solid #aaa;background:white}
.blocked{position:relative;width:max-content}.overlay{position:absolute;inset:0;z-index:2;background:#aaa}
.pseudo:before{content:'Accept cookies'} .pseudo{cursor:pointer;display:inline-block;padding:12px;background:#ccc}
#clear{opacity:0} #hidden{display:none} summary{cursor:pointer}.bulk{display:block;margin:3px}
#transparentCardInput{width:0;height:0}
</style>
<ul><li class=pointer id=simpals>Войти через <strong>Google</strong></li></ul>
<div class=row><div class=pointer id=malta>Continue with Google</div><div class=pointer id=signup>Sign-Up</div></div>
<div class=row><div class=pointer tabindex=0 id=staff><img alt=google-icon-register width=20 height=20 src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E"></div></div>
<div class=row><div class=pointer id=login><span>Log in</span></div><div class=pseudo id=cookies></div></div>
<div class=row><div class=pointer id=account>Example Account <span>⌄</span></div><span class=pointer id=avatar><svg width=20 height=20><title>Account menu</title><circle r=8 cx=10 cy=10/></svg></span></div>
<div class=row><span id=inline onclick="this.dataset.clicked=event.isTrusted">Inline action</span><details><summary>More choices</summary><p>Opened details</p></details></div>
<div class=row><input id=save type=submit value="Išsaugoti"><input type=button value="Native button"><input type=reset value="Reset fields"><input type=password aria-label="Private field" value="NeverSearchThisPrivateValue"></div>
${card('freelancer', 'Freelancer')}
<input id=marketing type=checkbox aria-label="Optional marketing"><button id=proceed disabled>Proceed</button>
<div class=blocked>${card('covered', 'Covered card')}<div class=overlay>Unrelated overlay</div></div>
<fieldset disabled>${card('disabled', 'Disabled card')}</fieldset>
${card('ariaDisabled', 'ARIA disabled card', 'aria-disabled=true')}
${card('pointerDisabled', 'Pointer disabled card', 'style="pointer-events:none"')}
<div class=card id=ambiguous><input type=checkbox aria-label="Ambiguous checkbox" style="pointer-events:none"><label>Not associated</label><button>Other action</button></div>
<section style="cursor:pointer"><div class=card><input type=checkbox aria-label="Inherited pointer checkbox" style="pointer-events:none">Inherited cursor is not a card association</div><button>Separate section action</button></section>
<div class=blocked><div class=pointer id=coveredAction>Covered action</div><div class=overlay>Blocking surface</div></div>
<div class=pointer aria-disabled=true id=disabledAction>Disabled action</div>
<div class=pointer id=wrapper><button id=nativeChild>Native child</button><button>Second child</button></div>
<div class=pointer id=inherited>One inherited surface ${Array.from({ length: 40 }, () => '<span><b>decoration</b></span>').join('')}</div>
<p id=ordinary>Ordinary paragraph should not become a control</p><div id=hidden class=pointer>Hidden pointer</div><div id=clear class=pointer>Transparent pointer</div>
<div style="opacity:0" id=transparentAncestor>${card('transparentCard', 'Ancestor transparent card')}<div class=pointer id=transparentAction>Ancestor transparent action</div><div class=pointer tabindex=0>Ancestor transparent focusable action</div></div>
<div style="opacity:0" id=transparentShadow></div>
<div id=transparentSlot><div class=pointer slot=control>Slotted transparent action</div></div>
<div id=shadow></div><iframe src="${foreignOrigin}"></iframe>
${Array.from({ length: 180 }, (_, index) => `<div class="pointer bulk" id=bulk${index}>Extra surface ${index}</div>`).join('')}
<script>
document.documentElement.dataset.events='[]';
for(const type of ['click','change','keydown']) document.addEventListener(type,event=>{
 const list=JSON.parse(document.documentElement.dataset.events);list.push({type,id:event.target.id,host:event.target.closest('[id]')?.id,trusted:event.isTrusted,key:event.key});document.documentElement.dataset.events=JSON.stringify(list);
},true);
for(const el of document.querySelectorAll('.pointer,.pseudo'))el.addEventListener('click',event=>el.dataset.clicked=String(event.isTrusted));
for(const el of document.querySelectorAll('.card'))el.addEventListener('click',event=>{const input=el.querySelector('input');if(input.matches(':disabled')||el.getAttribute('aria-disabled')==='true')return;input.checked=true;el.dataset.clicked=String(event.isTrusted);if(el.id==='freelancer')document.getElementById('proceed').disabled=false});
document.getElementById('staff').addEventListener('keydown',event=>{if(event.key==='Enter')event.currentTarget.dataset.key=String(event.isTrusted)});
const root=document.getElementById('shadow').attachShadow({mode:'open'});root.innerHTML='<style>.surface{cursor:pointer;display:inline-block;padding:20px}</style><div class=surface id=shadowAction><img alt="Shadow provider" width=20 height=20></div>';root.getElementById('shadowAction').addEventListener('click',event=>event.currentTarget.dataset.clicked=String(event.isTrusted));
const transparentRoot=document.getElementById('transparentShadow').attachShadow({mode:'open'});transparentRoot.innerHTML='<div style="cursor:pointer;padding:20px" id=transparentShadowAction>Shadow transparent action</div><div style="cursor:pointer;padding:20px" id=transparentShadowCard><input type=checkbox style="width:0;height:0" id=transparentShadowInput>Shadow transparent card</div>';
document.getElementById('transparentSlot').attachShadow({mode:'open'}).innerHTML='<div style="opacity:0"><slot name=control></slot></div>';
</script>`
const server = createServer((request, response) => {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); response.end(html)
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`
let app, client, task, failure, page
async function call(name, values = {}, expectError = false) {
  const response = await client.callTool({ name: `velmren_${name}`, arguments: { ...(task ? { taskId: task.taskId } : {}), ...values } }, undefined, { timeout: 40000 })
  const result = JSON.parse(response.content.find(item => item.type === 'text').text)
  assert.equal(!!response.isError, expectError, JSON.stringify(result)); return result
}
async function observe(name) {
  const observation = await call('observe', { query: name })
  const element = observation.elements.find(item => item.name === name)
  assert.ok(element, `Missing ${name}`); return { observation, element }
}
async function action(name, values, expectError = false) {
  const { observation, element } = await observe(name)
  return call('act', { observationId: observation.observationId, actions: [{ ref: element.ref, ...values }] }, expectError)
}
async function clicked(id) { return page.evaluate(id => document.getElementById(id).dataset.clicked, id) }
try {
  app = await startBroker({ executable: path.resolve(executable), stateDir: path.join(output, 'state'), policy: { profileMode: 'persistent', allowedOrigins: [origin], webCompatibility: true }, browserArgs: ['--headless=new'] })
  const registration = await app.broker.rpc('admin', 'client_register', { label: 'VBR-014 control acceptance' })
  const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('./multi-agent-mcp-entry.mjs', import.meta.url)), directory], env: { VELMREN_ACCEPTANCE_CONNECTION: JSON.stringify({ endpoint: app.descriptor.endpoint, token: registration.token, client: registration.clientId }) }, stderr: 'pipe' })
  transport.stderr?.resume(); client = new Client({ name: 'vbr014-control-acceptance', version: '1' }); await client.connect(transport)
  task = await call('create_task', { url: origin }); page = app.broker.tasks.get(task.taskId).page; report.browser = page.browser.version
  for (const [name, id] of [['Войти через Google', 'simpals'], ['Continue with Google', 'malta'], ['Sign-Up', 'signup']]) {
    assert.equal((await observe(name)).element.discovery, 'pointer_surface')
    await action(name, { type: 'click' }); assert.equal(await clicked(id), 'true')
  }
  assert.equal((await call('observe', { query: 'Google' })).elements.length, 3)
  check('999 and MaltaPark pointer controls expose one named host and receive trusted clicks')
  const staff = await observe('google-icon-register'); assert.equal(staff.element.tag, 'div')
  await action('google-icon-register', { type: 'click' }); assert.equal(await clicked('staff'), 'true')
  await action('google-icon-register', { type: 'press', key: 'Enter' }); assert.equal(await page.evaluate(() => document.getElementById('staff').dataset.key), 'true')
  check('Staff image alternative names its focusable parent; click and Enter reach the same host')
  for (const [name, id] of [['Log in', 'login'], ['Accept cookies', 'cookies'], ['Example Account ⌄', 'account'], ['Account menu', 'avatar'], ['Inline action', 'inline']]) {
    await action(name, { type: 'click' }); assert.equal(await clicked(id), 'true')
  }
  await action('More choices', { type: 'click' }); assert.equal(await page.evaluate(() => document.querySelector('details').open), true)
  check('Header, generated cookie text, account text/SVG title, onclick and native summary remain actionable')
  for (const name of ['Išsaugoti', 'Native button', 'Reset fields']) assert.equal((await observe(name)).element.name, name)
  assert.equal((await call('observe', { query: 'NeverSearchThisPrivateValue' })).elements.length, 0)
  assert.equal((await observe('Private field')).element.value, '[redacted]')
  check('Native submit/button/reset values are searchable names; private field values remain unsearchable')
  const freelancer = 'Freelancer (I am looking for Work)', initial = (await observe(freelancer)).element
  assert.equal(initial.type, 'checkbox'); assert.equal(initial.checked, false); assert.equal(initial.interactionTarget, 'checkable_card')
  assert.equal((await action(freelancer, { type: 'setChecked', checked: true })).actionResult.delivery, 'delivered_verified')
  assert.equal((await observe(freelancer)).element.checked, true); assert.equal((await observe('Proceed')).element.disabled, false)
  assert.equal((await observe('Optional marketing')).element.checked, false); assert.equal(await clicked('freelancer'), 'true')
  const before = await page.evaluate(() => document.documentElement.dataset.events)
  await action(freelancer, { type: 'setChecked', checked: true })
  assert.equal(await page.evaluate(() => document.documentElement.dataset.events), before)
  check('Guru card template: trusted card activation verifies native checked state, enables Proceed and remains idempotent')
  for (const name of ['Covered card (I am looking for Work)', 'Disabled card (I am looking for Work)', 'ARIA disabled card (I am looking for Work)']) {
    assert.equal((await action(name, { type: 'setChecked', checked: true }, true)).actionResult.delivery, 'not_delivered')
    assert.equal((await observe(name)).element.checked, false)
  }
  for (const name of ['Covered action', 'Disabled action']) assert.equal((await action(name, { type: 'click' }, true)).actionResult.delivery, 'not_delivered')
  assert.equal((await observe('Ambiguous checkbox')).element.interactionTarget, undefined)
  assert.equal((await action('Ambiguous checkbox', { type: 'setChecked', checked: true }, true)).actionResult.delivery, 'not_delivered')
  assert.equal((await observe('Inherited pointer checkbox')).element.interactionTarget, undefined)
  assert.equal((await action('Inherited pointer checkbox', { type: 'setChecked', checked: true }, true)).actionResult.delivery, 'not_delivered')
  assert.equal(await page.evaluate(() => document.getElementById('pointerDisabledInput').checked), false)
  check('External overlays, disabled/ARIA-disabled cards and competing fields cannot receive a proxy click')
  for (const query of ['Ancestor transparent', 'Shadow transparent', 'Slotted transparent']) assert.equal((await call('observe', { query })).elements.length, 0)
  const transparent = await page.evaluate(() => {
    const card = document.getElementById('transparentCardInput'), shadow = document.getElementById('transparentShadow').shadowRoot
    const inputs = [card, shadow.getElementById('transparentShadowInput')]
    const actions = [document.getElementById('transparentAction'), shadow.getElementById('transparentShadowAction'), document.querySelector('#transparentSlot > div')]
    return {
      cards: inputs.map(input => {
        const capabilities = elementCapabilities(input)
        let pointAvailable = false
        try { controlActionPoint(input, 'setChecked'); pointAvailable = true } catch {}
        return { hidden: capabilities.hidden, actions: capabilities.availableActions, proxy: !!capabilities.cardProxy, pointAvailable, checked: input.checked }
      }),
      actions: actions.map(element => ({ hidden: elementCapabilities(element).hidden, actions: elementCapabilities(element).availableActions })),
    }
  })
  assert.ok(transparent.cards.every(card => card.hidden && !card.proxy && !card.pointAvailable && !card.checked && card.actions.length === 0))
  assert.ok(transparent.actions.every(action => action.hidden && action.actions.length === 0))
  check('Transparent light/shadow/slot ancestors expose no custom refs, checkable proxy, action point or available actions')
  const ordinary = await call('observe', { limit: 150, textLimit: 0 })
  assert.equal(ordinary.elements.filter(element => element.name.startsWith('One inherited surface')).length, 1)
  assert.ok(!ordinary.elements.some(element => /Ordinary paragraph|Hidden pointer|Transparent pointer|Native child Second child/.test(element.name)))
  assert.equal(ordinary.elements.filter(element => element.name === 'Native child').length, 1)
  check('Cursor inheritance is deduplicated; ordinary text, invisible surfaces and native-control containers are excluded')
  const extra = []; let offset = 0
  do {
    const chunk = await call('observe', { query: 'Extra surface', offset, limit: 60, textLimit: 0 }); extra.push(...chunk.elements.map(element => element.name)); offset = chunk.pagination.nextOffset
  } while (offset !== null)
  assert.equal(extra.length, 180); assert.equal(new Set(extra).size, 180); assert.equal((await observe('Extra surface 179')).element.name, 'Extra surface 179')
  check('All 180 custom controls remain reachable through query and pagination')
  const shadow = await observe('Shadow provider'); assert.equal(shadow.element.shadowRoot, 'open')
  await action('Shadow provider', { type: 'click' })
  assert.equal(await page.evaluate(() => document.getElementById('shadow').shadowRoot.getElementById('shadowAction').dataset.clicked), 'true')
  check('Open shadow custom host uses descendant alternative text and composed trusted hit testing')
  assert.equal((await call('observe', { query: 'Foreign Google action' })).elements.length, 0)
  const foreignTask = await call('create_task', { url: foreignOrigin }, true)
  assert.ok(foreignTask.error)
  check('New discovery never crosses an unapproved frame or task origin')
  const stale = await observe('Log in'); await call('observe')
  assert.equal((await call('act', { observationId: stale.observation.observationId, actions: [{ type: 'click', ref: stale.element.ref }] }, true)).actionResult.delivery, 'not_delivered')
  check('Fresh custom refs retain stale-observation rejection')
  await call('finish'); task = null; report.cleanup.taskFinished = true; report.passed = true
} catch (error) { failure = error; report.error = error.stack }
finally {
  try { if (task) { await call('cancel'); report.cleanup.taskCancelled = true } } catch (error) { report.cleanup.taskError = error.message; failure ??= error; report.passed = false }
  await client?.close().catch(() => {})
  try { await app?.close(); report.cleanup.browserClosed = app?.broker.browser.closed === true } catch (error) { report.cleanup.brokerError = error.message; failure ??= error; report.passed = false }
  await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => foreign.close(resolve))])
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2))
}
if (failure) throw failure

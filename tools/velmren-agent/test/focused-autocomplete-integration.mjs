// node test/focused-autocomplete-integration.mjs BROWSER_EXE NEW_OUTPUT_DIR [--agent-directory=DIR]
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const args = process.argv.slice(2), [executable, output] = args.filter(arg => !arg.startsWith('--'))
assert.ok(executable && output)
const directory = path.resolve(args.find(arg => arg.startsWith('--agent-directory='))?.slice(18) ?? fileURLToPath(new URL('../', import.meta.url)))
const { startBroker } = await import(pathToFileURL(path.join(directory, 'broker.mjs')))
await mkdir(path.dirname(output), { recursive: true }); await mkdir(output)
const html = `<!doctype html><style>
body{padding:30px;font:16px sans-serif}.value{position:relative;width:300px;height:22px;display:flex}.wrap{width:2px;height:22px}
input{box-sizing:border-box;width:2px;height:20px;padding:0;border:0}.placeholder{position:absolute;inset:0;background:#ddd}
#external{display:none;position:fixed;inset:0;z-index:9;background:#ddd}#modal{display:none;position:fixed;right:0;top:0}
</style><div class=value id=container><div class=wrap><div><input id=field aria-label=Skills aria-autocomplete=list></div></div><div class=placeholder id=placeholder>Select skills</div></div>
<div id=external>Loading</div><div id=modal role=dialog aria-modal=true>Dialog</div>
<script>document.documentElement.dataset.events='[]';document.getElementById('field').addEventListener('input',e=>{const events=JSON.parse(document.documentElement.dataset.events);events.push({type:'input',trusted:e.isTrusted});document.documentElement.dataset.events=JSON.stringify(events);document.getElementById('placeholder').style.display=e.target.value?'none':''});</script>`
const server = createServer((request, response) => { response.writeHead(200, { 'content-type': 'text/html' }); response.end(html) })
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`
const report = { passed: false, checks: [], cleanup: {} }
let app, task, page, failure
const unwrap = r => r.observation ?? r
async function observe() { return unwrap(await app.broker.rpc('scripts', 'task_observe', { taskId: task.taskId })) }
async function fill(value) {
  const o = await observe(), e = o.elements.find(e => e.name === 'Skills' && e.tag === 'input')
  assert.ok(e)
  return app.broker.rpc('scripts', 'task_act', { taskId: task.taskId, observationId: o.observationId, actions: [{ type: 'fill', ref: e.ref, value }] })
}
async function scenario(name, setup, blocked = true) {
  try {
    await page.navigate(origin); await page.evaluate(() => document.getElementById('field').focus())
    if (setup) await page.evaluate(setup)
    if (blocked) {
      await assert.rejects(fill('Python'), error => error.code === 'ELEMENT_OBSCURED')
      assert.deepEqual(await page.evaluate(() => ({ value: document.getElementById('field').value, events: JSON.parse(document.documentElement.dataset.events) })), { value: '', events: [] })
    } else {
      await fill('Python')
      assert.equal(await page.evaluate(() => document.getElementById('field').value), 'Python')
      assert.deepEqual(await page.evaluate(() => JSON.parse(document.documentElement.dataset.events)), [{ type: 'input', trusted: true }])
      await fill('')
      assert.equal(await page.evaluate(() => document.getElementById('field').value), '')
    }
    report.checks.push({ name, passed: true }); console.log(`PASS ${name}`)
  } catch (error) { failure ??= error; report.checks.push({ name, passed: false, error: error.stack }); console.log(`FAIL ${name}: ${error.message}`) }
}
try {
  app = await startBroker({ executable: path.resolve(executable), stateDir: path.join(output, 'state'), policy: { profileMode: 'persistent', allowedOrigins: [origin], webCompatibility: true }, browserArgs: ['--headless=new'] })
  task = await app.broker.rpc('scripts', 'task_create', { url: origin }); page = app.broker.tasks.get(task.taskId).page
  await scenario('focused_autosized_autocomplete_fills_and_clears_with_trusted_input', null, false)
  await scenario('unfocused_autocomplete_is_not_forced', () => document.getElementById('field').blur())
  await scenario('ordinary_focused_field_stays_obscured', () => document.getElementById('field').removeAttribute('aria-autocomplete'))
  await scenario('external_overlay_stays_obscured', () => document.getElementById('external').style.display = 'block')
  await scenario('nested_viewport_wide_strip_stays_obscured', () => {
    const cover = document.getElementById('placeholder'), box = document.getElementById('field').getBoundingClientRect()
    Object.assign(cover.style, { position: 'fixed', left: '0', right: '0', top: `${box.top}px`, bottom: 'auto', height: '22px' })
  })
  await scenario('oversized_absolute_placeholder_stays_obscured', () => document.getElementById('placeholder').style.width = '100vw')
  await scenario('semantic_placeholder_stays_obscured', () => document.getElementById('placeholder').setAttribute('role', 'button'))
  await scenario('interactive_placeholder_descendant_stays_obscured', () => { const a = document.createElement('a'); a.href = '#'; a.textContent = 'Continue'; document.getElementById('placeholder').append(a) })
  await scenario('multiple_controls_are_not_one_decorative_surface', () => { const input = document.createElement('input'); document.getElementById('container').append(input) })
  await scenario('large_container_is_not_a_control_decoration', () => document.getElementById('container').style.height = '300px')
  await scenario('focused_autocomplete_respects_modal', () => document.getElementById('modal').style.display = 'block')
  await scenario('full_sized_overlay_does_not_gain_keyboard_exception', () => document.getElementById('field').style.width = '150px')
  await app.broker.rpc('scripts', 'task_finish', { taskId: task.taskId }); task = null; report.cleanup.taskFinished = true; report.passed = !failure
} catch (error) { failure ??= error; report.error = error.stack }
finally {
  if (task) await app?.broker.rpc('scripts', 'task_cancel', { taskId: task.taskId }).catch(() => {})
  await app?.close(); report.cleanup.browserClosed = app?.broker.browser.closed === true
  await new Promise(resolve => server.close(resolve)); await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2))
}
if (failure) process.exitCode = 1

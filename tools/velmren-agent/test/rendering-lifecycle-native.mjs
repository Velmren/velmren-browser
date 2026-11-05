import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const [executable, output] = process.argv.slice(2)
if (!executable || !output) throw new Error('Usage: node test/rendering-lifecycle-native.mjs BROWSER_EXE NEW_OUTPUT_DIR')
const agentDirectory = process.argv.find(arg => arg.startsWith('--agent-directory='))?.slice('--agent-directory='.length) ?? fileURLToPath(new URL('../', import.meta.url))
const { startBroker } = await import(pathToFileURL(path.join(path.resolve(agentDirectory), 'broker.mjs')))
const directory = path.resolve(output)
await mkdir(directory, { recursive: false })
const report = { checks: [], osForegroundEquality: 'not_measured', secretProvided: false }
const pass = name => { report.checks.push({ name, passed: true }); console.log(`PASS ${name}`) }
let origin, childOrigin, app
const fixture = ({ child = false, popup = false } = {}) => `<!doctype html><meta charset="utf-8"><title>Rendering lifecycle fixture</title>
<style>body{padding:20px}#gate{opacity:0}input,button{display:block;margin:12px;min-height:30px}iframe{display:block;width:600px;height:300px}</style>
<div id="gate"><label>Fixture password<input type="password"></label><button id="action">Animate control</button><button id="popup">Open owned popup</button></div><p id="status">Loading</p>
${child || popup ? '' : `<iframe src="${childOrigin}/frame"></iframe>`}
<script>
window.fixtureFrames=0;function frame(){fixtureFrames++;requestAnimationFrame(frame)}requestAnimationFrame(frame);
function reveal(text){requestAnimationFrame(()=>requestAnimationFrame(()=>{document.getElementById('gate').style.opacity='1';document.getElementById('status').textContent=text}))}
reveal('Fixture ready');
document.getElementById('action').onclick=()=>{document.getElementById('gate').style.opacity='0';reveal('Action frame complete')};
document.getElementById('popup').onclick=()=>window.open('${origin}/popup','_blank');
</script>`
const server = createServer((request, response) => {
  response.writeHead(200, { 'content-type': 'text/html' })
  response.end(fixture({ child: request.url === '/frame', popup: request.url === '/popup' }))
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
origin = `http://127.0.0.1:${server.address().port}`
childOrigin = `http://localhost:${server.address().port}`
const owned = []
const state = async page => {
  const result = await page.send('Runtime.evaluate', { expression: `({visibility:document.visibilityState,focused:document.hasFocus(),opacity:getComputedStyle(document.getElementById('gate')).opacity,frames:window.fixtureFrames})`, returnByValue: true })
  assert.ok(!result.exceptionDetails, 'Fixture state evaluation succeeds')
  return result.result.value
}
const waitFrames = async page => {
  const result = await page.send('Runtime.evaluate', { expression: 'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))', awaitPromise: true, returnByValue: true }, 3000)
  assert.equal(result.result.value, true)
}
const assertFramesStopped = async page => {
  const result = await page.send('Runtime.evaluate', { expression: 'new Promise(resolve=>{let frames=0;requestAnimationFrame(()=>frames++);setTimeout(()=>resolve(frames),150)})', awaitPromise: true, returnByValue: true }, 3000)
  assert.equal(result.result.value, 0, 'Paused page does not receive an animation frame')
}
const waitReady = async (taskId, pageId, text = 'Fixture ready') => {
  const result = await app.broker.rpc('scripts', 'task_wait', { taskId, pageId, text, timeoutMs: 5000 })
  assert.equal(result.matched, true, 'RAF-dependent content becomes visible')
  return app.broker.rpc('scripts', 'task_observe', { taskId, pageId })
}
const rpc = (method, args) => app.broker.rpc('scripts', method, args)
const prepareRevoke = async (taskId, observation, expectedOrigin) => {
  const password = observation.elements.find(element => element.type === 'password')
  assert.ok(password, 'Password is exposed after real rendering')
  const prepared = await rpc('task_private_input', { action: 'prepare', taskId, pageId: observation.pageId, frameId: observation.frameId, observationId: observation.observationId, ref: password.ref, origin: expectedOrigin, topOrigin: origin })
  try { assert.equal(typeof prepared.secretRef, 'string') }
  finally { assert.equal((await rpc('task_private_input', { action: 'revoke', taskId, secretRef: prepared.secretRef })).revoked, true) }
  assert.equal(app.broker.privateInputs.entries.size, 0)
}
try {
  app = await startBroker({ executable: path.resolve(executable), stateDir: path.join(directory, 'state'), policy: { allowedOrigins: [origin, childOrigin], webCompatibility: true, profileMode: 'persistent' } })
  const methods = [], nativeSend = app.broker.browser.send.bind(app.broker.browser)
  app.broker.browser.send = (method, ...args) => { methods.push({ method, ...(method === 'Target.setTargetVisibility' ? { visible: args[0].visible } : {}) }); return nativeSend(method, ...args) }
  const a = await rpc('task_create', { url: origin, sensitive: true }); owned.push(a.taskId)
  const b = await rpc('task_create', { url: origin, sensitive: true }); owned.push(b.taskId)
  const taskA = app.broker.tasks.get(a.taskId), taskB = app.broker.tasks.get(b.taskId)
  const pageA = taskA.page, pageB = taskB.page
  let observed = await waitReady(a.taskId)
  await waitReady(b.taskId)
  assert.ok(observed.elements.some(element => element.type === 'password'))
  for (const page of [pageA, pageB]) { const current = await state(page); assert.equal(current.visibility, 'visible'); assert.equal(current.focused, true); assert.equal(current.opacity, '1'); assert.ok(current.frames > 0) }
  pass('hidden native roots render RAF-gated controls without user input')

  observed = await rpc('task_observe', { taskId: a.taskId, query: 'Animate control' })
  const button = observed.elements.find(element => element.tag === 'button')
  assert.ok(button, 'Observed synthetic animation control')
  const action = await rpc('task_act', { taskId: a.taskId, observationId: observed.observationId, actions: [{ type: 'click', ref: button.ref }] })
  assert.equal(action.actionResult.completed, 1)
  observed = await waitReady(a.taskId, undefined, 'Action frame complete')
  assert.equal((await state(pageA)).focused, true)
  pass('post-action cleanup leaves animation frames running')

  await prepareRevoke(a.taskId, observed, origin)
  await waitFrames(pageA)
  assert.equal((await state(pageA)).focused, true)
  pass('private prepare and revoke preserve rendering without a provided secret')

  const frames = await rpc('task_list_frames', { taskId: a.taskId })
  const child = frames.frames.find(frame => frame.frameId !== frames.mainFrameId)
  assert.ok(child, 'Cross-origin child frame is owned')
  const frameObservation = await rpc('task_observe', { taskId: a.taskId, frameId: child.frameId })
  await prepareRevoke(a.taskId, frameObservation, childOrigin)
  const childPage = pageA.frames.select(child.frameId)
  assert.notEqual(childPage.sessionId, pageA.sessionId, 'Fixture uses an out-of-process frame')
  await waitFrames(pageA)
  assert.equal((await state(pageA)).focused, true)
  pass('OOPIF private preparation preserves its root rendering baseline')

  observed = await rpc('task_observe', { taskId: a.taskId, query: 'Open owned popup' })
  const open = observed.elements.find(element => element.tag === 'button')
  assert.ok(open, 'Observed synthetic popup control')
  await rpc('task_act', { taskId: a.taskId, observationId: observed.observationId, actions: [{ type: 'click', ref: open.ref }] })
  for (let attempt = 0; taskA.pages.size < 2 && attempt < 30; attempt++) await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal(taskA.pages.size, 2)
  const popup = [...taskA.pages.values()].find(page => page !== pageA)
  await popup.ready; await waitReady(a.taskId, popup.pageId)
  assert.equal((await state(popup)).focused, true)
  pass('owned popup inherits active rendering before its first RAF-gated form')

  await app.broker.rpc('admin', 'task_control', { taskId: a.taskId, action: 'pause' })
  report.pausedStates = []
  for (const page of [pageA, popup]) { const current = await state(page); assert.equal(current.visibility, 'hidden'); await assertFramesStopped(page); report.pausedStates.push(current) }
  await waitFrames(pageB)
  assert.equal((await state(pageB)).focused, true)
  pass('pause releases every owned page while a sibling task continues rendering')

  await app.broker.rpc('admin', 'task_control', { taskId: a.taskId, action: 'resume' })
  for (const page of [pageA, popup]) { await waitFrames(page); assert.equal((await state(page)).focused, true) }
  const human = await rpc('task_request_human', { taskId: a.taskId, pageId: pageA.pageId, reason: 'Synthetic manual phase', showWindow: false })
  assert.equal(human.state, 'needs-human')
  for (const page of [pageA, popup]) { assert.equal((await state(page)).visibility, 'hidden'); await assertFramesStopped(page) }
  assert.equal((await state(pageB)).focused, true)
  await rpc('task_resume', { taskId: a.taskId, handoffId: human.handoff.id, userConfirmed: true })
  for (const page of [pageA, popup]) { await waitFrames(page); assert.equal((await state(page)).focused, true) }
  pass('human handoff releases all pages and confirmed resume restores their rendering')

  await rpc('task_navigate', { taskId: a.taskId, pageId: pageA.pageId, url: `${origin}/reload` })
  observed = await waitReady(a.taskId, pageA.pageId)
  await prepareRevoke(a.taskId, observed, origin)
  assert.equal((await state(pageA)).opacity, '1')
  pass('navigation after lifecycle transitions retains RAF-driven form visibility')
  const shows = methods.filter(call => ['Page.bringToFront', 'Target.activateTarget', 'Browser.setWindowBounds'].includes(call.method) || call.method === 'Target.setTargetVisibility' && call.visible)
  assert.equal(shows.length, 0)
  report.windowShowCommands = shows.length
  pass('integration sends no native window-show or activation commands')
} catch (error) {
  report.failure = { name: error.name, code: error.code, message: error.message }
  console.error(error)
  process.exitCode = 1
} finally {
  for (const taskId of owned) await app?.broker.rpc('scripts', 'task_cancel', { taskId }).catch(() => {})
  await app?.close()
  await new Promise(resolve => server.close(resolve))
  report.closed = app?.broker.browser.closed === true
  report.passed = !report.failure && report.checks.length === 9 && report.closed
  report.cleanup = { browserClosed: report.closed, fixtureClosed: !server.listening }
  await writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ output: directory, passed: report.checks.length, closed: report.closed }))
}

// node test/frames-integration.mjs BROWSER_EXE NEW_OUTPUT_DIR [--agent-directory=DIR]
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { startFormsFixture } from './forms-fixture.mjs'

const args = process.argv.slice(2), positions = args.filter(value => !value.startsWith('--'))
assert.equal(positions.length, 2)
assert.ok(args.every(value => !value.startsWith('--') || value.startsWith('--agent-directory=')))
const [executable, outputArgument] = positions
const directory = path.resolve(args.find(value => value.startsWith('--agent-directory='))?.slice(18) ?? fileURLToPath(new URL('../', import.meta.url)))
const output = path.resolve(outputArgument)
await mkdir(path.dirname(output), { recursive: true }); await mkdir(output)
const report = { passed: false, checks: [], cleanup: {} }, clients = []
let fixture, denied, app, failure
const check = name => { report.checks.push(name); console.log(`PASS ${name}`) }
async function connect(label) {
  const registration = await app.broker.rpc('admin', 'client_register', { label })
  const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('./multi-agent-mcp-entry.mjs', import.meta.url)), directory], env: { VELMREN_ACCEPTANCE_CONNECTION: JSON.stringify({ endpoint: app.descriptor.endpoint, token: registration.token, client: registration.clientId }) }, stderr: 'pipe' })
  transport.stderr?.resume()
  const client = new Client({ name: label, version: '1' }); clients.push(client); await client.connect(transport)
  return client
}
async function call(client, name, values = {}, expectError = false) {
  const result = await client.callTool({ name: `velmren_${name}`, arguments: values }, undefined, { timeout: 40000 })
  const value = JSON.parse(result.content.find(item => item.type === 'text').text)
  assert.equal(!!result.isError, expectError, JSON.stringify(value))
  return value
}
async function observe(client, task, frame, name) {
  const value = await call(client, 'observe', { taskId: task.taskId, ...(frame ? { frameId: frame.frameId } : {}) })
  const element = value.elements.find(item => item.name === name && item.tag !== 'label')
  assert.ok(element, `Missing ${name} in ${JSON.stringify(value)}`)
  return { value, element }
}
async function action(client, task, frame, name, values) {
  const { value, element } = await observe(client, task, frame, name)
  return call(client, 'act', { taskId: task.taskId, ...(frame ? { frameId: frame.frameId } : {}), observationId: value.observationId, actions: [{ ref: element.ref, ...values }] })
}
try {
  fixture = await startFormsFixture(); denied = await startFormsFixture()
  const { startBroker } = await import(pathToFileURL(path.join(directory, 'broker.mjs')))
  app = await startBroker({ executable: path.resolve(executable), stateDir: path.join(output, 'state'), policy: { profileMode: 'persistent', allowedOrigins: [fixture.origin, fixture.crossOrigin], webCompatibility: true }, browserArgs: ['--headless=new', '--site-per-process'] })
  report.browserPid = app.broker.browser.process.pid
  const a = await connect('Frame acceptance A'), b = await connect('Frame acceptance B')
  const task = await call(a, 'create_task', { url: `${fixture.origin}/frames` })
  const peer = await call(b, 'create_task', { url: `${fixture.origin}/frames` })
  assert.equal(task.sharedProfile, true)
  const listed = await call(a, 'list_frames', { taskId: task.taskId })
  assert.equal(listed.frames.length, 4)
  const same = listed.frames.find(frame => frame.url.endsWith('/frame-inner'))
  const cross = listed.frames.find(frame => frame.url.endsWith('/frame-cross'))
  const nested = listed.frames.find(frame => frame.url.endsWith('/frame-leaf'))
  assert.ok(same && cross && nested); assert.equal(nested.parentFrameId, same.frameId)
  assert.ok(task.observation.frames.some(frame => frame.frameId === cross.frameId))
  const localTask = app.broker.tasks.get(task.taskId), localPage = app.broker.page(localTask)
  assert.notEqual(localPage.frames.select(cross.frameId).sessionId, localPage.sessionId)
  assert.notEqual(localPage.frames.select(nested.frameId).sessionId, localPage.sessionId)
  check('Main, same-origin, cross-origin OOPIF and nested OOPIF frames are discoverable without exposing sessions')

  const peerFrames = await call(b, 'list_frames', { taskId: peer.taskId })
  const foreign = peerFrames.frames.find(frame => frame.url.endsWith('/frame-cross'))
  await call(a, 'observe', { taskId: peer.taskId, frameId: foreign.frameId }, true)
  await call(a, 'observe', { taskId: task.taskId, pageId: peer.selectedPageId, frameId: foreign.frameId }, true)
  await call(a, 'observe', { taskId: task.taskId, frameId: foreign.frameId }, true)
  const owned = await observe(a, task, same, 'Same frame name')
  await call(a, 'act', { taskId: task.taskId, frameId: cross.frameId, observationId: owned.value.observationId, actions: [{ type: 'fill', ref: owned.element.ref, value: 'Must not leak' }] }, true)
  check('Task, page and frame ownership reject foreign IDs despite the shared persistent profile')

  const upload = path.join(output, 'synthetic-frame-upload.txt'); await writeFile(upload, 'Synthetic frame upload\n')
  for (const [kind, frame] of [['Same frame', same], ['Cross frame', cross], ['Nested frame', nested]]) {
    const result = await action(a, task, frame, `${kind} name`, { type: 'fill', value: `${kind} User` })
    assert.equal(result.actionResult.delivery, 'delivered_verified')
    for (let attempt = 0; attempt < 2; attempt++) {
      const consent = await action(a, task, frame, `${kind} consent`, { type: 'setChecked', checked: true })
      assert.equal(consent.actionResult.delivery, 'delivered_verified')
    }
    const date = await action(a, task, frame, `${kind} date`, { type: 'fill', value: '1996-05-17' })
    assert.equal(date.actionResult.delivery, 'delivered_verified')
    const country = await observe(a, task, frame, `${kind} country`)
    const options = await call(a, 'list_options', { taskId: task.taskId, frameId: frame.frameId, observationId: country.value.observationId, ref: country.element.ref, query: 'Second country' })
    assert.equal(options.options.length, 1)
    await action(a, task, frame, `${kind} country`, { type: 'select', value: options.options[0].value })
    const opened = await action(a, task, frame, `${kind} file`, { type: 'click' })
    assert.ok(opened.observation.fileChooser?.chooserId)
    const uploaded = await call(a, 'upload_files', { taskId: task.taskId, frameId: frame.frameId, observationId: opened.observation.observationId, chooserId: opened.observation.fileChooser.chooserId, files: [upload] })
    assert.equal(uploaded.verified, true)
    await action(a, task, frame, `Submit ${kind} form`, { type: 'click' })
    const waited = await call(a, 'wait', { taskId: task.taskId, frameId: frame.frameId, text: `${kind} form accepted`, timeoutMs: 5000 })
    assert.equal(waited.matched, true)
    const submitted = fixture.records.find(value => value.kind === kind)
    assert.ok(submitted); assert.equal(submitted.values.name, `${kind} User`); assert.equal(submitted.values.consent, 'on'); assert.equal(submitted.values.country, 'two')
    assert.equal(submitted.values.date, '1996-05-17')
  }
  check('Trusted input, selection, upload and submission work across bordered and scrolled nested frames')

  for (const label of ['Scale same frame', 'Scale frame ancestor', 'Zoom frame ancestor']) {
    await action(a, task, null, label, { type: 'click' })
    const consent = await observe(a, task, same, 'Same frame consent')
    const rejected = await call(a, 'act', { taskId: task.taskId, frameId: same.frameId, observationId: consent.value.observationId, actions: [{ type: 'setChecked', ref: consent.element.ref, checked: false }] }, true)
    assert.equal(rejected.actionResult.delivery, 'not_delivered')
    assert.match(rejected.error, /unsupported CSS transform or zoom/)
    assert.equal((await observe(a, task, same, 'Same frame consent')).element.checked, true)
    await action(a, task, null, 'Restore frame layout', { type: 'click' })
  }
  check('Transforms and CSS zoom on frames or ancestors are rejected before input')

  const before = await observe(a, task, cross, 'Cross frame name')
  await action(a, task, null, 'Replace cross frame', { type: 'click' })
  await call(a, 'wait', { taskId: task.taskId, frameId: cross.frameId, text: 'generation 2', timeoutMs: 5000 })
  const stale = await call(a, 'act', { taskId: task.taskId, frameId: cross.frameId, observationId: before.value.observationId, actions: [{ type: 'fill', ref: before.element.ref, value: 'Stale' }] }, true)
  assert.equal(stale.actionResult.delivery, 'not_delivered')
  const sameBefore = await observe(a, task, same, 'Same frame name')
  await action(a, task, null, 'Remove same frame', { type: 'click' })
  await call(a, 'observe', { taskId: task.taskId, frameId: same.frameId }, true)
  await call(a, 'act', { taskId: task.taskId, frameId: same.frameId, observationId: sameBefore.value.observationId, actions: [{ type: 'fill', ref: sameBefore.element.ref, value: 'Detached' }] }, true)
  await call(a, 'observe', { taskId: task.taskId, frameId: nested.frameId }, true)
  await call(a, 'navigate', { taskId: task.taskId, url: `${fixture.origin}/frames` })
  await call(a, 'observe', { taskId: task.taskId, frameId: same.frameId }, true)
  check('Navigation, detach and a newly attached document invalidate old frame observations and IDs')

  const deniedResult = await call(a, 'navigate', { taskId: task.taskId, url: `${denied.origin}/frames` }, true)
  assert.match(JSON.stringify(deniedResult), /Origin|ORIGIN_DENIED/)
  // Exercise the same frame subresource policy without exposing a JS tool.
  await localPage.send('Runtime.evaluate', { expression: `document.querySelector('#cross').src=${JSON.stringify(`${denied.origin}/frame-cross`)}` })
  const probe = await localPage.send('Runtime.evaluate', { expression: `fetch(${JSON.stringify(`${denied.origin}/record`)},{method:'POST',body:'{}'}).then(()=>false,()=>true)`, awaitPromise: true, returnByValue: true })
  assert.equal(probe.result.value, true)
  assert.equal(denied.records.length, 0)
  check('Frame support preserves denied navigation and subresource network policy')
  await call(a, 'finish', { taskId: task.taskId }); await call(b, 'finish', { taskId: peer.taskId })
  report.passed = true
} catch (error) { failure = error; report.error = error.message; report.stack = error.stack }
finally {
  for (const client of clients) await client.close().catch(() => {})
  if (app) { await app.close(); report.cleanup.browserClosed = app.broker.browser.closed }
  if (fixture) { await fixture.close(); report.cleanup.fixtureClosed = true }
  if (denied) { await denied.close(); report.cleanup.deniedFixtureClosed = true }
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2))
}
if (failure) throw failure

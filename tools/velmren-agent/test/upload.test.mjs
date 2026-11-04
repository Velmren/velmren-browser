import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import { mkdir, mkdtemp, writeFile, symlink, open } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { AgentPage } from '../page.mjs'
import { AgentBroker, inspectUploadFiles } from '../runtime.mjs'
import { validateArguments } from '../client.mjs'
import { SERVER_INSTRUCTIONS, TOOL_DEFINITIONS } from '../mcp.mjs'

const root = fileURLToPath(new URL('../test-results/', import.meta.url))
const filePath = path.join(root, 'synthetic-resume.pdf')
const args = { taskId: 'task', observationId: 'obs', ref: 'e1', files: [filePath] }
const files = [{ path: filePath, name: 'synthetic-resume.pdf', size: 9 }]

function pageFixture() {
  const browser = new EventEmitter(), calls = [], document = {}
  const input = { isConnected: true, ownerDocument: document, tagName: 'INPUT', type: 'file', multiple: false, disabled: false, webkitdirectory: false, files: [], matches: () => false, getAttribute: () => null }
  const state = { revision: 0, refs: new Map([['e1', input]]) }
  const context = vm.createContext({ document, __velmrenAgent: state })
  let hook = () => {}, active = true, selection = files
  browser.send = async (method, params = {}, sessionId) => {
    calls.push({ method, params, sessionId })
    await hook(method, params)
    if (method === 'Runtime.evaluate') {
      try {
        const value = vm.runInContext(params.expression, context)
        return { result: params.returnByValue ? { value } : value === input ? { objectId: 'input-object' } : {} }
      } catch (error) { return { exceptionDetails: { text: error.message } } }
    }
    if (method === 'DOM.resolveNode') return { object: { objectId: 'input-object' } }
    if (method === 'Runtime.callFunctionOn') {
      try { return { result: { value: vm.runInContext(`(${params.functionDeclaration})`, context).apply(input, (params.arguments ?? []).map(arg => arg.value)) } } }
      catch (error) { return { exceptionDetails: { text: error.message } } }
    }
    if (method === 'DOM.setFileInputFiles') input.files = selection.map(({ name, size }) => ({ name, size }))
    return {}
  }
  const page = new AgentPage(browser, 'page', 'session')
  page.frameId = 'main'; page.world = 1
  page.observation = { id: 'obs', epoch: 0, revision: 0 }
  page.observe = async () => ({ observationId: 'next', pageId: page.pageId, elements: [], ...page.chooserObservation() })
  return { browser, page, calls, input, state, context, setSelection: value => { selection = value }, setHook: fn => { hook = fn }, pause: () => { active = false }, upload: (overrides = {}, chosen = files) => page.uploadFiles({ ...args, ...overrides }, chosen, () => active) }
}

test('upload argument boundary accepts only a bounded list of local paths and one opaque target', () => {
  validateArguments('task_upload_files', args)
  validateArguments('task_upload_files', { ...args, ref: undefined, chooserId: 'chooser' })
  for (const invalid of [
    { files: [] }, { files: Array(11).fill(filePath) }, { files: ['relative.pdf'] }, { files: ['//server/share/resume.pdf'] },
    { files: ['\\\\server\\share\\resume.pdf'] }, { files: ['\\\\?\\C:\\resume.pdf'] }, { files: [path.join(root, '*.pdf')] },
    { files: [path.join(root, 'NUL.pdf')] }, { files: [filePath + ':stream'] }, { files: [filePath + '\0'] },
    { files: [root + path.sep + '..' + path.sep + 'resume.pdf'] }, { ref: undefined }, { chooserId: 'x' }, { backendNodeId: 9 },
    { observationId: '' }, { files: [null] }, { files: 'resume.pdf' }
  ]) assert.throws(() => validateArguments('task_upload_files', { ...args, ...invalid }), { code: 'INVALID_ARGUMENTS' })
})

test('file inspection rejects missing files, directories, duplicate paths, links and oversize data without disclosing paths', async t => {
  await mkdir(root, { recursive: true })
  const directory = await mkdtemp(path.join(root, 'file-inspection-'))
  const ordinary = path.join(directory, 'synthetic.txt')
  await writeFile(ordinary, 'synthetic')
  assert.deepEqual((await inspectUploadFiles([ordinary])).map(({ name, size }) => ({ name, size })), [{ name: 'synthetic.txt', size: 9 }])
  for (const list of [[path.join(directory, 'missing.txt')], [directory], [ordinary, ordinary]]) {
    await assert.rejects(inspectUploadFiles(list), error => { assert.doesNotMatch(error.message, /file-inspection-|synthetic\.txt/); return true })
  }
  const large = path.join(directory, 'large-synthetic.bin')
  const handle = await open(large, 'w')
  await handle.truncate(100 * 1024 * 1024 + 1); await handle.close()
  await assert.rejects(inspectUploadFiles([large]), /100 MiB/)
  const link = path.join(directory, 'linked-directory')
  try { await symlink(directory, link, process.platform === 'win32' ? 'junction' : 'dir') }
  catch (error) { if (error.code === 'EPERM') { t.diagnostic('Symlink permission unavailable'); return } throw error }
  await assert.rejects(inspectUploadFiles([path.join(link, 'synthetic.txt')]), /symbolic link|junction/)
})

test('file upload binds the observed input, verifies names and sizes, and never sends paths through page JS or the result', async () => {
  const f = pageFixture()
  const result = await f.upload()
  assert.deepEqual(result.files, [{ name: 'synthetic-resume.pdf', size: 9 }])
  assert.equal(result.verified, true)
  const dispatch = f.calls.find(call => call.method === 'DOM.setFileInputFiles')
  assert.deepEqual(dispatch.params, { objectId: 'input-object', files: [filePath] })
  assert.equal(dispatch.sessionId, 'session')
  assert.ok(!JSON.stringify(result).includes(root))
  assert.ok(f.calls.filter(call => call.method.startsWith('Runtime.')).every(call => !JSON.stringify(call).includes(filePath)))
  assert.equal(f.calls.at(-1).method, 'Runtime.releaseObject')
  f.page.dispose()
})

for (const [name, change, pattern] of [
  ['stale observation', f => { f.page.observation.id = 'new' }, /Stale observation/],
  ['changed DOM', f => { f.state.revision++ }, /Page changed/],
  ['missing ref', f => { f.state.refs.clear() }, /reference is stale/],
  ['nonfile ref', f => { f.input.type = 'text' }, /not a file input/],
  ['disabled input', f => { f.input.disabled = true }, /disabled/],
  ['input inside a disabled fieldset', f => { f.input.matches = selector => selector === ':disabled' }, /disabled/],
  ['ARIA-disabled input', f => { f.input.getAttribute = name => name === 'aria-disabled' ? 'true' : null }, /disabled/],
  ['directory input', f => { f.input.webkitdirectory = true }, /Directory uploads/],
  ['disconnected input', f => { f.input.isConnected = false }, /reference is stale/],
  ['manual picker mode', f => { f.page.interceptFileChooser = false }, /state or page session/]
]) test(`upload rejects ${name} before any file selection`, async () => {
  const f = pageFixture(); change(f)
  await assert.rejects(f.upload(), pattern)
  assert.equal(f.calls.filter(call => call.method === 'DOM.setFileInputFiles').length, 0)
  f.page.dispose()
})

test('single input rejects multiple files, and multiple input verifies the full selected list', async () => {
  const f = pageFixture()
  const multiple = [...files, { path: path.join(root, 'other.txt'), name: 'other.txt', size: 2 }]
  await assert.rejects(f.upload({}, multiple), /only one file/)
  assert.equal(f.calls.filter(call => call.method === 'DOM.setFileInputFiles').length, 0)
  f.input.multiple = true
  f.setSelection(multiple)
  assert.equal((await f.upload({}, multiple)).files.length, 2)
  f.page.observation = { id: 'obs', epoch: 0, revision: 0 }
  f.setSelection(files)
  await assert.rejects(f.upload({}, multiple), /may already have reached/)
  assert.equal(f.page.observation, null)
  f.page.dispose()
})

for (const stage of ['Runtime.evaluate', 'DOM.resolveNode', 'Runtime.callFunctionOn']) test(`pause during upload ${stage} prevents selection`, async () => {
  const f = pageFixture()
  f.browser.emit('protocol', { sessionId: 'session', method: 'Page.fileChooserOpened', params: { frameId: 'main', backendNodeId: 7, mode: 'selectSingle' } })
  f.setHook(method => { if (method === stage) f.pause() })
  await assert.rejects(f.upload({ ref: undefined, chooserId: f.page.chooser.id }), /selection stopped/)
  assert.equal(f.calls.filter(call => call.method === 'DOM.setFileInputFiles').length, 0)
  f.page.dispose()
})

test('chooser IDs are opaque, session and frame bound, consumed after upload, and invalidated by navigation', async () => {
  const f = pageFixture()
  const opened = (sessionId, frameId = 'main') => f.browser.emit('protocol', { sessionId, method: 'Page.fileChooserOpened', params: { frameId, backendNodeId: 7, mode: 'selectSingle' } })
  opened('foreign'); assert.equal(f.page.chooser, null)
  opened('session', 'iframe')
  assert.equal(f.page.chooser, null, 'A chooser from another frame is not adopted')
  opened('session')
  const chooserId = f.page.chooser.id
  assert.equal(Object.hasOwn(f.page.chooserObservation().fileChooser, 'backendNodeId'), false)
  await assert.rejects(f.upload({ ref: undefined, chooserId: 'other' }), /Stale file chooser/)
  assert.equal((await f.upload({ ref: undefined, chooserId })).verified, true)
  assert.equal(f.page.chooser, null)
  opened('session')
  f.browser.emit('protocol', { sessionId: 'session', method: 'Page.navigatedWithinDocument', params: { frameId: 'main' } })
  assert.equal(f.page.chooser, null); assert.equal(f.page.observation, null)
  f.page.dispose()
})

test('an opaque chooser can select a detached input belonging to the current document', async () => {
  const f = pageFixture()
  f.input.isConnected = false; f.state.refs.clear()
  f.browser.emit('protocol', { sessionId: 'session', method: 'Page.fileChooserOpened', params: { frameId: 'main', backendNodeId: 7, mode: 'selectSingle' } })
  assert.equal((await f.upload({ ref: undefined, chooserId: f.page.chooser.id })).verified, true)
  assert.equal(f.calls.filter(call => call.method === 'DOM.setFileInputFiles').length, 1)
  f.page.dispose()
})

test('a detached chooser input from another document is rejected before selection', async () => {
  const f = pageFixture()
  f.input.isConnected = false; f.input.ownerDocument = {}; f.state.refs.clear()
  f.browser.emit('protocol', { sessionId: 'session', method: 'Page.fileChooserOpened', params: { frameId: 'main', backendNodeId: 7, mode: 'selectSingle' } })
  await assert.rejects(f.upload({ ref: undefined, chooserId: f.page.chooser.id }), /no longer available in this page/)
  assert.equal(f.calls.filter(call => call.method === 'DOM.setFileInputFiles').length, 0)
  f.page.dispose()
})

test('effective fieldset disabled state also prevents ordinary action preparation', async () => {
  const f = pageFixture()
  f.input.matches = selector => selector === ':disabled'
  assert.equal(f.input.disabled, false)
  await assert.rejects(f.page.act('obs', [{ type: 'click', ref: 'e1' }], () => true), /Element is disabled/)
  assert.equal(f.calls.filter(call => call.method === 'DOM.setFileInputFiles' || call.method.startsWith('Input.')).length, 0)
  f.page.dispose()
})

test('a path-bearing protocol failure after selection is sanitized and prevents blind retries', async () => {
  const f = pageFixture()
  f.setHook(method => { if (method === 'DOM.setFileInputFiles') throw new Error(`Cannot open ${filePath}`) })
  await assert.rejects(f.upload(), error => { assert.match(error.message, /may already have reached.*do not blindly replay/); assert.ok(!error.message.includes(filePath)); return true })
  assert.equal(f.page.observation, null)
  f.page.dispose()
})

test('broker checks ownership and page identity before inspecting a local file', async () => {
  const f = pageFixture(), broker = new AgentBroker(f.browser, 'unused', {}, { trace: null })
  const task = { taskId: 'task', owner: 'owner', state: 'agent-active', pages: new Map([['page', f.page]]), selectedPageId: 'page', queue: Promise.resolve(), downloads: [] }
  broker.tasks.set('task', task)
  await assert.rejects(broker.rpc('foreign', 'task_upload_files', args), /Task not found/)
  await assert.rejects(broker.rpc('owner', 'task_upload_files', { ...args, pageId: 'foreign-page' }), /Page not found/)
  let ready
  f.page.ready = new Promise(resolve => { ready = resolve })
  const pending = broker.rpc('owner', 'task_upload_files', args)
  await new Promise(resolve => setImmediate(resolve))
  task.state = 'paused'; ready()
  await assert.rejects(pending, /paused/)
  assert.equal(f.calls.filter(call => call.method === 'DOM.setFileInputFiles').length, 0)
  f.page.dispose()
})

test('pause during asynchronous filesystem inspection prevents selection even when page readiness already resolved', async t => {
  await mkdir(root, { recursive: true })
  const directory = await mkdtemp(path.join(root, 'file-pause-')), filename = path.join(directory, 'synthetic.txt')
  await writeFile(filename, 'synthetic')
  const f = pageFixture(), broker = new AgentBroker(f.browser, 'unused', {}, { trace: null })
  const task = { taskId: 'task', owner: 'owner', state: 'agent-active', pages: new Map([['page', f.page]]), selectedPageId: 'page', queue: Promise.resolve(), downloads: [] }
  broker.tasks.set('task', task)
  let entered, release
  const inspecting = new Promise(resolve => { entered = resolve }), pendingStat = new Promise(resolve => { release = resolve })
  const original = fs.promises.lstat
  t.mock.method(fs.promises, 'lstat', async (...values) => { entered(); await pendingStat; return original(...values) })
  syncBuiltinESMExports()
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); f.page.dispose() })
  const pending = broker.rpc('owner', 'task_upload_files', { ...args, files: [filename] })
  await inspecting
  const paused = broker.rpc('admin', 'task_control', { taskId: 'task', action: 'pause' })
  release()
  await assert.rejects(pending, /changed during file validation/)
  await paused
  assert.equal(f.calls.filter(call => call.method === 'DOM.setFileInputFiles').length, 0)
})

test('observations expose hidden file inputs and metadata without the browser fake path', async () => {
  const f = pageFixture()
  Object.assign(f.input, { getBoundingClientRect: () => ({ width: 0, height: 0 }), labels: [], value: 'C:\\fakepath\\synthetic.pdf', accept: '.pdf,.docx', multiple: true, files: [{ name: 'synthetic.pdf', size: 9 }], getAttribute: key => key === 'aria-label' ? 'Hidden CV' : null })
  Object.assign(f.context.document, { title: 'Fixture', body: { innerText: 'Upload fixture' }, querySelectorAll: () => [f.input] })
  Object.assign(f.context, { location: { href: 'http://localhost/' }, getComputedStyle: () => ({ display: 'none', visibility: 'hidden' }) })
  const observed = await AgentPage.prototype.observe.call(f.page, true)
  assert.equal(observed.elements[0].hidden, true)
  assert.equal(observed.elements[0].multiple, true)
  assert.equal(observed.elements[0].accept, '.pdf,.docx')
  assert.equal(observed.elements[0].value, '')
  assert.equal(observed.elements[0].files[0].name, 'synthetic.pdf')
  assert.ok(!JSON.stringify(observed).includes('fakepath'))
  f.input.matches = selector => selector === ':disabled'
  assert.equal(f.input.disabled, false)
  assert.equal((await AgentPage.prototype.observe.call(f.page, true)).elements[0].disabled, true)
  f.page.dispose()
})

test('manual-step messaging stays neutral and uploads are advertised as a consequential bounded tool', () => {
  const upload = TOOL_DEFINITIONS.find(tool => tool.name === 'velmren_upload_files')
  assert.equal(upload.inputSchema.properties.files.maxItems, 10)
  assert.match(upload.description, /immediately upload/)
  assert.doesNotMatch(SERVER_INSTRUCTIONS + TOOL_DEFINITIONS.find(tool => tool.name === 'velmren_request_human').description, /CAPTCHA|bypass|challenge/i)
})

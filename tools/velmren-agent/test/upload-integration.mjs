// node test/upload-integration.mjs BROWSER_EXE NEW_OUTPUT_DIR [--agent-directory=DIR]
// Uses only newly generated synthetic files and a fresh headless browser profile.
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { uploadFixture } from './upload-fixture.mjs'

const positional = process.argv.slice(2).filter(arg => !arg.startsWith('--'))
const option = process.argv.slice(2).find(arg => arg.startsWith('--agent-directory='))
if (positional.length !== 2 || process.argv.slice(2).some(arg => arg.startsWith('--') && arg !== option)) throw new Error('Usage: upload-integration.mjs BROWSER_EXE NEW_OUTPUT_DIR [--agent-directory=DIR]')
const [executable, outputArgument] = positional
const directory = path.resolve(option?.slice('--agent-directory='.length) ?? fileURLToPath(new URL('../', import.meta.url)))
const output = path.resolve(outputArgument)
await mkdir(path.dirname(output), { recursive: true }); await mkdir(output)
const report = { passed: false, startedAt: new Date().toISOString(), scope: 'Fresh headless native browser, five isolated MCP clients, synthetic files only', checks: [], cleanup: {} }
const peers = [], tasks = [], pending = new Set()
let fixture, app, failure
const pass = name => { report.checks.push(name); console.log(`PASS ${name}`) }
const tool = (index, name, args = {}) => {
  const call = (async () => {
    const result = await peers[index].client.callTool({ name, arguments: { ...(tasks[index] ? { taskId: tasks[index].taskId } : {}), ...args } }, undefined, { timeout: 40000 })
    const value = JSON.parse(result.content.find(item => item.type === 'text').text)
    if (result.isError) { const error = new Error(value.error); error.code = value.code; throw error }
    return value
  })()
  pending.add(call); call.then(() => pending.delete(call), () => pending.delete(call))
  return call
}
const observe = index => tool(index, 'velmren_observe')
const input = (observation, name) => {
  const element = observation.elements.find(element => element.name === name && element.type === 'file')
  assert.ok(element, `Missing file input: ${name}`); return element
}
const click = async (index, name) => {
  const observation = await observe(index)
  const element = observation.elements.find(element => element.name === name && element.tag === 'button')
  assert.ok(element, `Missing button: ${name}`)
  return tool(index, 'velmren_act', { observationId: observation.observationId, actions: [{ type: 'click', ref: element.ref }] })
}
const upload = async (index, name, samples) => {
  const observation = await observe(index)
  const result = await tool(index, 'velmren_upload_files', { observationId: observation.observationId, ref: input(observation, name).ref, files: samples.map(sample => sample.path) })
  assert.equal(result.verified, true)
  assert.deepEqual(result.files, samples.map(({ name, size }) => ({ name, size })))
  assert.ok(!JSON.stringify(result).includes(path.join(output, 'files')))
  return result
}
const received = async (index, control) => assert.equal((await tool(index, 'velmren_wait', { text: `Received ${control}`, timeoutMs: 15000 })).matched, true)
const admin = async (method, args = {}) => {
  const response = await fetch(`${app.descriptor.endpoint}/rpc`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${app.descriptor.adminToken}` }, body: JSON.stringify({ method, args }), signal: AbortSignal.timeout(30000) })
  const result = await response.json(); assert.equal(result.ok, true, result.error); return result.result
}
try {
  fixture = await uploadFixture(path.join(output, 'files'))
  const { startBroker } = await import(pathToFileURL(path.join(directory, 'broker.mjs')))
  app = await startBroker({ executable: path.resolve(executable), stateDir: path.join(output, 'state'), policy: { allowedOrigins: [fixture.origin], webCompatibility: true, maxTasks: 8, maxActiveActions: 5 }, browserArgs: ['--headless=new'] })
  report.browser = app.broker.browser.version
  const initialContexts = (await app.broker.browser.send('Target.getBrowserContexts')).browserContextIds
  for (let index = 0; index < 5; index++) {
    const registration = await admin('client_register', { label: `Synthetic upload ${index}` })
    const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('./multi-agent-mcp-entry.mjs', import.meta.url)), directory], env: { VELMREN_ACCEPTANCE_CONNECTION: JSON.stringify({ endpoint: app.descriptor.endpoint, token: registration.token, client: registration.clientId }) }, stderr: 'pipe' })
    const client = new Client({ name: `upload-acceptance-${index}`, version: '1' })
    peers.push({ client, transport }); transport.stderr?.resume()
    await client.connect(transport)
  }
  const created = await Promise.all(peers.map((_, index) => tool(index, 'velmren_create_task', { url: `${fixture.origin}/?agent=${index}`, label: `Synthetic uploads ${index}` })))
  tasks.push(...created)
  const samples = fixture.samples[0]
  await upload(0, 'Visible CV', [samples.pdf]); await click(0, 'Submit visible CV'); await received(0, 'visible')
  pass('Visible PDF input and multipart form submission preserve exact byte length and SHA-256')
  const hiddenObservation = await observe(0)
  assert.equal(input(hiddenObservation, 'Hidden CV').hidden, true)
  assert.match(input(hiddenObservation, 'Hidden CV').accept, /\.pdf/)
  await upload(0, 'Hidden CV', [samples.txt]); await received(0, 'hidden')
  pass('Hidden label input is observed with accept metadata and auto-uploads a synthetic TXT')
  const clicked = await click(0, 'Custom upload button')
  const chooserObservation = clicked.observation.fileChooser ? clicked.observation : await observe(0)
  assert.ok(chooserObservation.fileChooser?.chooserId)
  assert.equal(Object.hasOwn(chooserObservation.fileChooser, 'backendNodeId'), false)
  assert.ok(!chooserObservation.elements.some(element => element.type === 'file' && element.name === 'Custom file'), 'Custom chooser input must remain detached from the document')
  const chosen = await tool(0, 'velmren_upload_files', { observationId: chooserObservation.observationId, chooserId: chooserObservation.fileChooser.chooserId, files: [samples.docx.path] })
  assert.equal(chosen.verified, true); await received(0, 'custom')
  pass('Detached custom button chooser is intercepted and attaches a synthetic DOCX without an OS dialog')
  await upload(0, 'Multiple attachments', [samples.txt, samples.docx]); await received(0, 'multiple')
  const multipleUploads = fixture.evidence.uploads.filter(record => record.agent === 0 && record.control === 'multiple')
  assert.equal(multipleUploads.length, 1)
  assert.deepEqual(multipleUploads[0].files, [samples.txt, samples.docx].map(({ name, size, sha256 }) => ({ name, size, sha256 })))
  pass('Multiple input retains both selected files and both received byte hashes')
  const observation = await observe(0), visible = input(observation, 'Visible CV')
  const baseline = fixture.evidence.uploads.length
  const selectedFiles = () => Promise.all(tasks.map(task => app.broker.page(app.broker.tasks.get(task.taskId)).evaluate(() =>
    [...document.querySelectorAll('input[type="file"]')].map(input => ({ id: input.id, files: [...input.files].map(file => ({ name: file.name, size: file.size })) })))))
  const filesBeforeRejections = await selectedFiles()
  const uploadArgs = { observationId: observation.observationId, ref: visible.ref, files: [samples.pdf.path] }
  await assert.rejects(tool(1, 'velmren_upload_files', { ...uploadArgs, taskId: tasks[0].taskId }), /Task not found/)
  await assert.rejects(tool(0, 'velmren_upload_files', { ...uploadArgs, pageId: tasks[1].observation.pageId }), /Page not found/)
  await assert.rejects(tool(0, 'velmren_upload_files', { ...uploadArgs, files: [path.join(output, 'files', 'missing.pdf')] }), { code: 'INVALID_ARGUMENTS', message: 'Invalid browser operation arguments.' })
  await assert.rejects(tool(0, 'velmren_upload_files', { ...uploadArgs, files: [samples.pdf.path, samples.docx.path] }), { code: 'BROKER_ERROR', message: 'Browser operation failed.' })
  const disabled = input(observation, 'Disabled CV')
  assert.equal(disabled.disabled, true)
  await assert.rejects(tool(0, 'velmren_upload_files', { ...uploadArgs, ref: disabled.ref }), { code: 'BROKER_ERROR', message: 'Browser operation failed.' })
  const button = observation.elements.find(element => element.name === 'Change page' && element.tag === 'button')
  await assert.rejects(tool(0, 'velmren_upload_files', { ...uploadArgs, ref: button.ref }), { code: 'ACTION_FAILED', message: 'Action failed; inspect the delivery receipt before retrying.' })
  await observe(0)
  await assert.rejects(tool(0, 'velmren_upload_files', uploadArgs), { code: 'BROKER_ERROR', message: 'Browser operation failed.' })
  const fresh = await observe(0)
  await assert.rejects(tool(0, 'velmren_upload_files', { observationId: fresh.observationId, chooserId: chooserObservation.fileChooser.chooserId, files: [samples.pdf.path] }), { code: 'BROKER_ERROR', message: 'Browser operation failed.' })
  assert.equal(fixture.evidence.uploads.length, baseline)
  assert.deepEqual(await selectedFiles(), filesBeforeRejections)
  pass('Foreign task/page, missing file, nonfile ref, single-input multiplicity, stale observation and consumed chooser are rejected without uploading')
  await Promise.all(peers.map((_, index) => upload(index, 'Parallel attachment', [fixture.samples[index].pdf])))
  await Promise.all(peers.map((_, index) => received(index, 'parallel')))
  assert.equal(fixture.evidence.parallelPeak, 5)
  assert.deepEqual(fixture.evidence.uploads.filter(record => record.control === 'parallel').map(record => record.agent).sort(), [0, 1, 2, 3, 4])
  assert.deepEqual(fixture.evidence.failures, [])
  pass('Five independent MCP owners upload simultaneously with exact owner, length and SHA-256 checks')
  await Promise.all(tasks.map((_, index) => tool(index, 'velmren_finish')))
  assert.deepEqual((await app.broker.browser.send('Target.getBrowserContexts')).browserContextIds, initialContexts)
  report.cleanup.contextsRestored = true
  report.passed = true
} catch (error) { failure = error; report.error = error.message }
finally {
  await Promise.allSettled([...pending])
  if (app && !report.passed) await Promise.allSettled(tasks.map((_, index) => tool(index, 'velmren_cancel')))
  await Promise.allSettled(peers.map(peer => peer.client.close()))
  await Promise.allSettled(peers.map(peer => peer.transport.close()))
  try { await app?.close(); report.cleanup.brokerClosed = true } catch (error) { report.cleanup.error = error.message; report.passed = false }
  await fixture?.close()
  report.finishedAt = new Date().toISOString()
  report.evidence = fixture?.evidence
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2))
}
if (failure) throw failure
if (!report.passed) throw new Error('Upload acceptance cleanup failed')
console.log('Upload acceptance passed; report.json contains synthetic metadata only.')

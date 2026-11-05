import test from 'node:test'
import assert from 'node:assert/strict'
import { TaskDiagnostics, sanitizeTaskDiagnostics } from '../task-diagnostics.mjs'
import { sanitizePublicResult } from '../privacy.mjs'
import { validateArguments } from '../client.mjs'
import { TOOL_DEFINITIONS } from '../mcp.mjs'

const marker = 'PRIVATE_DIAGNOSTIC_MARKER'
const pageId = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', frameId = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
const entry = { page: { pageId } }
test('request bodies, headers, OAuth tails and exception strings are discarded before retention', () => {
  const diagnostics = new TaskDiagnostics()
  diagnostics.event({ sessionId: 'fixture', method: 'Network.requestWillBeSent', params: { requestId: 'one', frameId, type: 'Fetch', request: {
    url: `https://user:${marker}@fixture.test/oauth?code=${marker}#${marker}`, method: 'POST', postData: marker,
    headers: { Authorization: marker, Cookie: marker, 'Content-Type': 'multipart/form-data; boundary=' + marker }
  } } }, entry)
  diagnostics.event({ sessionId: 'fixture', method: 'Network.responseReceived', params: { requestId: 'one', type: 'Fetch', response: { status: 500, url: `https://fixture.test/${marker}`, headers: { 'Set-Cookie': marker } } } }, entry)
  diagnostics.event({ sessionId: 'fixture', method: 'Runtime.exceptionThrown', params: { exceptionDetails: { exception: { description: `FedCM request failed: ${marker}` } } } }, entry)
  const snapshot = diagnostics.snapshot()
  assert.equal(snapshot.network[0].origin, 'https://fixture.test'); assert.equal(snapshot.network[0].status, 500)
  assert.equal(snapshot.network[0].multipartUpload, true); assert.equal(snapshot.errors.fedcm, 1)
  assert.ok(!JSON.stringify([...diagnostics.network.values(), diagnostics.errors, snapshot]).includes(marker))
  assert.deepEqual(sanitizePublicResult({ diagnostics: snapshot, recoverySecret: marker }, { sensitive: true }), { diagnostics: snapshot })
})

test('bounded observations distinguish network failure, site HTTP response and local policy denial', () => {
  const diagnostics = new TaskDiagnostics()
  diagnostics.event({ sessionId: 's', method: 'Network.loadingFailed', params: { requestId: 'a', type: 'Document', errorText: 'net::ERR_CONNECTION_REFUSED', canceled: false, blockedReason: 'csp', corsErrorStatus: { corsError: 'DisallowedByMode' } } }, entry)
  diagnostics.blocked({ sessionId: 's', method: 'Fetch.requestPaused', params: { requestId: 'b', resourceType: 'Script', request: { url: 'https://denied.test/script', method: 'GET' } } }, entry)
  const view = diagnostics.snapshot()
  assert.equal(view.network[0].networkError, 'ERR_CONNECTION_REFUSED'); assert.equal(view.network[0].corsFailure, true)
  assert.equal(view.network[1].policyBlocked, true)
  for (let index = 0; index < 180; index++) diagnostics.event({ sessionId: 's', method: 'Network.loadingFinished', params: { requestId: `item-${index}` } }, entry)
  assert.equal(diagnostics.snapshot().network.length, 160); assert.equal(diagnostics.dropped, 22)
})

test('application console failures contribute only fixed categories without retaining arguments', () => {
  const diagnostics = new TaskDiagnostics()
  const event = (type, args) => diagnostics.event({ method: 'Runtime.consoleAPICalled', params: { type, args, stackTrace: { description: marker } } }, entry)
  event('error', [{ type: 'string', value: `FedCM request failed ${marker}` }])
  event('warning', [{ type: 'object', subtype: 'error', description: `InvalidPDFException ${marker}`, objectId: marker }])
  event('error', [{ type: 'object', objectId: marker, description: marker }])
  event('log', [{ type: 'string', value: `CORS ${marker}` }])
  assert.equal(diagnostics.errors.fedcm, 1); assert.equal(diagnostics.errors['file-import'], 1)
  assert.equal(diagnostics.errors.javascript, 1); assert.equal(diagnostics.errors.cors, 0)
  assert.ok(!JSON.stringify([diagnostics, diagnostics.snapshot()]).includes(marker))
})

test('diagnostic projection rejects arbitrary codes and accessors while retaining safe category counts', () => {
  let getters = 0
  const value = { available: true, errors: { cors: 1 }, network: [{ resourceType: marker, method: marker, origin: 'https://fixture.test/private?code=' + marker,
    networkError: 'ERR_' + marker, blockedReason: marker, frameId: marker, get status() { getters++; return 500 } }] }
  const clean = sanitizeTaskDiagnostics(value)
  assert.equal(getters, 0); assert.ok(!JSON.stringify(clean).includes(marker)); assert.equal(clean.errors.cors, 1)
  assert.equal(clean.network[0].resourceType, 'Other'); assert.equal(clean.network[0].origin, 'https://fixture.test')
})

test('diagnostic RPC accepts only a scoped task and advertises no mutation arguments', () => {
  validateArguments('task_diagnostics', { taskId: 'own-task' })
  assert.throws(() => validateArguments('task_diagnostics', { taskId: 'own-task', headers: true }), { code: 'INVALID_ARGUMENTS' })
  const tool = TOOL_DEFINITIONS.find(item => item.name === 'velmren_diagnostics')
  assert.equal(tool.method, 'task_diagnostics'); assert.deepEqual(Object.keys(tool.inputSchema.properties), ['taskId'])
})

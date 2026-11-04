import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { connectClient, createClient, dashboardUrl, parseOptions, readConnection, validateArguments } from '../client.mjs'
import { unknownActionResult } from '../action-result.mjs'

const run = promisify(execFile)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const testRoot = resolve(root, 'test-results')
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZ1kAAAAASUVORK5CYII='

async function brokerFixture(t, override) {
  await mkdir(testRoot, { recursive: true })
  const stateDir = await mkdtemp(resolve(testRoot, 'adapters-'))
  const requests = []
  const tasks = new Map()
  const server = createServer(async (req, res) => {
    let raw = ''
    for await (const chunk of req) raw += chunk
    const body = JSON.parse(raw)
    const owner = req.headers.authorization?.replace('Bearer test-', '')
    requests.push({ method: req.method, url: req.url, auth: req.headers.authorization, body })
    if (override) return override(req, res, body)
    const send = (status, payload) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(payload)) }
    if (!['codex', 'claude', 'scripts'].includes(owner)) return send(401, { ok: false, error: 'Unauthorized', code: 'UNAUTHORIZED' })
    const { method, args } = body
    if (method === 'task_create') {
      const task = { taskId: `task-${tasks.size + 1}`, owner, label: args.label, url: args.url, state: 'agent-active', reason: '' }
      tasks.set(task.taskId, task)
      return send(200, { ok: true, result: task })
    }
    if (method === 'task_list') return send(200, { ok: true, result: { tasks: [...tasks.values()].filter(task => task.owner === owner) } })
    const task = tasks.get(args.taskId)
    if (!task || task.owner !== owner) return send(403, { ok: false, error: 'Task is owned by another client', code: 'TASK_FORBIDDEN' })
    if (method === 'task_observe') return send(200, { ok: true, result: { ...task, observationId: 'obs-1', text: 'Test form', elements: [{ ref: 'e1', tag: 'input', role: 'textbox', name: 'Name' }], downloads: [] } })
    if (method === 'task_screenshot') return send(200, { ok: true, result: { mimeType: 'image/png', data: png } })
    if (method === 'task_act' && args.observationId !== 'obs-1') return send(409, { ok: false, error: 'Observe again', code: 'STALE_OBSERVATION' })
    if (method === 'task_request_human') { task.state = 'needs-human'; task.reason = args.reason }
    if (method === 'task_finish') task.state = 'completed'
    if (method === 'task_cancel') task.state = 'cancelled'
    send(200, { ok: true, result: task })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const descriptor = {
    endpoint: `http://127.0.0.1:${server.address().port}`, adminToken: 'test-admin-private',
    clients: Object.fromEntries(['codex', 'claude', 'scripts'].map(client => [client, { token: `test-${client}` }]))
  }
  await writeFile(resolve(stateDir, 'connection.json'), JSON.stringify(descriptor))
  t.after(async () => {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    assert.ok(stateDir.startsWith(testRoot + '\\') || stateDir.startsWith(testRoot + '/'))
    await rm(stateDir, { recursive: true, force: true })
  })
  return { stateDir, descriptor, requests }
}

async function mcpFixture(t, stateDir, owner) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [resolve(root, 'mcp.mjs'), '--state-dir', stateDir, '--client', owner], stderr: 'pipe' })
  let stderr = ''
  transport.stderr?.on('data', chunk => { stderr += chunk.toString() })
  const client = new Client({ name: 'adapter-test', version: '1.0.0' })
  await client.connect(transport)
  t.after(async () => { await client.close(); assert.equal(stderr, '', 'stdio adapter should not emit diagnostics on success') })
  return client
}

test('CLI options reject missing state, unknown clients, and unexpected flags', () => {
  assert.deepEqual(parseOptions(['--state-dir', 'somewhere', '--client', 'claude', 'task_list']), { client: 'claude', positional: ['task_list'], stateDir: 'somewhere' })
  assert.throws(() => parseOptions([]), /state-dir is required/)
  assert.throws(() => parseOptions(['--state-dir', 'x', '--client', 'admin']), /must be codex/)
  assert.throws(() => parseOptions(['--token', 'secret']), /Unknown option/)
})

test('client sends only the chosen credential and preserves arguments without evaluation', async t => {
  const fixture = await brokerFixture(t)
  const client = await connectClient(fixture.stateDir, 'scripts')
  const label = '<script>alert("test")</script>'
  const created = await client.call('task_create', { url: 'https://example.test/form', label })
  assert.equal(created.label, label)
  assert.equal(created.owner, 'scripts')
  assert.deepEqual(fixture.requests[0], {
    method: 'POST', url: '/rpc', auth: 'Bearer test-scripts', body: { method: 'task_create', args: { url: 'https://example.test/form', label } }
  })
  assert.ok(!JSON.stringify(fixture.requests).includes(fixture.descriptor.adminToken))
})

test('connection descriptor refuses remote or credential-bearing endpoints before sending a token', async t => {
  const fixture = await brokerFixture(t)
  for (const endpoint of ['https://example.test', 'http://localhost:1234', 'http://127.0.0.1:1234/rpc', 'http://user:password@127.0.0.1:1234', 'http://127.0.0.1:1234?token=x']) {
    await writeFile(resolve(fixture.stateDir, 'connection.json'), JSON.stringify({ ...fixture.descriptor, endpoint }))
    await assert.rejects(readConnection(fixture.stateDir), /Broker endpoint must/)
  }
  assert.equal(fixture.requests.length, 0)
})

test('task argument boundary rejects administrative methods, code, stale input shapes, and oversized waits', () => {
  for (const [method, args] of [
    ['shutdown', {}], ['task_control', { taskId: 't', action: 'show' }],
    ['task_navigate', { taskId: 't', url: 'javascript:alert(1)' }],
    ['task_act', { taskId: 't', observationId: 'o', actions: [{ type: 'evaluate', value: 'alert(1)' }] }],
    ['task_act', { taskId: 't', observationId: 'o', actions: [{ type: 'click', ref: 'e1', selector: '#submit' }] }],
    ['task_act', { taskId: 't', observationId: 'o', actions: [{ type: 'fill', ref: 'e1' }] }],
    ['task_act', { taskId: 't', observationId: 'o', actions: [{ type: 'setChecked', ref: 'e1', checked: 'true' }] }],
    ['task_act', { taskId: 't', observationId: 'o', actions: [{ type: 'click', ref: 'e1', checked: true }] }],
    ['task_observe', { taskId: 't', offset: -1 }],
    ['task_list_options', { taskId: 't', observationId: 'o', ref: 'e1', limit: 101 }],
    ['task_wait', { taskId: 't', text: 'done', timeoutMs: 15001 }],
    ['task_list', { owner: 'claude' }]
  ]) assert.throws(() => validateArguments(method, args))
  assert.doesNotThrow(() => validateArguments('task_act', { taskId: 't', observationId: 'o', actions: [{ type: 'fill', ref: 'e1', value: '' }, { type: 'press', key: 'Enter' }] }))
  assert.doesNotThrow(() => validateArguments('task_act', { taskId: 't', frameId: 'child', observationId: 'o', actions: [{ type: 'setChecked', ref: 'e1', checked: true }, { type: 'fill', ref: 'e2', value: '1996-05-17' }] }))
  assert.doesNotThrow(() => validateArguments('task_observe', { taskId: 't', frameId: 'child', query: 'country', offset: 150, limit: 100, textOffset: 10000, textLimit: 10000 }))
  assert.doesNotThrow(() => validateArguments('task_list_options', { taskId: 't', frameId: 'child', observationId: 'o', ref: 'e1', query: 'Zimbabwe', offset: 0, limit: 100 }))
})

test('ordinary profile-login APIs require explicit confirmation and bounded arguments', () => {
  assert.doesNotThrow(() => validateArguments('profile_login_start', { url: 'https://accounts.google.com/', userConfirmed: true }))
  assert.doesNotThrow(() => validateArguments('profile_login_status', {}))
  assert.doesNotThrow(() => validateArguments('profile_login_finish', { loginId: 'current-login', userConfirmed: true }))
  for (const [method, args] of [
    ['profile_login_start', { url: 'https://accounts.google.com/' }],
    ['profile_login_start', { url: 'https://accounts.google.com/', userConfirmed: false }],
    ['profile_login_start', { url: '--remote-debugging-port=1', userConfirmed: true }],
    ['profile_login_start', { url: 'https://user:password@example.test/', userConfirmed: true }],
    ['profile_login_start', { url: 'https://example.test/', userConfirmed: true, browserArgs: ['--headless'] }],
    ['profile_login_finish', { loginId: '', userConfirmed: true }],
    ['profile_login_finish', { loginId: 'current-login', userConfirmed: 'true' }],
    ['profile_login_status', { loginId: 'unrequested' }]
  ]) assert.throws(() => validateArguments(method, args), { code: 'INVALID_ARGUMENTS' })
})

test('HTTP broker error codes and client ownership survive the adapter', async t => {
  const fixture = await brokerFixture(t)
  const codex = await connectClient(fixture.stateDir, 'codex')
  const claude = await connectClient(fixture.stateDir, 'claude')
  const task = await codex.call('task_create', { url: 'https://example.test' })
  await assert.rejects(claude.call('task_observe', { taskId: task.taskId }), { code: 'TASK_FORBIDDEN' })
  await assert.rejects(codex.call('task_act', { taskId: task.taskId, observationId: 'old', actions: [{ type: 'click', ref: 'e1' }] }), { code: 'STALE_OBSERVATION' })
  assert.deepEqual(await claude.call('task_list'), { tasks: [] })
})

test('redirects are rejected without forwarding credentials', async t => {
  let redirected = false
  const fixture = await brokerFixture(t, (req, res) => {
    if (req.url === '/redirected') redirected = true
    res.writeHead(302, { Location: '/redirected' }); res.end()
  })
  const client = await connectClient(fixture.stateDir)
  await assert.rejects(client.call('task_list'), { code: 'CONNECTION_ERROR' })
  assert.equal(redirected, false)
  assert.equal(fixture.requests.length, 1)
})

test('malformed broker responses produce a useful adapter error', async t => {
  const fixture = await brokerFixture(t, (req, res) => { res.writeHead(503); res.end('offline') })
  const client = await connectClient(fixture.stateDir)
  await assert.rejects(client.call('task_list'), { code: 'INVALID_RESPONSE', message: 'Broker returned a non-JSON response (HTTP 503)' })
})

test('CLI returns JSON and dashboard credential stays in the URL fragment', async t => {
  const fixture = await brokerFixture(t)
  const result = await run(process.execPath, [resolve(root, 'cli.mjs'), '--state-dir', fixture.stateDir, '--client', 'scripts', 'task_create', JSON.stringify({ url: 'https://example.test/form', label: 'CLI task' })])
  assert.equal(result.stderr, '')
  assert.equal(JSON.parse(result.stdout).result.owner, 'scripts')
  const printed = await run(process.execPath, [resolve(root, 'cli.mjs'), '--state-dir', fixture.stateDir, 'dashboard'])
  const url = new URL(printed.stdout.trim())
  assert.equal(url.search, '')
  assert.equal(url.pathname, '/')
  assert.equal(new URLSearchParams(url.hash.slice(1)).get('token'), fixture.descriptor.adminToken)
  assert.equal(await dashboardUrl(fixture.stateDir), printed.stdout.trim())
  await assert.rejects(run(process.execPath, [resolve(root, 'cli.mjs'), '--state-dir', fixture.stateDir, 'shutdown']), error => {
    assert.equal(JSON.parse(error.stderr).code, 'UNKNOWN_METHOD')
    return true
  })
})

test('MCP stdio advertises bounded tools, carries observations/actions, and emits screenshot image content', { timeout: 15000 }, async t => {
  const fixture = await brokerFixture(t)
  const client = await mcpFixture(t, fixture.stateDir, 'codex')
  const listed = await client.listTools()
  assert.equal(listed.tools.length, 21)
  assert.ok(listed.tools.every(tool => tool.name.startsWith('velmren_') && tool.inputSchema.additionalProperties === false))
  assert.ok(!listed.tools.some(tool => /evaluate|execute|cdp|control|shutdown/.test(tool.name)))
  const call = (name, args) => client.callTool({ name, arguments: args })
  const created = await call('velmren_create_task', { url: 'https://example.test/form', label: 'MCP task' })
  const taskId = JSON.parse(created.content[0].text).taskId
  const observation = JSON.parse((await call('velmren_observe', { taskId })).content[0].text)
  const actions = [{ type: 'fill', ref: observation.elements[0].ref, value: 'A "quoted" value' }, { type: 'press', key: 'Enter' }]
  const acted = await call('velmren_act', { taskId, observationId: observation.observationId, actions })
  assert.ok(!acted.isError)
  assert.deepEqual(fixture.requests.at(-1).body.args.actions, actions)
  const image = await call('velmren_screenshot', { taskId })
  assert.deepEqual(image.content, [{ type: 'image', mimeType: 'image/png', data: png }])
  const needsHuman = await call('velmren_request_human', { taskId, reason: 'Complete the test login' })
  assert.equal(JSON.parse(needsHuman.content[0].text).state, 'needs-human')
  assert.equal(JSON.parse(needsHuman.content[0].text).reason, 'Complete the test login')
  const before = fixture.requests.length
  const invalid = await call('velmren_act', { taskId, observationId: 'obs-1', actions: [{ type: 'evaluate', value: 'window.secret' }] })
  assert.equal(invalid.isError, true)
  assert.equal(fixture.requests.length, before)
})

test('two MCP clients use separate credentials and relay broker denial as tool error', { timeout: 15000 }, async t => {
  const fixture = await brokerFixture(t)
  const codex = await mcpFixture(t, fixture.stateDir, 'codex')
  const claude = await mcpFixture(t, fixture.stateDir, 'claude')
  const created = await codex.callTool({ name: 'velmren_create_task', arguments: { url: 'https://example.test' } })
  const taskId = JSON.parse(created.content[0].text).taskId
  const denied = await claude.callTool({ name: 'velmren_observe', arguments: { taskId } })
  assert.equal(denied.isError, true)
  assert.equal(JSON.parse(denied.content[0].text).code, 'TASK_FORBIDDEN')
  const own = await claude.callTool({ name: 'velmren_list_tasks', arguments: {} })
  assert.deepEqual(JSON.parse(own.content[0].text), { tasks: [] })
})

test('panel keeps tokens out of storage and treats page data as text', async () => {
  const app = await readFile(resolve(root, 'public/app.js'), 'utf8')
  const html = await readFile(resolve(root, 'public/index.html'), 'utf8')
  assert.ok(app.includes("history.replaceState(null, '', location.pathname)"))
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|localStorage|sessionStorage|document\.cookie/.test(app))
  assert.ok(!/src=["']https?:|href=["']https?:/.test(html))
  assert.ok(app.includes("$('screenshot').addEventListener('click'"))
})

test('predicate wait arguments enforce exactly one wait kind and state-specific fields', () => {
  const predicate = { observationId: 'o', ref: 'e1', state: 'value', value: '' }
  assert.doesNotThrow(() => validateArguments('task_wait', { taskId: 't', predicate, timeoutMs: 15000 }))
  for (const args of [
    {}, { text: 'done', predicate }, { predicate: { ...predicate, selector: '#field' } },
    { predicate: { ...predicate, state: 'visible' } }, { predicate: { ...predicate, state: 'script' } },
    { predicate: { observationId: 'o', ref: 'e1', state: 'value' } },
    { predicate: { ref: 'e1', state: 'exists' } }, { predicate, timeoutMs: 0 }
  ]) assert.throws(() => validateArguments('task_wait', { taskId: 't', ...args }), { code: 'INVALID_ARGUMENTS' })
})

test('manual handoff validates page/window selection and explicit confirmation', () => {
  assert.doesNotThrow(() => validateArguments('task_request_human', { taskId: 't', pageId: 'p', reason: 'Sign in', showWindow: true }))
  assert.doesNotThrow(() => validateArguments('task_resume', { taskId: 't', handoffId: 'current', userConfirmed: true }))
  for (const [method, args] of [
    ['task_request_human', { taskId: 't', reason: 'Sign in', showWindow: 'true' }],
    ['task_request_human', { taskId: 't', reason: 'Sign in', pageId: '' }],
    ['task_resume', { taskId: 't', handoffId: 'current' }],
    ['task_resume', { taskId: 't', handoffId: 'current', userConfirmed: false }],
    ['task_resume', { taskId: 't', userConfirmed: true }]
  ]) assert.throws(() => validateArguments(method, args), { code: 'INVALID_ARGUMENTS' })
})

test('MCP relays manual show and matching user-confirmed resume without admin access', { timeout: 15000 }, async t => {
  const fixture = await brokerFixture(t, (req, res, body) => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true, result: { taskId: body.args.taskId, state: body.method === 'task_resume' ? 'agent-active' : 'human', handoff: { id: 'handoff-current' } } }))
  })
  const mcp = await mcpFixture(t, fixture.stateDir, 'codex')
  const shown = await mcp.callTool({ name: 'velmren_request_human', arguments: { taskId: 'owned', pageId: 'page', reason: 'Complete sign-in', showWindow: true } })
  assert.equal(JSON.parse(shown.content[0].text).state, 'human')
  const resumed = await mcp.callTool({ name: 'velmren_resume', arguments: { taskId: 'owned', handoffId: 'handoff-current', userConfirmed: true } })
  assert.equal(JSON.parse(resumed.content[0].text).state, 'agent-active')
  assert.deepEqual(fixture.requests.map(x => x.body.method), ['task_request_human', 'task_resume'])
  assert.ok(fixture.requests.every(x => x.auth === 'Bearer test-codex'))
  const calls = fixture.requests.length
  const denied = await mcp.callTool({ name: 'velmren_resume', arguments: { taskId: 'owned', handoffId: 'handoff-current', userConfirmed: false } })
  assert.ok(denied.isError)
  assert.equal(fixture.requests.length, calls)
})

test('HTTP, CLI and MCP preserve structured partial failure without forwarding extra secret fields', { timeout: 15000 }, async t => {
  const actionResult = { completed: 1, failedIndex: 1, delivery: 'not_delivered',
    results: [{ index: 0, type: 'fill', ref: 'e1', delivery: 'delivered_verified', verification: { scope: 'element', status: 'matched' } },
      { index: 1, type: 'click', ref: 'e2', delivery: 'not_delivered' }],
    recovery: { retry: 'failed_action_only', observe: true, reason: 'not_dispatched' } }
  const fixture = await brokerFixture(t, (req, res) => {
    res.writeHead(409, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: false, error: 'Element is disabled', code: 'ACTION_FAILED', actionResult: { ...actionResult, value: 'secret-value' } }))
  })
  const args = { taskId: 't', observationId: 'o', actions: [{ type: 'click', ref: 'e1' }] }
  const http = await connectClient(fixture.stateDir)
  await assert.rejects(http.call('task_act', args), error => {
    assert.deepEqual(error.actionResult, actionResult); assert.equal(JSON.stringify(error).includes('secret-value'), false); return true
  })
  const mcp = await mcpFixture(t, fixture.stateDir, 'codex')
  const result = await mcp.callTool({ name: 'velmren_act', arguments: args })
  assert.equal(result.isError, true); assert.deepEqual(JSON.parse(result.content[0].text).actionResult, actionResult)
  const tools = await mcp.listTools(), wait = tools.tools.find(tool => tool.name === 'velmren_wait')
  assert.equal(tools.tools.length, 21); assert.ok(wait.inputSchema.properties.predicate); assert.equal(wait.annotations.readOnlyHint, true)
  assert.ok(wait.inputSchema.properties.frameId)
  for (const name of ['velmren_list_frames', 'velmren_list_options']) assert.equal(tools.tools.find(tool => tool.name === name).annotations.readOnlyHint, true)
  assert.equal(JSON.stringify(result).includes('secret-value'), false)
  await assert.rejects(run(process.execPath, [resolve(root, 'cli.mjs'), '--state-dir', fixture.stateDir, 'task_act', JSON.stringify(args)]), error => {
    const value = JSON.parse(error.stderr.trim())
    assert.deepEqual(value.actionResult, actionResult)
    assert.equal(error.stderr.includes('secret-value'), false)
    return true
  })
})

test('client transport interruption and malformed mutation responses are unknown and never replayed', async t => {
  const args = { taskId: 't', observationId: 'o', actions: [{ type: 'fill', ref: 'e1', value: 'secret-value' }] }
  const fixture = await brokerFixture(t, (req, res) => { res.writeHead(503); res.end('offline') })
  const client = await connectClient(fixture.stateDir)
  await assert.rejects(client.call('task_act', args), error => {
    assert.deepEqual(error.actionResult, unknownActionResult()); return true
  })
  assert.equal(fixture.requests.length, 1)
  const controller = new AbortController(); controller.abort()
  await assert.rejects(client.call('task_act', args, { signal: controller.signal }), error => {
    assert.deepEqual(error.actionResult, unknownActionResult()); assert.equal(JSON.stringify(error).includes('secret-value'), false); return true
  })
  assert.equal(fixture.requests.length, 1)
})

test('wait diagnostics survive HTTP and MCP errors as bounded booleans only', { timeout: 15000 }, async t => {
  const waitResult = { matched: false, elapsedMs: 123, pageId: 'page', lastObserved: { state: 'value', exists: true, valueMatches: false } }
  const fixture = await brokerFixture(t, (req, res) => {
    res.writeHead(409, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: false, error: 'Element reference is stale; observe again', waitResult: { ...waitResult, value: 'private', lastObserved: { ...waitResult.lastObserved, actualValue: 'private' } } }))
  })
  const args = { taskId: 't', predicate: { observationId: 'o', ref: 'e1', state: 'value', value: 'private' } }
  const http = await connectClient(fixture.stateDir)
  await assert.rejects(http.call('task_wait', args), error => { assert.deepEqual(error.waitResult, waitResult); return true })
  const mcp = await mcpFixture(t, fixture.stateDir, 'codex')
  const result = await mcp.callTool({ name: 'velmren_wait', arguments: args })
  assert.equal(result.isError, true); assert.deepEqual(JSON.parse(result.content[0].text).waitResult, waitResult)
  assert.equal(JSON.stringify(result).includes('private'), false)
})

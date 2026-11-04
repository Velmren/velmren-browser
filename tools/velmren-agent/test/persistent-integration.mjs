// node persistent-integration.mjs BROWSER_EXE NEW_OUTPUT_DIR
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { persistentFixture } from './persistent-fixture.mjs'

const args = process.argv.slice(2), positional = args.filter(arg => !arg.startsWith('--'))
const directoryOption = args.find(arg => arg.startsWith('--agent-directory='))
if (args.some(arg => arg.startsWith('--') && arg !== directoryOption)) throw new Error('Unknown option')
const [executable, outputArg] = positional
if (!executable || !outputArg) throw new Error('BROWSER_EXE and NEW_OUTPUT_DIR are required')
const directory = path.resolve(directoryOption?.slice('--agent-directory='.length) ?? fileURLToPath(new URL('../', import.meta.url)))
const { startBroker } = await import(pathToFileURL(path.join(directory, 'broker.mjs')))
const output = path.resolve(outputArg), stateDir = path.join(output, 'state')
await mkdir(path.dirname(output), { recursive: true }); await mkdir(output)
const report = { passed: false, directory, cases: [], processes: [], errors: [], downloads: [] }
let fixture, forbidden, app
const mcpClients = new Set()
const until = async (condition, timeout = 10000) => {
  const end = Date.now() + timeout
  do { const value = await condition(); if (value) return value; await delay(25) } while (Date.now() < end)
  throw new Error('Fixture condition timed out')
}
const evaluate = async (task, expression) => {
  const page = app.broker.page(app.broker.tasks.get(task.taskId), task.selectedPageId)
  const result = await page.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true })
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
  return result.result.value
}
const storage = value => {
  assert.match(value.cookie, /persistent_cookie=durable/)
  assert.match(value.cookie, /session_cookie=durable/)
  assert.equal(value.local, 'durable'); assert.equal(value.idb, 'durable')
}
try {
  fixture = await persistentFixture(); forbidden = await persistentFixture()
  const crossOrigin = fixture.origin.replace('127.0.0.1', 'localhost')
  const policy = { profileMode: 'persistent', allowedOrigins: [fixture.origin, crossOrigin], webCompatibility: true }
  const policyFile = path.join(output, 'policy.json')
  await writeFile(policyFile, JSON.stringify(policy))
  const connectMcp = async label => {
    const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(directory, 'managed-mcp.mjs'), '--browser', path.resolve(executable), '--state-dir', stateDir, '--policy', policyFile, '--label', label], stderr: 'pipe' })
    const client = new Client({ name: label, version: '1' })
    mcpClients.add(client)
    transport.stderr?.resume()
    await client.connect(transport)
    return client
  }
  const mcp = async (client, name, args = {}) => {
    const result = await client.callTool({ name, arguments: args })
    const value = JSON.parse(result.content.find(item => item.type === 'text').text)
    assert.equal(!!result.isError, false, JSON.stringify(value))
    return value
  }
  const closeMcp = async client => { await client.close(); mcpClients.delete(client) }
  const launch = async () => {
    const result = await startBroker({ executable: path.resolve(executable), stateDir, policy, browserArgs: ['--headless=new', '--site-per-process'] })
    report.processes.push(result.broker.browser.process.pid)
    result.broker.onEvent = event => { if (event.type === 'protocol-error') report.errors.push(event.message) }
    result.broker.browser.on('protocol', message => { if (message.method.startsWith('Browser.download')) report.downloads.push(message) })
    return result
  }
  app = await launch()
  report.browser = app.broker.browser.version
  const register = label => app.broker.rpc('admin', 'client_register', { label })
  const create = owner => app.broker.rpc(owner, 'task_create', { url: fixture.origin, label: 'Persistent QA' })
  const a = await register('A'), b = await register('B')
  let [ta, tb] = await Promise.all([create(a.clientId), create(b.clientId)])
  assert.equal(ta.sharedProfile, true)
  assert.equal(app.broker.tasks.get(ta.taskId).contextId, app.broker.tasks.get(tb.taskId).contextId)
  assert.notEqual(ta.selectedPageId, tb.selectedPageId)
  await assert.rejects(app.broker.rpc(a.clientId, 'task_observe', { taskId: tb.taskId }), /Task not found/)
  await assert.rejects(app.broker.rpc(a.clientId, 'task_observe', { taskId: ta.taskId, pageId: tb.selectedPageId }), /Page not found/)
  storage(await evaluate(ta, 'seed()'))
  storage(await evaluate(tb, 'readState()'))
  report.cases.push('simultaneous clients share origin storage, not task/page control')
  const waiting = app.broker.rpc(a.clientId, 'task_wait', { taskId: ta.taskId, text: 'never appears', timeoutMs: 500 })
  assert.match((await app.broker.rpc(b.clientId, 'task_observe', { taskId: tb.taskId })).title, /Persistent profile/)
  assert.equal((await waiting).matched, false)
  report.cases.push('one task wait does not block another task observation')
  const wa = await evaluate(ta, 'sharedPing()'), wb = await evaluate(tb, 'sharedPing()')
  assert.equal(wa.id, wb.id)
  assert.ok([...app.broker.targets.values()].some(entry => entry.type === 'shared_worker' && entry.profileOwned && !entry.task))
  await app.broker.rpc(a.clientId, 'task_finish', { taskId: ta.taskId })
  storage(await evaluate(tb, 'readState()'))
  assert.equal((await evaluate(tb, 'sharedPing()')).id, wb.id)
  ta = await create(a.clientId); storage(await evaluate(ta, 'readState()'))
  report.cases.push('task finish preserves storage and peer shared worker')
  await app.broker.rpc(a.clientId, 'client_release', {})
  const c = await register('A reconnected')
  ta = await create(c.clientId); storage(await evaluate(ta, 'readState()'))
  report.cases.push('client release and reconnect preserve login')
  const [mcpA, mcpB] = await Promise.all([connectMcp('MCP A'), connectMcp('MCP B')])
  const [mcpTaskA, mcpTaskB] = await Promise.all([mcp(mcpA, 'velmren_create_task', { url: fixture.origin }), mcp(mcpB, 'velmren_create_task', { url: fixture.origin })])
  storage(await evaluate(mcpTaskA, 'readState()'))
  await closeMcp(mcpA)
  await until(() => app.broker.tasks.get(mcpTaskA.taskId).state === 'cancelled')
  assert.match((await mcp(mcpB, 'velmren_observe', { taskId: mcpTaskB.taskId })).title, /Persistent profile/)
  const mcpAgain = await connectMcp('MCP A reconnected')
  const againTask = await mcp(mcpAgain, 'velmren_create_task', { url: fixture.origin })
  storage(await evaluate(againTask, 'readState()'))
  await Promise.all([closeMcp(mcpAgain), closeMcp(mcpB)])
  await until(() => [againTask, mcpTaskB].every(task => app.broker.tasks.get(task.taskId).state === 'cancelled'))
  report.cases.push('real managed MCP stdio disconnect/reconnect preserves login and peer tasks')
  assert.equal(await evaluate(tb, `servicePing(${JSON.stringify(`${forbidden.origin}/forbidden`)})`), 'blocked')
  assert.equal(forbidden.evidence.forbidden, 0)
  report.cases.push('service worker policy blocks off-policy fetch')
  await evaluate(ta, `document.querySelector('iframe').src=${JSON.stringify(`${crossOrigin}/frame`)};true`)
  const childSession = await until(() => [...app.broker.sessions.values()].find(entry => entry.type === 'iframe' && entry.task?.taskId === ta.taskId))
  await childSession.ready
  await evaluate(ta, `document.querySelector('iframe').src=${JSON.stringify(`${crossOrigin}/download?key=child-a&slow=1`)};true`)
  await evaluate(tb, `location.href='/download?key=main-b&slow=1';true`)
  const ad = await until(() => app.broker.tasks.get(ta.taskId).downloads[0])
  const bd = await until(() => app.broker.tasks.get(tb.taskId).downloads[0])
  assert.equal(ad.name, 'child-a.txt'); assert.equal(bd.name, 'main-b.txt')
  await app.broker.rpc(c.clientId, 'task_finish', { taskId: ta.taskId })
  fixture.finishDownload('main-b')
  await until(() => bd.state === 'completed')
  assert.equal(await readFile(bd.path, 'utf8'), 'start-'.padEnd(65536, '.') + 'done!')
  assert.equal(ad.state, 'canceled')
  report.cases.push('OOPIF child-frame downloads have immutable owners and peer completion survives task finish')
  // Leave one task live: broker shutdown itself must close it before session save.
  await app.close(); app = null
  await assert.rejects(startBroker({ executable, stateDir, policy: { ...policy, allowedOrigins: [fixture.origin, forbidden.origin] }, browserArgs: ['--headless=new'] }), /policy mismatch/)
  report.cases.push('different policy rejected before persistent profile launch')
  app = await launch()
  const initial = await app.broker.browser.send('Target.getTargets')
  assert.equal(initial.targetInfos.filter(info => ['page', 'other'].includes(info.type)).length, 0)
  report.cases.push('clean restart restores no task pages/windows')
  const d = await register('After restart'), td = await create(d.clientId)
  storage(await evaluate(td, 'readState()'))
  report.cases.push('persistent cookie, session cookie, localStorage and IndexedDB survive clean browser/broker restart')
  assert.equal(await evaluate(td, 'navigator.serviceWorker.getRegistrations().then(r=>r.length)'), 1)
  assert.equal(await evaluate(td, `servicePing(${JSON.stringify(`${forbidden.origin}/forbidden`)})`), 'blocked')
  assert.equal(forbidden.evidence.forbidden, 0)
  report.cases.push('service worker registration survives restart and retains off-policy CSP')
  assert.deepEqual(report.errors, [])
  report.passed = true
} catch (error) { report.failure = error.stack; report.fixture = fixture?.evidence; report.frames = app && [...app.broker.frameOwners].map(([id, owner]) => ({ id, taskId: owner.task.taskId })); process.exitCode = 1 }
finally {
  await Promise.allSettled([...mcpClients].map(client => client.close()))
  if (app) await app.close()
  if (fixture) await fixture.close()
  if (forbidden) await forbidden.close()
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
}

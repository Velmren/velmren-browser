// node test/target-lifecycle-integration.mjs BROWSER_EXE NEW_OUTPUT_DIR [--agent-directory=DIR]
// Uses a fresh native browser profile and synthetic loopback pages only.
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

const args = process.argv.slice(2), positions = args.filter(arg => !arg.startsWith('--'))
const [executable, outputArgument] = positions
if (!executable || !outputArgument || positions.length !== 2 || args.some(arg => arg.startsWith('--') && !arg.startsWith('--agent-directory='))) throw new Error('Expected BROWSER_EXE NEW_OUTPUT_DIR and optional agent directory')
const directory = path.resolve(args.find(arg => arg.startsWith('--agent-directory='))?.slice(18) ?? fileURLToPath(new URL('../', import.meta.url)))
const { startBroker } = await import(pathToFileURL(path.join(directory, 'broker.mjs')).href)
const output = path.resolve(outputArgument)
await mkdir(path.dirname(output), { recursive: true }); await mkdir(output)
const report = { passed: false, cases: [], lifecycle: [], commands: [], cleanup: {} }
let app, server, failure, originalSend
const counts = { opens: 0, forbidden: 0 }
const until = async condition => {
  const deadline = Date.now() + 25000
  while (true) {
    const result = await condition()
    if (result) return result
    if (Date.now() >= deadline) throw new Error('Fixture condition timed out')
    await delay(25)
  }
}
try {
  server = http.createServer((request, response) => {
    if (request.url === '/opened') { counts.opens++; response.end('ok'); return }
    if (request.url === '/forbidden') counts.forbidden++
    response.setHeader('Content-Type', 'text/html; charset=utf-8')
    response.setHeader('Cache-Control', 'no-store')
    if (request.url === '/popup') response.end('<title>Popup ready</title><button onclick="window.close()">Close popup</button><p>Popup ready</p>')
    else if (request.url === '/transient') response.end('<script>window.close()</script>')
    else if (request.url === '/redirect') { response.writeHead(302, { Location: '/popup' }); response.end() }
    else response.end(`<title>Lifecycle fixture</title><button onclick="fetch('/opened');window.open('/popup','_blank','width=400,height=300')">Open popup</button><button onclick="window.open('/redirect','_blank','width=400,height=300')">Redirect popup</button><button onclick="window.open('/transient','_blank','width=400,height=300')">Transient popup</button><button onclick="window.open('http://localhost:${server.address().port}/forbidden','_blank','width=400,height=300')">Forbidden popup</button><button onclick="window.open('about:blank')">Blank popup</button><button onclick="window.open('/popup','_blank','noopener')">Noopener popup</button><a target="_blank" href="/popup">Anchor popup</a><p>Parent ready</p>`)
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const origin = `http://127.0.0.1:${server.address().port}`
  app = await startBroker({ executable: path.resolve(executable), stateDir: path.join(output, 'state'), policy: { allowedOrigins: [origin], webCompatibility: true, profileMode: 'persistent' } })
  const broker = app.broker, browser = broker.browser
  report.version = browser.version; report.browserPid = browser.process.pid
  originalSend = browser.send
  browser.send = async function (method, params, sessionId, ...rest) {
    const entry = { method, sessionId, started: performance.now() }; report.commands.push(entry)
    try { const result = await originalSend.call(this, method, params, sessionId, ...rest); entry.result = 'ok'; return result }
    catch (error) { entry.result = error.code ?? (error.message.includes('timed out') ? 'timeout' : 'error'); throw error }
    finally { entry.elapsedMs = performance.now() - entry.started }
  }
  browser.on('protocol', message => {
    if (!message.method.startsWith('Target.')) return
    const p = message.params, info = p.targetInfo
    report.lifecycle.push({ method: message.method, sessionId: p.sessionId, parentSessionId: message.sessionId, targetId: p.targetId ?? info?.targetId, type: info?.type, waitingForDebugger: p.waitingForDebugger })
  })
  const registration = await broker.rpc('admin', 'client_register', { label: 'Target lifecycle regression' })
  const rpc = (method, args) => broker.rpc(registration.clientId, method, args)
  const first = await rpc('task_create', { url: origin, label: 'Lifecycle regression' })
  const peer = await rpc('task_create', { url: origin, label: 'Peer isolation' })
  const task = broker.tasks.get(first.taskId), parentId = first.selectedPageId
  for (const name of ['Open popup', 'Redirect popup', 'Blank popup', 'Noopener popup', 'Anchor popup', 'Transient popup', 'Forbidden popup']) {
    const entry = { name }; report.cases.push(entry)
    const lifecycleStart = report.lifecycle.length
    const observation = await rpc('task_observe', { taskId: task.taskId, pageId: parentId })
    const control = observation.elements.find(element => element.name === name)
    assert.ok(control, `Missing fixture control: ${name}`)
    const action = await rpc('task_act', { taskId: task.taskId, pageId: parentId, observationId: observation.observationId, actions: [{ type: 'click', ref: control.ref }] })
    entry.delivery = action.actionResult?.delivery
    if (name === 'Transient popup') {
      const attached = await until(() => report.lifecycle.slice(lifecycleStart).find(event => event.method === 'Target.attachedToTarget'))
      entry.popupId = attached.targetId
      await until(() => report.lifecycle.slice(lifecycleStart).some(event => event.method === 'Target.targetDestroyed' && event.targetId === attached.targetId) && task.pages.size === 1)
    } else {
      const popup = await until(() => [...task.pages.values()].find(page => page.pageId !== parentId))
      entry.popupId = popup.pageId
      await popup.ready
      assert.equal(task.state, 'agent-active', task.reason)
      if (!['Forbidden popup', 'Blank popup'].includes(name)) {
        const observed = await rpc('task_observe', { taskId: task.taskId, pageId: popup.pageId })
        assert.match(observed.text, /Popup ready/)
      } else if (name === 'Forbidden popup') {
        await until(() => task.blockedOrigins.length > 0)
        assert.equal(counts.forbidden, 0)
      }
      await rpc('task_close_page', { taskId: task.taskId, pageId: popup.pageId })
    }
    assert.equal(task.state, 'agent-active', task.reason)
    assert.equal(task.selectedPageId, parentId)
    const peerObservation = await rpc('task_observe', { taskId: peer.taskId })
    assert.match(peerObservation.text, /Parent ready/)
    entry.passed = true
    console.log(`PASS ${name}`)
  }
  assert.equal(counts.opens, 1, 'The external-action fixture must not be retried')
  const injection = { name: 'Live target policy failure', passed: false }; report.cases.push(injection)
  const observation = await rpc('task_observe', { taskId: task.taskId, pageId: parentId })
  const commandRecorder = browser.send
  const resumes = report.commands.filter(command => command.method === 'Runtime.runIfWaitingForDebugger').length
  browser.send = async function (method, params, sessionId, ...rest) {
    const target = broker.sessions.get(sessionId)
    if (method === 'Fetch.enable' && target?.task === task && target.targetId !== parentId) throw Object.assign(new Error('Synthetic policy enforcement failure'), { code: 'CDP_PROTOCOL_ERROR', protocolCode: -32601 })
    return commandRecorder.call(this, method, params, sessionId, ...rest)
  }
  try {
    await rpc('task_act', { taskId: task.taskId, pageId: parentId, observationId: observation.observationId, actions: [{ type: 'click', ref: observation.elements.find(element => element.name === 'Noopener popup').ref }] })
  } catch (error) { injection.actionCode = error.code; injection.delivery = error.actionResult?.delivery }
  await until(() => task.state === 'cancelled' && task.pages.size === 0)
  browser.send = commandRecorder
  assert.equal(report.commands.filter(command => command.method === 'Runtime.runIfWaitingForDebugger').length, resumes)
  assert.match(task.reason, /request-interception; unsupported-command/)
  assert.match((await rpc('task_observe', { taskId: peer.taskId })).text, /Parent ready/)
  injection.reason = task.reason; injection.passed = true
  console.log('PASS Live target policy failure')
  await rpc('task_finish', { taskId: peer.taskId })
  report.cleanup.tasksFinished = true
} catch (error) { failure = error; report.error = { message: error.message, code: error.code } }
finally {
  if (app && originalSend) app.broker.browser.send = originalSend
  try { await app?.close(); report.cleanup.browserClosed = app?.broker.browser.closed ?? true }
  catch (error) { failure ??= error; report.cleanup.error = error.message }
  if (server) await new Promise(resolve => { server.close(resolve); server.closeAllConnections() })
  report.cleanup.fixtureClosed = true
}
report.counts = counts; report.passed = !failure
await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2))
if (failure) throw failure
console.log('Native target lifecycle regression passed.')

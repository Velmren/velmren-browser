import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const [executable, output] = process.argv.slice(2)
if (!executable || !output) throw new Error('Usage: node test/service-worker-restart-integration.mjs BROWSER_EXE NEW_OUTPUT_DIR [--agent-directory=INSTALLED_AGENT_DIR]')
const agentDirectory = process.argv.find(arg => arg.startsWith('--agent-directory='))?.slice('--agent-directory='.length) ?? fileURLToPath(new URL('../', import.meta.url))
const { startBroker } = await import(pathToFileURL(path.join(path.resolve(agentDirectory), 'broker.mjs')))
const directory = path.resolve(output)
await mkdir(directory, { recursive: false })
const report = { checks: [], cases: [], lifecycle: [], commands: [], scriptRequests: [], windowShowCommands: [], cleanup: {}, secretProvided: false }
const pass = name => { report.checks.push({ name, passed: true }); console.log(`PASS ${name}`) }
const owned = new Set(), versions = new Map(), updates = new Set()
let app, blockedHits = 0, peerId, peerPage, workerVersion = 1
const worker = () => `
const fixtureVersion=${workerVersion};
self.addEventListener('install',event=>event.waitUntil(self.skipWaiting()));
self.addEventListener('activate',event=>event.waitUntil(clients.claim()));
self.addEventListener('message',event=>{
 const port=event.ports[0];
 if(event.data.kind==='ping')port.postMessage('worker-pong-v'+fixtureVersion);
 if(event.data.kind==='policy')event.waitUntil(fetch(event.data.url).then(()=>port.postMessage('unexpected-allowed'),()=>port.postMessage('blocked')));
});
self.addEventListener('fetch',event=>event.respondWith(new URL(event.request.url).pathname==='/app/probe'?new Response('worker-fetch-v'+fixtureVersion,{headers:{'content-type':'text/plain'}}):fetch(event.request)));
`
const module = `
globalThis.fixture={phase:'registering'};
globalThis.fixtureRegistration=await navigator.serviceWorker.register('/app/sw.js',{scope:'/app/',updateViaCache:'none'});
fixture.phase='ready';await navigator.serviceWorker.ready;
fixture.phase='hydrated';document.getElementById('status').textContent='Hydrated';
document.getElementById('account').onclick=()=>{document.getElementById('menu').hidden=false};
`
const html = '<!doctype html><meta charset="utf-8"><title>Service worker restart fixture</title><link rel="modulepreload" href="/app/entry.js"><script type="module" src="/app/entry.js"></script><button id="account">Fixture account</button><p id="status">SSR only</p><div id="menu" hidden>Account menu open</div>'
const peerHtml = '<!doctype html><title>Uncontrolled peer</title><button id="peer">Peer action</button><p id="count">0</p><script>window.peerCount=0;document.getElementById("peer").onclick=()=>document.getElementById("count").textContent=String(++peerCount)</script>'
const server = createServer((request, response) => {
  const pathname = new URL(request.url, 'http://localhost').pathname
  const body = pathname === '/app/sw.js' ? worker() : pathname === '/app/entry.js' ? module : html
  if (pathname === '/app/sw.js') report.scriptRequests.push({ version: workerVersion, time: Date.now() })
  response.writeHead(200, { 'content-type': pathname.endsWith('.js') ? 'text/javascript' : 'text/html', 'cache-control': pathname === '/app/entry.js' ? 'max-age=3600' : 'no-cache' })
  response.end(body)
})
const blocked = createServer((request, response) => { blockedHits++; response.end('must not be requested') })
const peerServer = createServer((request, response) => { response.writeHead(200, { 'content-type': 'text/html' }); response.end(peerHtml) })
await Promise.all([new Promise(resolve => server.listen(0, '127.0.0.1', resolve)), new Promise(resolve => blocked.listen(0, '127.0.0.1', resolve)), new Promise(resolve => peerServer.listen(0, '127.0.0.1', resolve))])
const origin = `http://127.0.0.1:${server.address().port}`, peerOrigin = `http://127.0.0.1:${peerServer.address().port}`, denied = `http://127.0.0.1:${blocked.address().port}/denied`
const waitVersion = (predicate, timeoutMs = 5000) => new Promise((resolve, reject) => {
  let timer
  const check = () => { const found = [...versions.values()].find(predicate); if (found) { clearTimeout(timer); updates.delete(check); resolve(found) } }
  timer = setTimeout(() => { updates.delete(check); reject(new Error('Service worker lifecycle event timed out')) }, timeoutMs)
  updates.add(check); check()
})
const main = async (page, expression) => {
  const result = await page.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, 8000)
  assert.ok(!result.exceptionDetails, 'Fixture main-world evaluation succeeds')
  return result.result.value
}
const liveness = page => main(page, `(async()=>{
 const worker=globalThis.fixtureRegistration?.active;
 const message=kind=>new Promise(resolve=>{if(!worker)return resolve('missing-worker');const channel=new MessageChannel();const timer=setTimeout(()=>{channel.port1.close();resolve('timeout')},2000);channel.port1.onmessage=event=>{clearTimeout(timer);channel.port1.close();resolve(event.data)};worker.postMessage({kind,url:${JSON.stringify(denied)}},[channel.port2])});
 const fetchResult=Promise.race([fetch('/app/probe',{cache:'no-store'}).then(response=>response.text(),()=> 'fetch-error'),new Promise(resolve=>setTimeout(()=>resolve('timeout'),2000))]);
 const [pong,fetchBody,policy]=await Promise.all([message('ping'),fetchResult,message('policy')]);
 return {phase:globalThis.fixture?.phase,pong,fetchBody,policy,controller:navigator.serviceWorker.controller?.state};
})()`)
const assertLive = (result, expectedVersion = workerVersion) => {
  assert.equal(result.phase, 'hydrated')
  assert.equal(result.pong, `worker-pong-v${expectedVersion}`, 'Expected worker version answers an actual message')
  assert.equal(result.fetchBody, `worker-fetch-v${expectedVersion}`, 'Expected worker version handles an actual fetch')
  assert.equal(result.policy, 'blocked', 'Worker network policy remains enforced')
  assert.equal(blockedHits, 0, 'Disallowed localhost server receives no request')
}
const createApp = async () => {
  const task = await app.broker.rpc('scripts', 'task_create', { url: `${origin}/app/page`, label: 'Service worker restart fixture' })
  owned.add(task.taskId)
  const page = app.broker.tasks.get(task.taskId).page
  const ready = await app.broker.rpc('scripts', 'task_wait', { taskId: task.taskId, text: 'Hydrated', timeoutMs: 5000 })
  assert.equal(ready.matched, true, 'Register/ready-gated SSR content hydrates')
  return { taskId: task.taskId, page }
}
try {
  app = await startBroker({ executable: path.resolve(executable), stateDir: path.join(directory, 'state'), policy: { allowedOrigins: [origin, peerOrigin], webCompatibility: true, profileMode: 'persistent' } })
  report.browserPid = app.broker.browser.process.pid
  const browser = app.broker.browser, nativeSend = browser.send.bind(browser)
  report.launchFeatures = browser.process.spawnargs.filter(arg => arg.startsWith('--enable-features=') || arg.startsWith('--disable-features='))
  browser.send = async (method, params, sessionId, ...rest) => {
    if (['Page.bringToFront', 'Target.activateTarget', 'Browser.setWindowBounds'].includes(method) || method === 'Target.setTargetVisibility' && params?.visible) report.windowShowCommands.push({ method, sessionId })
    const selected = ['Inspector.enable', 'Fetch.enable', 'Target.setAutoAttach', 'Runtime.runIfWaitingForDebugger', 'ServiceWorker.stopWorker'].includes(method)
    const record = selected ? { method, sessionId, started: Date.now() } : null
    if (record) report.commands.push(record)
    try { const result = await nativeSend(method, params, sessionId, ...rest); if (record) { record.completed = Date.now(); record.ok = true } return result }
    catch (error) { if (record) { record.completed = Date.now(); record.ok = false; record.error = error.code } throw error }
  }
  browser.on('protocol', message => {
    const p = message.params ?? {}
    if (message.method === 'ServiceWorker.workerVersionUpdated') {
      for (const version of p.versions) versions.set(version.versionId, version)
      report.lifecycle.push({ method: message.method, time: Date.now(), versions: p.versions.map(v => ({ versionId: v.versionId, runningStatus: v.runningStatus, status: v.status, targetId: v.targetId })) })
      for (const update of updates) update()
    }
    if (message.method.startsWith('Inspector.')) report.lifecycle.push({ method: message.method, sessionId: message.sessionId, time: Date.now() })
    if (message.method === 'Target.attachedToTarget' && p.targetInfo.type === 'service_worker') report.lifecycle.push({ method: message.method, sessionId: p.sessionId, targetId: p.targetInfo.targetId, waitingForDebugger: p.waitingForDebugger, time: Date.now() })
  })
  const peer = await app.broker.rpc('scripts', 'task_create', { url: `${peerOrigin}/peer`, label: 'Untouched unrelated-origin peer' })
  peerId = peer.taskId; owned.add(peerId); peerPage = app.broker.tasks.get(peerId).page
  await peerPage.send('ServiceWorker.enable', {})
  const o = await app.broker.rpc('scripts', 'task_observe', { taskId: peerId, query: 'Peer action' })
  await app.broker.rpc('scripts', 'task_act', { taskId: peerId, observationId: o.observationId, actions: [{ type: 'click', ref: o.elements.find(e => e.tag === 'button').ref }] })
  let current = await createApp()
  report.initial = await liveness(current.page); assertLive(report.initial)
  pass('cold register/ready hydration has working messages, fetch and network policy')
  const workerEntry = [...app.broker.targets.values()].find(e => e.profileOwned && e.type === 'service_worker')
  assert.ok(workerEntry, 'Worker is owned by the persistent profile')
  for (let cycle = 0; cycle < 3; cycle++) {
    const version = await waitVersion(v => v.status === 'activated' && v.runningStatus === 'running')
    await peerPage.send('ServiceWorker.stopWorker', { versionId: version.versionId })
    await waitVersion(v => v.versionId === version.versionId && v.runningStatus === 'stopped')
    const result = await liveness(current.page)
    const record = { kind: 'restart', cycle, liveness: result, workerSessionRetained: app.broker.sessions.get(workerEntry.sessionId) === workerEntry }
    report.cases.push(record)
    assertLive(result); assert.equal(record.workerSessionRetained, true)
    const running = await waitVersion(v => v.versionId === version.versionId && v.runningStatus === 'running')
    assert.equal(running.targetId, version.targetId, 'Chromium retains its service-worker target across restart')
    const peerState = await main(peerPage, '({count:window.peerCount,controlled:!!navigator.serviceWorker.controller})')
    record.peerState = peerState
    assert.deepEqual(peerState, { count: 1, controlled: false })
    assert.equal(app.broker.tasks.get(peerId).state, 'agent-active')
    await app.broker.rpc('scripts', 'task_cancel', { taskId: current.taskId }); owned.delete(current.taskId)
    current = await createApp()
    record.freshTask = await liveness(current.page); assertLive(record.freshTask)
    pass(`restart ${cycle + 1} resumes retained worker once, preserves policy and peer, and hydrates a fresh task`)
  }
  const observation = await app.broker.rpc('scripts', 'task_observe', { taskId: current.taskId, query: 'Fixture account' })
  await app.broker.rpc('scripts', 'task_act', { taskId: current.taskId, observationId: observation.observationId, actions: [{ type: 'click', ref: observation.elements.find(e => e.tag === 'button').ref }] })
  assert.equal(await main(current.page, '!document.getElementById("menu").hidden'), true)
  pass('fresh SSR menu responds to native input after repeated worker restarts')
  const workerCommands = report.commands.filter(c => c.sessionId === workerEntry.sessionId)
  const resumes = workerCommands.filter(c => c.method === 'Runtime.runIfWaitingForDebugger')
  assert.equal(resumes.length, 4, 'Only initial startup and the three observed restarts resume this worker')
  let sinceResume = []
  for (const command of workerCommands) {
    if (command.method !== 'Runtime.runIfWaitingForDebugger') { sinceResume.push(command); continue }
    for (const method of ['Inspector.enable', 'Fetch.enable', 'Target.setAutoAttach']) assert.ok(sinceResume.some(c => c.method === method && c.ok && c.completed <= command.started), `${method} is acknowledged before worker resume`)
    sinceResume = []
  }
  assert.equal(report.lifecycle.filter(e => e.method === 'Target.attachedToTarget').length, 1)
  assert.equal(report.lifecycle.filter(e => e.method === 'Inspector.targetReloadedAfterCrash').length, 3)
  pass('native restart signals cause exactly one resume after acknowledged policy on the retained session')
  for (const changed of [false, true]) {
    const previousVersion = await waitVersion(v => v.status === 'activated' && v.runningStatus === 'running')
    if (changed) workerVersion++
    const offset = report.scriptRequests.length
    const update = await main(current.page, `(async()=>{const start=performance.now();return Promise.race([
      fixtureRegistration.update().then(()=>({state:'resolved',ms:performance.now()-start}),error=>({state:'rejected',name:error.name})),
      new Promise(resolve=>setTimeout(()=>resolve({state:'timeout'}),5000))]);})()`)
    const record = { kind: 'update', changed, version: workerVersion, update, scriptRequests: report.scriptRequests.slice(offset) }
    report.cases.push(record)
    assert.equal(update.state, 'resolved', 'Explicit service-worker update is not blocked behind hidden browser startup')
    assert.ok(record.scriptRequests.some(request => request.version === workerVersion), 'Update fetched the actual worker script bytes')
    if (changed) await waitVersion(v => v.versionId !== previousVersion.versionId && v.status === 'activated' && v.runningStatus === 'running')
    record.afterUpdate = await liveness(current.page); assertLive(record.afterUpdate)
    await app.broker.rpc('scripts', 'task_cancel', { taskId: current.taskId }); owned.delete(current.taskId)
    record.remainingSameOriginPages = [...app.broker.tasks.values()].filter(task => task.state === 'agent-active')
      .flatMap(task => [...app.broker.pages(task).values()]).filter(page => page.url.startsWith(`${origin}/`)).length
    assert.equal(record.remainingSameOriginPages, 0)
    current = await createApp()
    record.freshTask = await liveness(current.page); assertLive(record.freshTask)
    record.peerState = await main(peerPage, '({count:window.peerCount,controlled:!!navigator.serviceWorker.controller})')
    assert.deepEqual(record.peerState, { count: 1, controlled: false })
    assert.equal(app.broker.tasks.get(peerId).state, 'agent-active')
    pass(`${changed ? 'changed' : 'unchanged'} worker update fetches bytes, completes and permits fresh registration after all same-origin pages close`)
  }
  assert.equal(report.windowShowCommands.length, 0)
  assert.ok(browser.process.spawnargs.includes('--no-startup-window'))
  assert.ok(browser.process.spawnargs.includes('--velmren-agent-mode'))
  const featureSpec = 'ImprovedStartupBestEffortDelay:StartupDelayVisibleTabTimeout/0ms/StartupDelayFailsafeTimeout/1000ms'
  assert.equal(report.launchFeatures.filter(arg => arg.startsWith('--enable-features=')).length, 1)
  assert.ok(report.launchFeatures.some(arg => arg.startsWith('--enable-features=') && arg.slice('--enable-features='.length).split(',').includes(featureSpec)))
  assert.ok(!report.launchFeatures.some(arg => arg.startsWith('--disable-features=') && arg.includes('ImprovedStartupBestEffortDelay')))
  pass('hidden agent launch releases startup work without showing or activating a native window')
  report.completed = true
} catch (error) {
  report.failure = { name: error.name, code: error.code, message: error.message }
  console.error(error.message); process.exitCode = 1
} finally {
  for (const taskId of owned) { await app?.broker.rpc('scripts', 'task_cancel', { taskId }).catch(error => { report.cleanup.cancelError = error.code ?? error.message }); owned.delete(taskId) }
  await app?.close()
  await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => blocked.close(resolve)), new Promise(resolve => peerServer.close(resolve))])
  report.cleanup = { ...report.cleanup, remainingOwnedTasks: owned.size, browserProcessExited: app?.broker.browser.processExited === true, serverClosed: !server.listening && !blocked.listening && !peerServer.listening }
  report.passed = report.completed === true && report.cleanup.browserProcessExited && report.cleanup.serverClosed
  await writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ output: directory, passed: report.passed, checks: report.checks.length, cases: report.cases.length, failure: report.failure, cleanup: report.cleanup }))
}

import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { AgentBroker } from '../runtime.mjs'

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const rejectable = () => { let reject; const promise = new Promise((resolve, fail) => { reject = fail }); return { promise, reject } }
async function fixture(t) {
  const browser = new EventEmitter(), calls = []
  browser.closed = false
  browser.close = async () => { browser.closed = true }
  browser.send = async (method, params = {}, sessionId) => { calls.push({ method, params, sessionId }); return {} }
  const broker = new AgentBroker(browser, 'unused-service-worker-test-state', { profileMode: 'persistent', webCompatibility: true }, { trace: null })
  broker.profileContextId = 'default'
  t.after(async () => { broker.profileLogin.phase = 'automated'; broker.stopping = false; await broker.close() })
  await broker.onProtocol({ method: 'Target.attachedToTarget', params: { sessionId: 'worker-session', targetInfo: { targetId: 'worker', type: 'service_worker', browserContextId: 'default', url: 'http://localhost/sw.js' } } })
  const entry = broker.targets.get('worker')
  const signal = method => broker.onProtocol({ method: `Inspector.${method}`, sessionId: entry.sessionId, params: {} })
  return { browser, broker, calls, entry, signal }
}

test('retained service-worker restarts reapply policy before one resume per observed crash', async t => {
  const f = await fixture(t)
  assert.ok(f.calls.findIndex(c => c.method === 'Inspector.enable') < f.calls.findIndex(c => c.method === 'Runtime.runIfWaitingForDebugger'))
  let offset = f.calls.length
  await f.signal('targetReloadedAfterCrash')
  assert.equal(f.calls.length, offset, 'An initial or duplicate reload is not a restart')
  for (let round = 0; round < 3; round++) {
    await f.signal('targetCrashed')
    await f.signal('targetReloadedAfterCrash')
    await f.signal('targetReloadedAfterCrash')
    const calls = f.calls.slice(offset), methods = calls.map(c => c.method)
    assert.equal(methods.filter(m => m === 'Runtime.runIfWaitingForDebugger').length, 1)
    assert.ok(methods.indexOf('Fetch.enable') < methods.indexOf('Runtime.runIfWaitingForDebugger'))
    assert.ok(methods.indexOf('Target.setAutoAttach') < methods.indexOf('Runtime.runIfWaitingForDebugger'))
    assert.deepEqual(calls.find(c => c.method === 'Network.setBypassServiceWorker').params, { bypass: false })
    assert.ok(calls.every(c => c.sessionId === 'worker-session'))
    assert.equal(f.entry.policyPhase, 'ready')
    offset = f.calls.length
  }
})

test('restart waits for policy readiness and coalesces duplicate reload signals', async t => {
  const f = await fixture(t), ready = deferred(), offset = f.calls.length
  f.entry.ready = ready.promise
  await f.signal('targetCrashed')
  const restart = f.signal('targetReloadedAfterCrash')
  await f.signal('targetReloadedAfterCrash')
  assert.equal(f.calls.length, offset)
  ready.resolve(); await restart
  assert.equal(f.calls.slice(offset).filter(c => c.method === 'Runtime.runIfWaitingForDebugger').length, 1)
})

for (const change of ['detached', 'replaced-target', 'replaced-session', 'browser-generation', 'browser-replaced', 'manual', 'stopping', 'closed', 'policy-not-ready']) {
  test(`queued worker restart is rejected after ${change}`, async t => {
    const f = await fixture(t), ready = deferred(), offset = f.calls.length
    f.entry.ready = ready.promise
    await f.signal('targetCrashed')
    const restart = f.signal('targetReloadedAfterCrash')
    if (change === 'detached') f.broker.detachSession(f.entry.sessionId)
    if (change === 'replaced-target') f.broker.targets.set(f.entry.targetId, { ...f.entry })
    if (change === 'replaced-session') f.broker.sessions.set(f.entry.sessionId, { ...f.entry })
    if (change === 'browser-generation') f.broker.browserGeneration++
    if (change === 'browser-replaced') f.broker.browser = Object.assign(new EventEmitter(), { closed: false, close: async () => {} })
    if (change === 'manual') f.broker.profileLogin.phase = 'manual'
    if (change === 'stopping') f.broker.stopping = true
    if (change === 'closed') f.browser.closed = true
    if (change === 'policy-not-ready') f.entry.interceptionReady = false
    ready.resolve(); await restart
    assert.equal(f.calls.length, offset, 'No stale policy or resume command is sent')
  })
}

test('manual, non-profile and non-service-worker signals do not arm a restart', async t => {
  const f = await fixture(t), offset = f.calls.length
  f.broker.profileLogin.phase = 'manual'
  await f.signal('targetCrashed'); f.broker.profileLogin.phase = 'automated'; await f.signal('targetReloadedAfterCrash')
  f.entry.profileOwned = false
  await f.signal('targetCrashed'); f.entry.profileOwned = true; await f.signal('targetReloadedAfterCrash')
  f.entry.type = 'shared_worker'
  await f.signal('targetCrashed'); f.entry.type = 'service_worker'; await f.signal('targetReloadedAfterCrash')
  await f.broker.onProtocol({ method: 'Inspector.targetCrashed', sessionId: 'unknown' })
  await f.broker.onProtocol({ method: 'Inspector.targetReloadedAfterCrash', sessionId: 'unknown' })
  assert.equal(f.calls.length, offset)
})

test('lifetime is rechecked after a pending policy command before resuming', async t => {
  const f = await fixture(t), entered = deferred(), release = deferred(), send = f.browser.send, offset = f.calls.length
  f.browser.send = async (method, ...args) => { const result = await send(method, ...args); if (method === 'Fetch.enable') { entered.resolve(); await release.promise } return result }
  await f.signal('targetCrashed')
  const restart = f.signal('targetReloadedAfterCrash')
  await entered.promise; f.broker.profileLogin.phase = 'manual'; release.resolve(); await restart
  assert.ok(!f.calls.slice(offset).some(c => ['Target.setAutoAttach', 'Runtime.runIfWaitingForDebugger', 'Target.closeTarget'].includes(c.method)))
})

test('a second crash supersedes an in-flight restart without replaying its resume', async t => {
  const f = await fixture(t), entered = deferred(), release = deferred(), send = f.browser.send, offset = f.calls.length
  let first = true
  f.browser.send = async (method, ...args) => { const result = await send(method, ...args); if (method === 'Fetch.enable' && first) { first = false; entered.resolve(); await release.promise } return result }
  await f.signal('targetCrashed')
  const stale = f.signal('targetReloadedAfterCrash')
  await entered.promise
  await f.signal('targetCrashed')
  const current = f.signal('targetReloadedAfterCrash')
  release.resolve(); await Promise.all([stale, current])
  assert.equal(f.calls.slice(offset).filter(c => c.method === 'Runtime.runIfWaitingForDebugger').length, 1)
})

test('a restart policy failure closes only its worker without resuming it or its peer', async t => {
  const f = await fixture(t), send = f.browser.send, offset = f.calls.length
  f.broker.targets.set('peer', { targetId: 'peer', sessionId: 'peer-session', type: 'page' })
  f.browser.send = async (method, ...args) => { if (method === 'Fetch.enable') throw new Error('Fixture policy failure'); return send(method, ...args) }
  await f.signal('targetCrashed')
  await assert.rejects(f.signal('targetReloadedAfterCrash'), /Fixture policy failure/)
  const calls = f.calls.slice(offset)
  assert.ok(!calls.some(c => c.method === 'Runtime.runIfWaitingForDebugger'))
  assert.deepEqual(calls.filter(c => c.method === 'Target.closeTarget').map(c => c.params.targetId), ['worker'])
  assert.ok(f.broker.targets.has('peer'))
})

test('an early bypass failure never resumes the restarted worker', async t => {
  const f = await fixture(t), send = f.browser.send, offset = f.calls.length
  f.browser.send = async (method, ...args) => { if (method === 'Network.setBypassServiceWorker') throw new Error('Fixture bypass failure'); return send(method, ...args) }
  await f.signal('targetCrashed')
  await assert.rejects(f.signal('targetReloadedAfterCrash'), /Fixture bypass failure/)
  assert.ok(!f.calls.slice(offset).some(c => c.method === 'Runtime.runIfWaitingForDebugger'))
  assert.deepEqual(f.calls.slice(offset).filter(c => c.method === 'Target.closeTarget').map(c => c.params.targetId), ['worker'])
})

test('a late bypass rejection from a superseded crash cannot poison the new policy attempt', async t => {
  const f = await fixture(t), oldBypass = rejectable(), firstFetch = deferred(), secondFetch = deferred(), releaseFirst = deferred(), releaseSecond = deferred()
  const send = f.browser.send, offset = f.calls.length
  let bypassCount = 0, fetchCount = 0
  f.browser.send = async (method, ...args) => {
    const result = await send(method, ...args)
    if (method === 'Network.setBypassServiceWorker' && ++bypassCount === 1) return oldBypass.promise
    if (method === 'Fetch.enable') {
      if (++fetchCount === 1) { firstFetch.resolve(); await releaseFirst.promise }
      else { secondFetch.resolve(); await releaseSecond.promise }
    }
    return result
  }
  await f.signal('targetCrashed')
  const oldRestart = f.signal('targetReloadedAfterCrash')
  await firstFetch.promise
  await f.signal('targetCrashed')
  const newRestart = f.signal('targetReloadedAfterCrash')
  releaseFirst.resolve(); await secondFetch.promise
  oldBypass.reject(new Error('Superseded bypass failure'))
  await Promise.resolve(); await Promise.resolve()
  releaseSecond.resolve(); await Promise.all([oldRestart, newRestart])
  const calls = f.calls.slice(offset)
  assert.equal(f.entry.bypassError, null)
  assert.equal(f.entry.policyPhase, 'ready')
  assert.equal(calls.filter(c => c.method === 'Runtime.runIfWaitingForDebugger').length, 1)
  assert.ok(!calls.some(c => c.method === 'Target.closeTarget'))
})

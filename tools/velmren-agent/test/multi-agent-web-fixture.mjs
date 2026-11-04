import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import http from 'node:http'

export const AGENTS = Array.from({ length: 5 }, (_, index) => `agent-${index + 1}`)
export const ROUNDS = {
  'during-wait': AGENTS.slice(1),
  'during-pause': AGENTS.slice(1),
  'conversation-1': AGENTS,
  'conversation-2': AGENTS,
  'after-finish': AGENTS.slice(1)
}

const shell = (title, body, script) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font:16px system-ui;margin:24px;max-width:1000px}label{display:block;margin:8px 0}input,textarea,select,button{font:inherit;padding:6px}p{margin:8px 0}section{margin:16px 0}</style>
</head><body>${body}<script>${script}</script></body></html>`

function signupPage(agent, authOrigin) {
  return shell(`Synthetic signup ${agent}`, `
<h1>Synthetic signup ${agent}</h1><p>Owned local fixture. No real accounts or messages.</p>
<p id="storage"></p><p id="oauth">OAuth pending</p><p id="dialog">Dialog pending</p>
<button id="signin">Begin local sign-in</button><button id="prompt">Open synthetic prompt</button>
<form id="signup"><label>Display name <input name="displayName" aria-label="Display name" required></label>
<label>Synthetic email <input name="email" aria-label="Synthetic email" type="email" required></label>
<label>Role <select name="role" aria-label="Role"><option value="reader">Reader</option><option value="builder">Builder</option></select></label>
<button>Create synthetic account</button></form><p id="signup-status">Signup ready</p>
<section><button id="gate">Wait for independent gate</button><p id="gate-status">Gate idle</p></section>
<section><h2>Local conversation</h2><form id="conversation">
<label>Conversation round <select name="round" aria-label="Conversation round">${Object.keys(ROUNDS).map(round => `<option value="${round}">${round}</option>`).join('')}</select></label>
<label>Local message <textarea name="message" aria-label="Local message" required></textarea></label>
<button>Send local message</button></form><div id="transcript"></div></section>`, `
const agent = ${JSON.stringify(agent)};
const authOrigin = ${JSON.stringify(authOrigin)};
const byId = id => document.getElementById(id);
const marker = sessionStorage.getItem('fixture-session') || crypto.randomUUID();
sessionStorage.setItem('fixture-session', marker);
localStorage.setItem('fixture-owner', agent);
byId('storage').textContent = 'Session marker: ' + marker + ' / Local owner: ' + localStorage.getItem('fixture-owner');
let popup, oauthOwner = '', dialogResult = '';
const state = crypto.randomUUID();
byId('signin').onclick = () => {
  popup = window.open(authOrigin + '/oauth?agent=' + agent + '&state=' + state, 'fixture-signin', 'popup,width=640,height=600');
  if (!popup) byId('oauth').textContent = 'OAuth popup blocked';
};
window.addEventListener('message', async event => {
  if (event.origin !== authOrigin || event.source !== popup || event.data?.type !== 'fixture-oauth' || event.data.state !== state) return;
  const response = await fetch('/session');
  const session = await response.json();
  oauthOwner = session.owner;
  byId('oauth').textContent = 'OAuth connected: ' + oauthOwner + ' / PostMessage state: verified';
  event.source.postMessage({type:'fixture-oauth-ack', state}, authOrigin);
});
byId('prompt').onclick = () => {
  dialogResult = prompt('Synthetic code for ' + agent, '');
  byId('dialog').textContent = 'Dialog result: ' + dialogResult;
};
byId('signup').onsubmit = async event => {
  event.preventDefault();
  const values = {...Object.fromEntries(new FormData(event.target)), agent, sessionMarker:marker, localOwner:localStorage.getItem('fixture-owner'), oauthOwner, dialogResult};
  byId('signup-status').textContent = 'Signup pending: ' + agent;
  const response = await fetch('/signup-submit', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(values)});
  const result = await response.json();
  byId('signup-status').textContent = result.ok ? 'Signup complete: ' + agent : 'Signup error: ' + result.error;
};
byId('gate').onclick = async () => {
  byId('gate-status').textContent = 'Independent gate waiting: ' + agent;
  const response = await fetch('/gate?agent=' + agent);
  const result = await response.json();
  byId('gate-status').textContent = result.ok ? 'Independent gate opened: ' + agent : 'Gate error';
};
byId('conversation').onsubmit = async event => {
  event.preventDefault();
  const values = {...Object.fromEntries(new FormData(event.target)), agent, sessionMarker:marker, localOwner:localStorage.getItem('fixture-owner')};
  const response = await fetch('/message', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(values)});
  const result = await response.json();
  const line = document.createElement('p');
  line.textContent = result.ok ? 'Conversation completed: ' + values.round + ' / ' + agent + ' / ' + result.reply : 'Conversation error: ' + result.error;
  byId('transcript').append(line);
};`)
}

function oauthPage(agent, state, mainOrigin) {
  return shell(`Synthetic authorization ${agent}`, `
<h1>Synthetic authorization ${agent}</h1><p id="opener"></p><p id="status">Authorization ready</p>
<button id="authorize">Authorize synthetic identity</button><p>This popup stays open until the test closes its page.</p>`, `
const agent = ${JSON.stringify(agent)}, state = ${JSON.stringify(state)}, mainOrigin = ${JSON.stringify(mainOrigin)};
document.getElementById('opener').textContent = 'Opener available: ' + (window.opener ? 'yes' : 'no');
window.addEventListener('message', event => {
  if (event.origin === mainOrigin && event.source === window.opener && event.data?.type === 'fixture-oauth-ack' && event.data.state === state) {
    document.getElementById('status').textContent = 'Authorization acknowledged: ' + agent;
  }
});
document.getElementById('authorize').onclick = async () => {
  const response = await fetch('/authorize', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({agent, state, hasOpener:!!window.opener})});
  if (!response.ok || !window.opener) { document.getElementById('status').textContent = 'Authorization failed'; return; }
  window.opener.postMessage({type:'fixture-oauth', agent, state}, mainOrigin);
};`)
}

export async function multiAgentFixture() {
  const events = new EventEmitter()
  const evidence = { signups: [], messages: [], authorizations: [], gates: [], barriers: [], errors: [] }
  const pending = new Set()
  const gates = new Map()
  const barriers = new Map()
  let mainOrigin, authOrigin

  const json = (res, status, body, headers = {}) => {
    pending.delete(res)
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers })
    res.end(JSON.stringify(body))
  }
  const cookieOwner = req => /(?:^|;\s*)fixture-oauth=([^;]*)/.exec(req.headers.cookie ?? '')?.[1] ?? ''
  const body = async req => {
    let text = ''
    for await (const chunk of req) {
      text += chunk
      if (text.length > 16384) throw new Error('Fixture request too large')
    }
    return JSON.parse(text)
  }
  const agentIsValid = agent => assert.ok(AGENTS.includes(agent), `Unknown synthetic agent: ${agent}`)
  const arrive = (name, expected, entry, res, response) => {
    let barrier = barriers.get(name)
    if (!barrier) {
      barrier = { expected, entries: [], released: false }
      barrier.timer = setTimeout(() => {
        const error = `${name}: only ${barrier.entries.length}/${expected.length} requests overlapped`
        evidence.errors.push(error)
        for (const item of barrier.entries) if (!item.res.writableEnded) json(item.res, 504, { error })
        events.emit('change')
      }, 20000)
      barriers.set(name, barrier)
    }
    assert.equal(barrier.released, false, `${name}: duplicate completed round`)
    assert.ok(expected.includes(entry.agent), `${name}: unexpected agent`)
    assert.ok(!barrier.entries.some(item => item.entry.agent === entry.agent), `${name}: duplicate request`)
    barrier.entries.push({ entry, res, response })
    pending.add(res)
    if (barrier.entries.length === expected.length) {
      clearTimeout(barrier.timer)
      barrier.released = true
      evidence.barriers.push({ name, concurrentRequests: barrier.entries.length, releasedAt: Date.now() })
      for (const item of barrier.entries) {
        item.entry.completedAt = Date.now()
        json(item.res, 200, { ok: true, ...item.response })
      }
    }
    events.emit('change')
  }
  const handler = kind => async (req, res) => {
    try {
      const url = new URL(req.url, kind === 'main' ? mainOrigin : authOrigin)
      if (kind === 'main' && req.method === 'GET' && url.pathname.startsWith('/signup/')) {
        const agent = url.pathname.split('/').at(-1)
        agentIsValid(agent)
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
        return res.end(signupPage(agent, authOrigin))
      }
      if (kind === 'auth' && req.method === 'GET' && url.pathname === '/oauth') {
        const agent = url.searchParams.get('agent'), state = url.searchParams.get('state')
        agentIsValid(agent)
        assert.match(state ?? '', /^[0-9a-f-]{36}$/)
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
        return res.end(oauthPage(agent, state, mainOrigin))
      }
      if (kind === 'auth' && req.method === 'POST' && url.pathname === '/authorize') {
        const values = await body(req)
        agentIsValid(values.agent)
        evidence.authorizations.push({ ...values, startedAt: Date.now(), previousOwner: cookieOwner(req) })
        events.emit('change')
        return json(res, 200, { ok: true }, { 'Set-Cookie': `fixture-oauth=${values.agent}; Path=/; HttpOnly; SameSite=Lax` })
      }
      if (kind === 'main' && req.method === 'GET' && url.pathname === '/session') return json(res, 200, { owner: cookieOwner(req) })
      if (kind === 'main' && req.method === 'POST' && ['/signup-submit', '/message'].includes(url.pathname)) {
        const values = await body(req)
        agentIsValid(values.agent)
        const entry = { ...values, cookieOwner: cookieOwner(req), startedAt: Date.now(), completedAt: null }
        if (url.pathname === '/signup-submit') {
          evidence.signups.push(entry)
          return arrive('signup', AGENTS, entry, res, {})
        }
        assert.ok(Object.hasOwn(ROUNDS, values.round), 'Unknown conversation round')
        evidence.messages.push(entry)
        const number = evidence.messages.filter(item => item.agent === entry.agent).length
        return arrive(values.round, ROUNDS[values.round], entry, res, { reply: `Synthetic reply ${number} for ${entry.agent}` })
      }
      if (kind === 'main' && req.method === 'GET' && url.pathname === '/gate') {
        const agent = url.searchParams.get('agent')
        agentIsValid(agent)
        assert.ok(!gates.has(agent), 'Gate already requested')
        const entry = { agent, startedAt: Date.now(), releasedAt: null }
        gates.set(agent, { res, entry })
        evidence.gates.push(entry)
        pending.add(res)
        events.emit('change')
        return
      }
      res.writeHead(404)
      res.end()
    } catch (error) {
      evidence.errors.push(error.message)
      events.emit('change')
      if (!res.headersSent) json(res, 400, { error: error.message })
      else res.destroy()
    }
  }
  const main = http.createServer(handler('main')), auth = http.createServer(handler('auth'))
  const listen = server => new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`))
  })
  try {
    mainOrigin = await listen(main)
    authOrigin = await listen(auth)
  } catch (error) {
    main.closeAllConnections(); auth.closeAllConnections()
    main.close(); auth.close()
    throw error
  }
  return {
    url: mainOrigin,
    origins: [mainOrigin, authOrigin],
    evidence,
    waitFor(predicate, description, timeoutMs = 10000) {
      return new Promise((resolve, reject) => {
        const finish = error => {
          clearTimeout(timer)
          events.off('change', check)
          error ? reject(error) : resolve()
        }
        const check = () => { if (predicate(evidence)) finish() }
        const timer = setTimeout(() => finish(new Error(`Fixture timeout: ${description}`)), timeoutMs)
        events.on('change', check)
        check()
      })
    },
    releaseGate(agent) {
      const gate = gates.get(agent)
      assert.ok(gate, `Missing gate for ${agent}`)
      assert.equal(gate.entry.releasedAt, null, 'Gate already released')
      gate.entry.releasedAt = Date.now()
      json(gate.res, 200, { ok: true })
      events.emit('change')
    },
    async close() {
      for (const barrier of barriers.values()) clearTimeout(barrier.timer)
      for (const res of pending) if (!res.writableEnded) json(res, 503, { error: 'Fixture closed' })
      await Promise.all([main, auth].map(server => new Promise(resolve => {
        server.closeAllConnections()
        server.close(resolve)
      })))
    }
  }
}

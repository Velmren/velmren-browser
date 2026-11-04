import { createHash } from 'node:crypto'
import http from 'node:http'

const listen = server => new Promise((resolve, reject) => {
  server.once('error', reject)
  server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`))
})

// The fixture accepts only small, unfragmented masked client text/control frames.
// Browser WebSocket messages below are short ASCII and need no general WS library.
function echoSocket(request, socket, head, record) {
  const key = request.headers['sec-websocket-key']
  if (typeof key !== 'string' || request.headers['sec-websocket-version'] !== '13') return socket.destroy()
  const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
  let buffered = Buffer.alloc(0)
  const receive = data => {
    buffered = Buffer.concat([buffered, data])
    if (buffered.length > 4096) return socket.destroy()
    while (buffered.length >= 2) {
      const opcode = buffered[0] & 15
      const size = buffered[1] & 127
      if (!(buffered[0] & 128) || !(buffered[1] & 128) || size > 125 || ![1, 8, 9, 10].includes(opcode)) return socket.destroy()
      if (buffered.length < 6 + size) return
      const mask = buffered.subarray(2, 6)
      const message = Buffer.from(buffered.subarray(6, 6 + size))
      for (let index = 0; index < message.length; index++) message[index] ^= mask[index % 4]
      buffered = buffered.subarray(6 + size)
      if (opcode === 8) { socket.end(Buffer.concat([Buffer.from([0x88, size]), message])); return }
      if (opcode === 9) socket.write(Buffer.concat([Buffer.from([0x8a, size]), message]))
      if (opcode === 1) {
        record(message.toString('utf8'), () => socket.write(Buffer.concat([Buffer.from([0x81, size]), message])))
      }
    }
  }
  socket.on('data', receive)
  socket.on('error', () => {})
  if (head.length) receive(head)
}

// This source runs in both the page and a same-origin dedicated worker.
const probeSource = `async function probe(source, peer, origin, deniedOrigin) {
  const payload = 'synthetic-' + source + '-' + peer;
  const echo = new Promise(resolve => {
    let socket; const done = value => { clearTimeout(timer); socket?.close(); resolve(value); };
    const timer = setTimeout(() => done('timeout'), 12000);
    try {
      socket = new WebSocket(origin.replace('http:', 'ws:') + '/socket?source=' + source + '&peer=' + peer);
      socket.onopen = () => socket.send(payload);
      socket.onmessage = event => done(event.data === payload ? 'echo ' + payload : 'wrong echo');
      socket.onerror = () => done('error');
    } catch { done('error'); }
  });
  const denied = new Promise(resolve => {
    let socket; const done = value => { clearTimeout(timer); socket?.close(); resolve(value); };
    const timer = setTimeout(() => done('timeout'), 12000);
    try {
      socket = new WebSocket(deniedOrigin.replace('http:', 'ws:') + '/denied?source=' + source + '&peer=' + peer);
      socket.onopen = () => done('connected'); socket.onerror = () => done('blocked');
    } catch { done('blocked'); }
  });
  const [echoResult, deniedResult] = await Promise.all([echo, denied]);
  return source + ' WebSocket: ' + echoResult + '; denied ' + deniedResult;
}`

export async function managedBrowserFixture() {
  const submissions = []
  const evidence = { handshakes: [], echoes: [], deniedHandshakes: 0, deniedRequests: 0, workerScripts: [], concurrentPendingEchoes: 0 }
  const replies = []
  const sockets = new Set()
  const track = server => server.on('connection', socket => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })
  const denied = http.createServer((_request, response) => { evidence.deniedRequests++; response.writeHead(403); response.end() })
  denied.on('upgrade', (_request, socket) => {
    evidence.deniedHandshakes++
    socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
  })
  track(denied)
  const deniedUrl = await listen(denied)
  const server = http.createServer(async (request, response) => {
    const requestUrl = new URL(request.url, 'http://fixture.invalid')
    if (requestUrl.pathname === '/submitted') {
      let body = ''
      for await (const chunk of request) {
        body += chunk
        if (body.length > 16384) { response.writeHead(413); response.end(); return }
      }
      submissions.push({ at: new Date().toISOString(), body })
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end('{"ok":true}')
      return
    }
    if (requestUrl.pathname === '/worker.js') {
      evidence.workerScripts.push(requestUrl.searchParams.get('peer'))
      response.writeHead(200, { 'Content-Type': 'application/javascript', 'Cache-Control': 'no-store' })
      response.end(`${probeSource}\nonmessage = async event => { const { peer, origin, deniedOrigin } = event.data; postMessage(await probe('worker', peer, origin, deniedOrigin)); };`)
      return
    }
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
    response.end(`<!doctype html><title>Managed browser acceptance</title>
<h1>Managed browser synthetic forms and conversations</h1>
<form id="form"><label>Name <input name="name" autocomplete="off"></label>
<label>Category <select name="category"><option value="basic">Basic</option><option value="advanced">Advanced</option></select></label>
<label>Notes <textarea name="notes"></textarea></label><button>Save local record</button></form>
<p id="status">Ready</p><p id="storage"></p><button id="change">Change page</button>
<button id="sockets">Run WebSocket checks</button><p id="main-result">main WebSocket: not started</p><p id="worker-result">worker WebSocket: not started</p>
<script>${probeSource}
sessionStorage.setItem('velmren-marker', sessionStorage.getItem('velmren-marker') || crypto.randomUUID());
document.querySelector('#storage').textContent = 'Session marker: ' + sessionStorage.getItem('velmren-marker');
document.querySelector('#form').onsubmit = async event => {
  event.preventDefault(); const values = Object.fromEntries(new FormData(event.target));
  await fetch('/submitted', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(values) });
  localStorage.setItem('record', JSON.stringify(values));
  document.querySelector('#status').textContent = 'Saved: ' + values.name + ' / ' + values.category + ' / ' + values.notes;
};
document.querySelector('#change').onclick = () => { document.querySelector('#status').textContent = 'Changed page'; };
document.querySelector('#sockets').onclick = () => {
  const peer = new URL(location.href).searchParams.get('peer');
  const deniedOrigin = ${JSON.stringify(deniedUrl)};
  probe('main', peer, location.origin, deniedOrigin).then(value => { document.querySelector('#main-result').textContent = value; });
  try {
    const worker = new Worker('/worker.js?peer=' + encodeURIComponent(peer));
    worker.onmessage = event => { document.querySelector('#worker-result').textContent = event.data; worker.terminate(); };
    worker.onerror = event => { event.preventDefault(); document.querySelector('#worker-result').textContent = 'worker WebSocket: worker failed'; worker.terminate(); };
    worker.postMessage({ peer, origin: location.origin, deniedOrigin });
  } catch { document.querySelector('#worker-result').textContent = 'worker WebSocket: worker creation failed'; }
};
</script>`)
  })
  track(server)
  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url, 'http://fixture.invalid')
    if (url.pathname !== '/socket') return socket.destroy()
    const identity = { source: url.searchParams.get('source'), peer: url.searchParams.get('peer') }
    evidence.handshakes.push(identity)
    echoSocket(request, socket, head, (message, reply) => {
      evidence.echoes.push({ ...identity, message })
      replies.push(reply)
      evidence.concurrentPendingEchoes = Math.max(evidence.concurrentPendingEchoes, replies.length)
      // Hold the echoes until five main pages and five workers are all in flight.
      if (replies.length === 10) for (const respond of replies) respond()
    })
  })
  let url
  try { url = await listen(server) }
  catch (error) { denied.close(); throw error }
  return {
    url, deniedUrl, server, submissions, evidence,
    close: async () => {
      for (const socket of sockets) socket.destroy()
      await Promise.all([server, denied].map(item => new Promise(resolve => item.close(resolve))))
    }
  }
}

import http from 'node:http'

export const SENTINELS = {
  field: 'synthetic-private-field-9a41',
  password: 'synthetic-password-72f4',
  wait: 'synthetic-property-only-ready-5cc8'
}

export async function ergonomicsFixture() {
  const evidence = { submissions: 0, requests: 0 }
  const normal = `<!doctype html><meta charset="utf-8"><title>Agent contract acceptance</title>
  <style>body{font:16px sans-serif;padding:24px}label,button{display:block;margin:12px 0}input,select{margin:4px}</style>
  <h1>Agent contract acceptance</h1>
  <label>Full name<input aria-label="Full name" id="name"></label>
  <label>Password<input aria-label="Password" type="password" id="password"></label>
  <label>Read only<input aria-label="Read only" value="fixed" readonly></label>
  <label>Choice<select aria-label="Choice"><option value="one">One</option><option value="two">Two</option></select></label>
  <label>Rewritten value<input aria-label="Rewritten value" oninput="this.value='application-rewrite'"></label>
  <label>Delayed value<input aria-label="Delayed value" id="delayed" disabled></label>
  <input aria-label="Hidden upload" type="file" style="display:none">
  <fieldset disabled><input aria-label="Disabled upload" type="file"></fieldset>
  <button onclick="setTimeout(()=>{document.querySelector('#delayed').disabled=false;setTimeout(()=>{document.querySelector('#delayed').value='${SENTINELS.wait}'},300)},100)">Start property changes</button>
  <button onclick="fetch('/submit',{method:'POST'}).then(()=>document.querySelector('#status').textContent='Submitted')">Submit once</button>
  <button onclick="const e=document.querySelector('#name');e.replaceWith(e.cloneNode(true))">Replace field</button>
  <p id="status">Ready</p>`
  const large = `<!doctype html><meta charset="utf-8"><title>Large observation</title>
  <select aria-label="Many options">${Array.from({ length: 60 }, (_, i) => `<option value="${i}">Option ${i}</option>`).join('')}</select>
  <input aria-label="${'Long name '.repeat(30)}" value="${'v'.repeat(350)}">
  ${Array.from({ length: 170 }, (_, i) => `<button>Item ${i}</button>`).join('')}
  <p>${'Long visible text '.repeat(700)}</p>`
  const server = http.createServer((request, response) => {
    evidence.requests++
    if (request.method === 'POST' && request.url === '/submit') {
      evidence.submissions++
      request.resume()
      response.writeHead(200, { 'Content-Type': 'text/plain' }); response.end('ok')
      return
    }
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
    response.end(request.url?.startsWith('/large') ? large : normal)
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  return {
    origin: `http://127.0.0.1:${server.address().port}`, evidence,
    close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections() })
  }
}

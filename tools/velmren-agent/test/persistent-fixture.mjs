import http from 'node:http'

export async function persistentFixture() {
  const evidence = { forbidden: 0, workerProbes: [], downloads: [] }
  const streams = new Map()
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://fixture')
    if (url.pathname === '/forbidden') { evidence.forbidden++; response.end('unexpected'); return }
    if (url.pathname === '/probe') { evidence.workerProbes.push(url.searchParams.get('kind')); response.end('ok'); return }
    if (url.pathname === '/download') {
      const key = url.searchParams.get('key')
      evidence.downloads.push(key)
      response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="${key}.txt"`, 'Content-Length': 65541 })
      response.write('start-'.padEnd(65536, '.'))
      if (url.searchParams.has('slow')) streams.set(key, response)
      else response.end('done!')
      return
    }
    if (url.pathname === '/shared.js') {
      response.writeHead(200, { 'Content-Type': 'text/javascript' })
      response.end(`const id=crypto.randomUUID();let count=0;onconnect=e=>{const p=e.ports[0];p.onmessage=async e=>{await fetch('/probe?kind=shared');p.postMessage({id,count:++count});};p.start();};`)
      return
    }
    if (url.pathname === '/sw.js') {
      response.writeHead(200, { 'Content-Type': 'text/javascript', 'Service-Worker-Allowed': '/' })
      response.end(`addEventListener('install',e=>e.waitUntil(skipWaiting()));addEventListener('activate',e=>e.waitUntil(clients.claim()));addEventListener('message',e=>e.waitUntil((async()=>{let result='ok';await fetch('/probe?kind=service');if(e.data.url){try{await fetch(e.data.url);result='escaped';}catch{result='blocked';}}e.ports[0].postMessage(result);})()));`)
      return
    }
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
    if (url.pathname === '/frame') { response.end('<!doctype html><title>Child download</title><p>Child frame</p>'); return }
    response.end(`<!doctype html><meta charset="utf-8"><title>Persistent profile fixture</title><p id="status">Ready</p>
      <iframe src="/frame"></iframe><script>
      window.openStore=()=>new Promise((resolve,reject)=>{const r=indexedDB.open('persistent-fixture',1);r.onupgradeneeded=()=>r.result.createObjectStore('values');r.onerror=()=>reject(r.error);r.onsuccess=()=>resolve(r.result)});
      window.seed=async()=>{document.cookie='persistent_cookie=durable; Max-Age=3600; SameSite=Lax; Path=/';document.cookie='session_cookie=durable; SameSite=Lax; Path=/';localStorage.setItem('persistent-key','durable');const d=await openStore();await new Promise((resolve,reject)=>{const t=d.transaction('values','readwrite');t.objectStore('values').put('durable','key');t.oncomplete=resolve;t.onerror=()=>reject(t.error)});d.close();return readState()};
      window.readState=async()=>{const d=await openStore();const idb=await new Promise((resolve,reject)=>{const r=d.transaction('values').objectStore('values').get('key');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)});d.close();return {cookie:document.cookie,local:localStorage.getItem('persistent-key'),idb}};
      window.sharedPing=()=>new Promise(resolve=>{window.shared??=new SharedWorker('/shared.js');shared.port.onmessage=e=>resolve(e.data);shared.port.start();shared.port.postMessage('ping')});
      window.servicePing=async url=>{await navigator.serviceWorker.register('/sw.js');const r=await navigator.serviceWorker.ready;return new Promise(resolve=>{const c=new MessageChannel();c.port1.onmessage=e=>resolve(e.data);r.active.postMessage({url},[c.port2])})};
      </script>`)
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  return { server, evidence, origin: `http://127.0.0.1:${server.address().port}`, finishDownload(key) { streams.get(key)?.end('done!'); streams.delete(key) }, async close() { for (const stream of streams.values()) stream.destroy(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) } }
}

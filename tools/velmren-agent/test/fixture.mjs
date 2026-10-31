import http from 'node:http'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export async function fixtureServer(port=0) {
  const submissions=[]
  const server=http.createServer(async(req,res)=>{
    const url=new URL(req.url,'http://localhost')
    if(url.pathname==='/download') {
      res.writeHead(200,{'Content-Type':'text/csv','Content-Disposition':'attachment; filename="velmren-fixture.csv"'})
      return res.end('kind,value\nfixture,42\n')
    }
    if(url.pathname==='/submitted') {
      let body='';for await(const chunk of req)body+=chunk
      submissions.push({at:new Date().toISOString(),body})
      res.writeHead(200,{'Content-Type':'application/json'});return res.end('{"ok":true}')
    }
    if(url.pathname==='/login-success') {
      res.writeHead(200,{'Content-Type':'text/html'});return res.end('<title>Velmren login fixture</title><h1>Signed in to local test</h1><a href="/login">Back</a>')
    }
    if(url.pathname==='/login') {
      res.writeHead(200,{'Content-Type':'text/html'});return res.end('<title>Velmren password persistence fixture</title><h1>Local password fixture</h1><form action="/login-success" method="post"><label>Username <input id="username" name="username" autocomplete="username"></label><label>Password <input id="password" name="password" type="password" autocomplete="current-password"></label><button>Sign in</button></form>')
    }
    res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'})
    res.end(`<!doctype html><html><head><title>Velmren local acceptance</title><style>body{font:18px system-ui;margin:50px;max-width:760px;background:#f3f7fa;color:#112d33}label{display:block;margin:18px 0}input,select,textarea,button{font:inherit;padding:10px;border:1px solid #79949b;border-radius:6px}button{background:#00695c;color:white;cursor:pointer}#status{padding:20px;background:#e0f2ef}</style></head><body><h1>Velmren local acceptance</h1><p>Only synthetic local test data.</p><form id="form"><label>Name <input id="name" name="name" autocomplete="off"></label><label>Category <select id="category" name="category"><option value="basic">Basic</option><option value="advanced">Advanced</option></select></label><label>Notes <textarea id="notes" name="notes"></textarea></label><button type="submit">Save local record</button></form><p id="status">Ready</p><p id="storage"></p><a href="/download" download>Download fixture CSV</a><button id="change" type="button">Change page</button><script>
      sessionStorage.setItem('velmren-marker',sessionStorage.getItem('velmren-marker')||crypto.randomUUID());
      document.getElementById('storage').textContent='Session marker: '+sessionStorage.getItem('velmren-marker');
      document.getElementById('form').addEventListener('submit',async event=>{event.preventDefault();const values=Object.fromEntries(new FormData(event.target));await fetch('/submitted',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(values)});localStorage.setItem('record',JSON.stringify(values));document.cookie='fixture='+encodeURIComponent(values.name)+'; path=/';document.getElementById('status').textContent='Saved: '+values.name+' / '+values.category+' / '+values.notes});
      document.getElementById('change').onclick=()=>{document.getElementById('status').textContent='Changed page '+Date.now()};
    </script></body></html>`)
  })
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve)})
  return {server,submissions,url:`http://127.0.0.1:${server.address().port}`,close:()=>new Promise(resolve=>server.close(resolve))}
}

if(process.argv[1] && import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){const f=await fixtureServer(Number(process.argv[2]||18774));console.log(JSON.stringify({url:f.url}));for(const sig of ['SIGINT','SIGTERM'])process.once(sig,async()=>{await f.close();process.exit()})}

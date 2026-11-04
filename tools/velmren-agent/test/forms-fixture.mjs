import http from 'node:http'

export async function startFormsFixture() {
  const records = []
  const longOption = `country-200-${'x'.repeat(350)}`
  let origin, crossOrigin
  const html = body => `<!doctype html><html lang="en"><meta charset="utf-8"><style>body{font:16px sans-serif;margin:24px}label{display:block;margin:10px}input,select,button{font:inherit}iframe{width:800px;height:500px;border:7px solid #555;margin:30px 13px}</style><body>${body}</body></html>`
  const controls = () => html(`
    <h1>Ordinary form controls</h1>
    <form id="form">
      <label><input id="consent" name="consent" type="checkbox" checked required>Required consent</label>
      <label><input id="marketing" name="marketing" type="checkbox">Optional marketing</label>
      <label><input id="radio-a" name="plan" type="radio" value="a" checked>Plan A</label>
      <label><input id="radio-b" name="plan" type="radio" value="b">Plan B</label>
      <button id="switch" type="button" role="switch" aria-checked="true">Notification switch</button>
      <label>Constrained name<input id="name" name="name" required minlength="4" maxlength="20" pattern="[A-Z]+" aria-describedby="name-help"></label>
      <p id="name-help">Use uppercase letters, four to twenty characters.</p>
      <label>Constrained number<input id="number" name="number" type="number" min="1" max="11" step="2" value="3"></label>
      <label>Private field<input id="password" name="password" type="password" required minlength="8" maxlength="40"></label>
      <label>Birth date<input name="birth" type="date" min="1900-01-01" max="2099-12-31"></label>
      <label>Meeting time<input name="time" type="time" step="1"></label>
      <label>Local meeting<input name="local" type="datetime-local" step="1"></label>
      <label>Start month<input name="month" type="month"></label>
      <label>Start week<input name="week" type="week"></label>
      <label>Country list<select name="country">${Array.from({length:200}, (_, n) => `<option value="${n === 199 ? longOption : `country-${n + 1}`}">Country ${String(n + 1).padStart(3, '0')}</option>`).join('')}</select></label>
      <button id="submit" type="button">Submit synthetic form</button>
    </form>
    <p id="status">Consent changes: 0; switch changes: 0</p>
    <div id="extra">${Array.from({length:220}, (_, n) => `<button type="button" data-extra="${n + 1}">Extra control ${n + 1}</button>`).join('\n')}</div>
    <div>${Array.from({length:450}, (_, n) => `<p>Visible line ${n + 1}: ordinary page text for bounded reading.</p>`).join('')}</div>
    <p>END OF LONG PAGE</p>
    <script>
      let consentChanges=0,switchChanges=0;
      const status=document.querySelector('#status'),consent=document.querySelector('#consent'),toggle=document.querySelector('#switch');
      const show=()=>status.textContent='Consent changes: '+consentChanges+'; switch changes: '+switchChanges;
      consent.addEventListener('change',()=>{consentChanges++;show()});
      toggle.onclick=()=>{toggle.setAttribute('aria-checked',toggle.getAttribute('aria-checked')==='true'?'false':'true');switchChanges++;show()};
      document.querySelector('#extra').onclick=e=>{if(e.target.dataset.extra)status.textContent='Extra selected '+e.target.dataset.extra};
      document.querySelector('#submit').onclick=async()=>{
        const values=Object.fromEntries(new FormData(document.querySelector('#form')));
        delete values.password;
        await fetch('/record',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({kind:'controls',values,consentChanges,switchChanges})});
        status.textContent='Synthetic form accepted';
      };
    </script>`)
  const shadows = () => html(`
    <h1>Open shadow forms</h1><div id="host"><label slot="projected">Slotted name<input name="slotted"></label></div><div id="closed"></div>
    <script>
      const root=document.querySelector('#host').attachShadow({mode:'open'});
      root.innerHTML='<style>label{display:block;margin:12px}input{font:inherit}</style><label>Shadow name<input id="name"></label><label><input id="check" type="checkbox">Shadow consent</label><button id="submit">Submit shadow form</button><p id="status">Shadow ready</p><slot name="projected"></slot><div id="nested"></div>';
      root.querySelector('#nested').attachShadow({mode:'open'}).innerHTML='<label>Nested shadow date<input type="date"></label>';
      const concealed=document.createElement('p');concealed.textContent='Concealed shadow success';concealed.style.visibility='hidden';root.append(concealed);
      const reveal=document.createElement('button');reveal.textContent='Reveal shadow status';reveal.onclick=()=>concealed.style.visibility='visible';root.append(reveal);
      root.querySelector('#submit').onclick=async()=>{await fetch('/record',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({kind:'shadow',name:root.querySelector('#name').value,checked:root.querySelector('#check').checked})});root.querySelector('#status').textContent='Shadow form accepted'};
      document.querySelector('#closed').attachShadow({mode:'closed'}).innerHTML='<label>Closed secret control<input></label>';
    </script>`)
  const frames = () => html(`
    <h1>Nested ordinary forms</h1><label>Top frame name<input name="top"></label>
    <button id="replace">Replace cross frame</button><button id="remove">Remove same frame</button>
    <button id="scale-frame">Scale same frame</button><button id="scale-parent">Scale frame ancestor</button><button id="zoom-parent">Zoom frame ancestor</button><button id="restore-frame">Restore frame layout</button>
    <section id="frame-container"><iframe id="same" name="same-form" src="/frame-inner"></iframe></section>
    <iframe id="cross" name="cross-form" src="${crossOrigin}/frame-cross"></iframe>
    <script>document.querySelector('#replace').onclick=()=>document.querySelector('#cross').src='${crossOrigin}/frame-cross?generation=2';document.querySelector('#remove').onclick=()=>document.querySelector('#same').remove();
      document.querySelector('#scale-frame').onclick=()=>document.querySelector('#same').style.transform='scale(.5)';
      document.querySelector('#scale-parent').onclick=()=>document.querySelector('#frame-container').style.scale='.5';
      document.querySelector('#zoom-parent').onclick=()=>document.querySelector('#frame-container').style.zoom='.5';
      document.querySelector('#restore-frame').onclick=()=>{document.querySelector('#same').style.transform='none';document.querySelector('#frame-container').style.scale='none';document.querySelector('#frame-container').style.zoom='1'};
    </script>`)
  const frame = (kind, nested, generation) => html(`
    <h1>${kind} form generation ${generation}</h1>
    <form><label>${kind} name<input name="name"></label><label><input type="checkbox" name="consent">${kind} consent</label><label>${kind} date<input name="date" type="date"></label><label>${kind} country<select name="country"><option value="one">First country</option><option value="two">Second country</option></select></label><label>${kind} file<input name="attachment" type="file"></label><button type="button">Submit ${kind} form</button></form><p id="status">Frame ready</p>
    ${nested ? `<iframe name="nested-form" src="${crossOrigin}/frame-leaf"></iframe>` : ''}
    <script>document.querySelector('button').onclick=async()=>{const values=Object.fromEntries(new FormData(document.querySelector('form')));delete values.attachment;await fetch('/record',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({kind:'${kind}',generation:${generation},values})});document.querySelector('#status').textContent='${kind} form accepted'};</script>`)
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, origin)
    res.setHeader('Cache-Control', 'no-store')
    if (url.pathname === '/record' && req.method === 'POST') {
      let body = ''
      for await (const chunk of req) { body += chunk; if (body.length > 100000) { res.writeHead(413); res.end(); return } }
      try { records.push(JSON.parse(body)); res.end('recorded') } catch { res.writeHead(400); res.end() }
      return
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    const generation = url.searchParams.get('generation') === '2' ? 2 : 1
    if (url.pathname === '/shadows') res.end(shadows())
    else if (url.pathname === '/frames') res.end(frames())
    else if (url.pathname === '/frame-inner') res.end(frame('Same frame', true, generation))
    else if (url.pathname === '/frame-cross') res.end(frame('Cross frame', false, generation))
    else if (url.pathname === '/frame-leaf') res.end(frame('Nested frame', false, generation))
    else res.end(controls())
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  origin = `http://127.0.0.1:${server.address().port}`
  crossOrigin = `http://localhost:${server.address().port}`
  return { origin, crossOrigin, records, longOption, server, async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) } }
}

import http from 'node:http'
import { randomBytes } from 'node:crypto'

// Canaries are generated in memory. Acceptance reports must never serialize them.
export async function startSensitiveFixture() {
  const marker = `private-${randomBytes(18).toString('hex')}`
  const digits = Array.from(randomBytes(24), byte => byte % 10).join('')
  const secret = `${marker}-${digits}`
  const urlMarker = `route-${randomBytes(18).toString('hex')}`
  const probes = [marker, [...marker].reverse().join(''), digits, [...digits].join(' '), [...digits].reverse().join(''), urlMarker]
  let origin, crossOrigin
  const document = (body, script = '') => `<!doctype html><html><meta charset="utf-8"><title>Privacy fixture</title><style>body{font:16px sans-serif;margin:24px}label{display:block;margin:12px}input,select,button{font:inherit}iframe{display:block;width:700px;height:420px;margin-top:12px}</style><body>${body}<script>${script}</script></body></html>`
  // Seeded pixels make native PNG compression exercise arbitrary base64 bytes.
  const safe = () => document('<h1>Authentication confirmed</h1><label>Full name<input value="Privacy acceptance User"></label><h2>Settings</h2><p>Ordinary account settings are available.</p><canvas id="screenshot-pattern" width="192" height="96"></canvas>', `
    const context=document.querySelector('#screenshot-pattern').getContext('2d');
    const image=context.createImageData(192,96);let seed=0x4b13a095;
    for(let index=0;index<image.data.length;index++){
      seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;
      image.data[index]=index%4===3?255:seed&255;
    }
    context.putImageData(image,0,0);
  `)
  const form = ({ child = false, activate = false, lateMode = '' } = {}) => document(`
    <h1 id="heading">Synthetic authentication form</h1>
    <label id="password-label">Password<input id="password" type="password" aria-describedby="helper"></label>
    <label>One-time code<input id="otp" autocomplete="one-time-code"></label>
    <label>Section one-time code<input id="section-otp" autocomplete="section-login one-time-code"></label>
    <label>Multiline one-time code<textarea id="textarea-otp" autocomplete="one-time-code"></textarea></label>
    <label>Private text<input id="plain"></label>
    <label>Focus decoy<input id="decoy"></label>
    <p id="helper">Ordinary helper text</p>
    <label>Choices<select id="choices"><option value="ordinary">Ordinary option</option></select></label>
    <button id="popup">Open popup</button><button id="dialog">Open dialog</button>
    <a href="${origin}/safe/${urlMarker}?code=${urlMarker}#${urlMarker}">Safe destination</a>
    ${lateMode ? `<label style="${lateMode.startsWith('scroll') ? 'margin-top:1600px' : ''}">Late private field<input id="late"></label>` : ''}
    ${child ? '' : `<iframe id="same" src="${origin}/child/${urlMarker}?code=${urlMarker}#${urlMarker}"></iframe><iframe id="cross" src="${crossOrigin}/child/${urlMarker}?code=${urlMarker}#${urlMarker}"></iframe>`}
  `, `
    window.fixtureSecret=${JSON.stringify(secret)};
    window.fixtureEcho=value=>{
      window.lastPrivateValue=value;
      document.title=value;
      document.querySelector('#heading').textContent=[...value].reverse().join('');
      const digits=value.replace(/\\D/g,'');
      document.querySelector('#helper').textContent=value+' '+[...${JSON.stringify(digits)}].join(' ');
      document.querySelector('#plain').setAttribute('aria-label',value);
      document.querySelector('#plain').setAttribute('placeholder',value);
      document.querySelector('#plain').setAttribute('title',value);
      document.querySelector('#plain').setCustomValidity(value);
      document.querySelector('#choices').innerHTML='';
      document.querySelector('#choices').add(new Option(value,value));
      history.replaceState(null,'','/echo/'+${JSON.stringify(urlMarker)}+'?code='+${JSON.stringify(urlMarker)}+'#'+${JSON.stringify(urlMarker)});
      for(const frame of document.querySelectorAll('iframe'))frame.contentWindow.postMessage({fixtureEcho:value},'*');
      if(parent!==window)parent.postMessage({fixtureChildEcho:value},'*');
    };
    for(const id of ['password','otp','section-otp','textarea-otp','plain',...(document.querySelector('#late')?['late']:[])])document.getElementById(id).addEventListener('input',event=>window.fixtureEcho(event.target.value));
    document.querySelector('#password').addEventListener('focus',()=>document.querySelector('#decoy').focus());
    window.addEventListener('message',event=>{
      if(event.data?.fixtureEcho)window.fixtureEcho(event.data.fixtureEcho);
      if(event.data?.fixtureChildEcho){document.title=event.data.fixtureChildEcho;document.querySelector('#helper').textContent=event.data.fixtureChildEcho;}
    });
    document.querySelector('#popup').onclick=()=>window.open(${JSON.stringify(`${origin}/activation/${urlMarker}?token=${urlMarker}#${urlMarker}`)},'_blank');
    document.querySelector('#dialog').onclick=()=>alert(window.lastPrivateValue||window.fixtureSecret);
    ${lateMode ? `
      window.fixtureLateTriggered=false;
      const transition=()=>{
        window.fixtureLateTriggered=true;
        ${lateMode.endsWith('otp') ? "document.querySelector('#late').autocomplete='section-login one-time-code'" : "document.querySelector('#late').type='password'"};
      };
      ${lateMode.startsWith('scroll') ? "window.addEventListener('scroll',transition,{once:true})" : "document.querySelector('#late').addEventListener('focus',transition,{once:true})"};
    ` : ''}
    ${activate ? 'window.fixtureEcho(window.fixtureSecret);' : ''}
  `)
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, origin)
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    const lateMode = /^\/late-(focus-password|focus-otp|scroll-password)\//.exec(url.pathname)?.[1] ?? ''
    res.end(url.pathname.startsWith('/safe') ? safe() : form({ child: url.pathname.startsWith('/child'), activate: url.pathname.startsWith('/activation'), lateMode }))
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  origin = `http://127.0.0.1:${server.address().port}`
  crossOrigin = `http://localhost:${server.address().port}`
  return { origin, crossOrigin, marker, digits, secret, urlMarker, probes,
    async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) } }
}

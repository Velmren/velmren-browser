import { createServer } from 'node:http'

// Page-owned instrumentation records only fixed event names and synthetic IDs.
// Dismissal handlers deliberately retain normal blur and outside-pointer behavior.
const html = `<!doctype html><meta charset="utf-8"><title>VBR014 parallel menu fixture</title>
<style>body{font:16px sans-serif;padding:24px}button,input{padding:10px;margin:6px}#menu{border:1px solid;padding:12px;background:white}#menu[hidden]{display:none}</style>
<h1>Parallel menu fixture</h1><div id="widget">
<button id="open" aria-expanded="false" aria-controls="menu">Country menu</button>
<div id="menu" role="listbox" hidden><button id="belgium" role="option">Belgium</button><button id="france" role="option">France</button></div>
</div><label>Peer text <input id="text" type="text"></label><button id="outside">Outside action</button><button id="storage">Write shared state</button><output id="chosen">No country</output>
<script>
const kind=new URL(location.href).searchParams.get('kind')||'outside';
const menu=document.getElementById('menu'),open=document.getElementById('open'),widget=document.getElementById('widget');
const events=[];let sequence=0,closedReason=null;
const ids=new Set(['widget','menu','open','belgium','france','text','outside','storage','chosen']);
const id=node=>node===window?'window':node===document?'document':ids.has(node?.id)?node.id:node?.tagName?.toLowerCase()||null;
const isOpen=()=>kind==='native'?menu.matches(':popover-open'):!menu.hidden;
function publish(){document.documentElement.dataset.fixtureState=JSON.stringify({kind,open:isOpen(),chosen:document.getElementById('chosen').textContent,closedReason,focused:document.hasFocus(),active:id(document.activeElement),visibility:document.visibilityState});document.documentElement.dataset.fixtureEvents=JSON.stringify(events);}
function record(event,source='document'){events.push({seq:++sequence,type:event.type,source,target:id(event.target),related:id(event.relatedTarget),trusted:event.isTrusted,focused:document.hasFocus(),active:id(document.activeElement),visibility:document.visibilityState,open:isOpen(),newState:event.newState||undefined});publish();}
function close(reason){if(isOpen()){closedReason=reason;if(kind==='native')menu.hidePopover();else menu.hidden=true;open.setAttribute('aria-expanded','false');publish();}}
for(const type of ['pointerdown','pointerup','click','focusin','focusout','input','change','visibilitychange','beforetoggle','toggle'])document.addEventListener(type,event=>record(event),true);
for(const type of ['focus','blur'])window.addEventListener(type,event=>{record(event,'window');if(type==='blur'&&kind==='window-blur')close('window-blur');});
document.addEventListener('pointerdown',event=>{if(!widget.contains(event.target)&&kind!=='native')close('outside-pointer');},true);
widget.addEventListener('focusout',event=>{if(kind==='focusout'&&!widget.contains(event.relatedTarget))close('focusout');});
window.addEventListener('storage',event=>{record(event,'window');if(kind==='shared-storage'&&event.key==='vbr014-state')close('shared-storage');});
if(kind==='native'){menu.hidden=false;menu.setAttribute('popover','auto');open.setAttribute('popovertarget','menu');}
else open.onclick=()=>{closedReason=null;menu.hidden=!menu.hidden;open.setAttribute('aria-expanded',String(!menu.hidden));publish();};
for(const name of ['belgium','france'])document.getElementById(name).onclick=()=>{document.getElementById('chosen').textContent=name;close('selected');};
document.getElementById('storage').onclick=()=>localStorage.setItem('vbr014-state',String(Date.now()));
publish();
</script>`

export async function parallelFixture() {
  const servers = []
  const origins = []
  for (let index = 0; index < 2; index++) {
    const server = createServer((request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
      response.end(html)
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    servers.push(server)
    origins.push(`http://127.0.0.1:${server.address().port}`)
  }
  return {
    origins,
    async close() {
      await Promise.all(servers.map(server => new Promise(resolve => {
        server.close(resolve)
        server.closeAllConnections()
      })))
    }
  }
}

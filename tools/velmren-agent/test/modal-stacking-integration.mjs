// node test/modal-stacking-integration.mjs BROWSER_EXE NEW_OUTPUT_DIR [--agent-directory=DIR]
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile, access } from 'node:fs/promises'
import { createServer } from 'node:http'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const argv = process.argv.slice(2), positional = argv.filter(value => !value.startsWith('--'))
if (positional.length !== 2 || argv.some(value => value.startsWith('--') && !value.startsWith('--agent-directory='))) throw new Error('Expected browser, fresh output directory and optional agent directory')
const repoAgent = fileURLToPath(new URL('../', import.meta.url))
const agent = path.resolve(argv.find(value => value.startsWith('--agent-directory='))?.slice(18) ?? repoAgent)
const executable = path.resolve(positional[0]), output = path.resolve(positional[1]), stateDir = path.join(output, 'state')
const { startBroker } = await import(pathToFileURL(path.join(agent, 'broker.mjs')))
const { createClient } = await import(pathToFileURL(path.join(agent, 'client.mjs')))
const { stagePrivateInput } = await import(pathToFileURL(path.join(agent, 'private-input.mjs')))
await mkdir(path.dirname(output), { recursive: true }); await mkdir(output)
const sourceFiles = ['form-controls.mjs', 'page.mjs', 'document-observation.mjs', 'sensitive-renderer.mjs']
const hash = async name => createHash('sha256').update(await readFile(name)).digest('hex')
const report = { kind: 'Native modal interaction scope acceptance', agent, executable, output, cases: [], cleanup: {} }
report.hashes = Object.fromEntries(await Promise.all(sourceFiles.map(async name => [name, await hash(`${agent}/${name}`)])))
report.fixtureSha256 = await hash(fileURLToPath(import.meta.url))

const cases = [
  { name: 'single-aria-modal', allow: true, actions: ['fill', 'cancel', 'close', 'private'] },
  { name: 'sibling-top-last', allow: true, actions: ['fill', 'cancel', 'close', 'private'] },
  { name: 'sibling-top-first-higher-z', allow: true, actions: ['fill', 'cancel', 'private'] },
  { name: 'pointer-none-fullscreen-siblings', allow: true, actions: ['fill', 'cancel', 'close', 'private'] },
  { name: 'pointer-none-stacking-context-inversion', allow: true, actions: ['fill', 'private'] },
  { name: 'background-inert', allow: true, actions: ['fill', 'private'] },
  { name: 'background-ancestor-inert', allow: true, actions: ['fill'] },
  { name: 'background-aria-hidden', allow: true, actions: ['fill', 'cancel', 'private'] },
  { name: 'background-ancestor-aria-hidden', allow: true, actions: ['fill'] },
  { name: 'background-css-hidden', allow: true, actions: ['fill'] },
  { name: 'nested-top-modal', allow: true, actions: ['fill'] },
  { name: 'native-top-first-show-last', allow: true, actions: ['fill', 'cancel', 'private'] },
  { name: 'native-over-aria-high-z', allow: true, actions: ['fill', 'private'] },
  { name: 'native-show-is-not-modal', allow: true, actions: ['fill'] },
  { name: 'native-open-attribute-is-not-modal', allow: true, actions: ['fill'] },
  { name: 'native-escapes-inert-ancestor', allow: true, actions: ['fill', 'private'] },
  { name: 'native-explicitly-inert', allow: false, error: 'ELEMENT_DISABLED', actions: ['fill', 'private'] },
  { name: 'native-nested-native', allow: true, actions: ['fill', 'private'] },
  { name: 'native-nested-aria-foreground', allow: true, actions: ['fill', 'private'] },
  { name: 'native-nested-aria-background', target: 'background', allow: false, actions: ['fill', 'private'] },
  { name: 'true-background-exposed', allow: false, actions: ['fill', 'private'] },
  { name: 'true-background-native', allow: false, actions: ['fill', 'private'] },
  { name: 'portal-owned-single', allow: true, actions: ['option'] },
  { name: 'portal-owned-top-sibling', allow: true, actions: ['option'] },
  { name: 'portal-aria-owns', allow: true, actions: ['option'] },
  { name: 'portal-unowned', allow: false, actions: ['option'] },
  { name: 'portal-owned-by-background', allow: false, actions: ['option'] },
  { name: 'portal-collapsed-owner', allow: false, actions: ['option'] },
  { name: 'focus-opens-new-modal', allow: false, obstruction: 'ambiguous-modal-scope', actions: ['fill'] },
  { name: 'disjoint-aria-scopes', allow: false, obstruction: 'ambiguous-modal-scope', actions: ['fill', 'private'] },
  { name: 'physical-overlay-target', allow: false, obstruction: 'hit-test', actions: ['fill', 'private'] },
  { name: 'private-stage-opens-modal', allow: false, reads: 1, obstruction: 'ambiguous-modal-scope', actions: ['private'] },
  { name: 'private-stage-reorders-modal', allow: false, reads: 1, actions: ['private'] },
  { name: 'interleaved-shadow-partial', allow: true, actions: ['fill', 'private'] },
  { name: 'interleaved-plain-partial', allow: true, actions: ['fill', 'private'] },
  { name: 'interleaved-shadow-cover', target: 'background', allow: false, actions: ['fill', 'private'] },
  { name: 'interleaved-plain-cover', target: 'background', allow: false, actions: ['fill', 'private'] },
  { name: 'interleaved-shadow-owned-overlay', target: 'background', allow: false, obstruction: 'ambiguous-modal-scope', actions: ['fill', 'private'] },
]

function interleavedHtml(name) {
  return `<!doctype html><meta charset="utf-8"><title>Owned interleaved modal fixture</title><script>
  const kind=${JSON.stringify(name)},state=window.fixtureState={events:[],clicks:[],focuses:[],privateCanary:'VBR031_SYNTHETIC_PRIVATE'};
  const host=document.createElement('div');host.id='host';document.documentElement.append(host);
  const root=kind.includes('shadow')?host.attachShadow({mode:'open'}):host;
  root.innerHTML='<style>#lower{position:fixed;inset:0;pointer-events:none;z-index:1}#lower-surface{position:absolute;left:30px;top:20px;width:900px;height:650px;pointer-events:auto;background:#ccc;padding:20px;box-sizing:border-box}#background{height:30px;width:200px;margin:20px}</style><div id="lower" role="dialog" aria-modal="true"><div id="lower-surface"><input id="background" aria-label="Background field" value="original"></div></div>';
  const upper=document.createElement('div');upper.id='upper';upper.setAttribute('role','dialog');upper.setAttribute('aria-modal','true');upper.style.cssText='position:fixed;left:300px;top:150px;width:400px;height:350px;background:white;z-index:50';upper.innerHTML='<input id="username" aria-label="Username" value="original" style="position:absolute;left:200px;top:230px;width:150px;height:30px">';document.documentElement.append(upper);
  const overlay=document.createElement('div');overlay.id='unrelated-overlay';overlay.style.cssText='position:fixed;left:300px;top:150px;width:400px;height:'+(kind.includes('partial')?'120':'350')+'px;background:pink;z-index:100';root.append(overlay);
  if(kind.endsWith('owned-overlay')){host.style.cssText='position:absolute;inset:0';host.setAttribute('role','dialog');host.setAttribute('aria-modal','true');root.querySelector('#lower').removeAttribute('role');root.querySelector('#lower').removeAttribute('aria-modal')}
  for(const input of [root.querySelector('#background'),document.getElementById('username')]){
    for(const type of ['input','change'])input.addEventListener(type,e=>state.events.push({type,id:input.id,trusted:e.isTrusted}));
    input.addEventListener('click',e=>state.clicks.push({id:input.id,trusted:e.isTrusted}));
    input.addEventListener('focus',()=>state.focuses.push(input.id));
  }
  </script>`
}

function html(name) {
  if(name.startsWith('interleaved-'))return interleavedHtml(name)
  return `<!doctype html><meta charset="utf-8"><title>Owned VBR031 ${name}</title>
  <style>
  body{font:16px sans-serif;margin:0;background:#ddd} .panel{position:fixed;box-sizing:border-box;padding:20px;background:white;border:2px solid #555;box-shadow:0 2px 15px #4448}
  #lower{left:30px;top:25px;width:700px;height:510px;z-index:10;background:#ddd}
  #upper{left:240px;top:140px;width:420px;height:300px;z-index:100;background:#f9f9ff}
  input{width:260px;height:32px;display:block;margin:12px 0}button{padding:10px;margin:8px}#outside{position:fixed;left:35px;top:590px}
  #choices{position:fixed;left:330px;top:465px;width:220px;height:70px;z-index:200;background:#fff;padding:10px;border:2px solid #55f}
  dialog.panel{margin:0}dialog::backdrop{background:#0004}#newer{position:fixed;left:20px;top:530px;width:500px;height:100px;z-index:999;background:pink}
  </style><div id="outside"><input id="outside-field" aria-label="Outside field"></div>
  <script>
  const kind=${JSON.stringify(name)};
  const state=window.fixtureState={events:[],clicks:[],focuses:[],privateCanary:'VBR031_SYNTHETIC_PRIVATE'};
  const markup='<h2>Username editor</h2><input id="username" aria-label="Username" value="original"><button id="cancel" aria-label="Cancel">Cancel</button><button id="close" aria-label="Close">Close</button><button id="controller" aria-label="Choose option" aria-expanded="true" aria-controls="choices">Choose option</button>';
  const lower=document.createElement(kind.startsWith('native-')||kind==='true-background-native'?'dialog':'div');lower.id='lower';lower.className='panel';lower.setAttribute('role','dialog');lower.setAttribute('aria-modal','true');lower.innerHTML='<h2>Account settings</h2><input id="background" aria-label="Background field" value="original"><button id="lower-controller" aria-expanded="true" aria-controls="choices">Background owner</button>';
  const upper=document.createElement(kind==='native-top-first-show-last'||kind==='native-over-aria-high-z'||kind==='true-background-native'||kind==='native-escapes-inert-ancestor'||kind==='native-explicitly-inert'||kind==='native-nested-native'?'dialog':'div');upper.id='upper';upper.className='panel';upper.setAttribute('role','dialog');upper.setAttribute('aria-modal','true');upper.innerHTML=markup;
  if(kind==='sibling-top-first-higher-z'||kind==='native-top-first-show-last'){document.body.append(upper,lower)}else if(kind==='single-aria-modal'||kind.startsWith('portal-')&&kind!=='portal-owned-top-sibling'&&kind!=='portal-owned-by-background'||kind==='focus-opens-new-modal'||kind==='physical-overlay-target'||kind==='private-stage-opens-modal'){document.body.append(upper)}else{document.body.append(lower,upper)}
  if(kind==='nested-top-modal')lower.append(upper);
  if(kind==='background-inert')lower.inert=true;
  if(kind==='background-aria-hidden')lower.setAttribute('aria-hidden','true');
  if(kind==='background-ancestor-inert'||kind==='background-ancestor-aria-hidden'){const wrap=document.createElement('div');document.body.append(wrap);wrap.append(lower);if(kind.endsWith('-inert'))wrap.inert=true;else wrap.setAttribute('aria-hidden','true')}
  if(kind==='background-css-hidden')lower.style.display='none';
  if(kind.startsWith('pointer-none-')){for(const panel of [lower,upper]){const content=document.createElement('div');content.id=panel.id+'-content';content.innerHTML=panel.innerHTML;panel.replaceChildren(content);panel.style.cssText='position:fixed;inset:0;width:100vw;height:100vh;pointer-events:none;background:none;border:0;box-shadow:none;padding:0;z-index:auto';content.style.cssText=panel===lower?'position:absolute;left:40px;top:40px;width:1160px;height:670px;pointer-events:auto;background:#ddd;padding:20px;box-sizing:border-box':'position:absolute;left:400px;top:220px;width:480px;height:360px;pointer-events:auto;background:white;padding:20px;box-sizing:border-box';const wrapper=document.createElement('div');wrapper.id=panel.id+'-wrapper';wrapper.style.cssText='position:absolute;inset:0;z-index:1002;pointer-events:none';document.body.append(wrapper);wrapper.append(panel)}if(kind==='pointer-none-stacking-context-inversion'){document.querySelector('#upper-wrapper').style.zIndex='20';document.querySelector('#lower-wrapper').style.zIndex='10';lower.style.zIndex='10000';upper.style.zIndex='1';document.body.insertBefore(document.querySelector('#upper-wrapper'),document.querySelector('#lower-wrapper'))}}
  if(kind==='native-top-first-show-last'){lower.removeAttribute('aria-modal');upper.removeAttribute('aria-modal');lower.showModal();upper.showModal()}
  if(kind==='native-over-aria-high-z'){const other=document.createElement('div');other.id='aria-high';other.className='panel';other.setAttribute('role','dialog');other.setAttribute('aria-modal','true');other.style.cssText='left:30px;top:25px;width:700px;height:510px;z-index:2147483647';other.innerHTML='<h2>Old high-z modal</h2>';lower.remove();document.body.append(other);upper.removeAttribute('aria-modal');upper.showModal()}
  if(kind==='native-show-is-not-modal'||kind==='native-open-attribute-is-not-modal'){lower.removeAttribute('aria-modal');if(kind==='native-show-is-not-modal')lower.show();else lower.open=true}
  if(kind==='native-escapes-inert-ancestor'||kind==='native-explicitly-inert'){lower.remove();const wrap=document.createElement('div');wrap.id='inert-wrapper';wrap.inert=true;document.body.append(wrap);wrap.append(upper);upper.removeAttribute('aria-modal');upper.showModal();if(kind==='native-explicitly-inert')upper.inert=true}
  if(kind.startsWith('native-nested-')){lower.removeAttribute('aria-modal');lower.append(upper);lower.showModal();if(kind==='native-nested-native'){upper.removeAttribute('aria-modal');upper.showModal()}}
  if(kind==='true-background-native'){lower.removeAttribute('aria-modal');upper.removeAttribute('aria-modal');lower.showModal();upper.showModal()}
  if(kind.startsWith('portal-')){const list=document.createElement('div');list.id='choices';list.setAttribute('role','listbox');list.innerHTML='<button id="option" role="option">Owned option</button>';document.body.append(list);if(kind==='portal-unowned')document.querySelector('#controller').removeAttribute('aria-controls');if(kind==='portal-collapsed-owner')document.querySelector('#controller').setAttribute('aria-expanded','false');if(kind==='portal-owned-by-background')document.querySelector('#controller').removeAttribute('aria-controls');if(kind==='portal-owned-top-sibling')document.querySelector('#lower-controller').removeAttribute('aria-controls');if(kind==='portal-aria-owns'){const c=document.querySelector('#controller');c.removeAttribute('aria-controls');c.setAttribute('aria-owns','choices');c.setAttribute('aria-expanded','false')}}
  if(kind==='disjoint-aria-scopes')upper.style.left='800px';
  if(kind==='physical-overlay-target'){const cover=document.createElement('div'),box=document.querySelector('#username').getBoundingClientRect();cover.id='cover';cover.style.cssText='position:fixed;z-index:1000;background:pink;left:'+box.x+'px;top:'+box.y+'px;width:'+box.width+'px;height:'+box.height+'px';document.body.append(cover)}
  if(kind==='focus-opens-new-modal')document.querySelector('#username').addEventListener('focus',()=>{if(document.querySelector('#newer'))return;const modal=document.createElement('div');modal.id='newer';modal.setAttribute('role','dialog');modal.setAttribute('aria-modal','true');modal.innerHTML='<h2>New foreground modal</h2><button>New action</button>';document.body.append(modal)},{once:true});
  for(const type of ['input','change'])document.addEventListener(type,e=>state.events.push({type,id:e.target.id,trusted:e.isTrusted}),true);
  document.addEventListener('click',e=>state.clicks.push({id:e.target.id,trusted:e.isTrusted}),true);
  document.addEventListener('focus',e=>state.focuses.push(e.target.id),true);
  </script>`
}

const server=createServer((req,res)=>{const name=new URL(req.url,'http://owned.invalid').pathname.slice(1);res.writeHead(200,{'content-type':'text/html'});res.end(html(name))})
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
const origin=`http://127.0.0.1:${server.address().port}`
let app,client,localClient,transport,taskId
async function call(method,args={}) {
  const envelope=await client.callTool({name:`velmren_${method}`,arguments:args},undefined,{timeout:40000})
  const data=JSON.parse(envelope.content.find(block=>block.type==='text').text)
  return {isError:!!envelope.isError,...data}
}
function safeResult(result) {
  return {isError:result.isError,code:result.code,diagnostic:result.diagnostic,completed:result.completed,actionResult:result.actionResult}
}
async function state(page,id) {
  return page.evaluate(id=>{
    const target=documentRoots().map(root=>root.getElementById?.(id)).find(Boolean),box=target.getBoundingClientRect(),x=box.x+box.width/2,y=box.y+box.height/2;
    const chain=element=>{const out=[];for(let node=element;node;node=composedParent(node))out.push(node.id||node.tagName);return out};
    const modals=documentRoots().flatMap(root=>[...root.querySelectorAll('dialog,[role="dialog"],[role="alertdialog"]')]).map(node=>({id:node.id,nativeModal:node.matches(':modal'),open:node.open??null,ariaModal:node.getAttribute('aria-modal'),ariaHidden:node.getAttribute('aria-hidden'),inert:node.inert,ancestors:chain(node),style:{display:getComputedStyle(node).display,visibility:getComputedStyle(node).visibility,zIndex:getComputedStyle(node).zIndex},contains:composedContains(node,target),rect:node.getBoundingClientRect().toJSON()}));
    let point,error;try{point=controlActionPoint(target,'fill')}catch(e){error=e.message}
    let blockedByModal,modalError;try{blockedByModal=controlBlockedByModal(target)}catch(e){modalError=e.message}
    return {target:id,blockedByModal,modalError,capabilities:elementCapabilities(target),targetRect:box.toJSON(),centerHits:document.elementsFromPoint(x,y).map(node=>node.id||node.tagName),actionPoint:point,actionPointError:error,modals,activeElement:document.activeElement?.id};
  },id)
}
async function outcome(page,id) {
  const result=await page.send('Runtime.evaluate',{expression:`(()=>{const find=root=>root.getElementById?.(${JSON.stringify(id)})||[...root.querySelectorAll('*')].map(node=>node.shadowRoot?find(node.shadowRoot):null).find(Boolean);const s=window.fixtureState,e=find(document);return {valueUnchanged:e.value==='original',publicValueMatched:e.value==='fixture-public',privateValueMatched:e.value===s.privateCanary,events:s.events,clicks:s.clicks,focuses:s.focuses,newModal:!!document.getElementById('newer'),activeElement:document.activeElement?.id}})()`,returnByValue:true})
  assert(!result.exceptionDetails);return result.result.value
}
try {
  app=await startBroker({executable,stateDir,policy:{profileMode:'isolated',allowedOrigins:[origin]},browserArgs:['--headless=new','--window-size=1280,800']})
  report.browserPid=app.broker.browser.process.pid;report.browser=app.broker.browser.version;report.fixtureOrigin=origin
  const registration=await app.broker.rpc('admin','client_register',{label:'VBR031 owned modal diagnosis'})
  const connection={endpoint:app.descriptor.endpoint,token:registration.token,client:registration.clientId}
  localClient=createClient(connection)
  transport=new StdioClientTransport({command:process.execPath,args:[`${repoAgent}/test/multi-agent-mcp-entry.mjs`,agent],env:{VELMREN_ACCEPTANCE_CONNECTION:JSON.stringify(connection)},stderr:'pipe'})
  transport.stderr?.resume();client=new Client({name:'vbr031-modal-diagnosis',version:'1'});await client.connect(transport)
  report.toolCount=(await client.listTools()).tools.length
  assert.equal(report.toolCount,24)
  for(const test of cases)for(const action of test.actions) {
    const row={name:test.name,action,expectedAllow:test.allow};report.cases.push(row)
    try {
      const task=await call('create_task',{url:`${origin}/${test.name}`,sensitive:false,label:`Owned ${test.name} ${action}`})
      assert(!task.isError,JSON.stringify(safeResult(task)));taskId=task.taskId
      const page=app.broker.tasks.get(taskId).page
      const id=test.target??(test.name.startsWith('true-background')?'background':action==='option'?'option':action==='cancel'?'cancel':action==='close'?'close':'username')
      const label={background:'Background field',option:'Owned option',cancel:'Cancel',close:'Close',username:'Username'}[id]
      const observed=await call('observe',{taskId}),obs=observed.observation??observed
      const element=obs.elements.find(e=>e.name===label)
      assert(element,`${test.name}: missing ${label}`)
      row.before=await state(page,id)
      if(test.name.startsWith('interleaved-')){
        row.nativePaintWitness=await page.evaluate(()=>documentRoots().map(root=>root.elementsFromPoint(500,220).map(node=>node.id||node.tagName)))
        if(test.name.includes('shadow')){
          const stack=row.nativePaintWitness[0],upper=stack.indexOf('upper')
          assert(upper>stack.indexOf('host')&&upper<stack.lastIndexOf('host'),'Fixture must retain native cross-root interleaving')
        }
        assert.equal(row.before.actionPointError,undefined,'Fixture target must remain physically exposed')
      }
      if(['sibling-top-last','pointer-none-fullscreen-siblings'].includes(test.name)&&action==='fill'){
        const png=await page.send('Page.captureScreenshot',{format:'png'});await writeFile(path.join(output,`${test.name}.png`),Buffer.from(png.data,'base64'))
      }
      const binding={taskId,pageId:obs.pageId,frameId:obs.frameId,observationId:obs.observationId}
      if(action==='private') {
        let reads=0
        try {
          const staged=await stagePrivateInput({...binding,ref:element.ref,origin,topOrigin:origin,client:localClient,readSecret:async()=>{
            reads++
            if(test.name==='private-stage-opens-modal')await page.send('Runtime.evaluate',{expression:`(()=>{const modal=document.createElement('div');modal.id='newer';modal.setAttribute('role','dialog');modal.setAttribute('aria-modal','true');modal.innerHTML='<button>New modal</button>';document.body.append(modal)})()`})
            if(test.name==='private-stage-reorders-modal')await page.send('Runtime.evaluate',{expression:`document.querySelector('#lower').style.zIndex='1000'`})
            return 'VBR031_SYNTHETIC_PRIVATE'
          }})
          row.privatePrepared=true
          const result=await call('act',{...binding,actions:[{type:'fill',ref:element.ref,secretRef:staged.secretRef}]})
          row.result=safeResult(result)
        }catch(error){row.privatePrepared=false;row.result={isError:true,code:error.code,diagnostic:error.diagnostic}}
        row.secretReaderCalls=reads
      }else{
        row.result=safeResult(await call('act',{...binding,actions:[action==='fill'?{type:'fill',ref:element.ref,value:'fixture-public'}:{type:'click',ref:element.ref}]}))
      }
      row.after=await outcome(page,id)
      row.allowed=!row.result.isError
      row.meetsIntendedBehavior=row.allowed===test.allow
      if(!test.allow){assert(row.result.isError);assert.equal(row.after.events.length,0);assert.equal(row.after.clicks.length,0);if(action==='private')assert.equal(row.secretReaderCalls,test.reads??0);assert.equal(row.result.code,test.error??'ELEMENT_OBSCURED');if(row.result.actionResult)assert.equal(row.result.actionResult.delivery,'not_delivered');if(row.result.code==='ELEMENT_OBSCURED')assert.equal(row.result.diagnostic?.obstruction,test.obstruction??'modal-scope');if(test.name.startsWith('interleaved-'))assert(row.after.valueUnchanged)}
      if(row.allowed&&action==='fill')assert(row.after.publicValueMatched)
      if(row.allowed&&action==='private')assert(row.after.privateValueMatched)
      if(row.allowed&&['cancel','close','option'].includes(action))assert(row.after.clicks.some(e=>e.id===id&&e.trusted))
      console.log(`${row.meetsIntendedBehavior?'PASS':'FAIL'} ${test.name} ${action}: ${row.result.code??'allowed'} hit=${row.before.centerHits[0]} modalBlocked=${row.before.blockedByModal}`)
    }catch(error){row.harnessFailure={message:error.message,stack:error.stack};report.harnessFailed=true;console.log(`HARNESS ${test.name} ${action} ${error.message}`)}
    finally{if(taskId){const cancellation=await call('cancel',{taskId});row.cancelled=!cancellation.isError;assert(row.cancelled);taskId=undefined}}
    await writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2))
  }
}catch(error){report.fatal={message:error.message,stack:error.stack};process.exitCode=1}
finally{
  if(taskId)await call('cancel',{taskId}).catch(()=>{})
  if(client){await client.close();report.cleanup.clientClosed=true}
  if(app){await app.close();report.cleanup.browserClosed=app.broker.browser.closed===true;report.cleanup.browserExitCode=app.broker.browser.process.exitCode;report.cleanup.retainedTerminalTaskRecords=[...app.broker.tasks.values()].filter(t=>['completed','cancelled'].includes(t.state)).length;report.cleanup.activeTasksLeft=[...app.broker.tasks.values()].filter(t=>!['completed','cancelled'].includes(t.state)).length;report.cleanup.brokerListening=app.server.listening}
  await new Promise(resolve=>{server.close(resolve);server.closeAllConnections()});report.cleanup.fixtureListening=server.listening
  report.cleanup.connectionRemoved=await access(path.join(stateDir,'connection.json')).then(()=>false,()=>true)
  report.cleanup.lockRemoved=await access(path.join(stateDir,'broker.lock')).then(()=>false,()=>true)
  report.counts={total:report.cases.length,intendedPass:report.cases.filter(r=>r.meetsIntendedBehavior).length,reproducedFalseRejections:report.cases.filter(r=>r.expectedAllow&&!r.allowed&&!r.harnessFailure).length,harnessFailures:report.cases.filter(r=>r.harnessFailure).length}
  report.passed=!report.fatal&&!report.harnessFailed&&report.cases.length===cases.reduce((sum,test)=>sum+test.actions.length,0)&&report.cases.every(row=>row.meetsIntendedBehavior)
  await writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({output,counts:report.counts,cleanup:report.cleanup,fatal:report.fatal}))
  if(report.harnessFailed)process.exitCode=1
  if(report.cases.some(row=>!row.meetsIntendedBehavior))process.exitCode=1
}

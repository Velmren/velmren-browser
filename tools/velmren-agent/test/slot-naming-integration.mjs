// node test/slot-naming-integration.mjs BROWSER_EXE NEW_OUTPUT_DIR [--agent-directory=DIR]
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const args=process.argv.slice(2),positions=args.filter(arg=>!arg.startsWith('--'));
if(positions.length!==2||args.some(arg=>arg.startsWith('--')&&!arg.startsWith('--agent-directory=')))throw Error('Expected browser executable, fresh output directory and optional agent directory');
const [executable,outputArgument]=positions,output=path.resolve(outputArgument);
const directory=path.resolve(args.find(arg=>arg.startsWith('--agent-directory='))?.slice(18)??fileURLToPath(new URL('../',import.meta.url)));
const {startBroker}=await import(pathToFileURL(path.join(directory,'broker.mjs')));
await mkdir(path.dirname(output),{recursive:true});await mkdir(output);
const html=`<!doctype html><title>Owned name fixture</title><style>body{font:18px sans-serif}x-slot,x-one,x-many,x-private,x-manual{display:block;margin:20px}</style>
<span id="remember">Remember session</span><span id="alternative">Keep session</span>
<x-slot id="slotted">Jatka</x-slot><x-one id="single" aria-labelledby="remember"></x-one>
<x-many id="multiple" aria-label="Unrelated component name"></x-many>
<x-private id="private"><input type="password" value="SecretSlotCanary123"><span aria-hidden="true">HiddenNameCanary</span>Public action</x-private>
<x-manual id="manual"><span>Manual first</span><span>Manual second</span></x-manual>
<script>
for(const name of ['x-slot','x-one','x-many','x-private','x-manual'])customElements.define(name,class extends HTMLElement{connectedCallback(){const root=this.attachShadow({mode:'open',...(name==='x-manual'?{slotAssignment:'manual'}:{})});root.innerHTML='<style>button{min-width:100px;min-height:36px}</style>'+ (name==='x-many'?'<button type="button"></button><button type="button"></button>':'<button type="button"><slot></slot></button>');if(name==='x-manual')root.querySelector('slot').assign(this.firstElementChild);}});
</script>`;
const server=createServer((request,response)=>{response.writeHead(200,{'content-type':'text/html'});response.end(html);});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
let app,taskId,page;const checks=[];
const observe=async query=>{const r=await app.broker.rpc('scripts','task_observe',{taskId,query,textLimit:0});return r.observation??r;};
const unique=async name=>{const o=await observe(name),m=o.elements.filter(e=>e.tag==='button'&&e.name===name);assert.equal(m.length,1,name);return {o,e:m[0]};};
async function mutate(expression){const r=await page.send('Runtime.evaluate',{expression,returnByValue:true});assert(!r.exceptionDetails);}
async function stale(target,expression,label){
 await mutate(expression);
 await assert.rejects(()=>app.broker.rpc('scripts','task_act',{taskId,pageId:target.o.pageId,frameId:target.o.frameId,observationId:target.o.observationId,actions:[{type:'click',ref:target.e.ref}]}),e=>e.code==='STALE_OBSERVATION');
 checks.push(label);
}
const report={kind:'Native composed-slot and delegated-host naming fixture',output,agentDirectory:directory,checks};
try{
 app=await startBroker({executable:path.resolve(executable),stateDir:path.join(output,'state'),policy:{allowedOrigins:[`http://127.0.0.1:${server.address().port}`],profileMode:'isolated'}});
 const task=await app.broker.rpc('scripts','task_create',{url:`http://127.0.0.1:${server.address().port}`,sensitive:false});taskId=task.taskId;page=app.broker.tasks.get(taskId).page;
 const all=await observe('');
 assert.equal(all.elements.filter(e=>e.tag==='button'&&e.name==='').length,2);
 assert(!all.elements.some(e=>/SecretSlotCanary|HiddenNameCanary|Unrelated component name/.test(e.name)));
 assert.equal((await observe('SecretSlotCanary123')).elements.length,0);
 checks.push('multi-control host label not inherited','password/hidden canaries absent from names and search');
 await unique('Public action');checks.push('slotted public text excludes password and aria-hidden descendants');
 await stale(await unique('Jatka'),`document.querySelector('#slotted').firstChild.textContent='Proceed'`,'slotted text mutation invalidates reference');
 await unique('Proceed');checks.push('fresh query resolves updated slot name');
 await stale(await unique('Remember session'),`document.querySelector('#remember').textContent='Remember device'`,'external host label mutation invalidates reference');
 await stale(await unique('Remember device'),`document.querySelector('#single').setAttribute('aria-labelledby','alternative')`,'host aria-labelledby reassignment invalidates reference');
 await unique('Keep session');checks.push('single internal control resolves fresh host label');
 await stale(await unique('Manual first'),`document.querySelector('#manual').shadowRoot.querySelector('slot').assign(document.querySelector('#manual').lastElementChild)`,'manual slot reassignment invalidates reference');
 await unique('Manual second');checks.push('fresh manual slot assignment name resolved');
 await mutate(`{
   const region=document.createElement('div');region.innerHTML='<label>User<span>name</span><input></label><span id="split">Pass<span>word</span></span><input aria-labelledby="split"><label>First<br>Second<input></label>';
   document.body.append(region);
 }`);
 for(const name of ['Username','Password','First Second'])assert.equal((await observe(name)).elements.filter(e=>e.tag==='input'&&e.name===name).length,1,name);
 checks.push('inline label fragments preserve words and line breaks separate words');
 await mutate(`{
   const role=document.createElement('div');role.id='role-host';role.setAttribute('aria-label','Ambiguous role component');role.attachShadow({mode:'open'}).innerHTML='<button></button><div role="menuitem">Other action</div>';document.body.append(role);
   const slotted=document.createElement('div');slotted.id='sibling-host';slotted.setAttribute('aria-label','Ambiguous slotted component');slotted.innerHTML='<button>Other slotted action</button>';slotted.attachShadow({mode:'open'}).innerHTML='<button></button><slot></slot>';document.body.append(slotted);
 }`);
 for(const name of ['Ambiguous role component','Ambiguous slotted component'])assert.equal((await observe(name)).elements.filter(e=>e.tag==='button'&&e.name===name).length,0,name);
 checks.push('host labels reject role-based and slotted sibling actions');
 report.passed=true;
}catch(error){report.failure={name:error.name,code:error.code??null,message:error.message?.slice(0,500)};process.exitCode=1;}
finally{
 if(taskId)try{await app.broker.rpc('scripts','task_cancel',{taskId});report.taskCancelled=true;}catch(error){report.cancelCode=error.code;}
 if(app){await app.close();report.closed=app.broker.browser.closed===true;}
 await new Promise(r=>server.close(r));report.cleanup={taskCancelled:report.taskCancelled===true,browserClosed:report.closed===true,fixtureClosed:!server.listening};
 report.passed=report.passed===true&&Object.values(report.cleanup).every(Boolean);
 await writeFile(`${output}/report.json`,JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}

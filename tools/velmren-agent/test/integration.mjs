import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { fixtureServer } from './fixture.mjs'
import { probeTransportPolicy } from './policy-probe.mjs'

const [executable,output]=process.argv.slice(2)
const agentDirectory=process.argv.find(arg=>arg.startsWith('--agent-directory='))?.slice('--agent-directory='.length)??fileURLToPath(new URL('../',import.meta.url))
const {startBroker}=await import(pathToFileURL(path.join(path.resolve(agentDirectory),'broker.mjs')))
const {createClient}=await import(pathToFileURL(path.join(path.resolve(agentDirectory),'client.mjs')))
const backgroundOnly=process.argv.includes('--background-only')
const lifecycleSoak=process.argv.includes('--lifecycle-soak')
const headless=process.argv.includes('--headless')
const soakSeconds=Number(process.argv.find(arg=>arg.startsWith('--soak-seconds='))?.split('=')[1]??90)
if(!Number.isFinite(soakSeconds)||soakSeconds<90||soakSeconds>900)throw new Error('Lifecycle soak must be 90–900 seconds')
if(!executable||!output)throw new Error('integration.mjs BROWSER_EXE NEW_OUTPUT_DIR')
await mkdir(output,{recursive:true})
const fixture=await fixtureServer()
const checks=[]
let app
try {
  app=await startBroker({executable,stateDir:path.join(output,'state'),browserArgs:headless?['--headless=new']:[]})
  app.broker.onEvent=event=>{void writeFile(path.join(output,'last-event.json'),JSON.stringify(event))}
  const connection=owner=>({endpoint:app.descriptor.endpoint,token:app.descriptor.clients[owner].token,client:owner})
  const codex=createClient(connection('codex')),claude=createClient(connection('claude')),scripts=createClient(connection('scripts'))
  const admin=async(method,args={})=>{
    const response=await fetch(app.descriptor.endpoint+'/rpc',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+app.descriptor.adminToken},body:JSON.stringify({method,args})})
    const result=await response.json();if(!result.ok)throw new Error(result.error);return result.result
  }
  const pass=name=>{checks.push({name,passed:true});console.log('PASS '+name)}
  const tasks=await Promise.all([codex.call('task_create',{url:fixture.url,label:'Codex hidden task'}),claude.call('task_create',{url:fixture.url,label:'Claude hidden task'}),scripts.call('task_create',{url:fixture.url,label:'Script hidden task'})])
  assert.equal(new Set(tasks.map(t=>t.taskId)).size,3);pass('three clients create independent hidden tasks over browser pipes')
  assert.equal((await codex.call('task_list')).tasks.length,1)
  await assert.rejects(claude.call('task_observe',{taskId:tasks[0].taskId}),/Task not found/);pass('cross-client ownership enforced over HTTP')
  const clients=[codex,claude,scripts]
  await Promise.all(tasks.map(async(task,i)=>{
    const obs=await clients[i].call('task_observe',{taskId:task.taskId})
    const ref=name=>obs.elements.find(el=>el.name===name)?.ref
    await clients[i].call('task_act',{taskId:task.taskId,observationId:obs.observationId,actions:[{type:'fill',ref:ref('Name'),value:['Codex fixture','Claude fixture','Script fixture'][i]},{type:'select',ref:ref('Category'),value:'advanced'},{type:'fill',ref:ref('Notes'),value:'no foreground input'},{type:'click',ref:ref('Save local record')}]})
    assert.equal((await clients[i].call('task_wait',{taskId:task.taskId,text:'Saved:',timeoutMs:10000})).matched,true)
  }))
  assert.equal(fixture.submissions.length,3);pass('concurrent form filling and real submissions without OS input')
  const task=app.broker.tasks.get(tasks[0].taskId)
  const marker=()=>task.page.evaluate(()=>({marker:sessionStorage.getItem('velmren-marker'),name:document.getElementById('name').value,record:localStorage.getItem('record')}))
  const before=await marker()
  assert.notEqual(before.marker,await app.broker.tasks.get(tasks[1].taskId).page.evaluate(()=>sessionStorage.getItem('velmren-marker')));pass('browser contexts separate storage')
  if(!backgroundOnly) {
    await codex.call('task_request_human',{taskId:task.taskId,reason:'Test same-document handoff'})
    await assert.rejects(codex.call('task_observe',{taskId:task.taskId}),/paused/)
    assert.equal((await admin('task_observe',{taskId:task.taskId})).state,'needs-human')
    await admin('task_control',{taskId:task.taskId,action:'show'})
    assert.equal(task.state,'human');assert.deepEqual(await marker(),before)
    await admin('task_control',{taskId:task.taskId,action:'resume'})
    assert.equal(task.state,'agent-active');assert.deepEqual(await marker(),before);pass('same WebContents form/sessionStorage/localStorage survive human handoff and resume')
  }
  const stale=await codex.call('task_observe',{taskId:task.taskId})
  await task.page.evaluate(()=>{document.querySelector('#status').textContent='Changed outside the agent'})
  await assert.rejects(codex.call('task_act',{taskId:task.taskId,observationId:stale.observationId,actions:[{type:'click',ref:stale.elements.find(e=>e.name==='Save local record').ref}]}),/changed since observation/);pass('stale observation rejected before input')
  await assert.rejects(codex.call('task_navigate',{taskId:task.taskId,url:'https://example.com'}),/not permitted/)
  const denied=await task.page.evaluate(async()=>{try{await fetch('https://example.com/');return false}catch{return true}})
  assert.equal(denied,true);pass('top-level and page subresource origin restrictions')
  const transportPolicy=await probeTransportPolicy(task.page)
  await writeFile(path.join(output,'transport-policy.json'),JSON.stringify(transportPolicy,null,2))
  pass('workers and off-policy WebSockets cannot send requests')
  const shot=await scripts.call('task_screenshot',{taskId:tasks[2].taskId})
  assert.equal(Buffer.from(shot.data,'base64').subarray(1,4).toString(),'PNG')
  await writeFile(path.join(output,'hidden-task.png'),Buffer.from(shot.data,'base64'));pass('hidden task screenshots are returned on demand')
  const d=await scripts.call('task_observe',{taskId:tasks[2].taskId})
  await scripts.call('task_act',{taskId:tasks[2].taskId,observationId:d.observationId,actions:[{type:'click',ref:d.elements.find(e=>e.name==='Download fixture CSV').ref}]})
  const downloadTask=app.broker.tasks.get(tasks[2].taskId)
  const deadline=Date.now()+15000
  while(!downloadTask.downloads.some(x=>x.state==='completed')&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,100))
  const download=downloadTask.downloads.find(x=>x.state==='completed');assert.ok(download)
  assert.equal(await readFile(download.path,'utf8'),'kind,value\nfixture,42\n');pass('download stays in task directory with completion status')
  const badOrigin=await fetch(app.descriptor.endpoint+'/rpc',{method:'POST',headers:{Origin:'https://foreign.invalid','Content-Type':'application/json',Authorization:'Bearer '+app.descriptor.adminToken},body:JSON.stringify({method:'broker_status',args:{}})})
  assert.equal(badOrigin.status,403)
  assert.equal((await fetch(app.descriptor.endpoint+'/rpc',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,401);pass('HTTP foreign origin and missing token rejected')
  await Promise.all(tasks.map((t,i)=>clients[i].call('task_finish',{taskId:t.taskId})))
  const {targetInfos}=await app.broker.browser.send('Target.getTargets')
  assert.ok(tasks.every(t=>!targetInfos.some(target=>target.targetId===app.broker.tasks.get(t.taskId).targetId)))
  assert.ok([...app.broker.tasks.values()].every(t=>t.state==='completed'));pass('finishing tasks disposes isolated contexts')
  if(lifecycleSoak) {
    // Chromium's delayed BrowserContext teardown previously crashed at 60s.
    await new Promise(resolve=>setTimeout(resolve,soakSeconds*1000))
    await app.broker.browser.send('Browser.getVersion')
    const next=await scripts.call('task_create',{url:fixture.url,label:'Task after delayed cleanup'})
    assert.match((await scripts.call('task_observe',{taskId:next.taskId})).text,/Velmren local acceptance/)
    await scripts.call('task_finish',{taskId:next.taskId})
    pass('browser survives delayed context teardown and accepts the next task')
  }
  await writeFile(path.join(output,'result.json'),JSON.stringify({passed:true,scope:backgroundOnly?'background-only':headless?'headless protocol':'full',agentDirectory:path.resolve(agentDirectory),deferred:backgroundOnly||headless?['visible human handoff and resume']:[],browser:app.broker.browser.version,checks},null,2))
}catch(error){await writeFile(path.join(output,'result.json'),JSON.stringify({passed:false,checks,error:error.stack},null,2));throw error}
finally{await app?.close();await fixture.close()}

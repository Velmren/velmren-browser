import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { AgentBroker, originAllowed, rpcErrorResponse } from '../broker.mjs'

function fixture() {
  const browser=new EventEmitter()
  browser.version={product:'fixture'}
  browser.calls=[]
  browser.send=async(method,params)=>{browser.calls.push({method,params});return method==='Target.getTargets'?{targetInfos:[]}:{}}
  browser.close=async()=>{}
  const broker=new AgentBroker(browser,'unused',{maxActiveActions:2},{trace:null})
  let inputs=0
  const page={sessionId:'s1',observation:null,send:async()=>{},setFileChooserInterception:async()=>{},dispose(){},observe:async()=>({text:'fixture',observationId:'obs'}),act:async(_id,_actions,active)=>{if(active())inputs++;return {inputs}}}
  const task={taskId:'task1',targetId:'target1',contextId:'context1',owner:'codex',state:'agent-active',label:'fixture',url:'http://127.0.0.1/',createdAt:new Date().toISOString(),downloads:[],blockedOrigins:[],queue:Promise.resolve(),page}
  broker.tasks.set(task.taskId,task)
  return {browser,broker,task,page,get inputs(){return inputs}}
}

test('default network policy permits loopback only and explicit origins are exact',()=>{
  for(const url of ['http://127.0.0.1:1234/x','http://localhost:9999/','https://[::1]:88/'])assert.equal(originAllowed(url),true)
  for(const url of ['https://example.com/','file:///c:/secret','chrome://settings','http://u:p@localhost/','http://127.0.0.1.attacker/'])assert.equal(originAllowed(url),false)
  assert.equal(originAllowed('https://example.com/a',['https://example.com']),true)
  assert.equal(originAllowed('http://example.com/a',['https://example.com']),false)
  assert.equal(originAllowed('https://sub.example.com/a',['https://example.com']),false)
})

test('client cannot access another client task or administrator methods',async()=>{
  const {broker}=fixture()
  assert.deepEqual((await broker.rpc('claude','task_list',{})).tasks,[])
  await assert.rejects(broker.rpc('claude','task_observe',{taskId:'task1'}),/Task not found/)
  await assert.rejects(broker.rpc('codex','task_control',{taskId:'task1',action:'show'}),/Unsupported task method/)
  await assert.rejects(broker.rpc('codex','shutdown',{}),/Unsupported task method/)
})

test('requesting human never shows the page and stops agent input until explicit resume',async()=>{
  const f=fixture()
  await f.broker.rpc('codex','task_request_human',{taskId:'task1',reason:'Verify form'})
  assert.equal(f.task.state,'needs-human')
  assert.equal(f.browser.calls.length,0)
  await assert.rejects(f.broker.rpc('codex','task_act',{taskId:'task1',observationId:'obs',actions:[{type:'click',ref:'e1'}]}),/paused/)
  assert.equal(f.inputs,0)
  await f.broker.rpc('admin','task_control',{taskId:'task1',action:'show'})
  assert.equal(f.task.state,'human')
  assert.deepEqual(f.browser.calls.at(-1),{method:'Target.setTargetVisibility',params:{targetId:'target1',visible:true}})
  await assert.rejects(f.broker.rpc('codex','task_observe',{taskId:'task1'}),/paused/)
  await f.broker.rpc('admin','task_control',{taskId:'task1',action:'resume'})
  assert.equal(f.task.state,'agent-active')
  assert.equal(f.page.observation,null)
  assert.equal(f.browser.calls.at(-1).params.visible,false)
})

test('pause invalidates work already queued behind an in-flight command',async()=>{
  const f=fixture()
  let release
  f.task.queue=new Promise(resolve=>{release=resolve})
  const pending=f.broker.rpc('codex','task_act',{taskId:'task1',observationId:'obs',actions:[{type:'click',ref:'e1'}]})
  const rejected=assert.rejects(pending,/paused/)
  const paused=f.broker.rpc('admin','task_control',{taskId:'task1',action:'pause'})
  release()
  await rejected;await paused
  assert.equal(f.inputs,0)
})

test('intercepted redirects and subresource requests outside policy fail closed',async()=>{
  const {broker,browser,task}=fixture()
  const calls=browser.calls
  await broker.onProtocol({sessionId:'s1',method:'Fetch.requestPaused',params:{requestId:'r1',request:{url:'https://example.com/private'}}})
  assert.equal(calls[0].method,'Fetch.failRequest')
  assert.deepEqual(task.blockedOrigins,['https://example.com'])
  await broker.onProtocol({sessionId:'s1',method:'Fetch.requestPaused',params:{requestId:'r2',request:{url:'http://localhost:1234/allowed'}}})
  assert.equal(calls[1].method,'Fetch.continueRequest')
})

test('latest Pause supersedes queued Resume and intervening agent work',async()=>{
  const f=fixture()
  let release
  f.task.queue=new Promise(resolve=>{release=resolve})
  const resumed=f.broker.rpc('admin','task_control',{taskId:'task1',action:'resume'})
  const work=f.broker.rpc('codex','task_act',{taskId:'task1',observationId:'obs',actions:[{type:'click',ref:'e1'}]})
  const rejected=assert.rejects(work,/paused/)
  const paused=f.broker.rpc('admin','task_control',{taskId:'task1',action:'pause'})
  release();await resumed;await rejected;await paused
  assert.equal(f.task.state,'paused');assert.equal(f.inputs,0)
  assert.equal(f.browser.calls.filter(c=>c.method==='Target.setTargetVisibility').length,0)
})

test('human closing the tab disposes its context once',async()=>{
  const {broker,browser,task}=fixture()
  await broker.onProtocol({method:'Target.targetDestroyed',params:{targetId:'target1'}})
  await broker.onProtocol({method:'Target.targetDestroyed',params:{targetId:'target1'}})
  assert.equal(task.state,'cancelled');assert.equal(task.contextId,null)
  assert.equal(browser.calls.filter(c=>c.method==='Target.disposeBrowserContext').length,1)
})

test('response policy tightens an existing CSP and refuses worker/popup capability',async()=>{
  const {broker,browser}=fixture()
  await broker.onProtocol({sessionId:'s1',method:'Fetch.requestPaused',params:{requestId:'r1',responseStatusCode:200,responseHeaders:[{name:'Content-Security-Policy',value:"default-src 'self'"}]}})
  const headers=browser.calls[0].params.responseHeaders
  assert.equal(headers.length,2);assert.equal(headers[0].value,"default-src 'self'")
  assert.match(headers[1].value,/worker-src 'none'/);assert.doesNotMatch(headers[1].value,/allow-popups/)
})

test('a root-session attachment is not mistaken for a child of a starting task',async()=>{
  const {broker,task}=fixture();task.page=null
  await broker.onProtocol({method:'Target.attachedToTarget',params:{sessionId:'new',targetInfo:{type:'other'}}})
  assert.equal(task.state,'agent-active');assert.equal(task.contextId,'context1')
})

test('closing a task disposes its context and excludes further actions',async()=>{
  const {broker,browser,task}=fixture()
  await broker.rpc('codex','task_finish',{taskId:'task1'})
  assert.equal(task.state,'completed')
  assert.deepEqual(browser.calls.map(call=>call.method),['Target.closeTarget','Target.getTargets','Target.disposeBrowserContext'])
  assert.deepEqual(browser.calls.at(-1),{method:'Target.disposeBrowserContext',params:{browserContextId:'context1'}})
  await assert.rejects(broker.rpc('codex','task_observe',{taskId:'task1'}),/already ended/)
})

test('HTTP error envelope forwards only the structured action whitelist',()=>{
  const error=Object.assign(new Error('Action failed'),{code:'STALE_OBSERVATION',token:'secret',actionResult:{
    completed:1,failedIndex:1,delivery:'not_delivered',
    results:[{index:0,type:'fill',ref:'e1',delivery:'delivered_verified',value:'secret',verification:{scope:'element',status:'matched',actual:'secret'}}],
    recovery:{retry:'failed_action_only',observe:true,reason:'not_dispatched',prompt:'secret'},args:{password:'secret'}
  }})
  assert.deepEqual(rpcErrorResponse(error),{ok:false,error:'Page observation changed; observe again.',code:'STALE_OBSERVATION',actionResult:{
    completed:1,failedIndex:1,delivery:'not_delivered',
    results:[{index:0,type:'fill',ref:'e1',delivery:'delivered_verified',verification:{scope:'element',status:'matched'}}],
    recovery:{retry:'failed_action_only',observe:true,reason:'not_dispatched'}
  }})
  error.actionResult.delivery='secret'
  assert.equal(rpcErrorResponse(error).actionResult,undefined)
})

test('broker distinguishes pre-dispatch rejection from an unclassified dispatched mutation failure',async()=>{
  const f=fixture(), args={taskId:'task1',observationId:'obs',actions:[{type:'click',ref:'e1'}]}
  await assert.rejects(f.broker.rpc('claude','task_act',args),error=>{
    assert.equal(error.actionResult.delivery,'not_delivered')
    assert.equal(error.actionResult.completed,0)
    return true
  })
  await assert.rejects(f.broker.rpc('codex','task_act',{...args,actions:[]}),error=>{
    assert.equal(error.actionResult.delivery,'not_delivered')
    assert.equal(error.actionResult.recovery.retry,'none')
    return true
  })
  f.page.act=async()=>{throw new Error('Interrupted after input dispatch')}
  await assert.rejects(f.broker.rpc('codex','task_act',args),error=>{
    assert.equal(error.actionResult.delivery,'unknown')
    assert.equal(error.actionResult.completed,null)
    assert.equal(error.actionResult.recovery.retry,'none')
    return true
  })
})

test('HTTP wait failure keeps bounded state evidence without actual values',()=>{
  const error=Object.assign(new Error('Wait expired'),{waitResult:{
    matched:false,elapsedMs:20,pageId:'page1',lastObserved:{state:'value',exists:true,valueMatches:false,value:'secret'},text:'secret'
  }})
  assert.deepEqual(rpcErrorResponse(error).waitResult,{
    matched:false,elapsedMs:20,pageId:'page1',lastObserved:{state:'value',exists:true,valueMatches:false}
  })
  error.waitResult.elapsedMs=Infinity
  assert.equal(rpcErrorResponse(error).waitResult,undefined)
})

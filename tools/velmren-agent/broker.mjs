import http from 'node:http'
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, writeFile, unlink, open } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { BrowserPipe } from './cdp.mjs'
import { AgentPage } from './page.mjs'
import { validateArguments, CLIENTS, BrokerError } from './client.mjs'

const terminal = new Set(['completed', 'cancelled'])
const token = () => randomBytes(32).toString('base64url')
const fail = (message, code='INVALID_STATE') => { throw new BrokerError(message,code) }
const publicDirectory = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public')

export function originAllowed(raw, allowedOrigins) {
  let url
  try { url = new URL(raw) } catch { return false }
  if (!['http:','https:'].includes(url.protocol) || url.username || url.password) return false
  return allowedOrigins ? allowedOrigins.includes(url.origin) : ['localhost','127.0.0.1','[::1]'].includes(url.hostname)
}

class Slots {
  constructor(max) { this.max=max; this.active=0; this.waiters=[] }
  async run(fn) {
    if (this.active >= this.max) await new Promise(resolve=>this.waiters.push(resolve))
    else this.active++
    try { return await fn() }
    finally { const next=this.waiters.shift(); if(next) next(); else this.active-- }
  }
}

export class AgentBroker {
  constructor(browser,stateDir,policy={}) {
    this.browser=browser; this.stateDir=stateDir; this.tasks=new Map(); this.stopping=false
    if (policy.allowedOrigins !== undefined && (!Array.isArray(policy.allowedOrigins) || policy.allowedOrigins.some(origin=>{
      try { const u=new URL(origin); return !['http:','https:'].includes(u.protocol)||u.origin!==origin } catch {return true}
    }))) throw new Error('allowedOrigins must contain exact HTTP(S) origins')
    this.allowedOrigins=policy.allowedOrigins
    this.maxTasks=policy.maxTasks ?? 8
    const maxActions=policy.maxActiveActions ?? 2
    if (!Number.isInteger(this.maxTasks)||this.maxTasks<1||this.maxTasks>32||!Number.isInteger(maxActions)||maxActions<1||maxActions>8) throw new Error('Invalid task/concurrency limits')
    this.slots=new Slots(maxActions)
    this.childSessions=new Map()
    this.listener=message=>{ void this.onProtocol(message).catch(error=>this.event('protocol-error',{message:error.message})) }
    browser.on('protocol',this.listener)
    browser.on('closed',()=>{for(const task of this.tasks.values()) if(!terminal.has(task.state)){task.state='cancelled';task.reason='Browser stopped'}})
  }
  event(type,fields={}) { this.onEvent?.({type,...fields,time:new Date().toISOString()}) }
  record(task) { const {taskId,label,owner,state,reason,url,createdAt,downloads,blockedOrigins}=task; return {taskId,label,owner,state,reason,url,createdAt,downloads,blockedOrigins} }
  task(id,owner) {
    const task=this.tasks.get(id)
    if (!task || (owner!=='admin' && task.owner!==owner)) fail('Task not found','NOT_FOUND')
    return task
  }
  serialize(task,fn) { const result=task.queue.then(fn); task.queue=result.catch(()=>{}); return result }
  checkActive(task) { if(task.state!=='agent-active') fail(`Task is ${task.state}; agent actions are paused`) }
  async init() { await this.browser.send('Target.setDiscoverTargets',{discover:true}) }
  contentPolicy() {
    const sources=this.allowedOrigins?.length ? this.allowedOrigins.join(' ') : this.allowedOrigins ? "'none'" : 'http://localhost:* https://localhost:* http://127.0.0.1:* https://127.0.0.1:* http://[::1]:* https://[::1]:*'
    // A second response CSP can only tighten a site's own policy. Workers and
    // popups are deliberately unsupported in this first local prototype.
    return `connect-src ${sources}; worker-src 'none'; object-src 'none'; frame-src ${sources}; form-action ${sources}; sandbox allow-scripts allow-same-origin allow-forms allow-downloads`
  }
  async configureSession(sessionId) {
    await this.browser.send('Network.setBypassServiceWorker',{bypass:true},sessionId)
    await this.browser.send('Fetch.enable',{patterns:[{urlPattern:'*',requestStage:'Request'},{urlPattern:'*',resourceType:'Document',requestStage:'Response'}]},sessionId)
    await this.browser.send('Target.setAutoAttach',{autoAttach:true,waitForDebuggerOnStart:true,flatten:true},sessionId)
  }
  async onProtocol(message) {
    const p=message.params ?? {}
    if(message.method==='Target.attachedToTarget') {
      if(!message.sessionId)return
      const task=[...this.tasks.values()].find(t=>t.page?.sessionId===message.sessionId)??this.childSessions.get(message.sessionId)
      if(!task)return
      this.childSessions.set(p.sessionId,task)
      if(p.targetInfo.type!=='iframe') {
        task.reason='This prototype blocks workers and additional page targets'
        await this.end(task,'cancelled')
        return
      }
      try {
        await this.configureSession(p.sessionId)
        await this.browser.send('Runtime.runIfWaitingForDebugger',{},p.sessionId)
      } catch(error) {task.reason='Could not enforce child frame policy';await this.end(task,'cancelled');throw error}
    } else if(message.method==='Target.detachedFromTarget') {
      this.childSessions.delete(p.sessionId)
    } else if(message.method==='Fetch.requestPaused') {
      const task=[...this.tasks.values()].find(t=>t.page?.sessionId===message.sessionId)??this.childSessions.get(message.sessionId)
      if (!task) return
      const send=(method,params)=>this.browser.send(method,params,message.sessionId)
      if(p.responseStatusCode) {
        const headers=[...(p.responseHeaders??[]),{name:'Content-Security-Policy',value:this.contentPolicy()}]
        await send('Fetch.continueResponse',{requestId:p.requestId,responseCode:p.responseStatusCode,responseHeaders:headers})
        return
      }
      const allowed=originAllowed(p.request.url,this.allowedOrigins)
      if(!allowed) {
        let origin; try{origin=new URL(p.request.url).origin}catch{origin='invalid'}
        if(!task.blockedOrigins.includes(origin)) task.blockedOrigins.push(origin)
      }
      await send(allowed?'Fetch.continueRequest':'Fetch.failRequest',allowed?{requestId:p.requestId}:{requestId:p.requestId,errorReason:'BlockedByClient'})
    } else if(message.method==='Target.targetCreated' && p.targetInfo.openerId) {
      const owner=[...this.tasks.values()].find(t=>t.targetId===p.targetInfo.openerId)
      if(owner) { await this.browser.send('Target.closeTarget',{targetId:p.targetInfo.targetId}); owner.reason='Popup blocked; navigate the task explicitly' }
    } else if(message.method==='Target.targetDestroyed') {
      const task=[...this.tasks.values()].find(t=>t.targetId===p.targetId)
      if(task) task.targetClosed=true
      if(task&&!terminal.has(task.state)){task.reason='Page was closed';await this.end(task,'cancelled')}
    } else if(message.method==='Browser.downloadWillBegin') {
      const task=[...this.tasks.values()].find(t=>t.page?.frameId===p.frameId)
      if(task) task.downloads.push({guid:p.guid,name:path.basename(p.suggestedFilename.replaceAll('\\','/')),path:path.join(task.downloadDir,p.guid),state:'inProgress'})
    } else if(message.method==='Browser.downloadProgress') {
      for(const task of this.tasks.values()) { const item=task.downloads.find(d=>d.guid===p.guid); if(item) Object.assign(item,{state:p.state,receivedBytes:p.receivedBytes,totalBytes:p.totalBytes}) }
    } else if(message.method==='Page.frameNavigated' && !p.frame.parentId) {
      const task=[...this.tasks.values()].find(t=>t.page?.sessionId===message.sessionId)
      if(task)task.url=p.frame.url
    }
  }
  async create(owner,args) {
    if(!originAllowed(args.url,this.allowedOrigins)) fail('Origin is not permitted by the local policy','ORIGIN_DENIED')
    if([...this.tasks.values()].filter(t=>!terminal.has(t.state)).length>=this.maxTasks) fail('Task limit reached','LIMIT_REACHED')
    let initialized
    const task={taskId:randomUUID(),label:args.label||'Browser task',owner,state:'agent-active',reason:'',url:args.url,createdAt:new Date().toISOString(),downloads:[],blockedOrigins:[],queue:new Promise(resolve=>{initialized=resolve})}
    this.tasks.set(task.taskId,task)
    try {
      const context=await this.browser.send('Target.createBrowserContext',{disposeOnDetach:true})
      task.contextId=context.browserContextId
      task.downloadDir=path.join(this.stateDir,'downloads',task.taskId)
      await mkdir(task.downloadDir,{recursive:true})
      await this.browser.send('Browser.setDownloadBehavior',{behavior:'allowAndName',browserContextId:task.contextId,downloadPath:task.downloadDir,eventsEnabled:true})
      const target=await this.browser.send('Target.createTarget',{url:'about:blank',browserContextId:task.contextId,hidden:true,background:true})
      task.targetId=target.targetId
      const {sessionId}=await this.browser.send('Target.attachToTarget',{targetId:task.targetId,flatten:true})
      task.page=new AgentPage(this.browser,task.targetId,sessionId)
      await task.page.init()
      await this.configureSession(sessionId)
      this.checkActive(task)
      const observation=await task.page.navigate(args.url)
      this.event('task-created',{taskId:task.taskId,owner})
      return {...this.record(task),observation}
    }catch(error){await this.end(task,'cancelled');throw error}
    finally { initialized() }
  }
  async end(task,state) {
    task.state=state
    task.page?.dispose()
    const contextId=task.contextId
    // Hidden targets are owned by the DevTools session, not a tab strip.
    // Destroy them before their BrowserContext to avoid dangling renderers.
    if(task.targetId&&!task.targetClosed&&!this.browser.closed) {
      await this.browser.send('Target.closeTarget',{targetId:task.targetId})
      const deadline=Date.now()+10000
      while(true) {
        const {targetInfos}=await this.browser.send('Target.getTargets')
        if(!targetInfos.some(target=>target.targetId===task.targetId))break
        if(Date.now()>=deadline)throw new Error('Task page did not close; its profile was retained')
        await new Promise(resolve=>setTimeout(resolve,50))
      }
      task.targetClosed=true
    }
    task.contextId=null
    for(const [sessionId,owner] of this.childSessions)if(owner===task)this.childSessions.delete(sessionId)
    if(contextId) await this.browser.send('Target.disposeBrowserContext',{browserContextId:contextId}).catch(()=>{})
    this.event('task-ended',{taskId:task.taskId,state})
    return this.record(task)
  }
  async control(task,action) {
    if(terminal.has(task.state))fail('Task already ended')
    if(!['show','resume','pause','cancel'].includes(action))fail('Unknown control action','INVALID_ARGUMENTS')
    // Stop queued action batches before waiting for the current protocol command.
    const generation=task.controlGeneration=(task.controlGeneration??0)+1
    task.state=action==='cancel'?'cancelled':'paused'
    return this.serialize(task,async()=>{
      if(generation!==task.controlGeneration)return this.record(task)
      if(terminal.has(task.state) && action!=='cancel')return this.record(task)
      if(action==='cancel')return this.end(task,'cancelled')
      await task.page.send('Emulation.setFocusEmulationEnabled',{enabled:false})
      if(generation!==task.controlGeneration || terminal.has(task.state))return this.record(task)
      if(action==='show') {
        await task.page.send('Page.setWebLifecycleState',{state:'active'})
        if(generation!==task.controlGeneration || terminal.has(task.state))return this.record(task)
        await this.browser.send('Target.setTargetVisibility',{targetId:task.targetId,visible:true})
        if(generation===task.controlGeneration)task.state='human'
      } else if(action==='resume') {
        await this.browser.send('Target.setTargetVisibility',{targetId:task.targetId,visible:false})
        await task.page.send('Page.setWebLifecycleState',{state:'active'})
        task.page.observation=null
        if(generation===task.controlGeneration){task.state='agent-active';task.reason=''}
      } else {
        // A shown page stays available to its human owner; only agent work pauses.
        task.state='paused';task.reason='Paused by user'
      }
      this.event('task-control',{taskId:task.taskId,action})
      return this.record(task)
    })
  }
  async rpc(owner,method,args={}) {
    if(this.stopping)fail('Broker is stopping')
    if(owner==='admin') {
      if(method==='broker_status')return {tasks:[...this.tasks.values()].map(t=>this.record(t)),browserVersion:this.browser.version,activeActions:this.slots.active,maxTasks:this.maxTasks,maxActiveActions:this.slots.max,allowedOrigins:this.allowedOrigins??['loopback only']}
      if(method==='task_control')return this.control(this.task(args.taskId,owner),args.action)
      if(method==='shutdown'){setTimeout(()=>this.onShutdown?.(),20);return {stopping:true}}
    }
    validateArguments(method,args)
    if(method==='task_list')return {tasks:[...this.tasks.values()].filter(t=>owner==='admin'||t.owner===owner).map(t=>this.record(t))}
    if(method==='task_create')return this.slots.run(()=>this.create(owner,args))
    const task=this.task(args.taskId,owner)
    if(method==='task_cancel') {task.controlGeneration=(task.controlGeneration??0)+1;task.state='cancelled';return this.serialize(task,()=>this.end(task,'cancelled'))}
    if(method==='task_request_human') {
      if(terminal.has(task.state))fail('Task already ended')
      task.controlGeneration=(task.controlGeneration??0)+1
      task.state='needs-human';task.reason=args.reason
      if(task.page)task.page.observation=null
      return this.serialize(task,async()=>{
        if(!terminal.has(task.state))await task.page.send('Emulation.setFocusEmulationEnabled',{enabled:false})
        return this.record(task)
      })
    }
    return this.serialize(task,()=>this.slots.run(async()=>{
      if(terminal.has(task.state))fail('Task already ended')
      if (owner==='admin' && method==='task_observe') return {...await task.page.observe(true),taskId:task.taskId,state:task.state,downloads:task.downloads}
      if (owner==='admin' && method==='task_screenshot') return task.page.screenshot()
      this.checkActive(task)
      if(method==='task_finish')return this.end(task,'completed')
      if(method==='task_observe')return {...await task.page.observe(),taskId:task.taskId,state:task.state,downloads:task.downloads}
      if(method==='task_act')return task.page.act(args.observationId,args.actions,()=>task.state==='agent-active')
      if(method==='task_navigate') {
        if(!originAllowed(args.url,this.allowedOrigins))fail('Origin is not permitted by the local policy','ORIGIN_DENIED')
        return task.page.navigate(args.url)
      }
      if(method==='task_wait')return task.page.wait(args.text,args.timeoutMs??10000)
      if(method==='task_screenshot')return task.page.screenshot()
      fail('Unknown method','UNKNOWN_METHOD')
    }))
  }
  async close() {
    if(this.stopping)return
    this.stopping=true
    for(const task of this.tasks.values()){task.state=terminal.has(task.state)?task.state:'cancelled';task.page?.dispose()}
    this.browser.off('protocol',this.listener)
    await this.browser.close()
  }
}

export async function startBroker({executable,stateDir,policy={},port=0,browserArgs=[]}) {
  stateDir=path.resolve(stateDir)
  await mkdir(stateDir,{recursive:true,mode:0o700})
  const lock=await open(path.join(stateDir,'broker.lock'),'wx',0o600).catch(()=>{throw new Error('State directory is already in use. Use a fresh state directory, or remove a stale broker.lock only after checking its PID.')})
  await lock.writeFile(String(process.pid))
  let browser,broker,server,descriptor
  try {
    browser=await BrowserPipe.launch({executable,profile:path.join(stateDir,'browser-profile'),args:browserArgs})
    broker=new AgentBroker(browser,stateDir,policy)
    await broker.init()
    descriptor={endpoint:'',pid:process.pid,adminToken:token(),clients:Object.fromEntries(CLIENTS.map(client=>[client,{token:token()}]))}
    const identify=header=>{
      const candidate=Buffer.from(String(header??'').replace(/^Bearer /,''))
      for(const [owner,secret] of [['admin',descriptor.adminToken],...Object.entries(descriptor.clients).map(([k,v])=>[k,v.token])]) {
        const expected=Buffer.from(secret)
        if(candidate.length===expected.length && timingSafeEqual(candidate,expected))return owner
      }
      return null
    }
    server=http.createServer(async(req,res)=>{
      const json=(status,data)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(data))}
      try {
        if(req.headers.host!==new URL(descriptor.endpoint).host) return json(403,{ok:false,error:'Invalid host'})
        if(req.headers.origin && req.headers.origin!==descriptor.endpoint)return json(403,{ok:false,error:'Foreign origin'})
        if(req.method==='GET' && ['/','/app.js','/style.css'].includes(req.url)) {
          const file=req.url==='/'?'index.html':req.url.slice(1)
          const body=await readFile(path.join(publicDirectory,file))
          res.writeHead(200,{'Content-Type':file.endsWith('.html')?'text/html; charset=utf-8':file.endsWith('.js')?'text/javascript':'text/css','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'self'; img-src 'self' data:; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"});res.end(body);return
        }
        if(req.method!=='POST'||req.url!=='/rpc')return json(404,{ok:false,error:'Not found'})
        const owner=identify(req.headers.authorization)
        if(!owner)return json(401,{ok:false,error:'Authentication required',code:'UNAUTHORIZED'})
        if(!req.headers['content-type']?.startsWith('application/json'))return json(415,{ok:false,error:'JSON required'})
        let size=0;const chunks=[]
        for await(const chunk of req){size+=chunk.length;if(size>65536){json(413,{ok:false,error:'Request too large'});return}chunks.push(chunk)}
        const body=JSON.parse(Buffer.concat(chunks).toString())
        if(!body||typeof body.method!=='string'||!body.args||Array.isArray(body.args)||typeof body.args!=='object')return json(400,{ok:false,error:'Invalid request'})
        const result=await broker.rpc(owner,body.method,body.args)
        return json(200,{ok:true,result})
      }catch(error){if(!res.headersSent)json(400,{ok:false,error:error.message,code:error.code||'BROKER_ERROR'})}
    })
    server.requestTimeout=30000;server.headersTimeout=10000
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve)})
    descriptor.endpoint=`http://127.0.0.1:${server.address().port}`
    await writeFile(path.join(stateDir,'connection.json'),JSON.stringify(descriptor,null,2),{mode:0o600})
    let closed=false
    const close=async()=>{
      if(closed)return;closed=true
      server.close();server.closeIdleConnections()
      await broker.close();server.closeAllConnections()
      await unlink(path.join(stateDir,'connection.json')).catch(()=>{})
      await lock.close();await unlink(path.join(stateDir,'broker.lock')).catch(()=>{})
    }
    broker.onShutdown=close
    return {broker,descriptor,server,close}
  }catch(error){await browser?.close();server?.close();await lock.close();await unlink(path.join(stateDir,'broker.lock')).catch(()=>{});throw error}
}

if(process.argv[1] && import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) {
  const options={};const args=process.argv.slice(2)
  if(args[0]==='daemon')args.shift()
  for(let i=0;i<args.length;i+=2){if(!['--browser','--state-dir','--policy','--port'].includes(args[i])||!args[i+1])throw new Error('Usage: broker.mjs [daemon] --browser EXE --state-dir DIR [--policy JSON] [--port 0]');options[args[i]]=args[i+1]}
  if(!options['--browser']||!options['--state-dir'])throw new Error('--browser and --state-dir are required')
  const app=await startBroker({executable:options['--browser'],stateDir:options['--state-dir'],policy:options['--policy']?JSON.parse(await readFile(options['--policy'],'utf8')):{},port:Number(options['--port']??0)})
  console.log(JSON.stringify({status:'ready',endpoint:app.descriptor.endpoint,stateDir:path.resolve(options['--state-dir'])}))
  for(const signal of ['SIGINT','SIGTERM'])process.once(signal,async()=>{await app.close();process.exit(0)})
}

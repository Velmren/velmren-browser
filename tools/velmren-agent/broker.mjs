import http from 'node:http'
import { EventEmitter } from 'node:events'
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, writeFile, unlink, open, rename, realpath } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { BrowserPipe } from './cdp.mjs'
import { AgentBroker } from './runtime.mjs'
export { AgentBroker, originAllowed } from './runtime.mjs'
import { CLIENTS } from './client.mjs'
import { sanitizeActionResult, sanitizeWaitResult } from './action-result.mjs'
import { bindProfilePolicy } from './profile-state.mjs'
import { effectivePolicyIdentity } from './policy-identity.mjs'
import { ManualProfileError, ManualProfileSession, assertNoManualProfileSession, readManualProfileReceipt } from './manual-profile.mjs'

const token = () => randomBytes(32).toString('base64url')
const publicDirectory = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public')

export function rpcErrorResponse(error) {
  const actionResult = sanitizeActionResult(error?.actionResult)
  const waitResult = sanitizeWaitResult(error?.waitResult)
  return { ok: false, error: error.message, code: error.code || 'BROKER_ERROR', ...(actionResult ? { actionResult } : {}), ...(waitResult ? { waitResult } : {}) }
}

export async function validateProfileLoginRecovery({ executable, stateDir, policy = {} }, recovery) {
  if (recovery?.userConfirmed !== true) throw new ManualProfileError('Explicit confirmation is required after closing the manual browser.', 'USER_CONFIRMATION_REQUIRED')
  if (typeof recovery.loginId !== 'string' || !recovery.loginId || recovery.loginId.length > 256 || /[\x00-\x1f]/.test(recovery.loginId)) throw new ManualProfileError('A valid manual sign-in identity is required.', 'INVALID_ARGUMENTS')
  const receipt = await readManualProfileReceipt(stateDir)
  if (!receipt || receipt.id !== recovery.loginId) throw new ManualProfileError('Manual sign-in receipt does not match the requested login identity.')
  let browserPath, profilePath
  try { [browserPath, profilePath] = await Promise.all([realpath(executable), realpath(path.join(stateDir, 'browser-profile'))]) }
  catch { throw new ManualProfileError('The dedicated manual browser configuration cannot be verified.') }
  const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
  if (!samePath(receipt.executable, browserPath) || !samePath(receipt.profile, profilePath) || receipt.policyIdentity !== effectivePolicyIdentity(policy)) throw new ManualProfileError('Manual sign-in receipt belongs to another configuration. Keep automation stopped.')
  if (policy.profileMode !== 'persistent' || policy.allowWeb !== true || policy.allowedOrigins !== undefined) throw new ManualProfileError('Manual sign-in recovery requires the original persistent web policy.', 'PROFILE_LOGIN_POLICY')
  if (!['manual', 'awaiting-confirmation'].includes(receipt.state) || !receipt.browserPid || !receipt.browserStartTime) throw new ManualProfileError('The recorded manual browser identity is incomplete. Keep automation stopped.')
  try { process.kill(receipt.brokerPid, 0) }
  catch (error) { if (error.code === 'ESRCH') return receipt }
  throw new ManualProfileError('The recorded manual sign-in broker process is still running or cannot be verified. Keep automation stopped.', 'BROKER_STILL_RUNNING')
}

export async function startBroker({executable,stateDir,policy={},port=0,browserArgs=[],browserFactory=options=>BrowserPipe.launch(options),manualSession,profileLoginRecovery,signal,beforeProfileLoginComplete}) {
  stateDir=path.resolve(stateDir)
  await mkdir(stateDir,{recursive:true,mode:0o700})
  const lock=await open(path.join(stateDir,'broker.lock'),'wx',0o600).catch(()=>{throw new Error('State directory is already in use. Use a fresh state directory, or remove a stale broker.lock only after checking its PID.')})
  await lock.writeFile(String(process.pid))
  let browser,broker,server,descriptor,descriptorTemp,descriptorPublished=false,profileLoginRecovered=false,startupPending=true
  try {
    const recoveryReceipt=profileLoginRecovery===undefined?null:await validateProfileLoginRecovery({executable,stateDir,policy},profileLoginRecovery)
    if(!recoveryReceipt)await assertNoManualProfileSession(stateDir)
    await bindProfilePolicy(stateDir,policy)
    const browserOptions={executable,profile:path.join(stateDir,'browser-profile'),args:[...browserArgs],profileMode:policy.profileMode}
    manualSession??=new ManualProfileSession({stateDir,executable,profile:browserOptions.profile,policyIdentity:effectivePolicyIdentity(policy)})
    const launch=async()=>{
      if(startupPending)signal?.throwIfAborted()
      browser=await browserFactory({...browserOptions,args:[...browserOptions.args]})
      if(startupPending)signal?.throwIfAborted()
      return browser
    }
    if(recoveryReceipt){
      await manualSession.load()
      const loaded=manualSession.receipt
      for(const key of ['id','owner','brokerPid','browserPid','browserStartTime','executable','profile','policyIdentity']){
        if(loaded?.[key]!==recoveryReceipt[key])throw new ManualProfileError('Manual sign-in identity changed during recovery. Keep automation stopped.')
      }
      // Restore the gate without opening a browser or sending any CDP commands.
      browser=Object.assign(new EventEmitter(),{closed:true,close:async()=>{}})
      broker=new AgentBroker(browser,stateDir,policy,{manualSession,browserFactory:launch})
      broker.profileLogin={phase:'manual',loginId:recoveryReceipt.id,owner:recoveryReceipt.owner}
      signal?.throwIfAborted()
    }else{
      browser=await launch()
      broker=new AgentBroker(browser,stateDir,policy,{manualSession,browserFactory:launch})
      await broker.init()
    }
    descriptor={endpoint:'',pid:process.pid,adminToken:token(),clients:Object.fromEntries(CLIENTS.map(client=>[client,{token:token()}]))}
    const identify=header=>{
      const candidate=Buffer.from(String(header??'').replace(/^Bearer /,''))
      for(const [owner,secret] of [['admin',descriptor.adminToken],...Object.entries(descriptor.clients).map(([k,v])=>[k,v.token]),...Array.from(broker.clients,([k,v])=>[k,v.token])]) {
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
      }catch(error){if(!res.headersSent)json(400,rpcErrorResponse(error))}
    })
    server.requestTimeout=30000;server.headersTimeout=10000
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve)})
    descriptor.endpoint=`http://127.0.0.1:${server.address().port}`
    descriptorTemp=path.join(stateDir,`connection.${randomUUID()}.tmp`)
    await writeFile(descriptorTemp,JSON.stringify(descriptor,null,2),{mode:0o600,flag:'wx'})
    await rename(descriptorTemp,path.join(stateDir,'connection.json'))
    descriptorPublished=true
    if(recoveryReceipt){
      // Publish a gated endpoint before receipt completion, so startup failures
      // remain recoverable and cannot clear the guard before readiness.
      await broker.finishProfileLogin('admin',profileLoginRecovery,{signal,beforeComplete:beforeProfileLoginComplete})
      profileLoginRecovered=true
    }
    let closed=false
    const close=async()=>{
      if(closed)return
      broker.assertAutomated()
      closed=true
      server.close();server.closeIdleConnections()
      await broker.close();server.closeAllConnections()
      await unlink(path.join(stateDir,'connection.json')).catch(()=>{})
      await lock.close();await unlink(path.join(stateDir,'broker.lock')).catch(()=>{})
    }
    broker.onShutdown=()=>close().catch(error=>broker.event('shutdown-deferred',{code:error.code??'BROKER_ERROR'}))
    if(browser.closed) { await close(); throw new Error('Browser exited during broker startup') }
    startupPending=false
    return {broker,descriptor,server,close,...(profileLoginRecovered?{profileLoginRecovered:true}:{})}
  }catch(error){
    try{await browser?.close()}
    finally{
      server?.close();server?.closeAllConnections()
      if(descriptorPublished)await unlink(path.join(stateDir,'connection.json')).catch(()=>{})
      if(descriptorTemp)await unlink(descriptorTemp).catch(()=>{})
      broker?.unbindBrowser();clearInterval(broker?.lifecycleTimer)
      await Promise.allSettled([broker?.trace?.close(),manualSession?.close()])
      try{await lock.close()}finally{await unlink(path.join(stateDir,'broker.lock')).catch(()=>{})}
    }
    throw error
  }
}

if(process.argv[1] && import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) {
  const options={};const args=process.argv.slice(2)
  if(args[0]==='daemon')args.shift()
  for(let i=0;i<args.length;i+=2){if(!['--browser','--state-dir','--policy','--port'].includes(args[i])||!args[i+1])throw new Error('Usage: broker.mjs [daemon] --browser EXE --state-dir DIR [--policy JSON] [--port 0]');options[args[i]]=args[i+1]}
  if(!options['--browser']||!options['--state-dir'])throw new Error('--browser and --state-dir are required')
  const app=await startBroker({executable:options['--browser'],stateDir:options['--state-dir'],policy:options['--policy']?JSON.parse(await readFile(options['--policy'],'utf8')):{},port:Number(options['--port']??0)})
  console.log(JSON.stringify({status:'ready',endpoint:app.descriptor.endpoint,stateDir:path.resolve(options['--state-dir'])}))
  for(const signal of ['SIGINT','SIGTERM'])process.on(signal,async()=>{
    try{await app.close();process.exit(0)}
    catch(error){console.error(`${error.code??'BROKER_ERROR'}: ${error.message}`)}
  })
}

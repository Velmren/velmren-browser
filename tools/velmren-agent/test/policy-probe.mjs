import http from 'node:http'
import assert from 'node:assert/strict'

export async function probeTransportPolicy(page) {
  let requests=0
  const trap=http.createServer((_req,res)=>{requests++;res.setHeader('Access-Control-Allow-Origin','*');res.end('unexpected')})
  trap.on('upgrade',(_req,socket)=>{requests++;socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')})
  await new Promise(resolve=>trap.listen(0,'127.0.0.2',resolve))
  const address=`127.0.0.2:${trap.address().port}`
  try {
    const probe=async(address)=>{
      const violations=[]
      const listener=e=>violations.push({directive:e.effectiveDirective,blocked:e.blockedURI})
      document.addEventListener('securitypolicyviolation',listener)
      const blob=URL.createObjectURL(new Blob([`fetch('http://${address}/worker').then(()=>postMessage('connected')).catch(()=>postMessage('failed'))`],{type:'text/javascript'}))
      let worker
      const workerResult=await new Promise(resolve=>{
        const timer=setTimeout(()=>resolve('timeout'),2000)
        const done=value=>{clearTimeout(timer);resolve(value)}
        try{worker=new Worker(blob);worker.onmessage=e=>done(e.data);worker.onerror=e=>{e.preventDefault();done('blocked')}}catch{done('blocked')}
      })
      worker?.terminate();URL.revokeObjectURL(blob)
      let socket
      const socketResult=await new Promise(resolve=>{
        const timer=setTimeout(()=>resolve('timeout'),2000)
        const done=value=>{clearTimeout(timer);resolve(value)}
        try{socket=new WebSocket(`ws://${address}/socket`);socket.onopen=()=>done('connected');socket.onerror=()=>done('blocked')}catch{done('blocked')}
      })
      socket?.close()
      await new Promise(resolve=>setTimeout(resolve,0))
      document.removeEventListener('securitypolicyviolation',listener)
      return {workerResult,socketResult,violations}
    }
    // Main world is intentional: this exercises the site's own CSP environment.
    const result=await page.send('Runtime.evaluate',{expression:`(${probe.toString()})(${JSON.stringify(address)})`,awaitPromise:true,returnByValue:true})
    if(result.exceptionDetails)throw new Error(result.exceptionDetails.text)
    const value=result.result.value
    assert.equal(value.workerResult,'blocked');assert.equal(value.socketResult,'blocked');assert.equal(requests,0)
    assert.ok(value.violations.some(v=>v.directive==='worker-src'))
    assert.ok(value.violations.some(v=>v.directive==='connect-src'))
    return {...value,trapRequests:requests}
  }finally{trap.closeAllConnections();await new Promise(resolve=>trap.close(resolve))}
}

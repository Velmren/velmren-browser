import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { AgentPage } from '../page.mjs'

for(const type of ['fill','click','select','press']) {
  test(`pause during ${type} preparation prevents the input from being dispatched`,async()=>{
    const browser=new EventEmitter(),calls=[]
    browser.send=async(method)=>{calls.push(method);return {}}
    const page=new AgentPage(browser,'target','session')
    page.observation={id:'obs',epoch:0,revision:0}
    let active=true,evaluations=0
    page.evaluate=async()=>{
      evaluations++
      if(evaluations===1)return 0
      active=false
      return {x:20,y:20}
    }
    await assert.rejects(page.act('obs',[{type,ref:'e1',value:'fixture',key:'Enter'}],()=>active),/paused during action preparation/)
    assert.equal(calls.filter(method=>method.startsWith('Input.')).length,0)
    assert.equal(evaluations,2)
    assert.equal(page.observation,null)
    page.dispose()
  })
}

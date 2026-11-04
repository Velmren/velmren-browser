// Synthetic localhost widgets and mocked tokens only. No provider requests.
// node test/captcha-page-integration.mjs BROWSER_EXE NEW_OUTPUT_DIR
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { BrowserPipe } from '../cdp.mjs'
import { AgentPage } from '../page.mjs'
import { PageFrames } from '../frames.mjs'
import { CaptchaPage, installCaptchaSession } from '../captcha-page.mjs'

const [executable, outputArgument] = process.argv.slice(2)
if (!executable || !outputArgument) throw new Error('Usage: node test/captcha-page-integration.mjs BROWSER_EXE NEW_OUTPUT_DIR')
const output = path.resolve(outputArgument)
await mkdir(path.dirname(output), { recursive: true }); await mkdir(output)
const report = { passed: false, checks: [], cleanup: {} }
const check = name => { report.checks.push(name); console.log(`PASS ${name}`) }
const server = createServer((request, response) => {
  response.setHeader('Content-Type', 'text/html; charset=utf-8')
  // Provider-shaped iframe URLs below are DOM evidence only: CSP blocks all
  // external navigation, and no external scripts are loaded by this fixture.
  response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'unsafe-inline'; frame-src 'self' http://127.0.0.2:*; connect-src 'none'")
  const basic = name => `<form id="form-${name}"><div id="${name}" class="g-recaptcha" data-sitekey="synthetic-${name}" data-callback="callbacks.${name}"><textarea name="g-recaptcha-response"></textarea></div></form>`
  const fixture = `<!doctype html><meta charset="utf-8"><title>Synthetic CAPTCHA fixture</title>
    <input id="ordinary" value="ordinary value">
    ${basic('dom')}${basic('second')}${basic('throwing')}
    <form><div id="explicit"></div></form>
    <form><div id="enterprise"></div></form>
    <form><div id="turnstile"></div></form>
    <form id="iframe-form"><iframe id="anchor" src="https://www.recaptcha.net/recaptcha/api2/anchor?k=synthetic-anchor&amp;sa=signup&amp;s=synthetic-s&amp;size=normal"></iframe><textarea name="g-recaptcha-response"></textarea></form>
    <div class="g-recaptcha" data-sitekey="synthetic-invisible" data-size="invisible"></div>
    <div class="h-captcha" data-sitekey="synthetic-hcaptcha"></div>
    <div id="shadow"></div>
    <script>
      globalThis.calls = []; globalThis.callbacks = {};
      for (const name of ['dom','second','throwing']) callbacks[name] = token => { calls.push({name, token}); if(name==='throwing') throw new Error('synthetic callback failure'); };
      function provider(kind) {
        const widgets = new Map();
        return {
          render(container, options, third) {
            if (container==='throws') throw new TypeError('original render failure');
            const node = typeof container==='string' ? document.getElementById(container.replace(/^#/,'')) : container;
            if (options['response-field'] !== false) node.innerHTML='<input type="hidden" name="'+(options['response-field-name'] || (kind==='turnstile'?'cf-turnstile-response':'g-recaptcha-response'))+'">';
            calls.push({name:kind+'-render',receiver:this===globalThis[kind] || this===grecaptcha.enterprise,third});
            const widgetId = kind+'-'+node.id; widgets.set(widgetId,node); return widgetId;
          },
          reset(...args) {
            calls.push({name:kind+'-reset',args,receiver:this===globalThis[kind] || this===grecaptcha.enterprise});
            const node = args[0] === undefined ? widgets.values().next().value : widgets.get(args[0]);
            for (const field of node?.querySelectorAll('input,textarea') || []) field.value = '';
            return 'reset-return';
          },
          remove(...args) { calls.push({name:kind+'-remove',args,receiver:this===globalThis[kind] || this===grecaptcha.enterprise}); return 'remove-return'; }
        };
      }
      globalThis.grecaptcha = provider('grecaptcha'); grecaptcha.enterprise = provider('enterprise');
      globalThis.turnstile = provider('turnstile');
      globalThis.explicitCallback = token => calls.push({name:'explicit',token});
      globalThis.renderResult = grecaptcha.render('explicit',{sitekey:'synthetic-explicit',callback:explicitCallback},'third-arg');
      grecaptcha.enterprise.render('enterprise',{sitekey:'synthetic-enterprise',s:'enterprise-s',action:'login',callback:token=>calls.push({name:'enterprise',token})});
      turnstile.render('#turnstile',{sitekey:'synthetic-turnstile',action:'signup',cData:'synthetic_data','response-field-name':'custom-response',callback:token=>calls.push({name:'turnstile',token})});
      const shadow = document.getElementById('shadow').attachShadow({mode:'open'});
      shadow.innerHTML='<form><div class="cf-turnstile" data-sitekey="synthetic-shadow"><input type="hidden" name="cf-turnstile-response"></div></form>';
    </script>`
  if (request.url.startsWith('/child-explicit')) response.end(`<!doctype html><form><div id="child"></div></form><script>
    globalThis.turnstile = { render(node, options) { node.innerHTML='<input type="hidden" name="cf-turnstile-response">'; return 'child-widget'; } };
    turnstile.render(document.getElementById('child'),{sitekey:'synthetic-cross-child',callback:token=>{globalThis.receivedToken=token}});
  </script>`)
  else if (request.url.startsWith('/cross-frames')) response.end(`<!doctype html><iframe name="cross-child" src="http://127.0.0.2:${server.address().port}/child-explicit"></iframe>`)
  else if (request.url.startsWith('/child')) response.end(`<!doctype html><form><div class="cf-turnstile" data-sitekey="synthetic-child"><input type="hidden" name="cf-turnstile-response"></div></form>`)
  else if (request.url.startsWith('/frames')) response.end(`<!doctype html><iframe name="synthetic-child" src="/child"></iframe>`)
  else if (request.url.startsWith('/navigate-after')) response.end('<!doctype html><title>Callback destination</title>Callback destination')
  else response.end(fixture)
})
await new Promise(resolve => server.listen(0, '0.0.0.0', resolve))
const origin = `http://127.0.0.1:${server.address().port}`
let browser, page, failure
try {
  browser = await BrowserPipe.launch({ executable: path.resolve(executable), profile: path.join(output, 'owned-profile'), args: ['--headless=new', '--disable-background-networking', '--site-per-process'] })
  report.browser = browser.version
  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true })
  page = new AgentPage(browser, targetId, sessionId)
  page.captcha ||= new CaptchaPage(page)
  await page.init()
  const evaluate = async expression => {
    const result = await page.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text)
    return result.result.value
  }
  assert.equal(await evaluate('Object.keys(globalThis).some(key=>key.startsWith("__velmrenCaptcha_"))'), false)
  assert.equal(await evaluate('Object.getOwnPropertyDescriptor(globalThis,"grecaptcha")'), undefined)
  check('Disabled feature installs no provider global hooks')
  await page.captcha.install(); await page.captcha.install(); await installCaptchaSession(browser, sessionId)
  let generation = 0
  const load = () => page.navigate(`${origin}/fixture?generation=${++generation}&private=synthetic-secret#sensitive-fragment`)
  await load()
  let descriptions = await page.captcha.inspect()
  assert.equal(descriptions.length, 10)
  assert.equal(descriptions.filter(item => item.supported).length, 8)
  assert.ok(descriptions.some(item => item.reason === 'hcaptcha' && !item.supported))
  assert.ok(descriptions.some(item => item.reason === 'invisible-widget' && !item.supported))
  assert.doesNotMatch(JSON.stringify(descriptions), /synthetic-|sitekey|private|token|websiteURL/)
  assert.ok(descriptions.every(item => /^[0-9a-f-]{36}$/.test(item.challengeId)))
  assert.deepEqual(await page.captcha.inspect(), descriptions)
  check('Stable public challenge IDs classify supported, invisible and hCaptcha without token or site data')
  const preparedByKey = async () => {
    const result = new Map()
    for (const item of await page.captcha.inspect()) if (item.supported) {
      const prepared = await page.captcha.prepare(item.challengeId)
      assert.equal(prepared.task.websiteURL, origin + '/')
      result.set(prepared.task.websiteKey, prepared)
    }
    return result
  }
  let prepared = await preparedByKey()
  const anchor = prepared.get('synthetic-anchor')
  assert.deepEqual(anchor.task, { type: 'ReCaptchaV2TaskProxyLess', websiteURL: origin+'/', websiteKey:'synthetic-anchor', isInvisible:false, pageAction:'signup', recaptchaDataSValue:'synthetic-s', apiDomain:'www.recaptcha.net' })
  assert.deepEqual(prepared.get('synthetic-enterprise').task.enterprisePayload, { s: 'enterprise-s' })
  assert.deepEqual(prepared.get('synthetic-turnstile').task.metadata, { action:'signup', cdata:'synthetic_data' })
  for (const [key, callbackInvoked] of [['synthetic-dom',true],['synthetic-explicit',true],['synthetic-enterprise',true],['synthetic-turnstile',true],['synthetic-anchor',false],['synthetic-shadow',false]]) {
    const { binding } = await page.captcha.prepare(prepared.get(key).binding.challengeId)
    const receipt = await page.captcha.apply(binding, 'MOCK_TOKEN_'+key, ()=>true)
    assert.deepEqual(receipt, { applied:true, callbackInvoked })
    await assert.rejects(page.captcha.apply(binding, 'REPLAY'), {code:'CAPTCHA_STALE'})
  }
  assert.equal(await evaluate('document.getElementById("ordinary").value'), 'ordinary value')
  assert.equal(await evaluate('document.querySelector("#second textarea").value'), '')
  assert.equal(await evaluate('document.querySelector("#turnstile input").value'), 'MOCK_TOKEN_synthetic-turnstile')
  assert.equal(await evaluate('calls.filter(item=>item.name==="explicit").length'), 1)
  assert.equal(await evaluate('renderResult'), 'grecaptcha-explicit')
  assert.equal(await evaluate('calls.find(item=>item.name==="grecaptcha-render").receiver'), true)
  assert.equal(await evaluate('calls.find(item=>item.name==="grecaptcha-render").third'), 'third-arg')
  assert.equal(await evaluate('try { grecaptcha.render("throws",{}) } catch(error) { error instanceof TypeError && error.message === "original render failure" }'), true)
  descriptions = await page.captcha.inspect()
  assert.doesNotMatch(JSON.stringify(descriptions), /MOCK_TOKEN/)
  assert.equal(descriptions.filter(item=>item.alreadySolved).length, 6)
  check('DOM, explicit, enterprise, Turnstile, provider iframe and shadow widgets receive only their own token; API semantics preserved')
  const throwing = await page.captcha.prepare(prepared.get('synthetic-throwing').binding.challengeId)
  assert.deepEqual(await page.captcha.apply(throwing.binding, 'MOCK_THROW'), { applied:true, callbackInvoked:true, deliveryUncertain:true })
  await assert.rejects(page.captcha.prepare(throwing.binding.challengeId), {code:'CAPTCHA_ALREADY_SOLVED'})
  check('Callback exceptions retain delivery uncertainty and prevent another prepare')

  await load(); prepared = await preparedByKey()
  await evaluate('document.getElementById("dom").replaceWith(document.getElementById("dom").cloneNode(true))')
  await assert.rejects(page.captcha.apply(prepared.get('synthetic-dom').binding,'MOCK_STALE'),{code:'CAPTCHA_STALE'})
  assert.deepEqual(await page.captcha.apply(prepared.get('synthetic-second').binding,'MOCK_INDEPENDENT'),{applied:true,callbackInvoked:true})
  assert.equal(await evaluate('document.querySelector("#dom textarea").value'), '')
  check('Widget replacement invalidates its own binding while another widget remains independently deliverable')
  await load(); prepared = await preparedByKey()
  await evaluate(`{
    const clock = document.createElement('span'); document.getElementById('form-dom').append(clock); clock.textContent='countdown 30'; clock.textContent='countdown 29';
    const ad = document.createElement('aside'); document.body.append(ad); ad.textContent='unrelated content'; ad.remove();
    document.getElementById('second').dataset.sitekey='other-widget-key';
    document.querySelector('#second textarea').replaceWith(document.createElement('textarea'));
  }`)
  assert.deepEqual(await page.captcha.apply(prepared.get('synthetic-dom').binding,'MOCK_UNRELATED'),{applied:true,callbackInvoked:true})
  check('Unrelated countdown, ad and other-widget mutations do not discard a bound solution')
  await load(); prepared = await preparedByKey()
  await evaluate('document.querySelector("#dom textarea").replaceWith(document.createElement("textarea"))')
  await assert.rejects(page.captcha.apply(prepared.get('synthetic-dom').binding,'MOCK_STALE'),{code:'CAPTCHA_STALE'})
  await load(); prepared = await preparedByKey()
  await evaluate('callbacks.dom=()=>calls.push({name:"replacement"})')
  await assert.rejects(page.captcha.apply(prepared.get('synthetic-dom').binding,'MOCK_STALE'),{code:'CAPTCHA_STALE'})
  await load(); prepared = await preparedByKey()
  await evaluate('document.getElementById("dom").dataset.sitekey="changed-sitekey"')
  await assert.rejects(page.captcha.apply(prepared.get('synthetic-dom').binding,'MOCK_STALE'),{code:'CAPTCHA_STALE'})
  check('Response field, named callback and sitekey replacements reject stale token delivery')
  for (const mutation of [
    'const field=document.querySelector("#dom textarea"); field.remove(); document.getElementById("dom").append(field)',
    'const widget=document.getElementById("dom"), form=widget.parentElement; widget.remove(); form.append(widget)',
    'const form=document.getElementById("form-dom"), next=form.nextSibling; form.remove(); document.body.insertBefore(form,next)',
    'const form=document.getElementById("form-dom"), widget=document.getElementById("dom"), replacement=form.cloneNode(false); form.replaceWith(replacement); replacement.append(widget)',
    'document.getElementById("form-second").append(document.getElementById("dom"))',
    'const form=document.getElementById("form-dom"); form.setAttribute("action","/changed"); form.removeAttribute("action")',
  ]) {
    await load(); prepared = await preparedByKey()
    await evaluate(`{${mutation}}`)
    await assert.rejects(page.captcha.apply(prepared.get('synthetic-dom').binding,'MOCK_OWNERSHIP_STALE'),{code:'CAPTCHA_STALE'})
    assert.equal(await evaluate('document.querySelector("#dom textarea").value'), '')
  }
  check('Relevant field/widget/form detach-reinsert, form replacement, ownership moves and form-action changes reject delivery')
  await load(); prepared = await preparedByKey()
  await evaluate('history.pushState({},"","/fixture?new-spa-state")')
  await assert.rejects(page.captcha.apply(prepared.get('synthetic-dom').binding,'MOCK_STALE'),{code:'CAPTCHA_STALE'})
  await load(); prepared = await preparedByKey()
  await load()
  await assert.rejects(page.captcha.apply(prepared.get('synthetic-dom').binding,'MOCK_STALE'),{code:'CAPTCHA_STALE'})
  check('SPA URL changes and document navigation invalidate bound challenges')
  prepared = await preparedByKey()
  await assert.rejects(page.captcha.apply(prepared.get('synthetic-dom').binding,'MOCK_CANCEL',()=>false),{code:'CAPTCHA_CANCELLED'})
  assert.equal(await evaluate('document.querySelector("#dom textarea").value'), '')
  let activityChecks = 0
  await assert.rejects(page.captcha.apply(prepared.get('synthetic-second').binding,'MOCK_CANCEL',()=>++activityChecks === 1),{code:'CAPTCHA_CANCELLED'})
  assert.equal(await evaluate('document.querySelector("#second textarea").value'), '')
  assert.equal(await evaluate('grecaptcha.reset("grecaptcha-explicit", "extra")'), 'reset-return')
  await assert.rejects(page.captcha.apply(prepared.get('synthetic-explicit').binding,'MOCK_RESET'),{code:'CAPTCHA_STALE'})
  assert.equal(await evaluate('turnstile.remove("turnstile-turnstile", "extra")'), 'remove-return')
  await assert.rejects(page.captcha.apply(prepared.get('synthetic-turnstile').binding,'MOCK_REMOVE'),{code:'CAPTCHA_STALE'})
  assert.equal(await evaluate('calls.find(item=>item.name==="turnstile-remove").args.length'),2)
  check('Cancellation and provider reset/remove invalidate delivery while preserving normal API results')

  await load(); prepared = await preparedByKey()
  const firstGeneration = prepared.get('synthetic-explicit')
  const oldPending = await page.captcha.prepare(firstGeneration.binding.challengeId)
  assert.deepEqual(await page.captcha.apply(firstGeneration.binding,'MOCK_GENERATION_ONE'),{applied:true,callbackInvoked:true})
  let beforeReset = await page.captcha.inspect()
  assert.equal(beforeReset.find(item=>item.challengeId===firstGeneration.binding.challengeId).alreadySolved,true)
  assert.deepEqual(await page.captcha.inspect(),beforeReset)
  await evaluate('grecaptcha.reset("grecaptcha-explicit")')
  await assert.rejects(page.captcha.prepare(firstGeneration.binding.challengeId),{code:'CAPTCHA_STALE'})
  await assert.rejects(page.captcha.apply(oldPending.binding,'MOCK_OLD_GENERATION'),{code:'CAPTCHA_STALE'})
  const secondGeneration = (await preparedByKey()).get('synthetic-explicit')
  assert.notEqual(secondGeneration.binding.challengeId,firstGeneration.binding.challengeId)
  let afterReset = await page.captcha.inspect()
  assert.equal(afterReset.find(item=>item.challengeId===secondGeneration.binding.challengeId).alreadySolved,false)
  assert.deepEqual(await page.captcha.inspect(),afterReset)
  assert.deepEqual(await page.captcha.apply(secondGeneration.binding,'MOCK_GENERATION_TWO'),{applied:true,callbackInvoked:true})
  await assert.rejects(page.captcha.prepare(secondGeneration.binding.challengeId),{code:'CAPTCHA_ALREADY_SOLVED'})
  await evaluate('grecaptcha.render("explicit",{sitekey:"synthetic-explicit",callback:explicitCallback})')
  await assert.rejects(page.captcha.prepare(secondGeneration.binding.challengeId),{code:'CAPTCHA_STALE'})
  const thirdGeneration = (await preparedByKey()).get('synthetic-explicit')
  assert.notEqual(thirdGeneration.binding.challengeId,secondGeneration.binding.challengeId)
  assert.deepEqual(await page.captcha.apply(thirdGeneration.binding,'MOCK_GENERATION_THREE'),{applied:true,callbackInvoked:true})
  await assert.rejects(page.captcha.prepare(thirdGeneration.binding.challengeId),{code:'CAPTCHA_ALREADY_SOLVED'})
  assert.equal((await page.captcha.inspect()).find(item=>item.challengeId===thirdGeneration.binding.challengeId).alreadySolved,true)
  check('Successful reset and re-render create new challenge IDs and one-use generations; ordinary inspection remains stable')

  await page.navigate(origin+'/frames')
  page.frames ||= new PageFrames(page,()=>[],()=>null)
  const frames = await page.frames.refresh()
  const frame = page.frames.select(frames.find(item=>item.name==='synthetic-child').frameId)
  frame.captcha ||= new CaptchaPage(frame)
  const childDescriptions = await frame.captcha.inspect()
  assert.equal(childDescriptions.length,1)
  assert.equal((await page.captcha.inspect()).length,0)
  const childPrepared = await frame.captcha.prepare(childDescriptions[0].challengeId)
  await assert.rejects(page.captcha.prepare(childDescriptions[0].challengeId),{code:'CAPTCHA_STALE'})
  assert.deepEqual(await frame.captcha.apply(childPrepared.binding,'MOCK_CHILD'),{applied:true,callbackInvoked:false})
  const childValue = await frame.evaluate(()=>document.querySelector('input').value)
  assert.equal(childValue,'MOCK_CHILD')
  check('Selected same-process child forms use their owned default context and reject cross-frame challenge IDs')

  const childSessions = new Map(), childErrors = []
  const childListener = message => {
    if (message.method !== 'Target.attachedToTarget' || message.params.targetInfo.type !== 'iframe') return
    const entry = { type:'iframe', targetId:message.params.targetInfo.targetId, sessionId:message.params.sessionId }
    childSessions.set(entry.targetId,entry)
    entry.ready = (async()=>{
      const bridgeReady = installCaptchaSession(browser,entry.sessionId)
      await browser.send('Runtime.runIfWaitingForDebugger',{},entry.sessionId)
      await bridgeReady
    })()
    entry.ready.catch(error=>childErrors.push(error))
  }
  browser.on('protocol',childListener)
  await page.send('Target.setAutoAttach',{autoAttach:true,waitForDebuggerOnStart:true,flatten:true,filter:[{type:'iframe'}]})
  page.frames.dispose()
  page.frames = new PageFrames(page,()=>[...childSessions.values()],()=>({parentId:page.frameId}))
  const crossStarted = performance.now()
  await page.navigate(origin+'/cross-frames')
  assert.ok(performance.now()-crossStarted < 10000,'Paused iframe bootstrap should not hit a CDP timeout')
  const crossFrames = await page.frames.refresh()
  const cross = page.frames.select(crossFrames.find(item=>item.name==='cross-child').frameId)
  cross.captcha ||= new CaptchaPage(cross)
  assert.notEqual(cross.sessionId,page.sessionId)
  const crossDescriptions = await cross.captcha.inspect()
  assert.equal(crossDescriptions.length,1)
  const crossPrepared = await cross.captcha.prepare(crossDescriptions[0].challengeId)
  assert.equal(crossPrepared.task.websiteURL,`http://127.0.0.2:${server.address().port}/`)
  assert.deepEqual(await cross.captcha.apply(crossPrepared.binding,'MOCK_CROSS'),{applied:true,callbackInvoked:true})
  assert.equal(childErrors.length,0)
  const crossValue = await browser.send('Runtime.evaluate',{expression:'receivedToken',returnByValue:true},cross.sessionId)
  assert.equal(crossValue.result.value,'MOCK_CROSS')
  browser.off('protocol',childListener)
  cross.captcha.dispose(); page.frames.dispose(); page.frames = undefined
  check('Paused OOPIF preload queues before resume, captures early explicit callbacks and targets the correct session')

  await load()
  await evaluate('callbacks.dom=()=>{location.href="/navigate-after"}')
  prepared = await preparedByKey()
  const navigationReceipt = await page.captcha.apply(prepared.get('synthetic-dom').binding,'MOCK_NAVIGATION')
  assert.ok(navigationReceipt.applied || navigationReceipt.deliveryUncertain)
  check('Callback-driven navigation reports dispatch or uncertainty without replaying')
  report.passed = true
} catch(error) { failure=error; report.error={message:error.message,stack:error.stack}; console.error(error) }
finally {
  page?.captcha?.dispose(); page?.dispose()
  await browser?.close(); report.cleanup.browserClosed=!!browser?.closed
  await new Promise(resolve=>server.close(resolve)); report.cleanup.fixtureClosed=true
  await writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2))
}
if(failure)process.exitCode=1

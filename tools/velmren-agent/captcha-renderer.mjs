// Serialized into the page's main world. Nothing in this API accepts source code.
export function installCaptchaBridge(key) {
  if (Object.hasOwn(globalThis, key)) return globalThis[key]
  const records = new Map(), byNode = new WeakMap(), bindings = new Map(), hooked = new WeakMap()
  const pendingRenders = new Map(), refusedRenders = new WeakSet()
  const pendingLimit = 64, pendingLifetime = 30000
  const documentRef = document
  let sequence = 0, renderSequence = 0, disposed = false, pendingTimer
  const nativeApply = Reflect.apply, nativeDefine = Object.defineProperty
  const now = performance.now.bind(performance), later = setTimeout.bind(globalThis), cancelLater = clearTimeout.bind(globalThis)
  const inputSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
  const textareaSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
  const observers = new Map(), restorers = []
  const changed = mutations => {
    for (const mutation of mutations) if (mutation.type === 'childList') {
      for (const entry of pendingRenders.values()) if ([...mutation.removedNodes].some(node => node === entry.node || node.contains(entry.node))) refusePending(entry)
      for (const record of records.values()) if (record.render && [...mutation.removedNodes].some(node => record.ancestors?.has(node))) {
        record.render = undefined; record.ancestors = undefined; record.generation++
        refusedRenders.add(record.node)
        if (!connected(record.node)) records.delete(record.id)
      }
    }
    for (const binding of bindings.values()) {
      if (binding.invalid) continue
      for (const mutation of mutations) {
        if (mutation.type === 'attributes') {
          const attributes = binding.attributes.get(mutation.target)
          if (attributes?.has(mutation.attributeName)) { binding.invalid = true; break }
        } else if (mutation.type === 'childList') {
          // Remember detach/reinsert even when the original objects and final
          // DOM are restored before apply. Sibling widgets are independent.
          if ([...mutation.removedNodes].some(node => binding.ancestors.has(node)) || binding.fields.has(mutation.target)) {
            binding.invalid = true; break
          }
        } else if (mutation.type === 'characterData' && [...binding.fields].some(field => field.contains(mutation.target))) {
          binding.invalid = true; break
        }
      }
    }
    settlePending()
    arm()
  }
  const watch = root => {
    if (observers.has(root)) return
    const observer = new MutationObserver(changed)
    observer.observe(root, { subtree: true, childList: true, attributes: true, characterData: true })
    observers.set(root, observer)
  }
  watch(document)
  const flush = () => { for (const observer of observers.values()) changed(observer.takeRecords()) }
  const fail = code => { throw new Error(code) }
  const bounded = (value, max = 4096) => typeof value === 'string' && value.length <= max ? value : ''
  const parent = node => node.parentElement || node.getRootNode()?.host || null
  const within = (root, node) => { for (let p = node; p; p = parent(p)) if (p === root) return true; return false }
  const all = (selector, scope = document) => {
    const found = [], roots = [scope]
    for (let index = 0; index < roots.length && index < 200; index++) {
      const root = roots[index]; watch(root)
      found.push(...root.querySelectorAll(selector))
      for (const node of root.querySelectorAll('*')) if (node.shadowRoot) roots.push(node.shadowRoot)
      if (found.length > 500) break
    }
    return found.slice(0, 500)
  }
  const connected = node => node?.isConnected && node.ownerDocument === documentRef
  const resolveContainer = value => {
    if (value?.nodeType === 1) return value
    if (typeof value !== 'string') return null
    const byId = document.getElementById(value)
    if (byId) return byId
    try { return document.querySelector(value) } catch { return null }
  }
  const namedCallback = name => {
    if (!name || !/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(name) || name.length > 256) return null
    let value = globalThis
    for (const part of name.split('.')) {
      if (['__proto__', 'prototype', 'constructor'].includes(part)) return null
      try { value = value?.[part] } catch { return null }
    }
    return typeof value === 'function' ? value : null
  }
  const getRecord = node => {
    let record = byNode.get(node)
    if (!record) {
      record = { id: String(++sequence), node, generation: 0, consumed: false }
      byNode.set(node, record)
    }
    records.set(record.id, record)
    return record
  }
  const commitRender = (node, render) => {
    const record = getRecord(node)
    record.render = render; record.ancestors = new Set()
    for (let current = node; current; current = parent(current)) record.ancestors.add(current)
    record.removed = false; record.consumed = false; record.generation++
    refusedRenders.delete(node)
  }
  const refusePending = entry => {
    pendingRenders.delete(entry.node)
    refusedRenders.add(entry.node)
  }
  const settlePending = () => {
    cancelLater(pendingTimer); pendingTimer = undefined
    const time = now()
    for (const entry of pendingRenders.values()) {
      if (entry.node.ownerDocument !== documentRef || time >= entry.expires) refusePending(entry)
      else if (connected(entry.node)) { pendingRenders.delete(entry.node); commitRender(entry.node, entry.render) }
    }
    if (pendingRenders.size) pendingTimer = later(settlePending, Math.max(1, Math.min(...[...pendingRenders.values()].map(entry => entry.expires)) - time))
  }
  const capture = (provider, api, args, widgetId) => {
    const node = resolveContainer(args[0]), options = args[1] || {}
    if (!(node instanceof Element) || node.ownerDocument !== documentRef) {
      if (node?.nodeType === 1) refusedRenders.add(node)
      return
    }
    flush()
    // Do not retain arbitrary caller objects or secrets from render options.
    const render = { provider, api, widgetId, order: ++renderSequence, sitekey: bounded(options.sitekey), size: bounded(options.size, 32),
      callback: typeof options.callback === 'function' ? options.callback : null,
      callbackName: typeof options.callback === 'string' ? bounded(options.callback, 256) : '',
      callbackSpecified: options.callback != null,
      action: bounded(options.action, 256), cdata: bounded(options.cData, 1024),
      pagedata: !!options.chlPageData, s: bounded(options.s),
      responseField: options['response-field'] !== false,
      responseName: bounded(options['response-field-name'], 256) }
    pendingRenders.delete(node)
    if (connected(node)) commitRender(node, render)
    else {
      // Providers may render before insertion. Retain only a bounded, short-lived
      // candidate; it cannot be inspected or prepared while disconnected.
      while (pendingRenders.size >= pendingLimit) refusePending(pendingRenders.values().next().value)
      pendingRenders.set(node, { node, render, expires: now() + pendingLifetime })
      settlePending()
    }
  }
  // Preserve receiver, arguments, exceptions and return values of provider APIs.
  const hookProperty = (owner, property, transform) => {
    if (!owner || !['object', 'function'].includes(typeof owner)) return
    let map = hooked.get(owner)
    if (!map) { map = new Map(); hooked.set(owner, map) }
    const current = Object.getOwnPropertyDescriptor(owner, property)
    if (map.has(property) && map.get(property).get === current?.get) return
    if (current && (!current.configurable || current.get || current.set || !current.writable)) return
    let value = current?.value, exposed = transform(value)
    const get = () => exposed
    const set = next => { value = next; exposed = transform(next) }
    try {
      nativeDefine(owner, property, { configurable: true, enumerable: current?.enumerable ?? true, get, set })
      map.set(property, { get })
      restorers.push(() => {
        if (Object.getOwnPropertyDescriptor(owner, property)?.get !== get) return
        if (current || value !== undefined) nativeDefine(owner, property, { configurable: true, enumerable: current?.enumerable ?? true, writable: true, value })
        else delete owner[property]
      })
    } catch { /* Frozen provider objects are discovered through DOM only. */ }
  }
  const hookAPI = (api, provider) => {
    if (!api || !['object', 'function'].includes(typeof api)) return api
    for (const method of ['render', 'reset', 'remove']) {
      if (provider === 'turnstile' && !Object.hasOwn(api, method)) continue
      hookProperty(api, method, original => {
        if (typeof original !== 'function') return original
        return function(...args) {
          const result = nativeApply(original, this, args)
          try {
            if (!disposed && method === 'render') capture(provider, api, args, result)
            else if (!disposed) {
              flush()
              let candidates = [...records.values(), ...pendingRenders.values()]
                .filter(record => record.render?.api === api).sort((a, b) => a.render.order - b.render.order)
              if (args[0] === undefined) candidates = candidates.slice(0, 1)
              else candidates = candidates.filter(record => record.render.widgetId === args[0] || resolveContainer(args[0]) === record.node)
              for (const record of candidates) {
                if (pendingRenders.has(record.node)) { refusePending(record); continue }
                record.generation++
                if (method === 'remove') record.removed = true
                else record.consumed = false
              }
            }
          } catch { /* Instrumentation must not break the provider API. */ }
          return result
        }
      })
    }
    return api
  }
  const arm = () => {
    if (disposed) return
    hookProperty(globalThis, 'grecaptcha', value => {
      hookAPI(value, 'recaptcha-v2')
      hookProperty(value, 'enterprise', enterprise => hookAPI(enterprise, 'recaptcha-v2-enterprise'))
      return value
    })
    // Some provider bootstraps test property presence, even for undefined.
    // Do not create or replace the global; arm only an existing ordinary API.
    const turnstile = Object.getOwnPropertyDescriptor(globalThis, 'turnstile')
    if (turnstile && 'value' in turnstile) hookAPI(turnstile.value, 'turnstile')
    // hCaptcha can provide a grecaptcha-compatible facade. Recognize it as
    // unsupported here rather than submitting its key to the reCAPTCHA solver.
    hookProperty(globalThis, 'hcaptcha', value => hookAPI(value, 'hcaptcha'))
  }
  const loaded = event => { if (event.target?.tagName === 'SCRIPT' || event.target === documentRef) arm() }
  documentRef.addEventListener('load', loaded, true)
  documentRef.addEventListener('DOMContentLoaded', arm)
  documentRef.addEventListener('readystatechange', arm)
  arm()
  const iframeInfo = node => {
    let url
    try { url = new URL(node.getAttribute('src') || '', location.href) } catch { return null }
    if (['www.google.com', 'google.com', 'www.recaptcha.net', 'recaptcha.net'].includes(url.hostname) && /^\/recaptcha\/(api2|enterprise)\/anchor$/.test(url.pathname)) {
      return { provider: url.pathname.includes('/enterprise/') ? 'recaptcha-v2-enterprise' : 'recaptcha-v2',
        sitekey: bounded(url.searchParams.get('k')), size: bounded(url.searchParams.get('size'), 32),
        action: bounded(url.searchParams.get('sa'), 256), s: bounded(url.searchParams.get('s')),
        apiDomain: url.hostname.includes('recaptcha.net') ? 'www.recaptcha.net' : '' }
    }
    if (url.hostname === 'challenges.cloudflare.com' && /\/turnstile\//.test(url.pathname)) return { provider: 'turnstile' }
    if (url.hostname === 'hcaptcha.com' || url.hostname.endsWith('.hcaptcha.com')) return { provider: 'unsupported', reason: 'hcaptcha' }
    if (url.hostname === 'challenges.cloudflare.com') return { provider: 'unsupported', reason: 'cloudflare-interstitial' }
    return null
  }
  const scan = () => {
    if (disposed || document !== documentRef) fail('CAPTCHA_STALE')
    flush(); settlePending()
    arm()
    const nodes = new Set(all('[data-sitekey],.g-recaptcha,.cf-turnstile,.h-captcha'))
    for (const record of records.values()) if (record.render && connected(record.node) && !record.removed) nodes.add(record.node)
    const frames = new Map()
    for (const iframe of all('iframe[src]')) {
      const info = iframeInfo(iframe)
      if (!info) continue
      let owner = parent(iframe)
      while (owner && !nodes.has(owner)) owner = parent(owner)
      owner ||= iframe
      nodes.add(owner)
      const values = frames.get(owner) || []; values.push({ iframe, info }); frames.set(owner, values)
    }
    return [...nodes].filter(connected).map(node => {
      const record = getRecord(node), render = record.render, providerFrames = frames.get(node) || []
      const info = providerFrames[0]?.info || {}
      let provider = render?.provider || info.provider || (node.classList.contains('g-recaptcha') ? 'recaptcha-v2'
        : node.classList.contains('cf-turnstile') ? 'turnstile' : 'unsupported')
      let reason = provider === 'unsupported' ? info.reason || (node.classList.contains('h-captcha') ? 'hcaptcha' : 'unknown-provider') : null
      if (refusedRenders.has(node)) reason = 'callback-unavailable'
      const attrKey = bounded(node.getAttribute('data-sitekey')), sitekey = render?.sitekey || attrKey || info.sitekey || ''
      if (providerFrames.length > 1) reason = 'ambiguous-widget'
      if ([render?.sitekey, attrKey, info.sitekey].filter(Boolean).some(value => value !== sitekey)) reason = 'conflicting-sitekey'
      if (render?.provider && info.provider && render.provider !== info.provider) reason = 'conflicting-provider'
      if (render?.provider === 'hcaptcha' || render?.api && render.api === globalThis.hcaptcha ||
          info.reason === 'hcaptcha' || node.classList.contains('h-captcha')) { provider = 'unsupported'; reason = 'hcaptcha' }
      if (!sitekey) reason ||= 'missing-sitekey'
      const size = render?.size || node.getAttribute('data-size') || info.size
      const invisible = size === 'invisible'
      // A v3 execute(key) iframe is not a v2 invisible render(widget).
      if (invisible && !render && all('script[src]').some(script => {
        try {
          const url = new URL(script.src)
          return /^(?:www\.)?(?:google\.com|recaptcha\.net)$/.test(url.hostname) && url.searchParams.get('render') === sitekey
        } catch { return false }
      })) reason ||= 'unsupported-metadata'
      if (render?.pagedata || globalThis._cf_chl_opt || node.hasAttribute('data-chl-page-data')) reason = 'cloudflare-interstitial'
      const callbackName = render?.callbackName || bounded(node.getAttribute('data-callback'), 256)
      const resolvedCallback = namedCallback(callbackName)
      const callback = render?.callback || resolvedCallback
      if (callbackName && !callback) reason ||= 'callback-unavailable'
      const explicitRenderScript = all('script[src]').some(script => {
        try {
          const url = new URL(script.src)
          return url.searchParams.get('render') === 'explicit' && (provider === 'turnstile'
            ? url.hostname === 'challenges.cloudflare.com' : /^(?:www\.)?(?:google\.com|recaptcha\.net)$/.test(url.hostname))
        } catch { return false }
      })
      if (!render && !callbackName && explicitRenderScript) reason ||= 'callback-unavailable'
      const responseName = render?.responseName || bounded(node.getAttribute('data-response-field-name'), 256) || (provider === 'turnstile' ? 'cf-turnstile-response' : 'g-recaptcha-response')
      const responseField = render?.responseField !== false && node.getAttribute('data-response-field') !== 'false'
      const action = render?.action || bounded(node.getAttribute('data-action'), 256) || info.action || ''
      const cdata = render?.cdata || bounded(node.getAttribute('data-cdata'), 1024) || ''
      if (provider === 'turnstile' && ((action && !/^[\w-]{1,32}$/.test(action)) || (cdata && !/^[\w-]{1,255}$/.test(cdata)))) reason ||= 'unsupported-metadata'
      const description = { record, node, provider, reason, sitekey, callback, callbackName, responseName, responseField, action, cdata, invisible,
        captchaBinding: { renderCaptured: !!render, namedCallbackSpecified: !!callbackName, namedCallbackResolved: !!resolvedCallback,
          callbackCaptured: !!render?.callback, explicitRenderScript, responseFieldEnabled: responseField },
        s: render?.s || bounded(node.getAttribute('data-s')) || info.s || '', apiDomain: info.apiDomain || '', providerFrames }
      return description
    })
  }
  const fieldsFor = (item, items) => {
    if (!item.responseField) return []
    const matching = root => all('textarea[name],input[name]', root).filter(node => node.getAttribute('name') === item.responseName)
    let fields = matching(item.node)
    if (fields.length) return fields
    // An iframe-only widget's response control is usually a sibling in its form.
    // Stop at the first ancestor that owns controls, and reject multiple widgets.
    for (let root = parent(item.node); root; root = parent(root)) {
      fields = matching(root)
      if (fields.length) return items.filter(other => other.responseName === item.responseName && within(root, other.node)).length === 1 ? fields : []
      if (root.tagName === 'FORM' || root.tagName === 'BODY') break
    }
    return []
  }
  const complete = () => {
    const items = scan()
    for (const item of items) {
      item.fields = fieldsFor(item, items)
      item.captchaBinding.responseFieldCount = item.fields.length
      if (item.fields.length > 1) item.reason ||= 'ambiguous-response-field'
      if (!item.callback && item.fields.length !== 1) item.reason ||= 'response-target-unavailable'
      if (item.record.removed) item.reason = 'widget-removed'
      item.alreadySolved = item.record.consumed || item.fields.some(field => !!field.value)
      if (item.alreadySolved) item.reason ||= 'already-solved'
    }
    flush()
    return items
  }
  const inspect = () => complete().map(item => ({ id: item.record.id, generation: item.record.generation, provider: item.provider,
    supported: !item.reason, reason: item.reason, alreadySolved: item.alreadySolved, captchaBinding: item.captchaBinding }))
  const signature = item => JSON.stringify([item.provider, item.sitekey, item.callbackName, item.responseName, item.responseField,
    item.action, item.cdata, item.s, item.apiDomain, item.invisible, item.record.generation, item.providerFrames.map(value => value.iframe.getAttribute('src'))])
  const owningForm = node => {
    for (let current = node; current; current = parent(current)) if (current.tagName === 'FORM') return current
    return null
  }
  const ownership = item => [owningForm(item.node), ...item.fields.map(field => field.form)]
  const mutationBinding = item => {
    const forms = ownership(item), ancestors = new Set(), attributes = new Map()
    const track = (node, names) => {
      if (!node) return
      attributes.set(node, new Set([...(attributes.get(node) || []), ...names]))
      for (let current = node; current; current = parent(current)) ancestors.add(current)
    }
    track(item.node, ['class', 'id', 'data-sitekey', 'data-callback', 'data-size', 'data-action', 'data-cdata', 'data-s',
      'data-response-field', 'data-response-field-name', 'data-chl-page-data'])
    for (const field of item.fields) track(field, ['id', 'name', 'form', 'type', 'value', 'disabled'])
    for (const { iframe } of item.providerFrames) track(iframe, ['src', 'srcdoc', 'sandbox', 'name'])
    for (const form of forms) track(form, ['id', 'action', 'method', 'enctype', 'target', 'novalidate'])
    return { forms, ancestors, attributes, fields: new Set(item.fields), invalid: false }
  }
  const prepare = (id, generation, bindingId) => {
    const item = complete().find(item => item.record.id === id)
    if (!item || item.record.generation !== generation) fail('CAPTCHA_STALE')
    if (item.alreadySolved) fail('CAPTCHA_ALREADY_SOLVED')
    if (item.reason) fail('CAPTCHA_UNSUPPORTED')
    if (!/^https?:$/.test(location.protocol) || location.origin === 'null') fail('CAPTCHA_UNSUPPORTED')
    const task = { type: item.provider === 'turnstile' ? 'AntiTurnstileTaskProxyLess'
      : item.provider === 'recaptcha-v2-enterprise' ? 'ReCaptchaV2EnterpriseTaskProxyLess' : 'ReCaptchaV2TaskProxyLess',
    websiteURL: location.origin + '/', websiteKey: item.sitekey }
    if (item.provider === 'turnstile') {
      if (item.action || item.cdata) task.metadata = { ...(item.action ? { action: item.action } : {}), ...(item.cdata ? { cdata: item.cdata } : {}) }
    } else {
      task.isInvisible = item.invisible
      if (item.action) task.pageAction = item.action
      if (item.s) {
        if (item.provider === 'recaptcha-v2-enterprise') task.enterprisePayload = { s: item.s }
        else task.recaptchaDataSValue = item.s
      }
      if (item.apiDomain) task.apiDomain = item.apiDomain
    }
    bindings.set(bindingId, { item, signature: signature(item), url: location.href, document: documentRef, ...mutationBinding(item) })
    return { task }
  }
  const apply = (bindingId, token) => {
    const binding = bindings.get(bindingId)
    if (!binding || typeof token !== 'string' || !token || token.length > 65536) { bindings.delete(bindingId); fail('CAPTCHA_STALE') }
    let item
    try { item = complete().find(item => item.record === binding.item.record) }
    finally { bindings.delete(bindingId) }
    if (!item || binding.document !== document || binding.url !== location.href || binding.invalid ||
        signature(item) !== binding.signature || item.callback !== binding.item.callback || item.reason ||
        item.fields.length !== binding.item.fields.length || item.fields.some((field, index) => field !== binding.item.fields[index]) ||
        ownership(item).some((form, index) => form !== binding.forms[index]) ||
        item.providerFrames.some((frame, index) => frame.iframe !== binding.item.providerFrames[index]?.iframe)) fail('CAPTCHA_STALE')
    item.record.consumed = true
    let applied = false, callbackInvoked = false
    try {
      for (const field of item.fields) {
        nativeApply(field.tagName === 'TEXTAREA' ? textareaSetter : inputSetter, field, [token])
        applied = true
      }
      // No form submission or synthetic input/change handlers: the provider's
      // documented completion callback owns any follow-up navigation.
      if (item.callback) { callbackInvoked = true; applied = true; nativeApply(item.callback, undefined, [token]) }
      return { applied, callbackInvoked }
    } catch { return { applied, callbackInvoked, deliveryUncertain: true } }
  }
  const dispose = () => {
    disposed = true; bindings.clear()
    cancelLater(pendingTimer); pendingRenders.clear()
    documentRef.removeEventListener('load', loaded, true)
    documentRef.removeEventListener('DOMContentLoaded', arm)
    documentRef.removeEventListener('readystatechange', arm)
    for (const observer of observers.values()) observer.disconnect()
    for (const restore of restorers.reverse()) { try { restore() } catch {} }
    records.clear()
  }
  const bridge = Object.freeze({ inspect, prepare, apply, dispose })
  nativeDefine(globalThis, key, { value: bridge, configurable: false, writable: false, enumerable: false })
  return bridge
}

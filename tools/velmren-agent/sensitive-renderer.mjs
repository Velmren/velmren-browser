// These functions execute in the isolated agent world, never in a caller's
// arbitrary script. They return only destination metadata and boolean receipts.
export function isSensitiveTarget({ ref }) {
  const el = globalThis.__velmrenAgent?.refs.get(ref)
  return el?.tagName === 'INPUT' && el.type === 'password' ||
    ['INPUT', 'TEXTAREA'].includes(el?.tagName) && String(el.autocomplete ?? '').toLowerCase().split(/\s+/).includes('one-time-code')
}

export function inspectPrivateTarget({ ref, revision, origin }) {
  const state = globalThis.__velmrenAgent
  validateObservedRefs({ revision, refs: [ref] })
  const el = state.refs.get(ref)
  if (!el?.isConnected || el.ownerDocument !== document) throw new Error('Private input target changed')
  if (origin !== undefined && location.origin !== origin) throw new Error('Private input origin changed')
  if (!(el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' && ['text', 'search', 'email', 'url', 'tel', 'password', 'number'].includes(el.type))) throw new Error('Private input needs a native text control')
  const capabilities = elementCapabilities(el)
  if (capabilities.disabled) throw new Error('Element is disabled')
  if (capabilities.hidden) throw new Error('Element is not visible')
  if (!capabilities.availableActions.includes('fill')) throw new Error('Private input target is unavailable')
  if (controlBlockedByModal(el)) throw new Error('Element is obscured')
  controlActionPoint(el, 'fill')
  return { origin: location.origin }
}

export async function preparePrivateTarget(args) {
  const state = globalThis.__velmrenAgent, el = state?.refs.get(args.ref)
  validateObservedRefs({ revision: args.revision, refs: [args.ref] })
  if (!el?.isConnected || el.ownerDocument !== document) throw new Error('Private input target changed')
  el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  if (globalThis.__velmrenAgent !== state || state.refs.get(args.ref) !== el) throw new Error('Private input target changed')
  return inspectPrivateTarget(args)
}

export function applyPrivateValue(args) {
  inspectPrivateTarget(args)
  const state = globalThis.__velmrenAgent, el = state.refs.get(args.ref)
  const prototype = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set
  if (!setter || typeof args.value !== 'string') throw new Error('Private input is unavailable')
  // No focus-directed input: a focus handler cannot redirect this value to a
  // different control. Identity, origin and visibility are checked synchronously.
  setter.call(el, args.value)
  el.dispatchEvent(new Event('input', { bubbles: true, composed: true }))
  el.dispatchEvent(new Event('change', { bubbles: true }))
  return { scope: 'element', status: el.isConnected && el.ownerDocument === document && state.refs.get(args.ref) === el
    ? String(el.value) === args.value ? 'matched' : 'mismatch' : 'unavailable' }
}

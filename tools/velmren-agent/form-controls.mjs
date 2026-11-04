// These functions also run after toString() injection into an isolated world.
export function composedParent(el) {
  return el?.assignedSlot || el?.parentElement || el?.getRootNode?.()?.host || null
}

export function controlState(el) {
  const token = name => {
    const value = el.getAttribute(name)
    return value === 'true' ? true : value === 'false' ? false : value === 'mixed' ? 'mixed' : undefined
  }
  const native = el.tagName === 'INPUT' && ['checkbox', 'radio'].includes(el.type)
  const role = (el.getAttribute('role') || '').trim().split(/\s+/)[0]
  const aria = ['checkbox', 'switch', 'radio'].includes(role)
  const ariaChecked = token('aria-checked'), ariaSelected = token('aria-selected')
  const state = {}
  if (native) Object.assign(state, { checked: !!el.checked, indeterminate: !!el.indeterminate })
  else if (aria && ariaChecked !== undefined) Object.assign(state, { checked: ariaChecked, indeterminate: ariaChecked === 'mixed' })
  if (ariaChecked !== undefined) state.ariaChecked = ariaChecked
  if (ariaSelected === true || ariaSelected === false) state.ariaSelected = ariaSelected
  return state
}

export function elementCapabilities(el, measure = true) {
  const box = measure ? el.getBoundingClientRect() : null, style = measure ? getComputedStyle(el) : null
  const hidden = !!(measure && (!box.width || !box.height || ['hidden', 'collapse'].includes(style.visibility) || style.display === 'none'))
  let inert = false
  const ancestors = new Set()
  for (let parent = el; parent && !ancestors.has(parent); parent = composedParent(parent)) {
    ancestors.add(parent)
    if (parent.inert || parent.hasAttribute?.('inert')) { inert = true; break }
  }
  const disabled = !!el.disabled || !!el.matches?.(':disabled') || el.getAttribute('aria-disabled') === 'true' || inert
  const readOnly = !!el.readOnly || el.getAttribute('aria-readonly') === 'true'
  const fileInput = el.tagName === 'INPUT' && el.type === 'file'
  const textInput = el.tagName === 'INPUT' && ['text', 'search', 'email', 'url', 'tel', 'password', 'number'].includes(el.type)
  const nativeValueInput = el.tagName === 'INPUT' && ['date', 'time', 'datetime-local', 'month', 'week'].includes(el.type)
  const nativeCheckable = el.tagName === 'INPUT' && ['checkbox', 'radio'].includes(el.type)
  const role = (el.getAttribute('role') || '').trim().split(/\s+/)[0]
  const state = controlState(el)
  const checkable = nativeCheckable || ['checkbox', 'switch', 'radio'].includes(role) && state.checked !== undefined
  const availableActions = []
  if (!disabled) {
    if (fileInput && !el.webkitdirectory) availableActions.push('uploadFiles')
    if (!hidden) {
      availableActions.push('click', 'press')
      if ((textInput || nativeValueInput || el.tagName === 'TEXTAREA' || el.isContentEditable) && !readOnly) availableActions.push('fill')
      if (checkable && !readOnly) availableActions.push('setChecked')
      if (el.tagName === 'SELECT' && !readOnly && [...el.options].some(option => !option.disabled && !(option.parentElement?.tagName === 'OPTGROUP' && option.parentElement.disabled))) availableActions.push('select')
    }
  }
  return { hidden, disabled, fileInput, nativeValueInput, availableActions, ...state }
}

export function fieldMetadata(el) {
  const password = el.tagName === 'INPUT' && el.type === 'password'
  const metadataTruncation = {}
  const bounded = (value, limit, key, normalize = true) => {
    const text = normalize ? String(value || '').replace(/\s+/g, ' ').trim() : String(value || '')
    metadataTruncation[key] = !!metadataTruncation[key] || text.length > limit
    return text.slice(0, limit)
  }
  const metadata = {
    required: !!el.required || el.getAttribute('aria-required') === 'true',
    readOnly: !!el.readOnly || el.getAttribute('aria-readonly') === 'true',
    ...controlState(el),
  }
  for (const key of ['minLength', 'maxLength']) if (Number.isInteger(el[key])) metadata[key] = el[key]
  for (const key of ['min', 'max', 'step', 'pattern']) if (typeof el[key] === 'string') metadata[key] = bounded(el[key], 300, key, false)
  if (typeof el.willValidate === 'boolean') metadata.willValidate = el.willValidate
  if (el.validity) {
    metadata.validity = {}
    for (const key of ['badInput', 'customError', 'patternMismatch', 'rangeOverflow', 'rangeUnderflow', 'stepMismatch', 'tooLong', 'tooShort', 'typeMismatch', 'valid', 'valueMissing']) metadata.validity[key] = !!el.validity[key]
  }
  if (typeof el.validationMessage === 'string') metadata.validationMessage = password && el.validationMessage ? '[redacted]' : bounded(el.validationMessage, 300, 'validationMessage')
  const invalid = el.getAttribute('aria-invalid')
  if (['true', 'false', 'grammar', 'spelling'].includes(invalid)) metadata.ariaInvalid = invalid
  const describe = (attribute, key) => {
    const ids = (el.getAttribute(attribute) || '').trim().split(/\s+/).filter(Boolean)
    metadataTruncation[key] = ids.length > 20
    const root = el.getRootNode?.() || el.ownerDocument
    const descriptions = []
    for (const [index, id] of ids.slice(0, 20).entries()) {
      const node = root?.getElementById?.(id)
      if (!node) continue
      // A page can echo a password into custom error or helper text.
      if (password) return '[redacted]'
      descriptions.push(bounded(node.textContent, 1000, key))
      if (descriptions.join(' ').length >= 1000) {
        metadataTruncation[key] ||= index < ids.length - 1
        break
      }
    }
    return bounded(descriptions.join(' '), 1000, key)
  }
  const description = el.getAttribute('aria-description')
  const helperText = describe('aria-describedby', 'helperText') || (password && description ? '[redacted]' : bounded(description, 1000, 'helperText')), errorText = describe('aria-errormessage', 'errorText')
  if (helperText) metadata.helperText = helperText
  if (errorText) metadata.errorText = errorText
  metadata.metadataTruncation = metadataTruncation
  return metadata
}

export function probeFormValue(el, type, value) {
  if (typeof value !== 'string') throw new Error('Form value must be a string')
  if (type === 'select') {
    if (el.tagName !== 'SELECT' || ![...el.options].some(option => option.value === value && !option.disabled && !(option.parentElement?.tagName === 'OPTGROUP' && option.parentElement.disabled))) throw new Error('Select option is unavailable')
    return { expectedValue: value }
  }
  const patterns = {
    date: /^\d{4,}-\d{2}-\d{2}$/,
    time: /^\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?$/,
    'datetime-local': /^\d{4,}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?$/,
    month: /^\d{4,}-\d{2}$/,
    week: /^\d{4,}-W\d{2}$/,
  }
  if (type !== 'fill' || el.tagName !== 'INPUT' || !patterns[el.type]) throw new Error('Element does not support native value assignment')
  if (value && !patterns[el.type].test(value)) throw new Error('Date/time value must use the canonical HTML format for this input type')
  // Keep the value attribute: it can be the step base when min is absent.
  const probe = el.cloneNode(false)
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  if (!setter) throw new Error('Native input value setter is unavailable')
  setter.call(probe, value)
  if (value && !probe.value) throw new Error('Date/time value is invalid for this input type')
  if (value && probe.validity && !probe.validity.valid) throw new Error('Date/time value violates the input constraints')
  return { expectedValue: probe.value }
}

export async function prepareElement({ ref, type, value, checked }) {
  const el = globalThis.__velmrenAgent?.refs.get(ref)
  if (!el?.isConnected || el.ownerDocument && el.ownerDocument !== document) throw new Error('Element reference is stale; observe again')
  if (elementCapabilities(el, false).disabled) throw new Error('Element is disabled')
  const validate = () => {
    const capabilities = elementCapabilities(el)
    if (capabilities.disabled) throw new Error('Element is disabled')
    if (capabilities.hidden) throw new Error('Element is not visible')
    if (!capabilities.availableActions.includes(type)) throw new Error('Element does not support this action')
    if (type === 'setChecked') {
      if (typeof checked !== 'boolean') throw new Error('Checked state must be a boolean')
      if (el.tagName === 'INPUT' && el.type === 'radio' && el.checked && !checked) throw new Error('Cannot unset a selected native radio; select another radio in its group')
    }
    return capabilities
  }
  let capabilities = validate(), preparedValue
  if (type === 'select' || type === 'fill' && capabilities.nativeValueInput) preparedValue = probeFormValue(el, type, value)
  el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  if (!el.isConnected || el.ownerDocument && el.ownerDocument !== document) throw new Error('Element reference is stale; observe again')
  capabilities = validate()
  preparedValue = type === 'select' || type === 'fill' && capabilities.nativeValueInput ? probeFormValue(el, type, value) : undefined
  const box = el.getBoundingClientRect()
  const x = Math.max(0, Math.min(innerWidth - 1, box.x + box.width / 2))
  const y = Math.max(0, Math.min(innerHeight - 1, box.y + box.height / 2))
  if (type === 'setChecked' && controlState(el).checked === checked) return { x, y, noOp: true }
  let hit = document.elementFromPoint(x, y)
  const seen = new Set()
  while (hit?.shadowRoot?.elementFromPoint && !seen.has(hit)) {
    seen.add(hit)
    const next = hit.shadowRoot.elementFromPoint(x, y)
    if (!next || next === hit) break
    hit = next
  }
  let containsHit = false
  const ancestors = new Set()
  for (let candidate = hit; candidate && !ancestors.has(candidate); candidate = composedParent(candidate)) {
    ancestors.add(candidate)
    if (candidate === el) { containsHit = true; break }
  }
  if (!containsHit && hit !== el && !el.contains?.(hit)) throw new Error('Element is obscured')
  if (type === 'fill') {
    el.focus({ preventScroll: true })
    if (!capabilities.nativeValueInput) {
      if (el.isContentEditable) {
        const range = document.createRange(); range.selectNodeContents(el)
        const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range)
      } else el.select()
    }
  }
  if (type === 'press') el.focus({ preventScroll: true })
  return { x, y, ...(preparedValue || {}), ...(type === 'fill' && capabilities.nativeValueInput ? { inputMode: 'native' } : {}) }
}

export function applyFormValue({ ref, type, value }) {
  const el = globalThis.__velmrenAgent?.refs.get(ref)
  if (!el?.isConnected || el.ownerDocument !== document) throw new Error('Element reference is stale; observe again')
  const capabilities = elementCapabilities(el)
  if (!capabilities.availableActions.includes(type)) throw new Error('Element does not support this action')
  const { expectedValue } = probeFormValue(el, type, value)
  const prototype = type === 'select' ? HTMLSelectElement.prototype : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set
  if (!setter) throw new Error('Native form value setter is unavailable')
  setter.call(el, expectedValue)
  el.dispatchEvent(new Event('input', { bubbles: true, composed: true }))
  el.dispatchEvent(new Event('change', { bubbles: true }))
  return { expectedValue }
}

export function verifyElementValue({ ref, type, value, checked }) {
  const el = globalThis.__velmrenAgent?.refs.get(ref)
  if (!el?.isConnected || el.ownerDocument !== document) return { scope: 'element', status: 'unavailable' }
  const matched = type === 'setChecked'
    ? typeof checked === 'boolean' && controlState(el).checked === checked
    : String(el.isContentEditable ? el.innerText : el.value ?? '') === value
  return { scope: 'element', status: matched ? 'matched' : 'mismatch' }
}

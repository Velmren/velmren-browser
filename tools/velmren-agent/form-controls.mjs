// These functions also run after toString() injection into an isolated world.
export function composedParent(el) {
  return el?.assignedSlot || el?.parentElement || el?.getRootNode?.()?.host || null
}

export function hasTransparentAncestor(el) {
  const seen = new Set()
  for (let node = el; node && !seen.has(node); node = composedParent(node)) {
    seen.add(node)
    if (getComputedStyle(node).opacity === '0') return true
  }
  return false
}

export function labelledCombobox(el) {
  if (el.tagName !== 'INPUT' || !['text', 'search'].includes(el.type) || el.getAttribute('role') !== 'combobox' || el.getAttribute('aria-haspopup') !== 'listbox') return false
  const ids = (el.getAttribute('aria-controls') || '').trim().split(/\s+/).filter(Boolean)
  const root = el.getRootNode?.() || el.ownerDocument
  const listbox = ids.length === 1 ? root?.getElementById?.(ids[0]) : null
  return !!(listbox?.isConnected && listbox.ownerDocument === el.ownerDocument && listbox.getAttribute('role') === 'listbox')
}

export function associatedControlLabels(el) {
  if (!(el.tagName === 'INPUT' && ['checkbox', 'radio'].includes(el.type)) && !labelledCombobox(el)) return []
  return [...(el.labels ?? [])].filter(label => {
    if (!label.isConnected || label.ownerDocument !== el.ownerDocument || label.control !== el) return false
    const capabilities = elementCapabilities(label)
    if (capabilities.hidden || capabilities.disabled) return false
    return !hasTransparentAncestor(label)
  })
}

export function checkableCard(el) {
  if (el.tagName !== 'INPUT' || !['checkbox', 'radio'].includes(el.type) || el.labels?.length) return null
  // Some card widgets render an unlabelled checkable under a small pointer
  // surface. Require a single field and no competing interactive descendants.
  let surface = composedParent(el)
  for (let depth = 0; surface && depth < 3; depth++, surface = composedParent(surface)) {
    if (surface.ownerDocument !== el.ownerDocument || surface.matches?.('body,html,form,fieldset,a,button,label,[role],[tabindex],[contenteditable="true"]')) return null
    const style = getComputedStyle(surface)
    if (style.pointerEvents === 'none' || style.opacity === '0' || ['hidden', 'collapse'].includes(style.visibility) || style.display === 'none') return null
    const text = (surface.innerText || '').replace(/\s+/g, ' ').trim()
    if (style.cursor !== 'pointer' || !text || text.length > 300) continue
    const parent = composedParent(surface)
    if (parent && getComputedStyle(parent).cursor === 'pointer') continue
    const fields = surface.querySelectorAll('a[href],button,input,select,textarea,[role],[tabindex],[onclick],[contenteditable="true"]')
    if (fields.length !== 1 || fields[0] !== el) return null
    const box = surface.getBoundingClientRect()
    if (!box.width || !box.height || box.width > 800 || box.height > 600) return null
    if (hasTransparentAncestor(surface)) return null
    return surface
  }
  return null
}

export function composedContains(el, candidate) {
  const seen = new Set()
  for (; candidate && !seen.has(candidate); candidate = composedParent(candidate)) {
    if (candidate === el) return true
    seen.add(candidate)
  }
  return false
}

export function controlHit(x, y) {
  let hit = document.elementFromPoint(x, y)
  const seen = new Set()
  while (hit?.shadowRoot?.elementFromPoint && !seen.has(hit)) {
    seen.add(hit)
    const next = hit.shadowRoot.elementFromPoint(x, y)
    if (!next || next === hit) break
    hit = next
  }
  return hit
}

export function decorativeControlHit(surface, hit, control) {
  if (!composedContains(surface, hit)) return false
  // Links, other fields and custom widgets are never decorative activation areas.
  for (let node = hit; node && node !== surface; node = composedParent(node)) {
    if (node === control) return true
    if (node.matches?.('a[href],button,input,select,textarea,[role],[tabindex],[contenteditable="true"]')) return false
  }
  return true
}

export function controlClientRects(el) {
  const rects = [...(el.getClientRects?.() ?? [el.getBoundingClientRect()])]
  if (rects.some(rect => rect.width && rect.height) || getComputedStyle(el).display !== 'contents') return rects
  // display:contents retains the control and its event path, but gives its box
  // to descendants. Do not confuse that with a hidden, zero-sized control.
  return [...(el.querySelectorAll?.('*') ?? [])].slice(0, 128).flatMap(child => {
    const style = getComputedStyle(child)
    return style.display === 'none' || ['hidden', 'collapse'].includes(style.visibility) || hasTransparentAncestor(child)
      ? [] : [...child.getClientRects()]
  })
}

export function controlIsInert(el) {
  const seen = new Set()
  for (let node = el; node && !seen.has(node); node = composedParent(node)) {
    seen.add(node)
    if (node.inert || node.hasAttribute?.('inert')) return true
    // A showModal() dialog escapes inherited inertness, never its own inert.
    if (node.tagName === 'DIALOG' && node.matches?.(':modal')) return false
  }
  return false
}

export function modalPaintHits(x, y, root = document) {
  return [...(root.elementsFromPoint?.(x, y) ?? [root.elementFromPoint?.(x, y)])].filter(Boolean)
}

export function modalPaintStacks(x, y) {
  const stacks = [], roots = [document], seen = new Set(roots)
  for (let index = 0; index < roots.length; index++) {
    const stack = modalPaintHits(x, y, roots[index])
    // A shadow subtree can straddle an external surface in paint order. Keep
    // each native stack, including external anchors and repeated host entries.
    stacks.push(stack)
    for (const hit of stack) if (hit.shadowRoot && !seen.has(hit.shadowRoot)) {
      seen.add(hit.shadowRoot); roots.push(hit.shadowRoot)
    }
  }
  return stacks
}

export function modalPaintPoints(scopes, nodes, target) {
  const points = [], seen = new Set()
  const add = node => {
    for (const box of controlClientRects(node).slice(0, 16)) {
      const left = Math.max(0, box.x), top = Math.max(0, box.y)
      const right = Math.min(innerWidth, box.x + box.width), bottom = Math.min(innerHeight, box.y + box.height)
      if (right <= left || bottom <= top) continue
      for (const [horizontal, vertical] of [[.5, .5], [.15, .5], [.85, .5], [.5, .2], [.5, .8]]) {
        const point = { x: left + (right - left) * horizontal, y: top + (bottom - top) * vertical }
        const key = `${point.x}:${point.y}`
        if (!seen.has(key)) { seen.add(key); points.push(point) }
      }
    }
  }
  add(target)
  for (const scope of scopes) add(scope)
  // Pointer-transparent modal roots still own painted interactive descendants.
  // Bounded witnesses may leave ordering ambiguous, never imply DOM ordering.
  for (const scope of scopes) {
    let witnesses = 0
    for (const node of nodes) {
      if (node === scope || !composedContains(scope, node)) continue
      const style = getComputedStyle(node)
      if (style.pointerEvents === 'none' || style.display === 'none' || ['hidden', 'collapse'].includes(style.visibility)) continue
      if (!controlClientRects(node).some(box => box.width && box.height)) continue
      add(node)
      if (++witnesses === 64) break
    }
  }
  return points
}

export function frontmostModal(scopes, points) {
  if (scopes.length === 1) return scopes[0]
  const above = new Map(scopes.map(scope => [scope, new Set()]))
  for (const { x, y } of points) {
    for (const stack of modalPaintStacks(x, y)) {
      const earlier = new Set()
      for (const hit of stack) {
        const owner = scopes.find(scope => composedContains(scope, hit))
        if (!owner) continue
        // Interleaved scope surfaces contribute both directions, so conflicting
        // evidence remains ambiguous instead of selecting the first occurrence.
        for (const previous of earlier) if (previous !== owner) above.get(previous).add(owner)
        earlier.add(owner)
      }
    }
  }
  const reaches = (start, target) => {
    const pending = [...above.get(start)], seen = new Set()
    for (let index = 0; index < pending.length; index++) {
      const node = pending[index]
      if (node === target) return true
      if (seen.has(node)) continue
      seen.add(node); pending.push(...above.get(node))
    }
    return false
  }
  const winners = scopes.filter(scope => scopes.every(other => other === scope || reaches(scope, other) && !reaches(other, scope)))
  return winners.length === 1 ? winners[0] : null
}

export function modalOwnsTarget(modal, el, nodes) {
  // Ownership belongs to the active scope, not an obscured sibling's control.
  return [modal, ...nodes.filter(node => composedContains(modal, node))].some(controller => {
    const ids = `${controller.getAttribute?.('aria-owns') ?? ''} ${controller.getAttribute?.('aria-expanded') === 'true' ? controller.getAttribute?.('aria-controls') ?? '' : ''}`.trim().split(/\s+/).filter(Boolean)
    return ids.some(id => {
      const target = controller.getRootNode?.().getElementById?.(id)
      return target?.isConnected && target.ownerDocument === el.ownerDocument && composedContains(target, el)
    })
  })
}

export function controlBlockedByModal(el) {
  const roots = [document], nodes = [], native = [], aria = []
  for (let index = 0; index < roots.length; index++) {
    for (const node of roots[index].querySelectorAll?.('*') ?? []) {
      nodes.push(node)
      if (node.shadowRoot) roots.push(node.shadowRoot)
      if (node.tagName === 'DIALOG' && node.matches?.(':modal')) { native.push(node); continue }
      if (!node.matches?.('[role="dialog"][aria-modal="true"],[role="alertdialog"][aria-modal="true"]')) continue
      const style = getComputedStyle(node)
      if (style.display === 'none' || ['hidden', 'collapse'].includes(style.visibility) || hasTransparentAncestor(node) || controlIsInert(node)) continue
      let hidden = false
      const seen = new Set()
      for (let parent = node; parent && !seen.has(parent); parent = composedParent(parent)) {
        seen.add(parent)
        if (parent.getAttribute?.('aria-hidden') === 'true') { hidden = true; break }
      }
      if (!hidden && controlClientRects(node).some(rect => rect.width && rect.height)) aria.push(node)
    }
  }
  if (!native.length && !aria.length) return false
  let active = null
  if (native.length === 1) active = native[0]
  else if (native.length) {
    const witnessed = new Set()
    for (const { x, y } of modalPaintPoints(native, nodes, el)) {
      const hit = controlHit(x, y)
      // Native modality makes every other dialog inert, including its backdrop.
      const owners = native.filter(modal => composedContains(modal, hit))
      const owner = owners.find(modal => !owners.some(other => other !== modal && composedContains(modal, other)))
      if (owner) witnessed.add(owner)
    }
    if (witnessed.size !== 1) throw new Error('Modal interaction scope is ambiguous')
    active = [...witnessed][0]
  }
  if (active && !composedContains(active, el)) return true
  let pending = aria.filter(modal => !active || composedContains(active, modal))
  const points = pending.length > 1 ? modalPaintPoints(pending, nodes, el) : []
  while (pending.length) {
    const siblings = pending.filter(modal => !pending.some(other => other !== modal && composedContains(other, modal)))
    const foreground = frontmostModal(siblings, points)
    if (!foreground) throw new Error('Modal interaction scope is ambiguous')
    active = foreground
    pending = pending.filter(modal => modal !== active && composedContains(active, modal))
  }
  return !!active && !composedContains(active, el) && !modalOwnsTarget(active, el, nodes)
}

export function focusedAutocompleteDecorationPoint(el, type, hit, point) {
  // Autosized autocomplete inputs can keep keyboard focus under their own
  // placeholder. Filling that existing focus needs no pointer activation.
  if (type !== 'fill' || el.tagName !== 'INPUT' || !['text', 'search'].includes(el.type) ||
      !['list', 'both'].includes(el.getAttribute('aria-autocomplete')) || !hit) return null
  let active = document.activeElement
  while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement
  if (active !== el) return null
  const box = el.getBoundingClientRect(), cover = hit.getBoundingClientRect()
  if (box.width > 8 || !box.width || !box.height || cover.height > box.height + 16 || getComputedStyle(hit).position === 'fixed') return null
  const interactive = 'a[href],button,input,select,textarea,[role],[tabindex],[onclick],[contenteditable="true"]'
  for (let surface = composedParent(el), depth = 0; surface && depth < 6; surface = composedParent(surface), depth++) {
    if (surface.matches?.(`body,html,form,fieldset,${interactive}`)) return null
    if (!composedContains(surface, hit)) continue
    const area = surface.getBoundingClientRect()
    if (area.height > box.height + 24 || area.width > innerWidth || !area.width || !area.height) return null
    if (cover.width > area.width + 16 || cover.x < area.x - 16 || cover.x + cover.width > area.x + area.width + 16 ||
        cover.y < area.y - 8 || cover.y + cover.height > area.y + area.height + 8) return null
    const controls = surface.querySelectorAll(interactive)
    if (controls.length !== 1 || controls[0] !== el || !decorativeControlHit(surface, hit, el) || hit.querySelector?.(interactive)) return null
    if (hasTransparentAncestor(surface) || getComputedStyle(surface).pointerEvents === 'none') return null
    return point
  }
  return null
}

export function controlActionPoint(el, type) {
  const point = box => ({ x: Math.max(0, Math.min(innerWidth - 1, box.x + box.width / 2)), y: Math.max(0, Math.min(innerHeight - 1, box.y + box.height / 2)) })
  const box = el.getBoundingClientRect(), center = point(box)
  const hit = controlHit(center.x, center.y)
  const rects = controlClientRects(el).slice(0, 128)
  // Test painted fragments, not the union box: an inline link can wrap around
  // whitespace, and a field's center can be covered while its edge is exposed.
  for (const rect of rects) {
    const left = Math.max(0, rect.x), top = Math.max(0, rect.y)
    const right = Math.min(innerWidth, rect.x + rect.width), bottom = Math.min(innerHeight, rect.y + rect.height)
    if (right <= left || bottom <= top) continue
    for (const [horizontal, vertical] of [[.5, .5], [.15, .5], [.85, .5], [.5, .2], [.5, .8]]) {
      const x = left + (right - left) * horizontal, y = top + (bottom - top) * vertical
      const candidate = controlHit(x, y)
      if (composedContains(el, candidate) || el.contains?.(candidate)) return { x, y }
    }
  }
  const keyboardPoint = focusedAutocompleteDecorationPoint(el, type, hit, center)
  if (keyboardPoint) return keyboardPoint
  if (el.tagName === 'SELECT' && type === 'select' && box.width && box.height) {
    const wrapper = el.parentElement
    // Accept an associated label or explicit decoration confined to the select.
    // A broad single-control container is not enough to establish ownership.
    const controls = wrapper?.querySelectorAll?.('input,select,textarea,button,a[href],[role],[tabindex],[contenteditable="true"]') ?? []
    if (controls.length === 1 && controls[0] === el && !wrapper.matches?.('[role],[tabindex],[contenteditable="true"]') && decorativeControlHit(wrapper, hit, el)) {
      if (wrapper.tagName === 'LABEL' && wrapper.control === el) return center
      const confined = node => {
        const rect = node.getBoundingClientRect?.()
        return rect && rect.x >= box.x - 2 && rect.y >= box.y - 2 && rect.x + rect.width <= box.x + box.width + 2 && rect.y + rect.height <= box.y + box.height + 2
      }
      if (confined(wrapper)) for (let node = hit; node && node !== wrapper; node = composedParent(node)) {
        if (node.getAttribute?.('aria-hidden') === 'true' && confined(node)) return center
      }
    }
  }
  if (['click', 'setChecked', 'press'].includes(type) || type === 'fill' && labelledCombobox(el)) {
    const card = checkableCard(el)
    for (const label of [...associatedControlLabels(el), ...(card ? [card] : [])]) {
      const rects = [...(label.getClientRects?.() ?? [label.getBoundingClientRect()])].slice(0, 20)
      for (const rect of rects) for (const [horizontal, vertical] of [[.5, .5], [.15, .5], [.85, .5], [.5, .2], [.5, .8]]) {
        const x = rect.x + rect.width * horizontal, y = rect.y + rect.height * vertical
        if (x < 0 || x >= innerWidth || y < 0 || y >= innerHeight) continue
        if (decorativeControlHit(label, controlHit(x, y), el)) return { x, y }
      }
    }
  }
  throw new Error('Element is obscured')
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
  const hasBox = measure && (box.width && box.height || style.display === 'contents' && controlClientRects(el).some(rect => rect.width && rect.height))
  const hidden = !!(measure && (!hasBox || ['hidden', 'collapse'].includes(style.visibility) || style.display === 'none' || hasTransparentAncestor(composedParent(el))))
  const inert = controlIsInert(el)
  let ariaDisabled = false
  const ancestors = new Set()
  for (let parent = el; parent && !ancestors.has(parent); parent = composedParent(parent)) {
    ancestors.add(parent)
    ariaDisabled ||= parent.getAttribute?.('aria-disabled') === 'true'
  }
  const disabled = !!el.disabled || !!el.matches?.(':disabled') || ariaDisabled || inert
  const readOnly = !!el.readOnly || el.getAttribute('aria-readonly') === 'true'
  const fileInput = el.tagName === 'INPUT' && el.type === 'file'
  const textInput = el.tagName === 'INPUT' && ['text', 'search', 'email', 'url', 'tel', 'password', 'number'].includes(el.type)
  const nativeValueInput = el.tagName === 'INPUT' && ['date', 'time', 'datetime-local', 'month', 'week'].includes(el.type)
  const nativeCheckable = el.tagName === 'INPUT' && ['checkbox', 'radio'].includes(el.type)
  const role = (el.getAttribute('role') || '').trim().split(/\s+/)[0]
  const state = controlState(el)
  const checkable = nativeCheckable || ['checkbox', 'switch', 'radio'].includes(role) && state.checked !== undefined
  const labelProxy = measure && (nativeCheckable || !hidden && labelledCombobox(el)) && associatedControlLabels(el).length > 0
  const cardProxy = measure && nativeCheckable ? checkableCard(el) : null
  const availableActions = []
  if (!disabled) {
    if (fileInput && !el.webkitdirectory) availableActions.push('uploadFiles')
    if (hidden && (labelProxy || cardProxy)) {
      availableActions.push('click')
      if (nativeCheckable && !readOnly) availableActions.push('setChecked')
    }
    if (!hidden) {
      availableActions.push('click', 'press')
      if ((textInput || nativeValueInput || el.tagName === 'TEXTAREA' || el.isContentEditable) && !readOnly) availableActions.push('fill')
      if (checkable && !readOnly) availableActions.push('setChecked')
      if (el.tagName === 'SELECT' && !readOnly && [...el.options].some(option => !option.disabled && !(option.parentElement?.tagName === 'OPTGROUP' && option.parentElement.disabled))) availableActions.push('select')
    }
  }
  return { hidden, disabled, fileInput, nativeValueInput, labelProxy, cardProxy, availableActions, ...state }
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
    if (capabilities.hidden && !capabilities.labelProxy && !capabilities.cardProxy) throw new Error('Element is not visible')
    if (!capabilities.availableActions.includes(type)) throw new Error('Element does not support this action')
    if (type === 'setChecked') {
      if (typeof checked !== 'boolean') throw new Error('Checked state must be a boolean')
      if (el.tagName === 'INPUT' && el.type === 'radio' && el.checked && !checked) throw new Error('Cannot unset a selected native radio; select another radio in its group')
    }
    return capabilities
  }
  let capabilities = validate(), preparedValue
  if (type === 'select' || type === 'fill' && capabilities.nativeValueInput) preparedValue = probeFormValue(el, type, value)
  const surface = capabilities.labelProxy ? associatedControlLabels(el)[0] : capabilities.cardProxy || el
  surface.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  if (!el.isConnected || el.ownerDocument && el.ownerDocument !== document) throw new Error('Element reference is stale; observe again')
  capabilities = validate()
  if (controlBlockedByModal(el)) throw new Error('Element is outside active modal')
  preparedValue = type === 'select' || type === 'fill' && capabilities.nativeValueInput ? probeFormValue(el, type, value) : undefined
  const box = el.getBoundingClientRect()
  const x = Math.max(0, Math.min(innerWidth - 1, box.x + box.width / 2))
  const y = Math.max(0, Math.min(innerHeight - 1, box.y + box.height / 2))
  if (type === 'setChecked' && controlState(el).checked === checked) return { x, y, noOp: true }
  controlActionPoint(el, type)
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
  const actionPoint = validatePreparedElement({ ref, type })
  return { ...actionPoint, ...(preparedValue || {}), ...(type === 'fill' && capabilities.nativeValueInput ? { inputMode: 'native' } : {}) }
}

export function validatePreparedElement({ ref, type, point, noOp, checked }) {
  const el = globalThis.__velmrenAgent?.refs.get(ref)
  if (!el?.isConnected || el.ownerDocument && el.ownerDocument !== document) throw new Error('Element reference is stale; observe again')
  const capabilities = elementCapabilities(el)
  if (capabilities.disabled) throw new Error('Element is disabled')
  if (capabilities.hidden && !capabilities.labelProxy && !capabilities.cardProxy) throw new Error('Element is not visible')
  if (!capabilities.availableActions.includes(type)) throw new Error('Element does not support this action')
  if (controlBlockedByModal(el)) throw new Error('Element is outside active modal')
  if (noOp && type === 'setChecked' && controlState(el).checked === checked) return
  const currentPoint = controlActionPoint(el, type)
  if (point && (point.x !== currentPoint.x || point.y !== currentPoint.y)) throw new Error('Element is obscured')
  if (type === 'press' || type === 'fill') {
    let active = document.activeElement
    while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement
    if (active !== el) throw new Error('Element could not receive keyboard focus')
  }
  return currentPoint
}

export function applyFormValue({ ref, type, value }) {
  const el = globalThis.__velmrenAgent?.refs.get(ref)
  if (!el?.isConnected || el.ownerDocument !== document) throw new Error('Element reference is stale; observe again')
  const capabilities = elementCapabilities(el)
  if (!capabilities.availableActions.includes(type)) throw new Error('Element does not support this action')
  const { expectedValue } = probeFormValue(el, type, value)
  if (controlBlockedByModal(el)) throw new Error('Element is outside active modal')
  controlActionPoint(el, type)
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

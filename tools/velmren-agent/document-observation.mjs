import { elementCapabilities, fieldMetadata, hasTransparentAncestor } from './form-controls.mjs'

export function documentRoots() {
  const roots = [document]
  for (let index = 0; index < roots.length; index++) {
    for (const element of roots[index].querySelectorAll('*')) {
      if (element.shadowRoot && !roots.includes(element.shadowRoot)) roots.push(element.shadowRoot)
    }
  }
  return roots
}

export function elementName(element, { cardProxy } = {}) {
  const root = element.getRootNode?.() ?? document
  const labelled = (element.getAttribute('aria-labelledby') ?? '').trim().split(/\s+/).filter(Boolean)
    .map(id => root.getElementById?.(id)?.textContent ?? document.getElementById?.(id)?.textContent ?? '').join(' ')
  const labels = [...(element.labels ?? [])].map(label => {
    const copy = label.cloneNode(true)
    for (const child of copy.querySelectorAll('input,textarea,select')) child.remove()
    return copy.textContent
  }).join(' ')
  const actionValue = element.tagName === 'INPUT' && ['button', 'submit', 'reset'].includes(element.type) ? element.value : ''
  const imageName = element.getAttribute('alt') || [...(element.querySelectorAll?.('img[alt],svg title') ?? [])]
    .filter(node => node.getAttribute('aria-hidden') !== 'true').slice(0, 5).map(node => node.getAttribute('alt') || node.textContent).join(' ')
  let name = labelled || element.getAttribute('aria-label') || labels || actionValue || element.getAttribute('placeholder') || element.innerText || cardProxy?.innerText || imageName || element.getAttribute('title')
  if (!name && element.isConnected && typeof getComputedStyle === 'function') {
    name = ['::before', '::after'].map(pseudo => {
      const content = getComputedStyle(element, pseudo).content
      return /^(["']).*\1$/.test(content) ? content.slice(1, -1) : ''
    }).join(' ').trim()
  }
  return (name || element.getAttribute('name') || '').replace(/\s+/g, ' ').trim()
}

export function visibleDocumentText(roots = documentRoots()) {
  const chunks = [document.body?.innerText ?? '']
  // innerText omits shadow trees. Read their rendered text separately; assigned
  // light-DOM nodes are already represented in the main document's innerText.
  for (const root of roots.slice(1)) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    const text = []
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!node.textContent.trim() || node.parentElement?.closest('script,style,noscript,template')) continue
      const style = getComputedStyle(node.parentElement ?? root.host)
      if (['hidden', 'collapse'].includes(style.visibility) || style.display === 'none') continue
      const range = document.createRange()
      range.selectNodeContents(node)
      if ([...range.getClientRects()].some(rect => rect.width > 0 && rect.height > 0)) text.push(node.textContent)
    }
    chunks.push(text.join(' ').replace(/\s+/g, ' ').trim())
  }
  return chunks.filter(Boolean).join('\n')
}

export function observeDocument({ readOnly = false, query = '', offset = 0, limit = 150, textOffset = 0, textLimit = 10000 } = {}) {
  const roots = documentRoots()
  const prior = globalThis.__velmrenAgent
  if (!readOnly) prior?.observer?.disconnect()
  const state = { refs: new Map(), revision: 0 }
  if (!readOnly) {
    state.observer = new MutationObserver(() => state.revision++)
    for (const root of roots) state.observer.observe(root, { subtree: true, childList: true, attributes: true, characterData: true })
    globalThis.__velmrenAgent = state
  }
  const needle = query.trim().toLowerCase()
  const elements = [], limits = { elements: limit, text: textLimit, name: 200, value: 300, options: 50, files: 10 }
  const counts = { eligibleElements: 0, matchedElements: 0, returnedElements: 0, hiddenElements: 0, truncatedNames: 0, truncatedValues: 0, truncatedMetadata: 0, omittedOptions: 0, truncatedOptionLabels: 0, truncatedOptionValues: 0, omittedFiles: 0 }
  const seen = new Set()
  const semantic = 'a,button,input,select,textarea,label,summary,[role],[contenteditable="true"],[tabindex],[onclick]'
  const interactive = 'a[href],button,input:not([type="hidden"]),select,textarea,label,summary,[tabindex],[onclick],[contenteditable="true"],[role="button"],[role="link"],[role="checkbox"],[role="radio"],[role="switch"],[role="combobox"],[role="option"],[role="menuitem"]'
  const styles = new WeakMap()
  const styleOf = element => {
    if (!styles.has(element)) styles.set(element, getComputedStyle(element))
    return styles.get(element)
  }
  for (const root of roots) for (const element of root.querySelectorAll('*')) {
    if (seen.has(element)) continue
    seen.add(element)
    const explicit = element.matches?.(semantic) ?? ['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'LABEL', 'SUMMARY'].includes(element.tagName)
    if (!explicit) {
      if (['HTML', 'BODY', 'SCRIPT', 'STYLE', 'TEMPLATE'].includes(element.tagName)) continue
      const style = styleOf(element), parent = element.assignedSlot || element.parentElement || root.host
      // A cursor is inherited. Expose its owning surface, not every text/icon
      // descendant, and leave containers of distinct native controls alone.
      if (style.cursor !== 'pointer' || style.pointerEvents === 'none' || parent && styleOf(parent).cursor === 'pointer' || hasTransparentAncestor(element)) continue
      if (parent?.closest?.(interactive)) continue
      if ([...(element.querySelectorAll?.(interactive) ?? [])].some(child => {
        const box = child.getBoundingClientRect(), childStyle = styleOf(child)
        return box.width && box.height && childStyle.display !== 'none' && !['hidden', 'collapse'].includes(childStyle.visibility)
      })) continue
    }
    const { hidden, disabled, fileInput, labelProxy, cardProxy, availableActions } = elementCapabilities(element)
    if (element.tagName === 'LABEL' && element.control?.type !== 'file') continue
    if (hidden && !fileInput && !labelProxy && !cardProxy) { counts.hiddenElements++; continue }
    counts.eligibleElements++
    const name = elementName(element, { cardProxy })
    if (needle && !`${name} ${element.getAttribute('name') ?? ''} ${element.getAttribute('role') ?? ''} ${element.type ?? ''}`.toLowerCase().includes(needle)) continue
    const matchIndex = counts.matchedElements++
    if (matchIndex < offset || elements.length >= limit) continue
    const ref = `e${elements.length + 1}`
    state.refs.set(ref, element)
    const value = element.type === 'password' ? '[redacted]' : fileInput ? '' : String(element.value ?? '')
    const truncation = { name: name.length > limits.name, value: value.length > limits.value }
    counts.truncatedNames += Number(truncation.name); counts.truncatedValues += Number(truncation.value)
    const metadata = fieldMetadata(element)
    truncation.metadata = Object.values(metadata.metadataTruncation ?? {}).some(Boolean)
    counts.truncatedMetadata += Number(truncation.metadata)
    const entry = { ref, tag: element.tagName.toLowerCase(), role: element.getAttribute('role') ?? '', name: name.slice(0, limits.name), type: element.type ?? '', value: value.slice(0, limits.value), disabled, hidden, availableActions, truncation,
      ...metadata, ...(cardProxy ? { interactionTarget: 'checkable_card' } : labelProxy && (hidden || element.getAttribute('role') === 'combobox') ? { interactionTarget: 'associated_label' } : {}), ...(!explicit ? { discovery: 'pointer_surface' } : {}), ...(root !== document ? { shadowRoot: 'open' } : {}) }
    if (fileInput) {
      const files = [...element.files]
      Object.assign(entry, { accept: element.accept, multiple: element.multiple, directory: element.webkitdirectory, files: files.slice(0, limits.files).map(file => ({ name: file.name, size: file.size })), fileCount: files.length })
      truncation.files = files.length > limits.files; counts.omittedFiles += Math.max(0, files.length - limits.files)
    }
    if (element.tagName === 'SELECT') {
      const options = [...element.options]
      entry.optionCount = options.length; truncation.options = options.length > limits.options
      counts.omittedOptions += Math.max(0, options.length - limits.options)
      entry.options = options.slice(0, limits.options).map(option => {
        const truncated = { label: option.label.length > limits.name, value: option.value.length > limits.value }
        counts.truncatedOptionLabels += Number(truncated.label); counts.truncatedOptionValues += Number(truncated.value)
        return { value: option.value.slice(0, limits.value), label: option.label.slice(0, limits.name), selected: option.selected,
          disabled: option.disabled || option.parentElement?.tagName === 'OPTGROUP' && option.parentElement.disabled,
          valueComplete: !truncated.value, truncation: truncated }
      })
    }
    elements.push(entry)
  }
  const text = visibleDocumentText(roots)
  const returnedText = text.slice(textOffset, textOffset + textLimit)
  counts.returnedElements = elements.length; counts.text = text.length; counts.returnedText = returnedText.length
  const nextOffset = offset + elements.length < counts.matchedElements ? offset + elements.length : null
  const nextTextOffset = textLimit > 0 && textOffset + returnedText.length < text.length ? textOffset + returnedText.length : null
  const truncated = offset > 0 || counts.matchedElements > elements.length || textOffset > 0 || text.length > returnedText.length || counts.truncatedNames > 0 || counts.truncatedValues > 0 || counts.truncatedMetadata > 0 || counts.omittedOptions > 0 || counts.truncatedOptionLabels > 0 || counts.truncatedOptionValues > 0 || counts.omittedFiles > 0
  return { url: location.href, title: document.title, text: returnedText, elements, revision: state.revision,
    complete: !truncated, truncated, limits, counts,
    pagination: { offset, limit, total: counts.matchedElements, nextOffset, query },
    textPagination: { offset: textOffset, limit: textLimit, total: text.length, nextOffset: nextTextOffset },
    coverage: { scope: 'frame', childFrames: 'separate_frame_observations', shadowRoots: 'open', closedShadowRoots: 'excluded', hiddenElements: 'excluded_except_file_inputs_and_associated_checkables', customControls: 'explicit_semantics_or_pointer_surfaces', elements: query ? 'query_matches' : 'eligible_elements', completeness: 'eligible_elements_and_visible_text' } }
}

export function listSelectOptions({ ref, revision, query = '', offset = 0, limit = 50 }) {
  const state = globalThis.__velmrenAgent
  if (!state || state.revision !== revision) throw new Error('Page changed since observation; observe again')
  const element = state.refs.get(ref)
  if (!element?.isConnected || element.ownerDocument !== document) throw new Error('Element reference is stale; observe again')
  if (element.tagName !== 'SELECT') throw new Error('Element reference is not a select')
  const needle = query.trim().toLowerCase()
  const matches = [...element.options].map((option, index) => ({ option, index }))
    .filter(({ option }) => !needle || `${option.label} ${option.value}`.toLowerCase().includes(needle))
  const options = []
  let characters = 0
  for (const { option, index } of matches.slice(offset, offset + limit)) {
    const valueComplete = option.value.length <= 65536
    const value = valueComplete ? option.value : undefined
    const label = option.label.slice(0, 1000)
    const size = (value?.length ?? 0) + label.length
    if (options.length && characters + size > 100000) break
    characters += size
    const disabled = option.disabled || option.parentElement?.tagName === 'OPTGROUP' && option.parentElement.disabled
    options.push({ index, ...(valueComplete ? { value } : {}), label, valueComplete, disabled, selected: option.selected, selectable: !disabled && valueComplete,
      truncation: { value: !valueComplete, label: label.length !== option.label.length },
      ...(!valueComplete ? { unsupported: 'Option value exceeds the supported action limit' } : {}) })
  }
  const nextOffset = offset + options.length < matches.length ? offset + options.length : null
  return { options, optionCount: element.options.length, pagination: { offset, limit, total: matches.length, nextOffset, query },
    complete: offset === 0 && options.length === matches.length && options.every(option => option.valueComplete && !option.truncation.label),
    contentTrust: 'untrusted' }
}

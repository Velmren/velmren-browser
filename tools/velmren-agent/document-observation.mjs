import { elementCapabilities, fieldMetadata } from './form-controls.mjs'

export function documentRoots() {
  const roots = [document]
  for (let index = 0; index < roots.length; index++) {
    for (const element of roots[index].querySelectorAll('*')) {
      if (element.shadowRoot && !roots.includes(element.shadowRoot)) roots.push(element.shadowRoot)
    }
  }
  return roots
}

export function elementName(element) {
  const root = element.getRootNode?.() ?? document
  const labelled = (element.getAttribute('aria-labelledby') ?? '').trim().split(/\s+/).filter(Boolean)
    .map(id => root.getElementById?.(id)?.textContent ?? document.getElementById?.(id)?.textContent ?? '').join(' ')
  const labels = [...(element.labels ?? [])].map(label => {
    const copy = label.cloneNode(true)
    for (const child of copy.querySelectorAll('input,textarea,select')) child.remove()
    return copy.textContent
  }).join(' ')
  return (labelled || element.getAttribute('aria-label') || labels || element.getAttribute('placeholder') || element.innerText || element.getAttribute('name') || '').replace(/\s+/g, ' ').trim()
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
  for (const root of roots) for (const element of root.querySelectorAll('a,button,input,select,textarea,label,[role],[contenteditable="true"]')) {
    if (seen.has(element)) continue
    seen.add(element)
    const { hidden, disabled, fileInput, availableActions } = elementCapabilities(element)
    if (element.tagName === 'LABEL' && element.control?.type !== 'file') continue
    if (hidden && !fileInput) { counts.hiddenElements++; continue }
    counts.eligibleElements++
    const name = elementName(element)
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
      ...metadata, ...(root !== document ? { shadowRoot: 'open' } : {}) }
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
    coverage: { scope: 'frame', childFrames: 'separate_frame_observations', shadowRoots: 'open', closedShadowRoots: 'excluded', hiddenElements: 'excluded_except_file_inputs', elements: query ? 'query_matches' : 'eligible_elements', completeness: 'eligible_elements_and_visible_text' } }
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

import { sanitizeActionResult, sanitizeWaitResult } from './action-result.mjs'
import { sanitizeDiagnostic, sanitizeErrorContext } from './operation-error.mjs'
import { inflateSync } from 'node:zlib'

const invalidUrl = '[invalid URL]'
const privateUrl = '[redacted URL]'
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const identifier = value => typeof value === 'string' && (uuid.test(value) || /^[0-9a-f]{32}$/i.test(value))
const ref = value => typeof value === 'string' && /^e[1-9][0-9]{0,8}$/.test(value)
const urlKey = key => /(?:url|uri|href|src|origin)$/i.test(key)
const privateKeys = new Set(['secret', 'secretRef', 'password', 'token', 'adminToken', 'apiKey', 'clientKey', 'encryptedKey', 'authorization', 'cookie', '__proto__', 'constructor', 'prototype'])
const entities = { amp: '&', colon: ':', sol: '/', bsol: '\\', percnt: '%', quest: '?', num: '#', commat: '@', period: '.', equals: '=', tab: '\t', newline: '\n' }
const urlStart = /(?:https?:|wss?:|ftp:|file:|blob:|data:|javascript:|about:|mailto:|tel:|sms:|urn:|[a-z][a-z0-9+.-]*:[/\\])|(?<![:/\\])[/\\]{2}/i
const knownUrlStart = /https?:|wss?:|ftp:|file:|blob:|data:|javascript:|about:|mailto:|tel:|sms:|urn:/i

// Decode URL spelling, not arbitrary page content. A token is replaced only
// when its decoded spelling contains a URL; its entire tail is then private.
function decodeUrlSpelling(value) {
  for (let pass = 0; pass < 32; pass++) {
    const next = value.replace(/%([0-9a-f]{2})|\\(?:u\{([0-9a-f]{1,6})\}|u([0-9a-f]{4})|x([0-9a-f]{2})|([/\\]))|&#(x[0-9a-f]+|[0-9]+);?|&([a-z]+);/gi,
      (match, percent, braced, unicode, hex, slash, numeric, named) => {
        if (slash) return slash
        if (named) return entities[named.toLowerCase()] ?? match
        const point = percent ? parseInt(percent, 16) : numeric ? (numeric[0].toLowerCase() === 'x' ? parseInt(numeric.slice(1), 16) : Number(numeric)) : parseInt(braced ?? unicode ?? hex, 16)
        // Keep UTF-8 URL bytes intact for URL's host/IDNA parser.
        return point <= 0x10ffff && (!percent || point < 128) ? String.fromCodePoint(point) : match
      })
    if (next === value) return value
    value = next
  }
  return undefined
}

// An unknown path can contain a credential. No path or parameter is public.
export function safePublicUrl(raw) {
  if (typeof raw !== 'string') return invalidUrl
  const decoded = decodeUrlSpelling(raw)
  if (decoded === undefined) return privateUrl
  if (decoded === 'about:blank' || decoded === 'about:srcdoc') return decoded
  try {
    const parsed = new URL(decoded)
    return ['http:', 'https:'].includes(parsed.protocol) ? parsed.origin : privateUrl
  } catch { return invalidUrl }
}

const publicText = value => value.replace(/\S+/g, token => {
  const decoded = decodeUrlSpelling(token)
  if (decoded === undefined) return privateUrl
  const match = urlStart.exec(decoded)
  if (!match) return token
  const start = match.index + (knownUrlStart.exec(match[0])?.index ?? 0)
  return decoded.slice(0, start) + safePublicUrl(decoded.slice(start))
})

const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
const maxPngBytes = 64 * 1024 * 1024
const pngDepths = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] }
const pngChannels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }
const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  return value >>> 0
})

function pngLayout(header) {
  const width = header.readUInt32BE(0), height = header.readUInt32BE(4), depth = header[8], color = header[9]
  if (!width || !height || width > 32768 || height > 32768 || width * height > 16 * 1024 * 1024 ||
      !pngDepths[color]?.includes(depth) || header[10] !== 0 || header[11] !== 0 || header[12] > 1) return undefined
  const pattern = header[12] ? [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]] : [[0, 0, 1, 1]]
  const passes = []
  let size = 0
  for (const [x, y, dx, dy] of pattern) {
    const columns = Math.max(0, Math.ceil((width - x) / dx)), rows = Math.max(0, Math.ceil((height - y) / dy))
    if (!columns || !rows) continue
    const rowBytes = Math.ceil(columns * pngChannels[color] * depth / 8)
    size += rows * (rowBytes + 1)
    if (size > maxPngBytes) return undefined
    passes.push({ columns, rows, rowBytes })
  }
  return { size, passes, depth, color }
}

function pngPixels(chunks, layout, paletteSize) {
  try {
    const compressed = Buffer.concat(chunks)
    // Bound inflation by the exact dimensions before allocating any pixels.
    const { buffer: pixels, engine } = inflateSync(compressed, { maxOutputLength: layout.size, info: true })
    if (pixels.length !== layout.size || engine.bytesWritten !== compressed.length) return false
    let offset = 0
    for (const { columns, rows, rowBytes } of layout.passes) {
      let previous = layout.color === 3 ? Buffer.alloc(rowBytes) : undefined
      for (let row = 0; row < rows; row++) {
        const filter = pixels[offset++]
        if (filter > 4) return false
        if (layout.color === 3) {
          const current = Buffer.alloc(rowBytes)
          for (let index = 0; index < rowBytes; index++) {
            const left = index ? current[index - 1] : 0, above = previous[index], diagonal = index ? previous[index - 1] : 0
            const predictor = left + above - diagonal
            const leftDistance = Math.abs(predictor - left), aboveDistance = Math.abs(predictor - above), diagonalDistance = Math.abs(predictor - diagonal)
            const paeth = leftDistance <= aboveDistance && leftDistance <= diagonalDistance ? left : aboveDistance <= diagonalDistance ? above : diagonal
            let value = pixels[offset + index]
            if (filter === 1) value += left
            else if (filter === 2) value += above
            else if (filter === 3) value += Math.floor((left + above) / 2)
            else if (filter === 4) value += paeth
            current[index] = value
          }
          for (let column = 0; column < columns; column++) {
            const bit = column * layout.depth, sample = current[bit >> 3] >> (8 - layout.depth - (bit & 7)) & ((1 << layout.depth) - 1)
            if (sample >= paletteSize) return false
          }
          previous = current
        }
        offset += rowBytes
      }
    }
    return offset === pixels.length
  } catch { return false }
}

function pngData(descriptors) {
  if (descriptors.mimeType?.value !== 'image/png' || descriptors.type && descriptors.type.value !== 'image') return undefined
  const data = descriptors.data?.value
  if (typeof data !== 'string' || data.length > Math.ceil(maxPngBytes / 3) * 4 || data.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) return undefined
  const bytes = Buffer.from(data, 'base64')
  if (bytes.toString('base64') !== data || bytes.length < 57 || !bytes.subarray(0, 8).equals(pngSignature)) return undefined
  let offset = 8, layout, paletteSize = 0, pixelsEnded = false, chunkCount = 0
  const chunks = []
  while (offset + 12 <= bytes.length) {
    if (++chunkCount > 4096) return undefined
    const length = bytes.readUInt32BE(offset), type = bytes.toString('ascii', offset + 4, offset + 8)
    if (length > bytes.length - offset - 12 || !/^[A-Za-z]{2}[A-Z][A-Za-z]$/.test(type)) return undefined
    let crc = 0xffffffff
    for (let index = offset + 4; index < offset + 8 + length; index++) crc = crcTable[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8)
    if (((crc ^ 0xffffffff) >>> 0) !== bytes.readUInt32BE(offset + 8 + length)) return undefined
    if (!layout) {
      if (type !== 'IHDR' || length !== 13) return undefined
      layout = pngLayout(bytes.subarray(offset + 8, offset + 21))
      if (!layout) return undefined
    } else if (type === 'IHDR') return undefined
    else if (type === 'PLTE') {
      if (paletteSize || chunks.length || !length || length % 3 || length > 768 || [0, 4].includes(layout.color)) return undefined
      paletteSize = length / 3
      if (layout.color === 3 && paletteSize > 2 ** layout.depth) return undefined
    } else if (type === 'IDAT') {
      if (pixelsEnded || layout.color === 3 && !paletteSize) return undefined
      chunks.push(bytes.subarray(offset + 8, offset + 8 + length))
    } else {
      if (chunks.length) pixelsEnded = true
      if (type !== 'IEND' && type[0] === type[0].toUpperCase()) return undefined
    }
    offset += length + 12
    if (type === 'IEND') return length === 0 && chunks.length && offset === bytes.length && pngPixels(chunks, layout, paletteSize) ? data : undefined
  }
  return undefined
}
const errorMessages = Object.freeze({
  CAPTCHA_AUTH_REQUIRED: 'Save a valid CapSolver key in the local settings.',
  CAPTCHA_NO_BALANCE: 'The CapSolver account has insufficient balance.',
  CAPTCHA_PROVIDER_ERROR: 'The CAPTCHA provider could not complete the request.',
  CAPTCHA_DELIVERY_UNCERTAIN: 'The provider request may have been accepted. Do not repeat it automatically.',
  CAPTCHA_TIMEOUT: 'The CAPTCHA operation timed out; its result may be unknown.',
  CAPTCHA_CANCELLED: 'CAPTCHA delivery was cancelled. A dispatched attempt may still be charged.',
  CAPTCHA_LIMIT_REACHED: 'The configured CAPTCHA attempt limit was reached.',
  CAPTCHA_ALREADY_ATTEMPTED: 'This challenge already has a paid attempt. Inspect its result.',
  CAPTCHA_DISABLED: 'Enable CapSolver in the local settings first.',
  CAPTCHA_STORAGE_UNAVAILABLE: 'Local encrypted service storage is unavailable.',
  CAPTCHA_STALE: 'The CAPTCHA destination changed; its solution was not applied.',
  CAPTCHA_ALREADY_SOLVED: 'This widget already has a solution.',
  CAPTCHA_UNSUPPORTED: 'This CAPTCHA variant cannot be delivered by this integration.',
  CAPTCHA_CONTEXT_UNAVAILABLE: 'The CAPTCHA document is unavailable.',
  CAPTCHA_PAGE_FAILED: 'The CAPTCHA widget operation failed.',
  CAPTCHA_INVALID_TOKEN: 'The provider returned an invalid solution.',
  CAPTCHA_BUSY: 'This browser task already has a pending CAPTCHA job.',
  BROKER_ERROR: 'Browser operation failed.',
  BROKER_INCOMPATIBLE: 'The running broker lacks this agent protocol. Reconnect after existing clients finish and the old broker exits.',
  TOOL_ERROR: 'Browser tool failed.',
  CLI_ERROR: 'Browser command failed.',
  INVALID_ARGUMENTS: 'Invalid browser operation arguments.',
  INVALID_STATE: 'Task state changed; inspect the task before continuing.',
  NOT_FOUND: 'Task, page, frame, or session was not found.',
  UNAUTHORIZED: 'This client is not authorized for the operation.',
  ORIGIN_DENIED: 'Origin is not permitted by the local policy.',
  PAGE_DETACHED: 'Page or frame changed; observe again.',
  LIMIT_REACHED: 'Browser task limit reached.',
  UNKNOWN_METHOD: 'Unknown browser method.',
  POLICY_MISMATCH: 'Browser policy does not match the requested policy.',
  CONNECTION_ERROR: 'Browser connection interrupted; verify the outcome before retrying.',
  BROWSER_CLOSED: 'Browser closed; inspect task state before continuing.',
  NAVIGATION_FAILED: 'Page navigation failed; inspect the destination and task state.',
  NAVIGATION_TIMEOUT: 'Page navigation timed out; inspect the task before retrying.',
  INVALID_RESPONSE: 'Browser returned an invalid response.',
  ACTION_FAILED: 'Action failed; inspect the delivery receipt before retrying.',
  PROFILE_LOGIN_ACTIVE: 'Manual profile login is active.',
  PROFILE_LOGIN_BUSY: 'Finish active tasks before starting profile login.',
  PROFILE_LOGIN_POLICY: 'The browser policy does not permit profile login.',
  PROFILE_LOGIN_UNAVAILABLE: 'Manual profile login is unavailable.',
  PROFILE_LOGIN_RESTART_FAILED: 'Browser could not resume after profile login.',
  PROFILE_LOGIN_BROWSER_NOT_EXITED: 'Automated browser has not exited.',
  SENSITIVE_PHASE_ACTIVE: 'Page content is suppressed during the sensitive phase.',
  SENSITIVE_OUTPUT_BLOCKED: 'Page content is suppressed during the sensitive phase.',
  SENSITIVE_SCREENSHOT_BLOCKED: 'Screenshots are unavailable during the sensitive phase.',
  INVALID_SECRET_REF: 'Private input reference is invalid or unavailable.',
  SECRET_REF_EXPIRED: 'Private input reference expired.',
  SECRET_REF_CONSUMED: 'Private input reference has already been consumed.',
  SECRET_BINDING_MISMATCH: 'Private input no longer matches the intended field or origin.',
  SECRET_RESOLUTION_FAILED: 'Private input could not be resolved.',
  STALE_OBSERVATION: 'Page observation changed; observe again.',
  STALE_SENSITIVE_PHASE: 'Sensitive phase changed; inspect its current state.',
  PRIVATE_INPUT_UNAVAILABLE: 'Private input is unavailable or expired.',
  PRIVATE_INPUT_BINDING_CHANGED: 'Private input no longer matches its destination.',
  PRIVATE_INPUT_LIMIT: 'Too many private inputs are pending.',
  SENSITIVE_PHASE_STALE: 'Sensitive phase changed; inspect its current state.',
  SENSITIVE_DOCUMENT_CHANGED: 'Document changed; obtain the current document ID.',
  SENSITIVE_DOCUMENTS_REMAIN: 'Close other task pages and dialogs before revealing a safe destination.',
  SENSITIVE_TRANSITION_REQUIRED: 'Observe the protected page, then reach a known safe new document before revealing content.',
  SENSITIVE_ORIGIN_MISMATCH: 'The safe destination origin does not match.',
  TARGET_POLICY_FAILED: 'Target policy could not be enforced; inspect the task diagnostics.',
  CDP_TIMEOUT: 'Browser command timed out; inspect task state and delivery before continuing.',
  CDP_SESSION_CLOSED: 'Browser target session closed; inspect the remaining task pages.',
  CDP_PROTOCOL_ERROR: 'Browser protocol command failed.',
  MANUAL_PROFILE_ACTIVE: 'Manual profile login is active.',
  MANUAL_PROFILE_IN_USE: 'The manual profile is still in use.',
  MANUAL_PROFILE_OPEN: 'The manual profile window is still open.',
  MANUAL_PROFILE_STILL_OPEN: 'The manual profile window is still open.',
  MANUAL_PROFILE_RECOVERY_REQUIRED: 'Manual profile recovery requires explicit confirmed completion.',
  OWNERSHIP_MISMATCH: 'Managed runtime ownership does not match.',
  USER_CONFIRMATION_REQUIRED: 'Explicit user confirmation is required.',
  ELEMENT_OBSCURED: 'Element is obscured by another control.',
  ELEMENT_DISABLED: 'Element is disabled.',
  ELEMENT_HIDDEN: 'Element is not visible.',
  ELEMENT_UNAVAILABLE: 'Element is hidden, disabled, or no longer available.',
  TASK_FORBIDDEN: 'This client cannot access the requested task.'
})
const trustedMessages = new Set(['Task not found', 'Page not found in this task', 'Task already ended', 'Task is paused',
  'Task or client state changed; observe again', 'Task state or page session changed; wait stopped',
  'Client credential was released', 'Client lease expired', 'Unknown method', 'Unsupported task method'])

const ids = new Set(['id', 'taskId', 'targetId', 'pageId', 'frameId', 'parentFrameId', 'mainFrameId', 'selectedPageId', 'openerId', 'observationId', 'phaseId', 'documentId', 'handoffId', 'loginId', 'chooserId', 'requestId', 'clientId', 'guid'])
const containers = new Set(['observation', 'tasks', 'pages', 'frames', 'elements', 'downloads', 'dialog', 'privacy', 'sensitivePhase', 'handoff', 'fileChooser', 'coverage', 'pagination', 'textPagination', 'limits', 'counts', 'truncation', 'metadataTruncation', 'validity', 'recovery', 'results', 'lastObserved', 'profileLogin', 'targetPolicy'])
const booleans = new Set(['ok', 'active', 'sensitive', 'redacted', 'suppressed', 'attached', 'main', 'disabled', 'hidden', 'required', 'readOnly', 'checked', 'selected', 'expanded', 'pressed', 'multiple', 'directory', 'complete', 'truncated', 'verified', 'matched', 'exists', 'enabled', 'visible', 'valueMatches', 'textMatches', 'sharedProfile', 'shown', 'windowOpen', 'automationConnected', 'recoveryRequired', 'cleanupPending', 'observe', 'willValidate', 'badInput', 'customError', 'patternMismatch', 'rangeOverflow', 'rangeUnderflow', 'stepMismatch', 'tooLong', 'tooShort', 'typeMismatch', 'valid', 'valueMissing'])
const numbers = new Set(['completed', 'failedIndex', 'index', 'elapsedMs', 'generation', 'offset', 'limit', 'total', 'nextOffset', 'eligibleElements', 'matchedElements', 'returnedElements', 'hiddenElements', 'truncatedNames', 'truncatedValues', 'truncatedMetadata', 'omittedOptions', 'truncatedOptionLabels', 'truncatedOptionValues', 'omittedFiles', 'returnedText', 'text', 'elements', 'name', 'value', 'options', 'files', 'size', 'fileCount', 'optionCount', 'receivedBytes', 'totalBytes', 'minLength', 'maxLength', 'activeActions', 'maxTasks', 'maxActiveActions'])
const choices = {
  state: ['agent-active', 'paused', 'needs-human', 'human', 'completed', 'cancelled', 'inProgress', 'interrupted', 'failed', 'exists', 'enabled', 'visible', 'value', 'text'],
  phase: ['sensitive', 'normal', 'active', 'inactive', 'automated', 'manual', 'awaiting-confirmation', 'worker-ancestor-policy', 'descendant-attachment', 'service-worker-bypass', 'request-interception', 'file-chooser-interception', 'service-worker-acknowledgement', 'navigation-resume', 'classification', 'page-initialization', 'ready'],
  targetType: ['page', 'other', 'iframe', 'worker', 'service_worker', 'shared_worker', 'unsupported'],
  type: ['click', 'fill', 'select', 'press', 'setChecked', 'handleDialog', 'uploadFiles', 'navigate', 'alert', 'confirm', 'prompt', 'beforeunload', 'text', 'search', 'email', 'url', 'tel', 'password', 'number', 'date', 'time', 'datetime-local', 'month', 'week', 'checkbox', 'radio', 'file', 'button', 'submit', 'reset', 'range', 'color', 'hidden', 'textarea', 'select-one', 'select-multiple'],
  tag: ['a', 'button', 'input', 'select', 'textarea', 'label', 'div', 'span'],
  role: ['button', 'checkbox', 'radio', 'switch', 'textbox', 'combobox', 'listbox', 'option', 'link', 'slider', 'spinbutton', 'tab', 'menuitem'],
  delivery: ['not_delivered', 'delivery_uncertain', 'delivered_unverified', 'delivered_verified', 'unknown'],
  status: ['matched', 'mismatch', 'unavailable'],
  retry: ['none', 'failed_action_only'],
  reason: ['not_dispatched', 'delivery_uncertain', 'verify_outcome', 'completed', 'state_changed', 'transport_unknown', 'observation_unavailable', 'command-timeout', 'session-closed', 'unsupported-command', 'enforcement-failed', 'session-replaced', 'target-closed', 'session-detached', 'unsupported-target'],
  stopped: ['dialog', 'observation_unavailable'],
  scope: ['element', 'frame', 'main_frame', 'selected_frame'],
  blocked: ['dialog', 'observation_unavailable', 'sensitive_phase'],
  mode: ['selectSingle', 'selectMultiple'],
  profileMode: ['persistent', 'isolated'],
  contentTrust: ['untrusted'],
  shadowRoot: ['open'],
  ariaInvalid: ['true', 'false', 'grammar', 'spelling'],
  checked: ['mixed'], pressed: ['mixed'],
  owner: ['admin', 'codex', 'claude', 'scripts']
}
for (const key of ['jobId', 'challengeId']) ids.add(key)
for (const key of ['captchaStats', 'challenges', 'receipt']) containers.add(key)
for (const key of ['supported', 'alreadySolved', 'applied', 'callbackInvoked', 'deliveryUncertain', 'persisted']) booleans.add(key)
for (const key of ['solutionsDelivered', 'failed', 'cancelled', 'uncertain']) numbers.add(key)
choices.status.push('pending', 'delivered', 'failed', 'cancelled', 'uncertain')
choices.provider = ['capsolver', 'recaptcha-v2', 'recaptcha-v2-enterprise', 'turnstile', 'unsupported']
choices.code = Object.keys(errorMessages)
choices.reason.push('hcaptcha', 'cloudflare-interstitial', 'unknown-provider', 'ambiguous-widget', 'conflicting-sitekey', 'conflicting-provider', 'missing-sitekey', 'invisible-widget', 'callback-unavailable', 'unsupported-metadata', 'ambiguous-response-field', 'response-target-unavailable', 'widget-removed', 'already-solved')
const enums = new Map(Object.entries(choices).map(([key, values]) => [key, new Set(values)]))
const actions = new Set(['click', 'fill', 'select', 'press', 'setChecked', 'uploadFiles'])

// This is a projection, not secret recognition. The caller owns phase lifetime.
export function sanitizePublicResult(value, { sensitive = false } = {}) {
  const seen = new WeakSet()
  const project = (input, key = '', depth = 0, parent = '') => {
    if (depth > 32 || privateKeys.has(key)) return undefined
    if (key === 'diagnostic') return sanitizeDiagnostic(input)
    if (key === 'actionResult') return sanitizeActionResult(input)
    if (key === 'waitResult') {
      const clean = sanitizeWaitResult(input)
      return clean && (!sensitive || identifier(clean.pageId)) ? clean : undefined
    }
    if (key === 'error' || key === 'cleanupError') return errorMessages.BROKER_ERROR
    if (key === 'code') return typeof input === 'string' && Object.hasOwn(errorMessages, input) ? input : 'BROKER_ERROR'
    if (sensitive) {
      if (ids.has(key)) return input === null ? null : identifier(input) ? input : undefined
      if (key === 'ref') return ref(input) ? input : undefined
      if (key === 'owner' && identifier(input)) return input
      if (key === 'availableActions') return Array.isArray(input) ? input.filter(item => actions.has(item)) : undefined
      if (['url', 'href', 'src', 'origin'].includes(key)) return safePublicUrl(input)
      if (typeof input === 'boolean') return booleans.has(key) ? input : undefined
      if (typeof input === 'number') {
        // Text/value/name counts belong only to the counts/limits containers.
        const countOnly = ['text', 'elements', 'name', 'value', 'options', 'files'].includes(key)
        return numbers.has(key) && (!countOnly || ['counts', 'limits'].includes(parent)) && Number.isSafeInteger(input) && input >= 0 ? input : undefined
      }
      if (typeof input === 'string') return enums.get(key)?.has(input) ? input : undefined
      if (input === null) return ['nextOffset', 'failedIndex', 'completed', 'windowOpen'].includes(key) ? null : undefined
      if (key && !containers.has(key)) return undefined
    } else {
      if (urlKey(key)) return safePublicUrl(input)
      if (typeof input === 'string') return publicText(input)
      if (typeof input === 'boolean' || input === null) return input
      if (typeof input === 'number') return Number.isFinite(input) ? input : undefined
    }
    if (!input || typeof input !== 'object' || seen.has(input)) return undefined
    if (input instanceof Error) return sanitizePublicError(input, { sensitive })
    seen.add(input)
    try {
      if (Array.isArray(input)) {
        const output = []
        for (let index = 0; index < input.length; index++) {
          const descriptor = Object.getOwnPropertyDescriptor(input, index)
          if (!descriptor || !Object.hasOwn(descriptor, 'value')) continue
          const clean = project(descriptor.value, '', depth + 1, key)
          if (clean !== undefined) output.push(clean)
        }
        return output
      }
      const output = {}
      const descriptors = Object.getOwnPropertyDescriptors(input)
      const png = sensitive ? undefined : pngData(descriptors)
      const declaredPng = descriptors.mimeType?.value === 'image/png' && (!descriptors.type || descriptors.type.value === 'image')
      for (const [name, descriptor] of Object.entries(descriptors)) {
        if (!Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) continue
        // PNG base64 can contain "//"; it is binary transport, not URL text.
        const clean = declaredPng && name === 'data' ? png : project(descriptor.value, name, depth + 1, key)
        // Page-controlled metadata can put a URL in the key as well as its value.
        const publicName = sensitive ? name : publicText(name)
        if (clean !== undefined && !privateKeys.has(publicName) && !Object.hasOwn(output, publicName)) Object.defineProperty(output, publicName, { value: clean, enumerable: true, writable: true, configurable: true })
      }
      return output
    } finally { seen.delete(input) }
  }
  return project(value)
}

export function sanitizePublicError(error, { sensitive = false } = {}) {
  const own = key => error && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, key)?.value : undefined
  const candidate = own('code')
  const message = own('message')
  const code = typeof candidate === 'string' && Object.hasOwn(errorMessages, candidate) ? candidate : 'BROKER_ERROR'
  const actionResult = sanitizeActionResult(own('actionResult'))
  const waitResult = sanitizeWaitResult(own('waitResult'))
  return { error: typeof message === 'string' && (trustedMessages.has(message) || /^Task is (?:agent-active|paused|needs-human|human|completed|cancelled); agent actions are paused$/.test(message)) ? message : errorMessages[code], code,
    ...sanitizeErrorContext(error),
    ...(actionResult ? { actionResult } : {}),
    ...(waitResult && (!sensitive || identifier(waitResult.pageId)) ? { waitResult } : {}) }
}

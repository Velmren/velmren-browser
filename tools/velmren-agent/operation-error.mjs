const reasons = new Set(['detached', 'stale', 'obscured', 'disabled', 'hidden', 'navigation', 'transport', 'timeout', 'dialog', 'state', 'invalid', 'unsupported', 'unknown'])
for (const reason of ['observation-changed', 'document-changed', 'target-changed', 'origin-mismatch', 'unsupported-control', 'target-unavailable', 'binding-changed', 'capability-unavailable', 'value-unavailable', 'reader-failed', 'phase-stale', 'protected-documents-remain', 'baseline-unavailable', 'new-document-required', 'safe-reveal-required']) reasons.add(reason)
const phases = new Set(['validation', 'create', 'attach', 'navigate', 'observe', 'prepare', 'input', 'verify', 'cleanup', 'wait', 'protocol'])
const stages = new Set(['private_connect', 'private_prepare', 'private_read', 'private_provide', 'private_consume', 'private_revoke', 'sensitive_end'])
const obstructions = new Set(['modal-scope', 'ambiguous-modal-scope', 'hit-test', 'frame-hit-test'])
const networkErrors = new Set(['ERR_ABORTED', 'ERR_CONNECTION_CLOSED', 'ERR_CONNECTION_RESET', 'ERR_CONNECTION_REFUSED', 'ERR_CONNECTION_TIMED_OUT', 'ERR_TIMED_OUT', 'ERR_NAME_NOT_RESOLVED', 'ERR_INTERNET_DISCONNECTED', 'ERR_NETWORK_CHANGED', 'ERR_ADDRESS_UNREACHABLE', 'ERR_SSL_PROTOCOL_ERROR', 'ERR_CERT_AUTHORITY_INVALID', 'ERR_CERT_DATE_INVALID', 'ERR_CERT_COMMON_NAME_INVALID', 'ERR_BLOCKED_BY_CLIENT', 'ERR_BLOCKED_BY_RESPONSE', 'ERR_TOO_MANY_REDIRECTS', 'ERR_HTTP_RESPONSE_CODE_FAILURE', 'ERR_EMPTY_RESPONSE'])
const own = (value, key) => value && typeof value === 'object' ? Object.getOwnPropertyDescriptor(value, key)?.value : undefined

// Diagnostics carry only enumerated categories. They never carry a protocol
// exception, a URL, a field value, or a page-authored error description.
export function sanitizeDiagnostic(value) {
  const reason = own(value, 'reason'), phase = own(value, 'phase'), networkError = own(value, 'networkError'), stage = own(value, 'stage'), obstruction = own(value, 'obstruction')
  if (!reasons.has(reason) || !phases.has(phase)) return undefined
  return { reason, phase, ...(stages.has(stage) ? { stage } : {}), ...(networkErrors.has(networkError) ? { networkError } : {}), ...(reason === 'obscured' && obstructions.has(obstruction) ? { obstruction } : {}) }
}

export function sanitizeErrorContext(value) {
  const result = {}, diagnostic = sanitizeDiagnostic(own(value, 'diagnostic'))
  if (diagnostic) result.diagnostic = diagnostic
  for (const key of ['taskId', 'pageId', 'frameId']) {
    const id = own(value, key)
    if (typeof id === 'string' && /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{32})$/i.test(id)) result[key] = id
  }
  return result
}

const codeReasons = {
  PAGE_DETACHED: 'detached', CDP_SESSION_CLOSED: 'detached', STALE_OBSERVATION: 'stale',
  PRIVATE_INPUT_BINDING_CHANGED: 'stale', SENSITIVE_DOCUMENT_CHANGED: 'stale',
  ELEMENT_OBSCURED: 'obscured', ELEMENT_DISABLED: 'disabled', ELEMENT_HIDDEN: 'hidden',
  NAVIGATION_FAILED: 'navigation', NAVIGATION_TIMEOUT: 'timeout', CDP_TIMEOUT: 'timeout',
  CONNECTION_ERROR: 'transport', BROWSER_CLOSED: 'transport', INVALID_RESPONSE: 'transport',
  INVALID_STATE: 'state', INVALID_ARGUMENTS: 'invalid', ORIGIN_DENIED: 'invalid'
}
const reasonCodes = { detached: 'PAGE_DETACHED', stale: 'STALE_OBSERVATION', obscured: 'ELEMENT_OBSCURED',
  disabled: 'ELEMENT_DISABLED', hidden: 'ELEMENT_HIDDEN', navigation: 'NAVIGATION_FAILED', transport: 'CONNECTION_ERROR',
  state: 'INVALID_STATE', invalid: 'INVALID_ARGUMENTS', unsupported: 'INVALID_ARGUMENTS',
  'observation-changed': 'PRIVATE_INPUT_BINDING_CHANGED', 'document-changed': 'PRIVATE_INPUT_BINDING_CHANGED',
  'target-changed': 'PRIVATE_INPUT_BINDING_CHANGED', 'origin-mismatch': 'PRIVATE_INPUT_BINDING_CHANGED',
  'unsupported-control': 'INVALID_ARGUMENTS', 'target-unavailable': 'ELEMENT_UNAVAILABLE' }

export function annotateOperationError(error, phase = 'protocol') {
  const previous = sanitizeDiagnostic(own(error, 'diagnostic'))
  if (previous && phase === 'protocol') return error
  const code = own(error, 'code'), message = typeof own(error, 'message') === 'string' ? own(error, 'message').slice(0, 4000) : ''
  const privateReasons = { 'Private input observation changed': 'observation-changed', 'Private input document changed': 'document-changed',
    'Private input target changed': 'target-changed', 'Private input origin changed': 'origin-mismatch',
    'Private input needs a native text control': 'unsupported-control', 'Private input target is unavailable': 'target-unavailable' }
  let reason = previous?.reason ?? privateReasons[message] ?? codeReasons[code]
  if (!reason) {
    if (/^(?:Stale observation|Unknown element reference|Element reference is stale|Page changed since observation)/.test(message)) reason = 'stale'
    else if (/^(?:(?:Element|Frame) is obscured|Element is outside active modal|Modal interaction scope is ambiguous)$/.test(message)) reason = 'obscured'
    else if (/^Element is disabled$/.test(message)) reason = 'disabled'
    else if (/^Element is not visible$/.test(message)) reason = 'hidden'
    else if (/Cannot find context with specified id|Execution context was destroyed|No frame with given id|No target with given id|Could not find (?:node|object) with given id|Session with given id not found|Not attached to an active page|Frame was detached/.test(message)) reason = 'detached'
    else if (/^(?:Browser connection closed|Browser exited|read ECONNRESET|write EPIPE)/.test(message)) reason = 'transport'
    else if (/^Navigation failed:/.test(message)) reason = 'navigation'
    else if (/^(?:Page load timed out|Browser command timed out)/.test(message)) reason = 'timeout'
    else if (/^(?:Page has an open dialog|Page opened a dialog|Handle the open dialog)/.test(message)) reason = 'dialog'
    else if (/^(?:Task is paused|Task paused|Task state or document changed|Task state or page session changed|Task or client state changed)/.test(message)) reason = 'state'
    else if (/^(?:Unsupported key|Unsupported action)/.test(message)) reason = 'unsupported'
    else reason = 'unknown'
  }
  const match = /\bnet::(ERR_[A-Z_]+)\b/.exec(message)
  const networkError = previous?.networkError ?? (networkErrors.has(match?.[1]) ? match[1] : undefined)
  const obstruction = previous?.obstruction ?? ({ 'Element is outside active modal': 'modal-scope', 'Modal interaction scope is ambiguous': 'ambiguous-modal-scope', 'Element is obscured': 'hit-test', 'Frame is obscured': 'frame-hit-test' })[message]
  error.diagnostic = { reason, phase: phases.has(phase) ? phase : previous?.phase ?? 'protocol', ...(previous?.stage ? { stage: previous.stage } : {}), ...(networkError ? { networkError } : {}), ...(reason === 'obscured' && obstructions.has(obstruction) ? { obstruction } : {}) }
  if ((!code || ['BROKER_ERROR', 'ACTION_FAILED'].includes(code)) && reasonCodes[reason]) error.code = reasonCodes[reason]
  if ((!code || code === 'BROKER_ERROR') && reason === 'timeout') error.code = phase === 'navigate' ? 'NAVIGATION_TIMEOUT' : 'CDP_TIMEOUT'
  return error
}

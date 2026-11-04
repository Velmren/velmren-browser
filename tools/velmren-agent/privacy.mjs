import { sanitizeActionResult, sanitizeWaitResult } from './action-result.mjs'

const invalidUrl = '[invalid URL]'
const privateUrl = '[redacted URL]'
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const identifier = value => typeof value === 'string' && (uuid.test(value) || /^[0-9a-f]{32}$/i.test(value))
const ref = value => typeof value === 'string' && /^e[1-9][0-9]{0,8}$/.test(value)
const urlKey = key => /(?:url|uri|href|src|origin)$/i.test(key)
const privateKeys = new Set(['secret', 'secretRef', 'password', 'token', 'adminToken', 'authorization', 'cookie', '__proto__', 'constructor', 'prototype'])

// An unknown path can contain a credential. No path or parameter is public.
export function safePublicUrl(raw) {
  if (typeof raw !== 'string') return invalidUrl
  if (raw === 'about:blank' || raw === 'about:srcdoc') return raw
  try {
    const parsed = new URL(raw)
    return ['http:', 'https:'].includes(parsed.protocol) ? parsed.origin : privateUrl
  } catch { return invalidUrl }
}

const publicText = value => value.replace(/\b(?:https?:|wss?:|ftp:|file:|blob:|data:|javascript:|about:)[^\s]+|(?<![:/])\/\/[^\s]+/gi, safePublicUrl)
const errorMessages = Object.freeze({
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
const enums = new Map(Object.entries(choices).map(([key, values]) => [key, new Set(values)]))
const actions = new Set(['click', 'fill', 'select', 'press', 'setChecked', 'uploadFiles'])

// This is a projection, not secret recognition. The caller owns phase lifetime.
export function sanitizePublicResult(value, { sensitive = false } = {}) {
  const seen = new WeakSet()
  const project = (input, key = '', depth = 0, parent = '') => {
    if (depth > 32 || privateKeys.has(key)) return undefined
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
      if (Array.isArray(input)) return input.map(item => project(item, '', depth + 1, key)).filter(item => item !== undefined)
      const output = {}
      const png = !sensitive && Object.getOwnPropertyDescriptor(input, 'mimeType')?.value === 'image/png'
      for (const [name, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(input))) {
        if (!Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) continue
        // PNG base64 can contain "//"; it is binary transport, not URL text.
        const clean = png && name === 'data' && typeof descriptor.value === 'string' && /^[A-Za-z0-9+/]+={0,2}$/.test(descriptor.value)
          ? descriptor.value : project(descriptor.value, name, depth + 1, key)
        if (clean !== undefined) Object.defineProperty(output, name, { value: clean, enumerable: true, writable: true, configurable: true })
      }
      return output
    } finally { seen.delete(input) }
  }
  return project(value)
}

export function sanitizePublicError(error, { sensitive = false } = {}) {
  const own = key => error && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, key)?.value : undefined
  const candidate = own('code')
  const code = typeof candidate === 'string' && Object.hasOwn(errorMessages, candidate) ? candidate : 'BROKER_ERROR'
  const actionResult = sanitizeActionResult(own('actionResult'))
  const waitResult = sanitizeWaitResult(own('waitResult'))
  return { error: (trustedMessages.has(own('message')) || /^Task is (?:agent-active|paused|needs-human|human|completed|cancelled); agent actions are paused$/.test(own('message') ?? '')) ? own('message') : errorMessages[code], code,
    ...(actionResult ? { actionResult } : {}),
    ...(waitResult && (!sensitive || identifier(waitResult.pageId)) ? { waitResult } : {}) }
}

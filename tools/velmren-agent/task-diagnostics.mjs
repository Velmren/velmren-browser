const resourceTypes = new Set(['Document', 'Stylesheet', 'Image', 'Media', 'Font', 'Script', 'TextTrack', 'XHR', 'Fetch', 'Prefetch', 'EventSource', 'WebSocket', 'Manifest', 'SignedExchange', 'Ping', 'CSPViolationReport', 'Preflight', 'Other'])
const methods = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'])
const blockedReasons = new Set(['other', 'csp', 'mixed-content', 'origin', 'inspector', 'subresource-filter', 'content-type', 'coep-frame-resource-needs-coep-header', 'coop-sandboxed-iframe-cannot-navigate-to-coop-page', 'corp-not-same-origin', 'corp-not-same-origin-after-defaulted-to-same-origin-by-coep', 'corp-not-same-site'])
const categories = ['javascript', 'csp', 'cors', 'fedcm', 'file-import']
const safeId = value => typeof value === 'string' && /^(?:[a-f0-9]{32}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/i.test(value)
const origin = value => { if (typeof value !== 'string') return undefined; try { const url = new URL(value); return /^https?:$/.test(url.protocol) ? url.origin : undefined } catch { return undefined } }
const networkCodes = new Set(['ERR_FAILED', 'ERR_ABORTED', 'ERR_CONNECTION_CLOSED', 'ERR_CONNECTION_RESET', 'ERR_CONNECTION_REFUSED', 'ERR_CONNECTION_TIMED_OUT', 'ERR_TIMED_OUT', 'ERR_NAME_NOT_RESOLVED', 'ERR_INTERNET_DISCONNECTED', 'ERR_NETWORK_CHANGED', 'ERR_ADDRESS_UNREACHABLE', 'ERR_SSL_PROTOCOL_ERROR', 'ERR_CERT_AUTHORITY_INVALID', 'ERR_CERT_DATE_INVALID', 'ERR_CERT_COMMON_NAME_INVALID', 'ERR_BLOCKED_BY_CLIENT', 'ERR_BLOCKED_BY_RESPONSE', 'ERR_BLOCKED_BY_CSP', 'ERR_TOO_MANY_REDIRECTS', 'ERR_HTTP_RESPONSE_CODE_FAILURE', 'ERR_EMPTY_RESPONSE', 'ERR_FILE_NOT_FOUND', 'ERR_ACCESS_DENIED', 'ERR_UPLOAD_FILE_CHANGED'])
const errorCode = value => typeof value === 'string' && networkCodes.has(value.replace(/^net::/, '')) ? value.replace(/^net::/, '') : undefined
const own = (value, key) => value && typeof value === 'object' ? Object.getOwnPropertyDescriptor(value, key)?.value : undefined
const classify = text => /(?:Content Security Policy|\bCSP\b|Refused to (?:load|connect|frame|execute))/i.test(text) ? 'csp'
  : /(?:\bCORS\b|cross.origin request|access.control.allow.origin)/i.test(text) ? 'cors'
    : /(?:\bFedCM\b|IdentityCredential|identity provider|identity.get)/i.test(text) ? 'fedcm'
      : /(?:FileReader|PDF(?:\.js|Document)|InvalidPDF|MissingPDF|UnexpectedResponseException)/i.test(text) ? 'file-import' : 'javascript'

export function sanitizeTaskDiagnostics(value) {
  if (!value || typeof value !== 'object') return undefined
  const dropped = own(value, 'dropped'), network = own(value, 'network'), errors = own(value, 'errors')
  const result = { available: own(value, 'available') === true, network: [], errors: {}, dropped: Number.isSafeInteger(dropped) && dropped >= 0 ? dropped : 0 }
  for (const category of categories) { const count = own(errors, category); result.errors[category] = Number.isSafeInteger(count) && count >= 0 ? count : 0 }
  if (Array.isArray(network)) for (let index = Math.max(0, network.length - 160); index < network.length; index++) {
    const record = own(network, index), type = own(record, 'resourceType')
    const clean = { resourceType: resourceTypes.has(type) ? type : 'Other' }
    for (const name of ['pageId', 'frameId']) if (safeId(own(record, name))) clean[name] = own(record, name)
    const site = origin(own(record, 'origin'))
    if (site) clean.origin = site
    if (methods.has(own(record, 'method'))) clean.method = own(record, 'method')
    for (const name of ['status']) { const number = own(record, name); if (Number.isInteger(number) && number >= 100 && number <= 599) clean[name] = number }
    for (const name of ['requestBodyPresent', 'multipartUpload', 'failed', 'finished', 'cancelled', 'policyBlocked']) if (typeof own(record, name) === 'boolean') clean[name] = own(record, name)
    const code = errorCode(own(record, 'networkError'))
    if (code) clean.networkError = code
    if (blockedReasons.has(own(record, 'blockedReason'))) clean.blockedReason = own(record, 'blockedReason')
    if (typeof own(record, 'corsFailure') === 'boolean') clean.corsFailure = own(record, 'corsFailure')
    result.network.push(clean)
  }
  return result
}

// Keep origin/status metadata only. Request bodies, headers, exception strings
// and OAuth paths are discarded at event ingestion, before any diagnostic state.
export class TaskDiagnostics {
  constructor() { this.network = new Map(); this.errors = Object.fromEntries(categories.map(key => [key, 0])); this.dropped = 0 }
  event(message, entry) {
    const params = message.params ?? {}, type = message.method, prefix = message.sessionId ?? ''
    const key = `${prefix}:${params.networkId ?? params.requestId ?? ''}`
    if (type === 'Runtime.consoleAPICalled') {
      if (!['error', 'warning'].includes(params.type)) return
      // Classify primitive/error arguments only; never retain console payloads
      // or fetch the properties of an application-owned remote object.
      const text = (Array.isArray(params.args) ? params.args : []).slice(0, 4).map(arg =>
        typeof arg.value === 'string' ? arg.value.slice(0, 1024) : arg.subtype === 'error' && typeof arg.description === 'string' ? arg.description.slice(0, 1024) : '').join(' ')
      this.errors[classify(text)]++
      return
    }
    if (type === 'Runtime.exceptionThrown' || type === 'Log.entryAdded') {
      const text = type === 'Runtime.exceptionThrown' ? params.exceptionDetails?.exception?.description ?? params.exceptionDetails?.text : params.entry?.text
      if (typeof text === 'string' && (type !== 'Log.entryAdded' || ['error', 'warning'].includes(params.entry?.level))) this.errors[classify(text.slice(0, 4096))]++
      return
    }
    if (!['Network.requestWillBeSent', 'Network.responseReceived', 'Network.loadingFailed', 'Network.loadingFinished', 'Fetch.requestPaused'].includes(type)) return
    let record = this.network.get(key)
    if (!record) {
      if (this.network.size >= 160) { this.network.delete(this.network.keys().next().value); this.dropped++ }
      record = { resourceType: resourceTypes.has(params.type ?? params.resourceType) ? params.type ?? params.resourceType : 'Other' }
      if (safeId(entry?.page?.pageId ?? entry?.ownerPageId)) record.pageId = entry.page?.pageId ?? entry.ownerPageId
      if (safeId(params.frameId)) record.frameId = params.frameId
      this.network.set(key, record)
    }
    if (params.request) {
      record.origin = origin(params.request.url)
      if (methods.has(params.request.method)) record.method = params.request.method
      record.requestBodyPresent = params.request.hasPostData === true || typeof params.request.postData === 'string'
      const headers = params.request.headers
      const contentType = headers && Object.entries(headers).find(([name]) => name.toLowerCase() === 'content-type')?.[1]
      record.multipartUpload = typeof contentType === 'string' && /^multipart\/form-data(?:;|$)/i.test(contentType)
    }
    const status = params.response?.status ?? params.responseStatusCode
    if (Number.isInteger(status) && status >= 100 && status <= 599) record.status = status
    if (!record.origin && params.response) record.origin = origin(params.response.url)
    if (type === 'Network.loadingFinished') record.finished = true
    if (type === 'Network.loadingFailed') {
      record.failed = true; record.cancelled = params.canceled === true
      const code = errorCode(params.errorText)
      if (code) record.networkError = code
      if (blockedReasons.has(params.blockedReason)) record.blockedReason = params.blockedReason
      record.corsFailure = !!params.corsErrorStatus
      if (record.corsFailure) this.errors.cors++
    }
  }
  blocked(message, entry) {
    this.event(message, entry)
    const params = message.params ?? {}, key = `${message.sessionId ?? ''}:${params.networkId ?? params.requestId ?? ''}`
    const record = this.network.get(key)
    if (record) record.policyBlocked = true
  }
  snapshot() { return sanitizeTaskDiagnostics({ available: !this.incomplete, network: [...this.network.values()], errors: this.errors, dropped: this.dropped }) }
}

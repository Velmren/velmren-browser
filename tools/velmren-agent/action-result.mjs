const deliveries = new Set(['not_delivered', 'delivery_uncertain', 'delivered_unverified', 'delivered_verified', 'unknown'])
const types = new Set(['click', 'fill', 'select', 'press', 'handleDialog', 'uploadFiles', 'navigate'])
const reasons = new Set(['not_dispatched', 'delivery_uncertain', 'verify_outcome', 'completed', 'state_changed', 'transport_unknown'])
const index = value => Number.isInteger(value) && value >= 0 && value < 20

// Rebuild the public envelope; never forward arbitrary exception or input fields.
export function sanitizeActionResult(value) {
  if (!value || typeof value !== 'object' || !deliveries.has(value.delivery) ||
      !(Number.isInteger(value.completed) && value.completed >= 0 && value.completed <= 20 || value.completed === null && value.delivery === 'unknown') ||
      !(value.failedIndex === null || index(value.failedIndex)) || !Array.isArray(value.results) || value.results.length > 20) return undefined
  const recovery = value.recovery
  if (!recovery || !['none', 'failed_action_only'].includes(recovery.retry) || typeof recovery.observe !== 'boolean' || !reasons.has(recovery.reason)) return undefined
  if (recovery.retry === 'failed_action_only' && (value.delivery !== 'not_delivered' || value.failedIndex === null || recovery.reason !== 'not_dispatched')) return undefined
  const results = []
  for (const item of value.results) {
    if (!item || !index(item.index) || !types.has(item.type) || !deliveries.has(item.delivery) ||
        item.ref !== undefined && (typeof item.ref !== 'string' || !/^e[1-9][0-9]{0,8}$/.test(item.ref))) return undefined
    if (results.some(result => result.index === item.index)) return undefined
    if (recovery.retry === 'failed_action_only' && item.index === value.failedIndex && item.delivery !== 'not_delivered') return undefined
    const clean = { index: item.index, type: item.type, ...(item.ref === undefined ? {} : { ref: item.ref }), delivery: item.delivery }
    if (item.verification !== undefined) {
      if (item.verification?.scope !== 'element' || !['matched', 'mismatch', 'unavailable'].includes(item.verification.status)) return undefined
      clean.verification = { scope: 'element', status: item.verification.status }
    }
    results.push(clean)
  }
  return { completed: value.completed, failedIndex: value.failedIndex, delivery: value.delivery, results,
    recovery: { retry: recovery.retry, observe: recovery.observe, reason: recovery.reason } }
}

export function unknownActionResult() {
  return { completed: null, failedIndex: null, delivery: 'unknown', results: [],
    recovery: { retry: 'none', observe: true, reason: 'transport_unknown' } }
}

export function actionResult(completed, failedIndex, results, delivery, reason) {
  return { completed, failedIndex, delivery, results,
    recovery: { retry: failedIndex !== null && delivery === 'not_delivered' && reason === 'not_dispatched' ? 'failed_action_only' : 'none',
      observe: failedIndex !== null || delivery !== 'delivered_verified', reason } }
}

export function sanitizeWaitResult(value) {
  if (!value || typeof value.matched !== 'boolean' || !Number.isInteger(value.elapsedMs) || value.elapsedMs < 0 || value.elapsedMs > 15000 ||
      typeof value.pageId !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(value.pageId)) return undefined
  const observed = value.lastObserved
  if (!observed || !['text', 'exists', 'enabled', 'visible', 'value'].includes(observed.state)) return undefined
  const lastObserved = { state: observed.state }
  for (const key of ['exists', 'enabled', 'visible', 'valueMatches', 'textMatches']) {
    if (observed[key] === undefined) continue
    if (typeof observed[key] !== 'boolean') return undefined
    lastObserved[key] = observed[key]
  }
  return { matched: value.matched, elapsedMs: value.elapsedMs, lastObserved, pageId: value.pageId }
}

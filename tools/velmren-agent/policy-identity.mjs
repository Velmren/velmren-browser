import { createHash } from 'node:crypto'

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))
  return value
}

export function normalizeEffectivePolicy(policy = {}) {
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) throw new Error('Policy must be an object')
  const normalized = { ...policy, maxTasks: policy.maxTasks ?? 8, maxActiveActions: policy.maxActiveActions ?? 5,
    webCompatibility: policy.webCompatibility ?? false, allowWeb: policy.allowWeb ?? false,
    profileMode: policy.profileMode ?? 'isolated',
    webSocketPolicy: policy.webSocketPolicy === undefined ? 'disabled' : policy.webSocketPolicy, allowedOrigins: null }
  if (!Number.isInteger(normalized.maxTasks) || normalized.maxTasks < 1 || normalized.maxTasks > 32 ||
      !Number.isInteger(normalized.maxActiveActions) || normalized.maxActiveActions < 1 || normalized.maxActiveActions > 8 ||
      typeof normalized.webCompatibility !== 'boolean' || typeof normalized.allowWeb !== 'boolean') throw new Error('Invalid policy settings')
  if (!['isolated', 'persistent'].includes(normalized.profileMode)) throw new Error('profileMode must be isolated or persistent')
  if (!['disabled', 'csp-secure-upgrades'].includes(normalized.webSocketPolicy) ||
      (normalized.webSocketPolicy !== 'disabled' && !normalized.webCompatibility)) throw new Error('webSocketPolicy must be disabled, or csp-secure-upgrades with webCompatibility')
  if (policy.allowedOrigins !== undefined) {
    if (!Array.isArray(policy.allowedOrigins) || policy.allowedOrigins.some(origin => {
      try { const url = new URL(origin); return typeof origin !== 'string' || !['http:', 'https:'].includes(url.protocol) || url.origin !== origin } catch { return true }
    })) throw new Error('Invalid allowed origins')
    normalized.allowedOrigins = [...new Set(policy.allowedOrigins)].sort()
    normalized.allowWeb = false
  }
  // Preserve additional policy fields in the identity rather than silently
  // accepting a policy change introduced by a newer broker.
  return canonical(normalized)
}

export function effectivePolicyIdentity(policy = {}) {
  return createHash('sha256').update(JSON.stringify({ schema: 1, policy: normalizeEffectivePolicy(policy) })).digest('hex')
}

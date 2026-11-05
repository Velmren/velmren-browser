import { randomBytes } from 'node:crypto'
import { BrokerError, connectClient } from './client.mjs'
import { annotateOperationError } from './operation-error.mjs'
import { sanitizePublicError } from './privacy.mjs'

const fail = (code, stage, reason) => { throw new BrokerError('Private input is unavailable for this destination', code, undefined, undefined,
  { diagnostic: { phase: stage === 'private_consume' ? 'input' : 'prepare', stage, reason } }) }
const equalBinding = (left, right) => ['owner', 'taskId', 'pageId', 'frameId', 'observationId', 'ref', 'origin', 'topOrigin', 'documentId', 'topDocumentId']
  .every(key => left[key] === right[key])

// Capabilities live only in this broker's memory. They never name a file or a
// vault entry, and a page cannot resolve them. Buffers are cleared on disposal;
// JavaScript strings transiently used by the protocol remain GC-managed.
export class PrivateInputs {
  constructor({ now = Date.now, ttlMs = 60000, limit = 128 } = {}) {
    Object.assign(this, { now, ttlMs, limit, entries: new Map() })
  }
  drop(secretRef) {
    const entry = this.entries.get(secretRef)
    clearTimeout(entry?.timer)
    entry?.bytes?.fill(0)
    this.entries.delete(secretRef)
  }
  prune() { for (const [ref, entry] of this.entries) if (entry.expiresAt <= this.now()) this.drop(ref) }
  prepare(binding) {
    this.prune()
    if (this.entries.size >= this.limit) fail('PRIVATE_INPUT_LIMIT', 'private_prepare', 'state')
    const secretRef = `vsi_${randomBytes(32).toString('base64url')}`
    const expiresAt = this.now() + this.ttlMs
    const timer = setTimeout(() => this.drop(secretRef), this.ttlMs)
    timer.unref?.()
    this.entries.set(secretRef, { binding: { ...binding }, expiresAt, timer })
    return { secretRef, expiresInMs: this.ttlMs }
  }
  entry(secretRef, owner, taskId, stage) {
    this.prune()
    const entry = this.entries.get(secretRef)
    // A foreign owner's failed request must not consume the intended value.
    if (!entry || entry.binding.owner !== owner || entry.binding.taskId !== taskId) fail('PRIVATE_INPUT_UNAVAILABLE', stage, 'capability-unavailable')
    return entry
  }
  provide(secretRef, owner, taskId, value) {
    const entry = this.entry(secretRef, owner, taskId, 'private_provide')
    if (entry.bytes || typeof value !== 'string' || value.length > 65536) fail('PRIVATE_INPUT_UNAVAILABLE', 'private_provide', 'value-unavailable')
    entry.bytes = Buffer.from(value, 'utf8')
    return { secretRef, ready: true, expiresInMs: Math.max(0, entry.expiresAt - this.now()) }
  }
  revoke(secretRef, owner, taskId) {
    this.entry(secretRef, owner, taskId, 'private_revoke')
    this.drop(secretRef)
    return { revoked: true }
  }
  async consume(secretRef, binding, deliver) {
    const entry = this.entry(secretRef, binding.owner, binding.taskId, 'private_consume')
    if (!equalBinding(entry.binding, binding) || !entry.bytes) fail('PRIVATE_INPUT_BINDING_CHANGED', 'private_consume', 'binding-changed')
    // Consume before any asynchronous delivery: concurrent or failed attempts
    // can never replay a value whose delivery may have reached the website.
    this.entries.delete(secretRef)
    clearTimeout(entry.timer)
    try { return await deliver(entry.bytes.toString('utf8')) }
    finally { entry.bytes.fill(0) }
  }
  discardTask(taskId) { for (const [ref, entry] of this.entries) if (entry.binding.taskId === taskId) this.drop(ref) }
  close() { for (const ref of this.entries.keys()) this.drop(ref) }
}

// A trusted local adapter calls this function inside its vault/OTP callback.
// The browser destination is validated before the callback is invoked. Only an
// opaque one-use reference is returned to the agent; no new secret file exists.
export async function stagePrivateInput({ stateDir, taskId, pageId, frameId, observationId, ref, origin, topOrigin, readSecret, client }) {
  if (typeof readSecret !== 'function') throw new BrokerError('A local secret reader is required', 'INVALID_ARGUMENTS')
  let prepared, connection, stage = 'private_connect'
  try {
    connection = client ?? await connectClient(stateDir, 'admin')
    stage = 'private_prepare'
    prepared = await connection.call('task_private_input', { taskId, pageId, frameId, observationId, ref, origin, topOrigin, action: 'prepare' })
    stage = 'private_read'
    const value = await readSecret()
    stage = 'private_provide'
    return await connection.call('task_private_input', { taskId, action: 'provide', secretRef: prepared.secretRef, value })
  } catch (error) {
    if (prepared?.secretRef) await connection.call('task_private_input', { taskId, action: 'revoke', secretRef: prepared.secretRef }).catch(() => {})
    // Callback exceptions are untrusted and may contain a secret. Only broker
    // failures retain their allowlisted code and bounded destination diagnostic.
    const safe = stage === 'private_read' ? {} : sanitizePublicError(error)
    const clean = stage === 'private_read' ? {} : sanitizePublicError(annotateOperationError(new BrokerError(safe.error, safe.code, undefined, undefined, safe), 'prepare'))
    const code = clean.code && clean.code !== 'BROKER_ERROR' ? clean.code : 'PRIVATE_INPUT_UNAVAILABLE'
    throw new BrokerError('Private input preparation failed', code, undefined, undefined,
      { ...clean, diagnostic: { ...clean.diagnostic, reason: stage === 'private_read' ? 'reader-failed' : clean.diagnostic?.reason ?? 'unknown', phase: 'prepare', stage } })
  }
}

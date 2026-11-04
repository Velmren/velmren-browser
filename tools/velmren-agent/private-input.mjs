import { randomBytes } from 'node:crypto'
import { BrokerError, connectClient } from './client.mjs'

const fail = code => { throw new BrokerError('Private input is unavailable for this destination', code) }
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
    if (this.entries.size >= this.limit) fail('PRIVATE_INPUT_LIMIT')
    const secretRef = `vsi_${randomBytes(32).toString('base64url')}`
    const expiresAt = this.now() + this.ttlMs
    const timer = setTimeout(() => this.drop(secretRef), this.ttlMs)
    timer.unref?.()
    this.entries.set(secretRef, { binding: { ...binding }, expiresAt, timer })
    return { secretRef, expiresInMs: this.ttlMs }
  }
  entry(secretRef, owner, taskId) {
    this.prune()
    const entry = this.entries.get(secretRef)
    // A foreign owner's failed request must not consume the intended value.
    if (!entry || entry.binding.owner !== owner || entry.binding.taskId !== taskId) fail('PRIVATE_INPUT_UNAVAILABLE')
    return entry
  }
  provide(secretRef, owner, taskId, value) {
    const entry = this.entry(secretRef, owner, taskId)
    if (entry.bytes || typeof value !== 'string' || value.length > 65536) fail('PRIVATE_INPUT_UNAVAILABLE')
    entry.bytes = Buffer.from(value, 'utf8')
    return { secretRef, ready: true, expiresInMs: Math.max(0, entry.expiresAt - this.now()) }
  }
  revoke(secretRef, owner, taskId) {
    this.entry(secretRef, owner, taskId)
    this.drop(secretRef)
    return { revoked: true }
  }
  async consume(secretRef, binding, deliver) {
    const entry = this.entry(secretRef, binding.owner, binding.taskId)
    if (!equalBinding(entry.binding, binding) || !entry.bytes) fail('PRIVATE_INPUT_BINDING_CHANGED')
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
  const connection = client ?? await connectClient(stateDir, 'admin')
  let prepared
  try {
    prepared = await connection.call('task_private_input', { taskId, pageId, frameId, observationId, ref, origin, topOrigin, action: 'prepare' })
    const value = await readSecret()
    return await connection.call('task_private_input', { taskId, action: 'provide', secretRef: prepared.secretRef, value })
  } catch {
    if (prepared?.secretRef) await connection.call('task_private_input', { taskId, action: 'revoke', secretRef: prepared.secretRef }).catch(() => {})
    throw new BrokerError('Private input preparation failed', 'PRIVATE_INPUT_UNAVAILABLE')
  }
}

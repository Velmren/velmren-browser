import { mkdir, stat, appendFile, rename, unlink, truncate } from 'node:fs/promises'
import path from 'node:path'
import { METHODS } from './client.mjs'
import { sanitizeActionResult } from './action-result.mjs'

const methods = new Set([...METHODS, 'client_register', 'client_recover', 'broker_status', 'task_control', 'shutdown', 'captcha_settings'])
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value) ? value : undefined
const duration = value => Number.isFinite(value) && value >= 0 ? Math.round(value * 1000) / 1000 : 0

// Callers supply identities only after resolving ownership; all other fields
// are deliberately reconstructed rather than copied from requests or errors.
export function traceRecord(value) {
  const record = {
    requestId: identifier(value.requestId), timestamp: value.timestamp,
    method: methods.has(value.method) ? value.method : 'unknown',
    outcome: value.outcome === 'success' ? 'success' : 'error',
    durationMs: duration(value.durationMs), taskQueueMs: duration(value.taskQueueMs),
    activeSlotQueueMs: duration(value.activeSlotQueueMs)
  }
  if (!record.requestId || typeof record.timestamp !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(record.timestamp)) return undefined
  for (const key of ['clientId', 'taskId', 'pageId']) {
    const id = identifier(value[key])
    if (id) record[key] = id
  }
  const action = sanitizeActionResult(value.actionResult)
  if (action) record.actionResult = action
  return record
}

export class RequestTrace {
  constructor(stateDir, { maxBytes = 1024 * 1024, maxPending = 128, maxPendingBytes = 256 * 1024 } = {}) {
    this.stateDir = stateDir
    this.maxBytes = maxBytes
    this.maxPending = maxPending
    this.maxPendingBytes = maxPendingBytes
    this.pending = []
    this.pendingBytes = 0
    this.running = null
    this.disabled = false
    this.closed = false
  }
  record(value) {
    if (this.disabled || this.closed) return false
    const record = traceRecord(value)
    if (!record) return false
    const line = `${JSON.stringify(record)}\n`, bytes = Buffer.byteLength(line)
    if (bytes > this.maxBytes || this.pending.length >= this.maxPending || this.pendingBytes + bytes > this.maxPendingBytes) return false
    this.pending.push({ line, bytes }); this.pendingBytes += bytes
    this.start()
    return true
  }
  start() {
    if (this.running || !this.pending.length || this.disabled) return
    this.running = this.drain().catch(() => {
      // Diagnostics must never turn a successful action into a failure.
      this.disabled = true; this.pending.length = 0; this.pendingBytes = 0
    }).finally(() => { this.running = null; this.start() })
  }
  async drain() {
    if (!this.file) {
      const directory = typeof this.stateDir === 'function' ? this.stateDir() : this.stateDir
      await mkdir(directory, { recursive: true, mode: 0o700 })
      this.file = path.join(directory, 'requests.jsonl')
      this.previous = path.join(directory, 'requests.1.jsonl')
      for (const file of [this.file, this.previous]) {
        const size = await stat(file).then(info => info.size, error => { if (error.code === 'ENOENT') return 0; throw error })
        if (size > this.maxBytes) await truncate(file, 0)
      }
      this.bytes = await stat(this.file).then(info => info.size, error => { if (error.code === 'ENOENT') return 0; throw error })
    }
    while (this.pending.length) {
      const { line, bytes } = this.pending.shift(); this.pendingBytes -= bytes
      if (this.bytes + bytes > this.maxBytes) {
        await unlink(this.previous).catch(error => { if (error.code !== 'ENOENT') throw error })
        await rename(this.file, this.previous)
        this.bytes = 0
      }
      await appendFile(this.file, line, { mode: 0o600 })
      this.bytes += bytes
    }
  }
  async flush() { while (this.running) await this.running }
  async close() { this.closed = true; await this.flush() }
}

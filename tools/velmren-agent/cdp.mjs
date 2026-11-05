import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdir } from 'node:fs/promises'
import { persistentBrowserArgs } from './profile-state.mjs'
import { annotateOperationError } from './operation-error.mjs'

const startupFeature = 'ImprovedStartupBestEffortDelay'
const startupFeatureParameters = `${startupFeature}:StartupDelayVisibleTabTimeout/0ms/StartupDelayFailsafeTimeout/1000ms`

export function agentBrowserArgs(args) {
  const rest = [], enabled = new Map(), disabled = new Map()
  for (let index = 0; index < args.length; index++) {
    const arg = args[index], match = /^(--enable-features|--disable-features)(?:=(.*))?$/.exec(arg)
    if (!match) { rest.push(arg); continue }
    const value = match[2] ?? (args[index + 1] && !args[index + 1].startsWith('--') ? args[++index] : '')
    const features = match[1] === '--enable-features' ? enabled : disabled
    for (const token of value.split(',')) {
      const feature = token.trim(), name = feature.split(/[<:.]/, 1)[0].replace(/^\*/, '')
      if (name) features.set(name, feature)
    }
  }
  disabled.delete(startupFeature)
  // Preserve Chromium's disable precedence for unrelated feature conflicts.
  for (const name of disabled.keys()) enabled.delete(name)
  // Hidden agent windows cannot satisfy Chromium's visible-startup gate.
  // BEST_EFFORT service-worker updates otherwise wait for its three-minute failsafe.
  enabled.set(startupFeature, startupFeatureParameters)
  return [...rest, `--enable-features=${[...enabled.values()].join(',')}`,
    ...(disabled.size ? [`--disable-features=${[...disabled.values()].join(',')}`] : [])]
}

// The browser endpoint stays on inherited pipes; no browser-wide TCP port.
export class BrowserPipe extends EventEmitter {
  pending = new Map()
  sequence = 0
  buffer = Buffer.alloc(0)
  stderr = ''
  closed = false

  static async launch({ executable, profile, args = [], profileMode = 'isolated' }) {
    await mkdir(profile, { recursive: true })
    const transport = new BrowserPipe()
    transport.process = spawn(executable, [
      `--user-data-dir=${profile}`, '--remote-debugging-pipe',
      '--no-startup-window', '--no-first-run', '--no-default-browser-check',
      '--velmren-agent-mode', ...agentBrowserArgs(profileMode === 'persistent' ? persistentBrowserArgs(args) : args),
    ], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] })
    transport.process.stderr.on('data', chunk => {
      transport.stderr = (transport.stderr + chunk.toString()).slice(-8000)
    })
    transport.process.stdio[4].on('data', chunk => transport.receive(chunk))
    transport.process.stdio[3].on('error', error => transport.fail(error))
    transport.process.stdio[4].on('error', error => transport.fail(error))
    transport.process.on('error', error => transport.fail(error))
    transport.process.on('exit', (code, signal) => {
      transport.processExited = true
      transport.closed = true
      transport.fail(Object.assign(new Error('Browser exited'), { code: 'BROWSER_CLOSED' }))
      transport.emit('closed', { childPid: transport.process.pid, exitCode: code, signal })
    })
    try { transport.version = await transport.send('Browser.getVersion') }
    catch (error) { await transport.close(); throw error }
    return transport
  }

  receive(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk])
    for (let separator; (separator = this.buffer.indexOf(0)) !== -1;) {
      const raw = this.buffer.subarray(0, separator)
      this.buffer = this.buffer.subarray(separator + 1)
      if (!raw.length) continue
      let message
      try { message = JSON.parse(raw.toString('utf8')) } catch { continue }
      if (message.id) {
        const request = this.pending.get(message.id)
        if (!request) continue
        this.pending.delete(message.id)
        clearTimeout(request.timer)
        if (message.error) request.reject(annotateOperationError(Object.assign(new Error(`${request.method}: ${message.error.message}`), { code: 'CDP_PROTOCOL_ERROR', protocolCode: message.error.code, method: request.method })))
        else request.resolve(message.result)
      } else {
        if (message.method === 'Target.detachedFromTarget' && typeof message.params?.sessionId === 'string') {
          for (const [id, request] of this.pending) if (request.sessionId === message.params?.sessionId) {
            this.pending.delete(id); clearTimeout(request.timer)
            request.reject(annotateOperationError(Object.assign(new Error('Browser target session closed'), { code: 'CDP_SESSION_CLOSED', method: request.method })))
          }
        }
        this.emit('protocol', message)
      }
    }
  }

  send(method, params = {}, sessionId, timeout = 20000) {
    if (this.closed) return Promise.reject(annotateOperationError(Object.assign(new Error('Browser connection closed'), { code: 'BROWSER_CLOSED' })))
    const id = ++this.sequence
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(annotateOperationError(Object.assign(new Error('Browser command timed out'), { code: 'CDP_TIMEOUT', method })))
      }, timeout)
      this.pending.set(id, { resolve, reject, timer, method, sessionId })
      this.process.stdio[3].write(JSON.stringify({ id, method, params, sessionId }) + '\0')
    })
  }

  fail(error) {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer)
      request.reject(annotateOperationError(error))
    }
    this.pending.clear()
  }

  async closeForManual({ timeoutMs = 20000 } = {}) {
    if (!this.process) throw new Error('Browser process identity is unavailable')
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 20000) throw new Error('Invalid browser exit timeout')
    const exited = () => this.processExited || this.process.exitCode != null || this.process.signalCode != null
    if (exited()) return
    // A CDP acknowledgement or pipe failure does not release the profile lock.
    await new Promise((resolve, reject) => {
      const done = () => { clearTimeout(timer); this.process.off('exit', done); resolve() }
      const timer = setTimeout(() => {
        this.process.off('exit', done)
        const error = new Error('Automated browser did not exit; manual profile login remains blocked')
        error.code = 'PROFILE_LOGIN_BROWSER_NOT_EXITED'
        reject(error)
      }, timeoutMs)
      this.process.once('exit', done)
      if (exited()) { done(); return }
      void this.send('Browser.close', {}, undefined, timeoutMs).catch(() => {})
    })
  }

  async close() {
    if (!this.process || this.closed) return
    await this.send('Browser.close', {}, undefined, 3000).catch(() => {})
    if (this.closed) return
    await new Promise(resolve => {
      const timer = setTimeout(() => { this.process.kill(); resolve() }, 4000)
      this.process.once('exit', () => { clearTimeout(timer); resolve() })
    })
  }
}

import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdir } from 'node:fs/promises'
import { persistentBrowserArgs } from './profile-state.mjs'

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
      '--velmren-agent-mode', ...(profileMode === 'persistent' ? persistentBrowserArgs(args) : args),
    ], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] })
    transport.process.stderr.on('data', chunk => {
      transport.stderr = (transport.stderr + chunk.toString()).slice(-8000)
    })
    transport.process.stdio[4].on('data', chunk => transport.receive(chunk))
    transport.process.stdio[3].on('error', error => transport.fail(error))
    transport.process.stdio[4].on('error', error => transport.fail(error))
    transport.process.on('error', error => transport.fail(error))
    transport.process.on('exit', code => {
      transport.closed = true
      transport.fail(new Error(`Browser exited (${code}): ${transport.stderr.slice(-1500)}`))
      transport.emit('closed')
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
        if (message.error) request.reject(new Error(`${request.method}: ${message.error.message}`))
        else request.resolve(message.result)
      } else {
        this.emit('protocol', message)
      }
    }
  }

  send(method, params = {}, sessionId, timeout = 20000) {
    if (this.closed) return Promise.reject(new Error('Browser connection closed'))
    const id = ++this.sequence
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Browser command timed out: ${method}`))
      }, timeout)
      this.pending.set(id, { resolve, reject, timer, method })
      this.process.stdio[3].write(JSON.stringify({ id, method, params, sessionId }) + '\0')
    })
  }

  fail(error) {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer)
      request.reject(error)
    }
    this.pending.clear()
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

import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const helper = fileURLToPath(new URL('./ServiceKeyProtection.ps1', import.meta.url))
const unavailable = () => Object.assign(new Error('Local encrypted credential storage is unavailable.'), { code: 'CAPTCHA_STORAGE_UNAVAILABLE' })

// Secrets cross an anonymous stdin/stdout pipe, never process arguments or files.
async function protection(mode, input = '', directory) {
  if (process.platform !== 'win32') throw unavailable()
  const executable = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe')
  const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helper, '-Mode', mode]
  if (directory) args.push('-Directory', directory)
  return new Promise((resolve, reject) => {
    let finished = false, bytes = 0
    const chunks = []
    const modules = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/Modules')
    const child = spawn(executable, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PSModulePath: `${modules};${process.env.PSModulePath ?? ''}` } })
    const finish = (error, value) => {
      if (finished) return
      finished = true; clearTimeout(timer)
      if (error && child.exitCode === null) child.kill()
      for (const chunk of chunks) chunk.fill(0)
      error ? reject(unavailable()) : resolve(value)
    }
    const timer = setTimeout(() => { child.kill(); finish(true) }, 15000)
    child.on('error', () => finish(true))
    child.stderr.resume()
    child.stdout.on('data', chunk => {
      if (finished) { chunk.fill(0); return }
      bytes += chunk.length
      if (bytes > 16384) { child.kill(); finish(true) }
      else chunks.push(chunk)
    })
    child.on('close', code => {
      const output = Buffer.concat(chunks)
      try { finish(code !== 0, output.toString('utf8').trim()) } finally { output.fill(0) }
    })
    child.stdin.on('error', () => finish(true))
    child.stdin.end(input)
  })
}

export class WindowsServiceKey {
  get available() { return process.platform === 'win32' }
  async ensureDirectory(directory) {
    if (await protection('directory', '', directory) !== 'ok') throw unavailable()
  }
  async protect(value) {
    const bytes = Buffer.from(value, 'utf8')
    try { return await protection('protect', bytes.toString('base64')) }
    finally { bytes.fill(0) }
  }
  async unprotect(encrypted) {
    const encoded = await protection('unprotect', encrypted)
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw unavailable()
    const bytes = Buffer.from(encoded, 'base64')
    try {
      const value = bytes.toString('utf8')
      if (!/^[A-Za-z0-9_-]{20,256}$/.test(value)) throw unavailable()
      return value
    } finally { bytes.fill(0) }
  }
}

import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
// An explicit override lets the identical test exercise an older installed relay.
const launcher = path.resolve(process.env.VELMREN_RELAY_TEST_SOURCE || path.join(root, 'Start-VelmrenMcp.ps1'))

const harness = String.raw`param([string]$Launcher, [string]$NodePath, [string]$Fixture, [string]$Evidence)
$ErrorActionPreference = 'Stop'
$env:PSModulePath = (Join-Path $PSHOME 'Modules') + ';' + $env:PSModulePath
if ($PSVersionTable.PSEdition -ne 'Desktop' -or $PSVersionTable.PSVersion.Major -ne 5 -or $PSVersionTable.PSVersion.Minor -ne 1) {
    throw 'This regression requires Windows PowerShell 5.1.'
}
$source = [System.IO.File]::ReadAllText($Launcher)
$match = [regex]::Match($source, "(?s)Add-Type -TypeDefinition @'\r?\n(.*?)\r?\n'@")
if (-not $match.Success -or -not $match.Groups[1].Value.Contains('public static class VelmrenMcpRelay')) {
    throw 'Cannot extract the actual VelmrenMcpRelay definition.'
}
[System.IO.File]::WriteAllText((Join-Path $Evidence 'relay.cs'), $match.Groups[1].Value)
Add-Type -TypeDefinition $match.Groups[1].Value
$metadata = @{ version = $PSVersionTable.PSVersion.ToString(); edition = $PSVersionTable.PSEdition; home = $PSHOME; modulePath = $env:PSModulePath } | ConvertTo-Json -Compress
[System.IO.File]::WriteAllText((Join-Path $Evidence 'powershell.json'), $metadata)
exit [VelmrenMcpRelay]::Run($NodePath, @($Fixture, $Evidence))
`

const fixture = String.raw`import { appendFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
const evidence = process.argv[2]
let bytes = 0
// A lost test runner must not leave a fixture waiting for input indefinitely.
setTimeout(() => process.exit(124), 35000).unref()
writeFileSync(path.join(evidence, 'received.bin'), Buffer.alloc(0))
writeFileSync(path.join(evidence, 'fixture-ready.json'), JSON.stringify({ pid: process.pid, ppid: process.ppid }))
process.stdin.on('data', chunk => {
  bytes += chunk.length
  appendFileSync(path.join(evidence, 'received.bin'), chunk)
  process.stdout.write(chunk)
  process.stderr.write(chunk)
})
process.stdin.on('end', () => {
  writeFileSync(path.join(evidence, 'fixture-eof.json'), JSON.stringify({ bytes }))
})
`

test('Windows PowerShell 5.1 relay flushes small UTF-8 messages before EOF and exits naturally', {
  skip: process.platform !== 'win32', timeout: 45000,
}, async t => {
  await mkdir(path.join(root, 'test-results'), { recursive: true })
  const evidence = await mkdtemp(path.join(root, 'test-results', 'windows-relay-'))
  t.diagnostic(`Relay evidence: ${evidence}`)
  const harnessPath = path.join(evidence, 'relay-harness.ps1')
  const fixturePath = path.join(evidence, 'echo-fixture.mjs')
  const source = await readFile(launcher)
  await Promise.all([
    writeFile(harnessPath, harness), writeFile(fixturePath, fixture),
    writeFile(path.join(evidence, 'launcher.ps1'), source),
  ])
  const powershellHome = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0')
  const executable = path.join(powershellHome, 'powershell.exe')
  // Do not let an inherited PowerShell 7 module directory shadow native 5.1 modules.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'psmodulepath'))
  const inheritedModules = Object.entries(process.env).find(([key]) => key.toLowerCase() === 'psmodulepath')?.[1]
  env.PSModulePath = [path.join(powershellHome, 'Modules'), inheritedModules].filter(Boolean).join(';')
  const child = spawn(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', harnessPath,
    '-Launcher', launcher, '-NodePath', process.execPath, '-Fixture', fixturePath, '-Evidence', evidence], {
    windowsHide: true, env, stdio: ['pipe', 'pipe', 'pipe'],
  })
  const progress = new EventEmitter()
  let stdout = Buffer.alloc(0), stderr = Buffer.alloc(0), ioError, closed, exited = false, fixturePid
  const report = { launcher, sourceSha256: createHash('sha256').update(source).digest('hex'), node: process.execPath,
    relayPid: child.pid, startedAt: new Date().toISOString(), stdinEnded: false, exchanges: [], cleanup: [] }
  const deadline = Date.now() + 25000
  child.stdout.on('data', chunk => { stdout = Buffer.concat([stdout, chunk]); progress.emit('change') })
  child.stderr.on('data', chunk => { stderr = Buffer.concat([stderr, chunk]); progress.emit('change') })
  const onError = error => { ioError = error; progress.emit('change') }
  child.on('error', onError)
  child.stdin.on('error', onError)
  child.on('exit', () => { exited = true })
  child.on('close', (code, signal) => { closed = { code, signal }; progress.emit('change') })

  function waitFor(predicate, label, limitMs = 3000, allowClosed = false) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error(`${label} timed out (${stdout.length} stdout bytes, ${stderr.length} stderr bytes)`)),
        Math.max(1, Math.min(limitMs, deadline - Date.now())))
      function finish(error) {
        clearTimeout(timer)
        progress.off('change', check)
        error ? reject(error) : resolve()
      }
      function check() {
        if (ioError) return finish(ioError)
        if (predicate()) return finish()
        if (closed && !allowClosed) finish(new Error(`Relay exited before ${label}: ${JSON.stringify(closed)}; ${stderr.toString('utf8').slice(0, 2000)}`))
      }
      progress.on('change', check)
      check()
    })
  }

  let cleanupPromise
  function cleanup() {
    return cleanupPromise ||= (async () => {
      if (!exited && child.pid) {
        // This tree contains only the harness and the echo fixture created above.
        const result = spawnSync(path.join(process.env.SystemRoot, 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'],
          { windowsHide: true, encoding: 'utf8', timeout: 5000 })
        report.cleanup.push({ action: 'kill-owned-relay-tree', status: result.status, error: result.error?.message })
      }
      if (!fixturePid) {
        try {
          const ready = JSON.parse(await readFile(path.join(evidence, 'fixture-ready.json'), 'utf8'))
          if (ready.ppid === child.pid) fixturePid = ready.pid
        } catch {}
      }
      if (fixturePid) {
        try {
          process.kill(fixturePid, 0)
          process.kill(fixturePid)
          report.cleanup.push({ action: 'kill-owned-fixture', pid: fixturePid })
        } catch (error) { if (error.code !== 'ESRCH') throw error }
      }
      child.stdin.destroy()
      child.stdout.destroy()
      child.stderr.destroy()
      const cleanupDeadline = Date.now() + 3000
      function alive(pid) {
        if (!pid) return false
        try { process.kill(pid, 0); return true } catch (error) {
          if (error.code === 'ESRCH') return false
          throw error
        }
      }
      while (alive(child.pid) || alive(fixturePid)) {
        assert.ok(Date.now() < cleanupDeadline, 'Owned relay or fixture survived cleanup')
        await new Promise(resolve => setTimeout(resolve, 25))
      }
      report.cleanupComplete = true
    })()
  }
  t.after(cleanup)

  let expected = Buffer.alloc(0), sent = Buffer.alloc(0)
  function send(bytes) {
    sent = Buffer.concat([sent, bytes])
    child.stdin.write(bytes)
  }
  try {
    // Readiness is independent of the relay, so buffering cannot disguise startup.
    const startupDeadline = Date.now() + 15000
    for (;;) {
      if (ioError) throw ioError
      if (closed) throw new Error(`PowerShell startup failed: ${stderr.toString('utf8').slice(0, 2000)}`)
      let ready
      try { ready = JSON.parse(await readFile(path.join(evidence, 'fixture-ready.json'), 'utf8')) } catch (error) {
        if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error
      }
      if (ready) {
        assert.equal(ready.ppid, child.pid)
        fixturePid = ready.pid
        report.fixturePid = fixturePid
        break
      }
      assert.ok(Date.now() < startupDeadline, 'Windows PowerShell 5.1 fixture startup timed out')
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    report.powershell = JSON.parse(await readFile(path.join(evidence, 'powershell.json'), 'utf8'))
    assert.match(report.powershell.version, /^5\.1\./)
    assert.equal(report.powershell.edition, 'Desktop')
    assert.equal(report.powershell.modulePath.split(';')[0].toLowerCase(), path.join(report.powershell.home, 'Modules').toLowerCase())

    const messages = [Buffer.from('{"jsonrpc":"2.0","id":1}\n')]
    for (let id = 2; id <= 13; id++) messages.push(Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, text: 'Привет — ✓ 😀 漢字 café' }) + '\n', 'utf8'))
    assert.ok(Buffer.concat(messages).length < 4096, 'Keep the whole exchange below a typical pipe stream buffer')
    for (const [index, message] of messages.entries()) {
      const started = Date.now()
      expected = Buffer.concat([expected, message])
      if (index === 1) {
        // Send half a UTF-8 code point first; the relay must forward raw bytes.
        const split = message.indexOf(Buffer.from('Привет')) + 1
        send(message.subarray(0, split))
        const prefix = expected.length - message.length + split
        await waitFor(() => stdout.length >= prefix && stderr.length >= prefix, 'partial UTF-8 bytes before EOF')
        assert.deepEqual(stdout, expected.subarray(0, prefix))
        assert.deepEqual(stderr, expected.subarray(0, prefix))
        send(message.subarray(split))
      } else send(message)
      await waitFor(() => stdout.length >= expected.length && stderr.length >= expected.length, `message ${index + 1} response before EOF`)
      assert.equal(child.stdin.writableEnded, false)
      assert.equal(closed, undefined)
      assert.deepEqual(stdout, expected)
      assert.deepEqual(stderr, expected)
      assert.deepEqual(await readFile(path.join(evidence, 'received.bin')), expected)
      report.exchanges.push({ message: index + 1, bytes: message.length, elapsedMs: Date.now() - started, beforeEof: true })
    }
    report.stdinEnded = true
    child.stdin.end()
    await waitFor(() => Boolean(closed), 'natural exit after stdin EOF', 5000, true)
    assert.deepEqual(closed, { code: 0, signal: null })
    assert.deepEqual(stdout, expected)
    assert.deepEqual(stderr, expected)
    assert.deepEqual(JSON.parse(await readFile(path.join(evidence, 'fixture-eof.json'), 'utf8')), { bytes: expected.length })
    assert.throws(() => process.kill(fixturePid, 0), { code: 'ESRCH' }, 'Echo fixture must exit naturally')
    report.status = 'passed'
  } catch (error) {
    report.status = 'failed'
    report.error = error.stack
    throw error
  } finally {
    report.exit = closed
    report.sentBytes = sent.length
    let cleanupError
    try { await cleanup() } catch (error) {
      cleanupError = error
      report.cleanupError = error.stack
    }
    await Promise.all([
      writeFile(path.join(evidence, 'stdout.bin'), stdout), writeFile(path.join(evidence, 'stderr.bin'), stderr),
      writeFile(path.join(evidence, 'sent.bin'), sent),
      writeFile(path.join(evidence, 'report.json'), JSON.stringify(report, null, 2) + '\n'),
    ])
    if (cleanupError) throw cleanupError
  }
})

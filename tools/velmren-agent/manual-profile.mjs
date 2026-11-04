import { spawn, execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { link, lstat, open, readFile, realpath, rename, unlink } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

export const MANUAL_PROFILE_RECEIPT = 'manual-profile.json'
const execFileAsync = promisify(execFile)
const states = new Set(['preparing', 'manual', 'awaiting-confirmation'])
const samePath = (a, b) => typeof a === 'string' && typeof b === 'string' && (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b)
const validPid = value => Number.isSafeInteger(value) && value > 0
const validText = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\x00-\x1f]/.test(value)

export class ManualProfileError extends Error {
  constructor(message, code = 'MANUAL_PROFILE_RECOVERY_REQUIRED') { super(message); this.name = 'ManualProfileError'; this.code = code }
}
const fail = (message, code) => { throw new ManualProfileError(message, code) }

export function validateManualProfileUrl(raw) {
  let url
  try { if (typeof raw !== 'string' || raw.length > 8192 || /[\x00-\x20]/.test(raw)) throw new Error(); url = new URL(raw) } catch { fail('Manual sign-in requires a valid HTTP(S) URL.', 'INVALID_ARGUMENTS') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) fail('Manual sign-in requires a valid HTTP(S) URL without credentials.', 'INVALID_ARGUMENTS')
  return url.href
}

function validateReceipt(value) {
  if (!value || value.version !== 1 || !validText(value.id) || !validText(value.owner) || !states.has(value.state) ||
      !validPid(value.brokerPid) || (value.browserPid !== null && !validPid(value.browserPid)) ||
      (value.browserStartTime !== null && !validText(value.browserStartTime)) ||
      !path.isAbsolute(value.executable ?? '') || !path.isAbsolute(value.profile ?? '') || !validText(value.policyIdentity) ||
      !Number.isFinite(Date.parse(value.createdAt)) || !Number.isFinite(Date.parse(value.updatedAt))) {
    fail('Manual sign-in receipt cannot be verified. Keep automation stopped and recover the manual session explicitly.')
  }
  return value
}

export async function readManualProfileReceipt(stateDir) {
  const file = path.join(stateDir, MANUAL_PROFILE_RECEIPT)
  try {
    const info = await lstat(file)
    if (!info.isFile() || info.isSymbolicLink() || info.size > 16384) fail('Manual sign-in receipt cannot be verified. Keep automation stopped.')
    return validateReceipt(JSON.parse(await readFile(file, 'utf8')))
  } catch (error) {
    if (error.code === 'ENOENT') return null
    if (error instanceof ManualProfileError) throw error
    fail('Manual sign-in receipt cannot be read. Keep automation stopped and recover the manual session explicitly.')
  }
}

// Presence, including an incomplete/corrupt receipt, is enough to block startup.
export async function assertNoManualProfileSession(stateDir) {
  try { await lstat(path.join(stateDir, MANUAL_PROFILE_RECEIPT)) } catch (error) {
    if (error.code === 'ENOENT') return
    fail('Manual sign-in state cannot be inspected. Keep automation stopped.')
  }
  fail('A manual sign-in session is pending. Close its browser and explicitly confirm completion before reconnecting automation.', 'MANUAL_PROFILE_ACTIVE')
}

// Arguments arrive through the environment, never interpolated into executable code.
// Only matching profile processes and the one requested PID leave this helper.
const windowsInspectionScript = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$inspectionStage = 'request'
try {
$request = $env:VELMREN_MANUAL_PROCESS_QUERY | ConvertFrom-Json
$inspectionStage = 'native-helper'
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class VelmrenManualCommandLine {
  [DllImport("shell32.dll", SetLastError=true)] static extern IntPtr CommandLineToArgvW([MarshalAs(UnmanagedType.LPWStr)] string commandLine, out int count);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr pointer);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern SafeFileHandle CreateFileW(string name, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern uint GetFinalPathNameByHandleW(SafeFileHandle handle, StringBuilder buffer, uint length, uint flags);
  public static string CanonicalDirectory(string name) {
    using (var handle = CreateFileW(name, 0, 7, IntPtr.Zero, 3, 0x02000000, IntPtr.Zero)) {
      if (handle.IsInvalid) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
      var buffer = new StringBuilder(32768);
      uint size = GetFinalPathNameByHandleW(handle, buffer, (uint)buffer.Capacity, 0);
      if (size == 0 || size >= buffer.Capacity) throw new InvalidOperationException();
      string result = buffer.ToString();
      if (result.StartsWith(@"\\?\UNC\")) return @"\\" + result.Substring(8);
      return result.StartsWith(@"\\?\") ? result.Substring(4) : result;
    }
  }
  public static string[] Split(string line) {
    int count; IntPtr pointer = CommandLineToArgvW(line, out count);
    if (pointer == IntPtr.Zero) throw new InvalidOperationException();
    try { var result = new string[count]; for (int i = 0; i < count; i++) result[i] = Marshal.PtrToStringUni(Marshal.ReadIntPtr(pointer, i * IntPtr.Size)); return result; }
    finally { LocalFree(pointer); }
  }
}
'@
function Identity($entry) {
  $script:inspectionStage = 'process-identity'
  if (!$entry.ExecutablePath -or !$entry.CreationDate) { throw 'PROCESS_IDENTITY_UNAVAILABLE' }
  return @{ pid = [int]$entry.ProcessId; executable = [string]$entry.ExecutablePath; startTime = $entry.CreationDate.ToUniversalTime().ToString('o') }
}
$matchingProcesses = @()
$requested = $null
$expectedName = [IO.Path]::GetFileName($request.executable)
$inspectionStage = 'profile-path'
$expectedProfile = [VelmrenManualCommandLine]::CanonicalDirectory([IO.Path]::GetFullPath($request.profile)).TrimEnd([char[]]'\/')
$inspectionStage = 'process-query'
foreach ($entry in @(Get-CimInstance Win32_Process -ErrorAction Stop)) {
  if ($request.pid -and [int]$entry.ProcessId -eq [int]$request.pid) { $requested = Identity $entry }
  if (!$entry.CommandLine) {
    if ($entry.Name -ieq $expectedName) {
      $inspectionStage = 'process-query'
      $stillPresent = @(Get-CimInstance Win32_Process -Filter ('ProcessId = ' + [int]$entry.ProcessId) -ErrorAction Stop)
      if ($stillPresent.Count) { throw 'BROWSER_COMMANDLINE_UNAVAILABLE' }
    }
    continue
  }
  if ($entry.CommandLine -notmatch '(?i)--user-data-dir') { continue }
  $inspectionStage = 'command-line'
  $arguments = [VelmrenManualCommandLine]::Split($entry.CommandLine)
  for ($i = 1; $i -lt $arguments.Length; $i++) {
    $candidate = $null
    if ($arguments[$i].StartsWith('--user-data-dir=', [StringComparison]::OrdinalIgnoreCase)) { $candidate = $arguments[$i].Substring(16) }
    elseif ($arguments[$i] -ieq '--user-data-dir' -and $i + 1 -lt $arguments.Length) { $i++; $candidate = $arguments[$i] }
    if (!$candidate) { continue }
    if (![IO.Path]::IsPathRooted($candidate)) { throw 'RELATIVE_PROFILE_UNVERIFIED' }
    $inspectionStage = 'candidate-profile'
    try { $candidate = [VelmrenManualCommandLine]::CanonicalDirectory([IO.Path]::GetFullPath($candidate)).TrimEnd([char[]]'\/') }
    catch {
      # A process snapshot can outlive a test process and its temporary profile.
      # A missing live process alias is still ambiguous and must fail closed.
      $inspectionStage = 'process-query'
      $stillPresent = @(Get-CimInstance Win32_Process -Filter ('ProcessId = ' + [int]$entry.ProcessId) -ErrorAction Stop)
      if (!$stillPresent.Count) { break }
      $inspectionStage = 'candidate-profile'
      throw
    }
    if ($candidate -ieq $expectedProfile) { $matchingProcesses += (Identity $entry); break }
  }
}
$inspectionStage = 'result'
@{ matches = @($matchingProcesses); requested = $requested } | ConvertTo-Json -Compress -Depth 4
} catch {
  $knownIds = @('PROCESS_IDENTITY_UNAVAILABLE', 'BROWSER_COMMANDLINE_UNAVAILABLE', 'RELATIVE_PROFILE_UNVERIFIED', 'NonStringKeyInDictionary,Microsoft.PowerShell.Commands.ConvertToJsonCommand', 'MethodInvocationException')
  $errorId = 'POWERSHELL_ERROR'
  if ($knownIds -contains $_.FullyQualifiedErrorId) { $errorId = $_.FullyQualifiedErrorId.Split(',')[0] }
  $nativeCode = 0
  if ($_.Exception.InnerException -is [System.ComponentModel.Win32Exception]) { $nativeCode = $_.Exception.InnerException.NativeErrorCode }
  [Console]::Out.WriteLine('{"inspectionFailure":{"stage":"' + $inspectionStage + '","errorId":"' + $errorId + '","nativeCode":' + [int]$nativeCode + '}}')
}
`

export async function inspectManualProfileProcesses({ profile, executable, pid = null }, { runProcess = execFileAsync } = {}) {
  if (process.platform !== 'win32') fail('Reliable manual browser process inspection is not available on this platform. Keep automation stopped.')
  try {
    const powershell = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    const { stdout } = await runProcess(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(windowsInspectionScript, 'utf16le').toString('base64')], {
      timeout: 10000, maxBuffer: 256 * 1024, windowsHide: true, encoding: 'utf8',
      env: { ...process.env, VELMREN_MANUAL_PROCESS_QUERY: JSON.stringify({ profile, executable, pid }) }
    })
    const result = JSON.parse(stdout.replace(/^\uFEFF/, ''))
    if (result.inspectionFailure) {
      const { stage, errorId, nativeCode } = result.inspectionFailure
      const stages = ['request', 'native-helper', 'profile-path', 'process-query', 'process-identity', 'command-line', 'candidate-profile', 'result']
      const ids = ['PROCESS_IDENTITY_UNAVAILABLE', 'BROWSER_COMMANDLINE_UNAVAILABLE', 'RELATIVE_PROFILE_UNVERIFIED', 'NonStringKeyInDictionary', 'MethodInvocationException', 'POWERSHELL_ERROR']
      if (stages.includes(stage) && ids.includes(errorId) && Number.isSafeInteger(nativeCode)) {
        fail(`Manual browser processes cannot be verified (${stage}; ${errorId}; ${nativeCode}). Keep automation stopped and retry after closing the manual browser.`)
      }
      throw new Error()
    }
    return result
  } catch (error) {
    if (error instanceof ManualProfileError) throw error
    const reason = error.killed ? 'inspection-timeout' : Number.isInteger(error.code) ? `powershell-exit-${error.code}` : 'inspection-runtime'
    fail(`Manual browser processes cannot be verified (${reason}). Keep automation stopped and retry after closing the manual browser.`)
  }
}

/** The caller holds the broker's exclusive state-directory lock for this lifetime.
 * A receipt is a crash guard, not a lock against unrelated external browser launches.
 * No method terminates the manual browser. Complete only after successful CDP rebind.
 */
export class ManualProfileSession {
  constructor({ stateDir, executable, profile, policyIdentity, brokerPid = process.pid, spawnProcess = spawn,
    inspectProcesses = inspectManualProfileProcesses, now = () => new Date().toISOString() }) {
    Object.assign(this, { stateDir: path.resolve(stateDir), executable: path.resolve(executable), profile: path.resolve(profile), policyIdentity, brokerPid })
    this._spawn = spawnProcess; this._inspect = inspectProcesses; this._now = now
    this._receipt = null; this._queue = Promise.resolve(); this._child = null; this._exited = false; this._preparedHere = false; this._spawnAttempted = false; this._confirmed = null
  }
  get receipt() { return this._receipt ? { ...this._receipt } : null }
  get current() { return this.receipt }
  _run(fn) { const result = this._queue.then(fn); this._queue = result.catch(() => {}); return result }
  async _canonicalize() {
    try { [this.stateDir, this.executable, this.profile] = await Promise.all([realpath(this.stateDir), realpath(this.executable), realpath(this.profile)]) }
    catch { fail('The dedicated manual browser configuration cannot be verified.', 'INVALID_ARGUMENTS') }
  }
  async _readExpected(id = this._receipt?.id) {
    const receipt = await readManualProfileReceipt(this.stateDir)
    if (!receipt || receipt.id !== id || !samePath(receipt.executable, this.executable) || !samePath(receipt.profile, this.profile) || receipt.policyIdentity !== this.policyIdentity) {
      fail('Manual sign-in receipt changed or belongs to another configuration. Keep automation stopped.')
    }
    this._receipt = receipt
    return receipt
  }
  async _write(receipt, initial = false) {
    const file = path.join(this.stateDir, MANUAL_PROFILE_RECEIPT)
    const temporary = path.join(this.stateDir, `.manual-profile.${randomUUID()}.tmp`)
    let handle
    try {
      handle = await open(temporary, 'wx', 0o600)
      await handle.writeFile(`${JSON.stringify(validateReceipt(receipt), null, 2)}\n`)
      await handle.sync(); await handle.close(); handle = null
      // link publishes the first complete receipt without overwriting another one.
      if (initial) await link(temporary, file)
      else { await this._readExpected(receipt.id); await rename(temporary, file) }
      this._receipt = receipt
    } catch (error) {
      if (error instanceof ManualProfileError) throw error
      fail('Manual sign-in state could not be saved. Keep automation stopped.')
    } finally { await handle?.close().catch(() => {}); await unlink(temporary).catch(() => {}) }
  }
  async _processes() {
    let result
    try { result = await this._inspect({ profile: this.profile, executable: this.executable, pid: this._receipt?.browserPid ?? null }) }
    catch (error) {
      if (error instanceof ManualProfileError) throw error
      fail('Manual browser processes cannot be verified. Keep automation stopped and retry after closing the manual browser.')
    }
    const validIdentity = entry => entry && validPid(entry.pid) && path.isAbsolute(entry.executable ?? '') && validText(entry.startTime)
    if (!result || !Array.isArray(result.matches) || result.matches.some(entry => !validIdentity(entry)) ||
        !Object.hasOwn(result, 'requested') || (result.requested !== null && !validIdentity(result.requested))) fail('Manual browser process inspection is incomplete. Keep automation stopped.')
    return result
  }
  _public(windowOpen, recoveryRequired = false) {
    return { id: this._receipt.id, loginId: this._receipt.id, state: this._receipt.state, windowOpen, automationConnected: false, ...(recoveryRequired ? { recoveryRequired: true } : {}) }
  }
  async _status() {
    if (!this._receipt) return null
    await this._readExpected()
    const knownUnlaunched = this._preparedHere && !this._spawnAttempted && !this._child
    if ((this._receipt.state === 'preparing' || !this._receipt.browserPid) && !knownUnlaunched) return this._public(null, true)
    let processes
    try { processes = await this._processes() } catch { return this._public(null, true) }
    if (processes.matches.length) return this._public(true)
    // This proof exists only in the supervisor which prepared, but never spawned.
    // Keep preparing until explicit close verification so launch may be retried.
    if (knownUnlaunched && processes.requested === null) return this._public(false)
    if (processes.requested !== null || (!this._exited && !this._receipt.browserStartTime)) return this._public(null, true)
    if (this._receipt.state !== 'awaiting-confirmation') await this._write({ ...this._receipt, state: 'awaiting-confirmation', updatedAt: this._now() })
    return this._public(false)
  }
  load() { return this._run(async () => {
    await this._canonicalize()
    this._preparedHere = false
    const receipt = await readManualProfileReceipt(this.stateDir)
    if (!receipt) { this._receipt = null; return null }
    this._receipt = receipt
    await this._readExpected(receipt.id)
    return this._status()
  }) }
  prepare({ loginId = randomUUID(), owner }) { return this._run(async () => {
    if (!validText(loginId) || !validText(owner) || !validText(this.policyIdentity) || !validPid(this.brokerPid)) fail('Invalid manual sign-in identity.', 'INVALID_ARGUMENTS')
    await this._canonicalize()
    await assertNoManualProfileSession(this.stateDir)
    const timestamp = this._now()
    await this._write({ version: 1, id: loginId, owner, state: 'preparing', brokerPid: this.brokerPid, browserPid: null, browserStartTime: null,
      executable: this.executable, profile: this.profile, policyIdentity: this.policyIdentity, createdAt: timestamp, updatedAt: timestamp }, true)
    this._disown()
    this._preparedHere = true; this._spawnAttempted = false; this._exited = false; this._confirmed = null
    return this._public(null)
  }) }
  launch(rawUrl) {
    // Validate before any I/O, including receipt checks.
    const url = validateManualProfileUrl(rawUrl)
    return this._run(async () => {
      await this._readExpected()
      if (!this._preparedHere || this._receipt.state !== 'preparing') fail('This manual sign-in launch cannot be recovered automatically. Keep automation stopped.')
      const processes = await this._processes()
      if (processes.matches.length) fail('A browser already uses the dedicated profile. Close it before starting manual sign-in.', 'MANUAL_PROFILE_IN_USE')
      this._preparedHere = false
      this._spawnAttempted = true
      let child
      try {
        child = this._spawn(this.executable, [`--user-data-dir=${this.profile}`, '--no-first-run', '--no-default-browser-check',
          '--restore-last-session', '--disable-features=BraveCleanupSessionCookiesOnSessionRestore', url], { shell: false, detached: true, stdio: 'ignore', windowsHide: false })
        this._child = child
        this._exitListener = () => { this._exited = true }
        child.once('exit', this._exitListener)
        await new Promise((resolve, reject) => {
          const error = () => { child.off('spawn', spawned); reject(new Error()) }
          const spawned = () => { child.off('error', error); resolve() }
          child.once('error', error); child.once('spawn', spawned)
        })
        // Retain a harmless error listener after spawn; never expose OS paths.
        this._errorListener = () => {}
        child.on('error', this._errorListener)
        child.unref?.()
        if (!validPid(child.pid)) throw new Error()
      } catch { fail('The manual browser could not be launched. The receipt remains in place; keep automation stopped.') }
      let startTime = null
      // Save the PID first. A crash before identity capture remains fail-closed.
      await this._write({ ...this._receipt, state: 'manual', browserPid: child.pid, updatedAt: this._now() })
      try {
        const inspected = await this._processes()
        const identity = inspected.matches.find(entry => entry.pid === child.pid && samePath(entry.executable, this.executable))
        if (identity && inspected.requested?.pid === identity.pid && inspected.requested.startTime === identity.startTime && samePath(inspected.requested.executable, identity.executable)) startTime = identity.startTime
      } catch { /* Keep the PID-only guard; later recovery must not guess. */ }
      if (startTime) await this._write({ ...this._receipt, browserStartTime: startTime, updatedAt: this._now() })
      return this._status()
    })
  }
  status() { return this._run(() => this._status()) }
  async _assertClosed(loginId) {
    if (!this._receipt || this._receipt.id !== loginId) fail('Manual sign-in identity does not match.', 'INVALID_ARGUMENTS')
    const status = await this._status()
    if (status.windowOpen === true) fail('Close the manual browser window before reconnecting automation.', 'MANUAL_PROFILE_OPEN')
    if (status.windowOpen !== false) fail('The manual browser cannot be proven closed. Keep automation stopped and recover the manual session explicitly.')
    if (this._receipt.state !== 'awaiting-confirmation') await this._write({ ...this._receipt, state: 'awaiting-confirmation', updatedAt: this._now() })
    return status
  }
  assertClosed(loginId) { return this._run(() => this._assertClosed(loginId)) }
  finish(loginId, { userConfirmed } = {}) { return this._run(async () => {
    if (userConfirmed !== true) fail('Explicit confirmation is required after closing the manual browser.', 'USER_CONFIRMATION_REQUIRED')
    const status = await this._assertClosed(loginId)
    this._confirmed = loginId
    return status
  }) }
  complete(loginId) { return this._run(async () => {
    if (this._confirmed !== loginId) fail('Manual completion requires a verified close and explicit confirmation.', 'USER_CONFIRMATION_REQUIRED')
    const receipt = await this._readExpected(loginId)
    if (receipt.state !== 'awaiting-confirmation') fail('Manual sign-in is not ready for completion.')
    await unlink(path.join(this.stateDir, MANUAL_PROFILE_RECEIPT)).catch(() => fail('Manual sign-in receipt could not be cleared. Keep automation stopped.'))
    this._receipt = null; this._confirmed = null
    this._disown()
    return { id: loginId, loginId, completed: true }
  }) }
  _disown() {
    this._child?.off('exit', this._exitListener)
    // Keep the no-op error handler: disowning must not cause unhandled errors.
    this._child?.unref?.(); this._child = null
  }
  close() { return this._run(async () => { this._disown() }) }
}

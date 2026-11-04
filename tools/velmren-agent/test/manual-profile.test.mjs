import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath, symlink } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { ManualProfileSession, MANUAL_PROFILE_RECEIPT, assertNoManualProfileSession, readManualProfileReceipt, validateManualProfileUrl, inspectManualProfileProcesses } from '../manual-profile.mjs'

async function fixture(t) {
  const stateDir = await mkdtemp(path.join(path.dirname(fileURLToPath(import.meta.url)), '.manual-profile-'))
  t.after(() => rm(stateDir, { recursive: true, force: true }))
  const executable = path.join(stateDir, 'fixture-browser.exe'), profile = path.join(stateDir, 'browser-profile')
  await writeFile(executable, 'inert fixture, never executed'); await mkdir(profile)
  const calls = [], processes = new Map()
  let kills = 0, inspections = 0, inspectionError = false, spawnError = false, omitRequestedIdentity = false, nextPid = 4101
  const options = { stateDir, executable, profile, policyIdentity: 'fixture-policy', brokerPid: 4100,
    spawnProcess: (file, args, options) => {
      const child = new EventEmitter()
      child.pid = nextPid++; child.unref = () => {}; child.kill = () => { kills++ }
      calls.push({ file, args, options, child })
      if (spawnError) queueMicrotask(() => child.emit('error', new Error('sensitive OS path')))
      else {
        processes.set(child.pid, { pid: child.pid, executable: file, startTime: `fixture-time-${child.pid}` })
        queueMicrotask(() => child.emit('spawn'))
      }
      return child
    },
    inspectProcesses: async ({ pid }) => {
      inspections++
      if (inspectionError) throw new Error('sensitive command line')
      return { matches: [...processes.values()].filter(entry => !entry.otherProfile), requested: omitRequestedIdentity ? null : processes.get(pid) ?? null }
    }
  }
  const session = new ManualProfileSession(options)
  return { options, session, calls, processes, file: path.join(stateDir, MANUAL_PROFILE_RECEIPT),
    get kills() { return kills }, get inspections() { return inspections },
    set inspectionError(value) { inspectionError = value }, set spawnError(value) { spawnError = value }, set omitRequestedIdentity(value) { omitRequestedIdentity = value },
    async begin() { await session.prepare({ loginId: 'login-1', owner: 'codex' }); return session.launch('https://example.test/sign-in?private=value') },
    exit() { const child = calls.at(-1).child; processes.delete(child.pid); child.emit('exit', 0, null) }
  }
}

test('invalid URLs fail before I/O, inspection, spawning, or changing a receipt', async t => {
  const f = await fixture(t)
  await f.session.prepare({ loginId: 'login-1', owner: 'codex' })
  const before = await readFile(f.file, 'utf8')
  for (const url of ['--remote-debugging-port=9222', 'file:///private', 'chrome://settings', 'https://user:password@example.test/', 'https://example.test/\n--headless', ' https://example.test/', null]) {
    assert.throws(() => f.session.launch(url), { code: 'INVALID_ARGUMENTS' })
  }
  assert.equal(await readFile(f.file, 'utf8'), before)
  assert.equal(f.inspections, 0); assert.equal(f.calls.length, 0)
  assert.equal(validateManualProfileUrl('https://example.test'), 'https://example.test/')
})

test('manual launch uses only ordinary visible browser arguments and keeps URLs out of its receipt', async t => {
  const f = await fixture(t), status = await f.begin(), call = f.calls[0]
  assert.equal(status.windowOpen, true); assert.equal(status.automationConnected, false)
  assert.deepEqual(call.args, [`--user-data-dir=${await realpath(f.options.profile)}`, '--no-first-run', '--no-default-browser-check',
    '--restore-last-session', '--disable-features=BraveCleanupSessionCookiesOnSessionRestore', 'https://example.test/sign-in?private=value'])
  assert.deepEqual(call.options, { shell: false, detached: true, stdio: 'ignore', windowsHide: false })
  assert.doesNotMatch(call.args.join(' '), /remote-debugging|velmren-agent-mode|headless|enable-automation|user-agent|blink/)
  const raw = await readFile(f.file, 'utf8'), receipt = JSON.parse(raw)
  assert.doesNotMatch(raw, /example\.test|private=value|token|password/)
  assert.equal(receipt.browserPid, call.child.pid); assert.equal(receipt.browserStartTime, `fixture-time-${call.child.pid}`)
  assert.equal(receipt.brokerPid, 4100); assert.equal(receipt.profile, await realpath(f.options.profile))
  assert.equal(receipt.executable, await realpath(f.options.executable))
  assert.deepEqual(Object.keys(status).sort(), ['automationConnected', 'id', 'loginId', 'state', 'windowOpen'])
})

test('existing profile process prevents launch and leaves the guard in place', async t => {
  const f = await fixture(t)
  await f.session.prepare({ loginId: 'login-1', owner: 'codex' })
  f.processes.set(4200, { pid: 4200, executable: f.options.executable, startTime: 'earlier' })
  await assert.rejects(f.session.launch('https://example.test/'), { code: 'MANUAL_PROFILE_IN_USE' })
  assert.equal(f.calls.length, 0); assert.equal((await readManualProfileReceipt(f.options.stateDir)).state, 'preparing')
  await assert.rejects(assertNoManualProfileSession(f.options.stateDir), { code: 'MANUAL_PROFILE_ACTIVE' })
})

test('close disowns a live manual browser without killing it or clearing the guard', async t => {
  const f = await fixture(t)
  await f.begin(); await f.session.close()
  assert.equal(f.kills, 0); assert.equal(f.processes.size, 1)
  assert.equal((await readManualProfileReceipt(f.options.stateDir)).state, 'manual')
  assert.equal((await f.session.status()).windowOpen, true)
})

test('explicit confirmed close retains the guard until successful rebind completion', async t => {
  const f = await fixture(t)
  await f.begin()
  await assert.rejects(f.session.finish('login-1', { userConfirmed: true }), { code: 'MANUAL_PROFILE_OPEN' })
  f.exit()
  assert.equal((await f.session.status()).state, 'awaiting-confirmation')
  for (const confirmation of [undefined, false, 'true', 1]) await assert.rejects(f.session.finish('login-1', { userConfirmed: confirmation }), { code: 'USER_CONFIRMATION_REQUIRED' })
  await assert.rejects(f.session.finish('wrong-id', { userConfirmed: true }), { code: 'INVALID_ARGUMENTS' })
  await assert.rejects(f.session.complete('login-1'), { code: 'USER_CONFIRMATION_REQUIRED' })
  const checked = await f.session.finish('login-1', { userConfirmed: true })
  assert.equal(checked.windowOpen, false)
  await assert.rejects(assertNoManualProfileSession(f.options.stateDir), { code: 'MANUAL_PROFILE_ACTIVE' })
  // Root owns CDP rebind; its new process may now legitimately use the profile.
  f.processes.set(4500, { pid: 4500, executable: f.options.executable, startTime: 'automated-rebind' })
  assert.equal((await f.session.complete('login-1')).completed, true)
  await assertNoManualProfileSession(f.options.stateDir)
  assert.equal(f.session.receipt, null); assert.equal(f.kills, 0)
})

test('recovery observes a manual receipt and never spawns or assumes completion', async t => {
  const f = await fixture(t)
  await f.begin(); await f.session.close()
  const recovered = new ManualProfileSession(f.options)
  assert.equal((await recovered.load()).windowOpen, true)
  assert.equal(f.calls.length, 1)
  await assert.rejects(recovered.assertClosed('login-1'), { code: 'MANUAL_PROFILE_OPEN' })
  f.processes.clear()
  assert.equal((await recovered.status()).windowOpen, false)
  await recovered.finish('login-1', { userConfirmed: true }); await recovered.complete('login-1')
  assert.equal(f.calls.length, 1); assert.equal(f.kills, 0)
})

test('a reused PID blocks completion even if it now belongs to another profile', async t => {
  const f = await fixture(t)
  await f.begin(); await f.session.close()
  const childPid = f.calls[0].child.pid
  f.processes.set(childPid, { pid: childPid, executable: f.options.executable, startTime: 'reused-pid', otherProfile: true })
  const recovered = new ManualProfileSession(f.options), status = await recovered.load()
  assert.equal(status.windowOpen, null); assert.equal(status.recoveryRequired, true)
  await assert.rejects(recovered.finish('login-1', { userConfirmed: true }), { code: 'MANUAL_PROFILE_RECOVERY_REQUIRED' })
  assert.ok(await readManualProfileReceipt(f.options.stateDir))
})

test('recovered preparing receipt cannot launch or complete without a recorded PID', async t => {
  const f = await fixture(t)
  await f.session.prepare({ loginId: 'login-1', owner: 'codex' })
  const recovered = new ManualProfileSession(f.options), status = await recovered.load()
  assert.equal(status.windowOpen, null); assert.equal(status.recoveryRequired, true)
  await assert.rejects(recovered.launch('https://example.test/'), { code: 'MANUAL_PROFILE_RECOVERY_REQUIRED' })
  await assert.rejects(recovered.finish('login-1', { userConfirmed: true }), { code: 'MANUAL_PROFILE_RECOVERY_REQUIRED' })
  assert.equal(f.calls.length, 0)
})

test('spawn failure keeps an ambiguous guard and sanitizes the process error', async t => {
  const f = await fixture(t)
  f.spawnError = true
  await assert.rejects(f.begin(), error => error.code === 'MANUAL_PROFILE_RECOVERY_REQUIRED' && !error.message.includes('sensitive'))
  const receipt = await readManualProfileReceipt(f.options.stateDir)
  assert.equal(receipt.state, 'preparing'); assert.equal(receipt.browserPid, null); assert.equal(f.kills, 0)
  assert.equal((await f.session.status()).recoveryRequired, true)
})

test('failed inspection blocks launch and prevents claiming an existing window closed', async t => {
  const f = await fixture(t)
  await f.session.prepare({ loginId: 'login-1', owner: 'codex' })
  f.inspectionError = true
  await assert.rejects(f.session.launch('https://example.test/'), { code: 'MANUAL_PROFILE_RECOVERY_REQUIRED' })
  assert.equal(f.calls.length, 0)
  f.inspectionError = false; await f.session.launch('https://example.test/'); f.exit(); f.inspectionError = true
  assert.deepEqual(await f.session.status(), { id: 'login-1', loginId: 'login-1', state: 'manual', windowOpen: null, automationConnected: false, recoveryRequired: true })
  await assert.rejects(f.session.assertClosed('login-1'), { code: 'MANUAL_PROFILE_RECOVERY_REQUIRED' })
})

test('the original supervisor can explicitly finish a never-spawned session only after a fresh empty scan', async t => {
  const f = await fixture(t)
  await f.session.prepare({ loginId: 'login-1', owner: 'codex' })
  f.inspectionError = true
  await assert.rejects(f.session.launch('https://example.test/'), { code: 'MANUAL_PROFILE_RECOVERY_REQUIRED' })
  await assert.rejects(f.session.finish('login-1', { userConfirmed: true }), { code: 'MANUAL_PROFILE_RECOVERY_REQUIRED' })
  f.inspectionError = false
  // An automated browser which has not actually exited still blocks recovery.
  f.processes.set(4102, { pid: 4102, executable: f.options.executable, startTime: 'old-automated-browser' })
  await assert.rejects(f.session.finish('login-1', { userConfirmed: true }), { code: 'MANUAL_PROFILE_OPEN' })
  f.processes.clear()
  const recovered = new ManualProfileSession(f.options)
  await recovered.load()
  await assert.rejects(recovered.finish('login-1', { userConfirmed: true }), { code: 'MANUAL_PROFILE_RECOVERY_REQUIRED' })
  await assert.rejects(f.session.finish('login-1'), { code: 'USER_CONFIRMATION_REQUIRED' })
  await f.session.finish('login-1', { userConfirmed: true })
  assert.equal((await readManualProfileReceipt(f.options.stateDir)).state, 'awaiting-confirmation')
  await f.session.complete('login-1')
  assert.equal(f.calls.length, 0); assert.equal(f.kills, 0)
  // A later login in the same coordinator receives a fresh local proof.
  await f.session.prepare({ loginId: 'login-2', owner: 'codex' })
  assert.equal((await f.session.status()).windowOpen, false)
})

test('PID without captured start time is ambiguous after broker recovery', async t => {
  const f = await fixture(t)
  await f.begin(); f.exit()
  const receipt = await readManualProfileReceipt(f.options.stateDir)
  receipt.browserStartTime = null
  await writeFile(f.file, JSON.stringify(receipt))
  const recovered = new ManualProfileSession(f.options)
  assert.equal((await recovered.load()).recoveryRequired, true)
  await assert.rejects(recovered.assertClosed('login-1'), { code: 'MANUAL_PROFILE_RECOVERY_REQUIRED' })
  // The original supervisor has the actual exit event as additional evidence.
  assert.equal((await f.session.assertClosed('login-1')).windowOpen, false)
})

test('a prior login exit cannot prove a second browser with missing identity has exited', async t => {
  const f = await fixture(t)
  await f.begin(); f.exit()
  await f.session.finish('login-1', { userConfirmed: true }); await f.session.complete('login-1')
  await f.session.prepare({ loginId: 'login-2', owner: 'codex' })
  f.omitRequestedIdentity = true
  await f.session.launch('https://example.test/second-login')
  assert.equal((await readManualProfileReceipt(f.options.stateDir)).browserStartTime, null)
  // A snapshot no longer finding the PID is insufficient without its identity.
  f.processes.clear()
  assert.equal((await f.session.status()).windowOpen, null)
  await assert.rejects(f.session.finish('login-2', { userConfirmed: true }), { code: 'MANUAL_PROFILE_RECOVERY_REQUIRED' })
  f.calls.at(-1).child.emit('exit', 0, null)
  await f.session.finish('login-2', { userConfirmed: true }); await f.session.complete('login-2')
  assert.equal(f.kills, 0)
})

test('same-profile successor prevents completion after the spawned child exits', async t => {
  const f = await fixture(t)
  await f.begin(); f.exit()
  f.processes.set(4900, { pid: 4900, executable: f.options.executable, startTime: 'successor' })
  assert.equal((await f.session.status()).windowOpen, true)
  await assert.rejects(f.session.finish('login-1', { userConfirmed: true }), { code: 'MANUAL_PROFILE_OPEN' })
})

test('startup gate blocks corrupt receipts and directory placeholders without launching', async t => {
  const f = await fixture(t)
  await assertNoManualProfileSession(f.options.stateDir)
  await writeFile(f.file, '{broken')
  await assert.rejects(assertNoManualProfileSession(f.options.stateDir), { code: 'MANUAL_PROFILE_ACTIVE' })
  await assert.rejects(f.session.load(), { code: 'MANUAL_PROFILE_RECOVERY_REQUIRED' })
  await rm(f.file); await mkdir(f.file)
  await assert.rejects(assertNoManualProfileSession(f.options.stateDir), { code: 'MANUAL_PROFILE_ACTIVE' })
  assert.equal(f.calls.length, 0)
})

test('completion cannot remove a replacement receipt or a changed policy receipt', async t => {
  const f = await fixture(t)
  await f.begin(); f.exit(); await f.session.finish('login-1', { userConfirmed: true })
  const receipt = await readManualProfileReceipt(f.options.stateDir)
  await writeFile(f.file, JSON.stringify({ ...receipt, id: 'replacement-login' }))
  await assert.rejects(f.session.complete('login-1'), { code: 'MANUAL_PROFILE_RECOVERY_REQUIRED' })
  assert.equal((await readManualProfileReceipt(f.options.stateDir)).id, 'replacement-login')
  const differentPolicy = new ManualProfileSession({ ...f.options, policyIdentity: 'different-policy' })
  await assert.rejects(differentPolicy.load(), { code: 'MANUAL_PROFILE_RECOVERY_REQUIRED' })
})

test('concurrent prepares publish one intact receipt without overwriting the winner', async t => {
  const f = await fixture(t), other = new ManualProfileSession(f.options)
  const results = await Promise.allSettled([f.session.prepare({ loginId: 'first', owner: 'codex' }), other.prepare({ loginId: 'second', owner: 'claude' })])
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
  const receipt = await readManualProfileReceipt(f.options.stateDir)
  assert.ok(['first', 'second'].includes(receipt.id)); assert.equal(receipt.state, 'preparing')
  assert.equal(f.calls.length, 0)
})

async function inspectSyntheticProcesses(f, processes, { pid = null, transformScript = script => script } = {}) {
  return inspectManualProfileProcesses({ profile: f.options.profile.replaceAll('\\', '/'), executable: f.options.executable, pid }, {
    runProcess: async (executable, args, options) => {
      // Execute the actual Windows helper, with only CIM enumeration replaced.
      // No real processes are enumerated and no browser is launched.
      const fakeCim = `function Get-CimInstance {
        param([string]$ClassName, [string]$Filter)
        $syntheticProcesses = $env:VELMREN_TEST_PROCESSES | ConvertFrom-Json
        foreach ($item in $syntheticProcesses) {
          if ($Filter -and ($item.Gone -or $Filter -ne ('ProcessId = ' + $item.ProcessId))) { continue }
          if ($Filter -and $item.RequeryCreationDate) { $item.CreationDate = $item.RequeryCreationDate }
          if ($item.CreationDate) { $item.CreationDate = [DateTime]::Parse($item.CreationDate).ToUniversalTime() }
          $item
        }
      }\n`
      const script = fakeCim + transformScript(Buffer.from(args.at(-1), 'base64').toString('utf16le'))
      const output = await promisify(execFile)(executable, [...args.slice(0, -1), Buffer.from(script, 'utf16le').toString('base64')], {
        ...options, env: { ...options.env, VELMREN_TEST_PROCESSES: JSON.stringify(processes) }
      })
      assert.doesNotMatch(output.stdout, /example\.test|must-not-leak|private-missing-profile|CommandLine/)
      return output
    }
  })
}

function foreignProcess(f, overrides = {}) {
  const executable = path.join(f.options.stateDir, 'foreign-browser.exe')
  return { ProcessId: 5904, Name: 'foreign-browser.exe', ExecutablePath: executable, CreationDate: '2026-11-04T00:00:00Z',
    CommandLine: `"${executable}" "--user-data-dir=${path.join(f.options.stateDir, 'private-missing-profile')}" https://example.test/private`, ...overrides }
}

test('Windows inspector parses synthetic CIM processes without regex variables corrupting its result', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t)
  const result = await inspectSyntheticProcesses(f, [
    { ProcessId: 5901, Name: 'fixture-browser.exe', ExecutablePath: f.options.executable, CreationDate: '2026-11-04T00:00:00Z', CommandLine: `"${f.options.executable}" "--user-data-dir=${f.options.profile}" https://example.test/private` },
    { ProcessId: 5902, Name: 'unrelated.exe', ExecutablePath: f.options.executable, CreationDate: '2026-11-04T00:00:00Z', CommandLine: 'unrelated.exe --private=must-not-leak' },
    { ProcessId: 5903, Name: 'fixture-browser.exe', ExecutablePath: f.options.executable, CreationDate: '2026-11-04T00:00:00Z', CommandLine: `fixture-browser.exe "--user-data-dir=${path.join(f.options.stateDir, 'already-removed-profile')}"`, Gone: true }
  ], { pid: 5901 })
  assert.equal(result.matches.length, 1)
  assert.equal(result.matches[0].pid, 5901)
  assert.equal(result.requested.pid, 5901)
  assert.deepEqual(Object.keys(result.matches[0]).sort(), ['executable', 'pid', 'startTime'])
  assert.deepEqual(result.unresolvedForeign, [])
})

test('Windows inspector records a live foreign missing profile without losing requested PID identity', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t), entry = foreignProcess(f)
  const result = await inspectSyntheticProcesses(f, [entry], { pid: entry.ProcessId })
  assert.deepEqual(result.matches, [])
  assert.equal(result.unresolvedForeign.length, 1)
  assert.deepEqual(result.requested, result.unresolvedForeign[0])
  assert.equal(result.requested.pid, entry.ProcessId)
  assert.deepEqual(Object.keys(result.unresolvedForeign[0]).sort(), ['executable', 'pid', 'startTime'])
})

test('Windows inspector still detects a foreign executable using an existing profile junction', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t), alias = path.join(f.options.stateDir, 'profile-alias')
  await symlink(f.options.profile, alias, 'junction')
  const entry = foreignProcess(f, { CommandLine: `foreign-browser.exe "--user-data-dir=${path.join(f.options.stateDir, 'private-missing-profile')}" "--user-data-dir=${alias}"` })
  const result = await inspectSyntheticProcesses(f, [entry])
  assert.deepEqual(result.matches.map(item => item.pid), [entry.ProcessId])
  assert.deepEqual(result.unresolvedForeign, [])
})

test('an unresolved foreign profile keeps the completion receipt until the caller successfully rebinds', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t)
  await f.begin(); f.exit()
  const recovered = new ManualProfileSession({ ...f.options,
    inspectProcesses: ({ pid }) => inspectSyntheticProcesses(f, [foreignProcess(f)], { pid }) })
  assert.equal((await recovered.load()).windowOpen, false)
  await recovered.finish('login-1', { userConfirmed: true })
  assert.equal((await readManualProfileReceipt(f.options.stateDir)).state, 'awaiting-confirmation')
  await assert.rejects(assertNoManualProfileSession(f.options.stateDir), { code: 'MANUAL_PROFILE_ACTIVE' })
  assert.equal(f.calls.length, 1); assert.equal(f.kills, 0)
})

test('Windows inspector cannot defer the expected profile after it disappears during inspection', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t)
  const entry = foreignProcess(f, { CommandLine: `foreign-browser.exe "--user-data-dir=${f.options.profile}"` })
  const transformScript = script => script.replace('public static string CanonicalDirectory(string name) {', `static int directoryCalls;
    public static string CanonicalDirectory(string name) {
      if (++directoryCalls > 1) throw new System.ComponentModel.Win32Exception(3);`)
  await assert.rejects(inspectSyntheticProcesses(f, [entry], { transformScript }), /candidate-profile; .*; 3/)
})

test('Windows inspector fails closed for its executable or basename with a missing profile', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t)
  for (const overrides of [
    { Name: 'fixture-browser.exe', ExecutablePath: f.options.executable },
    { Name: 'fixture-browser.exe' },
    { ExecutablePath: path.join(f.options.stateDir, 'other-install', 'fixture-browser.exe') },
    { ExecutablePath: f.options.executable }
  ]) {
    await assert.rejects(inspectSyntheticProcesses(f, [foreignProcess(f, overrides)]), /candidate-profile; .*; [23]/)
  }
})

test('Windows inspector rejects incomplete or changing foreign process identity', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t)
  for (const overrides of [{ ExecutablePath: null }, { CreationDate: null }, { RequeryCreationDate: '2026-11-04T00:01:00Z' }]) {
    await assert.rejects(inspectSyntheticProcesses(f, [foreignProcess(f, overrides)]), /process-identity; PROCESS_IDENTITY_UNAVAILABLE/)
  }
})

test('Windows inspector does not treat relative or unsupported namespace paths as unresolved foreign profiles', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t)
  for (const candidate of ['relative-profile', 'C:relative-profile', '\\relative-profile', '\\\\?\\GLOBALROOT\\not-a-real-device\\profile']) {
    await assert.rejects(inspectSyntheticProcesses(f, [foreignProcess(f, { CommandLine: `foreign-browser.exe "--user-data-dir=${candidate}"` })]), { code: 'MANUAL_PROFILE_RECOVERY_REQUIRED' })
  }
})

test('Windows inspector defers only file-not-found and path-not-found errors from foreign profiles', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t), entry = foreignProcess(f)
  for (const code of [2, 3, 5, 123, null]) {
    const transformScript = script => script.replace('public static string CanonicalDirectory(string name) {', `public static string CanonicalDirectory(string name) {
      if (name.EndsWith("private-missing-profile")) throw new ${code === null ? 'InvalidOperationException()' : `System.ComponentModel.Win32Exception(${code})`};`)
    const inspection = inspectSyntheticProcesses(f, [entry], { transformScript })
    if (code === 2 || code === 3) assert.equal((await inspection).unresolvedForeign[0].pid, entry.ProcessId)
    else await assert.rejects(inspection, new RegExp(`candidate-profile; .*; ${code ?? 0}`))
  }
})

test('Windows inspector drops a disappeared foreign process instead of recording unresolved identity', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t)
  const result = await inspectSyntheticProcesses(f, [foreignProcess(f, { Gone: true })])
  assert.deepEqual(result, { matches: [], requested: null, unresolvedForeign: [] })
})

test('Windows inspection failures expose only a whitelisted stage and numeric code', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t)
  await assert.rejects(inspectManualProfileProcesses({ ...f.options }, { runProcess: async () => ({ stdout: JSON.stringify({ inspectionFailure: { stage: 'candidate-profile', errorId: 'MethodInvocationException', nativeCode: 2 } }) }) }), /candidate-profile; MethodInvocationException; 2/)
  await assert.rejects(inspectManualProfileProcesses({ ...f.options }, { runProcess: async () => ({ stdout: JSON.stringify({ inspectionFailure: { stage: 'https://secret.test', errorId: 'private-command-line', nativeCode: 2 } }) }) }), error => !/secret\.test|private-command-line/.test(error.message))
})

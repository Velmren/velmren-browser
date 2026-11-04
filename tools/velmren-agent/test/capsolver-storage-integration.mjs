// Real Windows DACL/DPAPI, synthetic provider only; the browser argument is not launched.
// node test/capsolver-storage-integration.mjs BROWSER_EXE NEW_OUTPUT_DIR [--agent-directory=DIR]
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, readFile, writeFile, chmod, stat } from 'node:fs/promises'
import { randomUUID, createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const argv = process.argv.slice(2), positional = argv.filter(value => !value.startsWith('--'))
if (positional.length !== 2 || argv.some(value => value.startsWith('--') && !value.startsWith('--agent-directory='))) throw new Error('Expected browser, fresh output directory and optional agent directory')
if (process.platform !== 'win32') throw new Error('Windows is required')
const directory = path.resolve(argv.find(value => value.startsWith('--agent-directory='))?.slice(18) ?? fileURLToPath(new URL('../', import.meta.url)))
const output = path.resolve(positional[1])
assert.ok((await stat(path.resolve(positional[0]))).isFile())
await mkdir(path.dirname(output), { recursive: true }); await mkdir(output)
const { WindowsServiceKey } = await import(pathToFileURL(path.join(directory, 'service-key.mjs')))
const { CaptchaService } = await import(pathToFileURL(path.join(directory, 'capsolver-service.mjs')))
const execute = promisify(execFile)
const powershell = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe')
const report = { passed: false, agentDirectory: directory, realWindowsProtection: true, syntheticProviderOnly: true, cases: [] }
const protector = new WindowsServiceKey(), key = `SyntheticKey_${randomUUID()}`
let service, reopened

async function ps(script, paths = []) {
  const { stdout } = await execute(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(`$ErrorActionPreference='Stop'\n${script}`, 'utf16le').toString('base64')], {
    windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024,
    env: { ...process.env, VELMREN_STORAGE_TEST_PATHS: JSON.stringify(paths) }
  })
  return JSON.parse(stdout.trim())
}

async function snapshot(paths) {
  return ps(`
$sections=[Security.AccessControl.AccessControlSections]::Access -bor [Security.AccessControl.AccessControlSections]::Owner -bor [Security.AccessControl.AccessControlSections]::Group
$sidType=[Security.Principal.SecurityIdentifier]
$rows=@(foreach($entry in (ConvertFrom-Json $env:VELMREN_STORAGE_TEST_PATHS)){
 $isDirectory=[IO.Directory]::Exists($entry)
 $acl=if($isDirectory){[IO.Directory]::GetAccessControl($entry,$sections)}else{[IO.File]::GetAccessControl($entry,$sections)}
 [PSCustomObject]@{
  path=$entry; owner=$acl.GetOwner($sidType).Value; group=$acl.GetGroup($sidType).Value
  sddl=$acl.GetSecurityDescriptorSddlForm($sections); protected=$acl.AreAccessRulesProtected
  readOnly=([IO.File]::GetAttributes($entry) -band [IO.FileAttributes]::ReadOnly) -ne 0
  rules=@($acl.GetAccessRules($true,$true,$sidType) | ForEach-Object {
   [PSCustomObject]@{ sid=$_.IdentityReference.Value; rights=[int]$_.FileSystemRights; inheritance=[int]$_.InheritanceFlags; propagation=[int]$_.PropagationFlags; type=[int]$_.AccessControlType; inherited=$_.IsInherited }
  })
 }
})
ConvertTo-Json -InputObject $rows -Depth 5 -Compress`, paths)
}

function exactAcl(acl, user, { protected: protectedAcl, inherited = false, inheritance = 3 }) {
  assert.equal(acl.protected, protectedAcl)
  assert.deepEqual(acl.rules.map(rule => rule.sid).sort(), [user, 'S-1-5-18'].sort())
  for (const rule of acl.rules) {
    assert.equal(rule.rights, 2032127) // FullControl, including Synchronize.
    assert.equal(rule.inheritance, inheritance)
    assert.equal(rule.propagation, 0)
    assert.equal(rule.type, 0)
    assert.equal(rule.inherited, inherited)
  }
}

async function scenario(name, run) {
  try { await run(); report.cases.push({ name, passed: true }); console.log(`PASS ${name}`) }
  catch (error) {
    const code = /^[A-Z][A-Z_]{2,64}$/.test(error?.code ?? '') ? error.code : 'ASSERTION_OR_RUNTIME_FAILURE'
    report.cases.push({ name, passed: false, code })
    console.log(`FAIL ${name} ${code}`)
    throw error
  }
}

try {
  let currentUser
  await scenario('ordinary token without security or elevation privileges', async () => {
    const token = await ps(`
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
$principal=New-Object Security.Principal.WindowsPrincipal($identity)
$privileges=(& "$env:SystemRoot\\System32\\whoami.exe" /priv | Out-String)
$groups=(& "$env:SystemRoot\\System32\\whoami.exe" /groups | Out-String)
[PSCustomObject]@{user=$identity.User.Value; elevated=$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator); securityPrivilege=$privileges.Contains('SeSecurityPrivilege'); mediumIntegrity=$groups.Contains('S-1-16-8192')} | ConvertTo-Json -Compress`)
    assert.equal(token.elevated, false)
    assert.equal(token.securityPrivilege, false)
    assert.equal(token.mediumIntegrity, true)
    currentUser = token.user
    report.token = { elevated: false, securityPrivilege: false, mediumIntegrity: true }
  })

  await scenario('repeated DACL protection preserves owner, parent and readonly children', async () => {
    const parent = path.join(output, 'acl-parent'), target = path.join(parent, 'capsolver')
    await mkdir(target, { recursive: true })
    const [parentBefore, targetBefore] = await snapshot([parent, target])
    assert.equal(targetBefore.owner, currentUser)
    await protector.ensureDirectory(target)
    await protector.ensureDirectory(target)
    const child = path.join(target, 'readonly.json')
    await writeFile(child, '{"synthetic":true}', { mode: 0o600 })
    await chmod(child, 0o400)
    const [readonlyBefore] = await snapshot([child])
    assert.equal(readonlyBefore.readOnly, true)
    await protector.ensureDirectory(target)
    const nested = path.join(target, 'new-directory'), later = path.join(target, 'later.json')
    await mkdir(nested)
    await writeFile(later, '{}', { mode: 0o600 })
    await protector.ensureDirectory(target)
    const [parentAfter, targetAfter, readonlyAfter, laterAfter, nestedAfter] = await snapshot([parent, target, child, later, nested])
    assert.deepEqual(parentAfter, parentBefore)
    assert.equal(targetAfter.owner, targetBefore.owner)
    assert.equal(targetAfter.group, targetBefore.group)
    assert.equal(readonlyAfter.readOnly, true)
    exactAcl(targetAfter, currentUser, { protected: true })
    for (const file of [readonlyAfter, laterAfter]) exactAcl(file, currentUser, { protected: false, inherited: true, inheritance: 0 })
    exactAcl(nestedAfter, currentUser, { protected: false, inherited: true })
    await chmod(child, 0o600)
    await protector.ensureDirectory(target)
    await assert.rejects(protector.ensureDirectory(child), { code: 'CAPTCHA_STORAGE_UNAVAILABLE' })
    await assert.rejects(protector.ensureDirectory(path.join(target, 'missing')), { code: 'CAPTCHA_STORAGE_UNAVAILABLE' })
    report.acl = { exactPrincipals: ['currentUser', 'SYSTEM'], fullControl: true, inheritable: true, parentUnchanged: true, ownerAndGroupUnchanged: true, repeatedCalls: 5 }
  })

  await scenario('CurrentUser DPAPI roundtrip and corrupt ciphertext rejection', async () => {
    const encrypted = await protector.protect(key)
    assert.notEqual(encrypted, Buffer.from(key).toString('base64'))
    assert.equal(await protector.unprotect(encrypted), key)
    await assert.rejects(protector.unprotect('Y29ycnVwdA=='), { code: 'CAPTCHA_STORAGE_UNAVAILABLE' })
  })

  await scenario('saved configuration, first dispatch, statistics and restart use real Windows storage', async () => {
    const state = path.join(output, 'state'), parent = path.join(state, 'services')
    await mkdir(parent, { recursive: true })
    const [parentBefore] = await snapshot([parent])
    let providerCalls = 0
    const provider = { solve: async () => {
      providerCalls++
      const ledger = JSON.parse(await readFile(path.join(service.directory, 'attempts.json'), 'utf8'))
      const stats = JSON.parse(await readFile(path.join(service.directory, 'statistics.json'), 'utf8'))
      assert.equal(ledger.entries.length, 1)
      assert.deepEqual(stats.pending, [{ taskId: 'synthetic-task', challengeId: 'synthetic-challenge' }])
      assert.equal(await service.readKey(), key)
      return { applied: true }
    } }
    service = new CaptchaService(state, { provider })
    await service.ready
    const saved = await service.settings({ action: 'save', enabled: true, key, maxRequestsPerDay: 100, maxConcurrent: 2, maxAttemptsPerTask: 3 })
    assert.equal(saved.enabled, true)
    assert.equal(saved.hasKey, true)
    const settingsText = await readFile(path.join(service.directory, 'settings.json'), 'utf8')
    assert.ok(!settingsText.includes(key))
    assert.ok(!JSON.stringify(saved).includes('encryptedKey'))
    const result = await service.run({ taskId: 'synthetic-task', challengeId: 'synthetic-challenge' }, async ({ dispatch, provider: mock }) => {
      await dispatch()
      return mock.solve()
    })
    assert.deepEqual(result, { applied: true })
    assert.equal(providerCalls, 1)
    const expectedStats = { solutionsDelivered: 1, failed: 0, cancelled: 0, uncertain: 0, persisted: true }
    assert.deepEqual(service.statistics(), expectedStats)
    assert.equal(service.view().usage.requestsLast24Hours, 1)
    const stats = JSON.parse(await readFile(path.join(service.directory, 'statistics.json'), 'utf8'))
    assert.deepEqual(stats.pending, [])
    assert.equal(stats.solutionsDelivered, 1)
    service.close()
    reopened = new CaptchaService(state, { provider })
    await reopened.ready
    assert.equal(reopened.enabled, true)
    assert.equal(await reopened.readKey(), key)
    assert.deepEqual(reopened.statistics(), expectedStats)
    assert.equal(reopened.view().usage.requestsLast24Hours, 1)
    await assert.rejects(reopened.run({ taskId: 'synthetic-task', challengeId: 'synthetic-challenge' }, async () => assert.fail('Duplicate dispatch reached provider')), { code: 'CAPTCHA_ALREADY_ATTEMPTED' })
    await reopened.settings({ action: 'save', enabled: true, maxRequestsPerDay: 99, maxConcurrent: 2, maxAttemptsPerTask: 3 })
    assert.equal(providerCalls, 1)
    const files = ['settings.json', 'attempts.json', 'statistics.json'].map(name => path.join(service.directory, name))
    const [parentAfter, target, ...fileAcls] = await snapshot([parent, service.directory, ...files])
    assert.deepEqual(parentAfter, parentBefore)
    exactAcl(target, currentUser, { protected: true })
    for (const file of fileAcls) exactAcl(file, currentUser, { protected: false, inherited: true, inheritance: 0 })
    report.service = { providerCalls, firstLedgerBeforeDispatch: true, pendingBeforeDispatch: true, settingsEncrypted: true, statisticsPersisted: true, reopened: true, duplicateRejected: true, parentUnchanged: true }
  })
  report.passed = true
} catch {
  process.exitCode = 1
} finally {
  service?.close(); reopened?.close()
  report.helperSha256 = createHash('sha256').update(await readFile(path.join(directory, 'ServiceKeyProtection.ps1'))).digest('hex')
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2))
  console.log(`Storage integration ${report.passed ? 'passed' : 'failed'}: ${path.join(output, 'report.json')}`)
}

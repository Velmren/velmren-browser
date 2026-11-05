// Windows acceptance only; never use a personal installation or an existing output.
// node test/managed-browser-integration.mjs INSTALL_ROOT FRESH_OUTPUT_DIR
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { managedBrowserFixture } from './managed-browser-fixture.mjs'

const execute = promisify(execFile)
const [installArgument, outputArgument, ...extra] = process.argv.slice(2)
if (process.platform !== 'win32' || !installArgument || !outputArgument || extra.length) {
  throw new Error('Usage on Windows: managed-browser-integration.mjs INSTALL_ROOT FRESH_OUTPUT_DIR')
}
const installation = await realpath(path.resolve(installArgument))
// The caller prepares a dedicated QA parent; resolve it before any writes so a
// junction cannot redirect this fresh output into the installation/profile tree.
const output = path.join(await realpath(path.dirname(path.resolve(outputArgument))), path.basename(path.resolve(outputArgument)))
const stateDir = path.join(output, 'state')
const powershell = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
const canonical = value => path.resolve(value).toLowerCase()
const within = (root, candidate) => canonical(candidate) === canonical(root) || canonical(candidate).startsWith(canonical(root) + path.sep)
assert.ok(!within(installation, output) && !within(output, installation), 'QA output and installation must be separate trees')
for (const root of [process.env.LOCALAPPDATA, process.env.APPDATA, process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean)) {
  assert.ok(!within(root, installation), 'Use an explicitly isolated QA installation outside personal application directories')
}
const jsonFile = async file => {
  const raw = await readFile(file, 'utf8')
  assert.ok(raw.length <= 1024 * 1024, 'JSON evidence exceeded its size bound')
  return JSON.parse(raw.replace(/^\uFEFF/, ''))
}
const pointer = await jsonFile(path.join(installation, 'current.json'))
assert.match(pointer.version, /^\d+\.\d+\.\d+\.\d+$/, 'Installed current.json must identify a release version')
const appRoot = await realpath(path.join(installation, 'versions', pointer.version, 'app'))
assert.ok(within(installation, appRoot), 'Installed app path must stay within the QA installation')
const config = await jsonFile(path.join(appRoot, 'delivery-app.json'))
const browserExecutable = await realpath(path.resolve(appRoot, config.browser))
const nodeExecutable = await realpath(path.resolve(appRoot, config.agent))
const entry = path.join(appRoot, 'agent', 'Start-VelmrenMcp.ps1')
const mcpScript = path.join(appRoot, 'agent', 'managed-mcp.mjs')
const brokerScript = path.join(appRoot, 'agent', 'managed-broker.mjs')
for (const file of [browserExecutable, nodeExecutable, entry, mcpScript, brokerScript]) {
  assert.ok(within(appRoot, await realpath(file)) && (await stat(file)).isFile(), 'Required runtime must be an installed app file')
}
const driverSdk = await jsonFile(fileURLToPath(new URL('../node_modules/@modelcontextprotocol/sdk/package.json', import.meta.url)))
const installedSdk = await jsonFile(path.join(appRoot, 'agent', 'node_modules', '@modelcontextprotocol', 'sdk', 'package.json'))
assert.equal(driverSdk.version, installedSdk.version, 'Driver and installed MCP SDK versions must match')

await mkdir(path.dirname(output), { recursive: true })
await mkdir(output) // Refuse existing evidence, profiles, and state directories.
const ps = async (script, environment = {}) => {
  const result = await execute(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    windowsHide: true, timeout: 20000, maxBuffer: 1024 * 1024,
    // A Node child of PowerShell 7 inherits its module search path. Load the
    // Windows PowerShell 5.1 modules before any inherited incompatible modules.
    env: { ...process.env, ...environment, PSModulePath: [path.join(path.dirname(powershell), 'Modules'), process.env.PSModulePath].filter(Boolean).join(path.delimiter) }, encoding: 'utf8'
  })
  return result.stdout.replace(/^\uFEFF/, '').trim()
}
const report = {
  passed: false, scope: 'Installed signed-payload bootstrap; five managed MCP clients; synthetic local forms; background browser only',
  startedAt: new Date().toISOString(), installRoot: installation, appRoot, output,
  version: pointer.version, sdkVersion: driverSdk.version, checks: [], clients: [], cleanup: {},
  limits: ['No visible-window or desktop-focus assertion', 'Popup callbacks are covered by the separate five-client web harness', 'Signature trust is enforced by the installed launcher resolve operation; this is not an Authenticode claim']
}
const peers = []
const taskIds = []
const knownProcesses = new Map()
let fixture, descriptor, stage = 'private-output-setup', failure
const digest = value => createHash('sha256').update(value).digest('hex')
const pass = (name, evidence = {}) => {
  report.checks.push({ name, passed: true, ...evidence })
  console.log(`PASS ${name}`)
}
const bounded = async (promise, label, timeoutMs) => {
  let timer
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timeout: ${label}`)), timeoutMs)
    })])
  } finally { clearTimeout(timer) }
}
const parallel = async callbacks => {
  const results = await Promise.allSettled(callbacks.map(callback => callback()))
  const rejected = results.find(result => result.status === 'rejected')
  if (rejected) throw rejected.reason
  return results.map(result => result.value)
}
const eventually = async (read, accept, label, timeoutMs = 10000) => {
  const deadline = Date.now() + timeoutMs
  do {
    const value = await read()
    if (accept(value)) return value
    await delay(200)
  } while (Date.now() < deadline)
  throw new Error(`Timeout: ${label}`)
}
const readOwnedDescriptor = async () => {
  const value = await jsonFile(path.join(stateDir, 'connection.json'))
  const owner = await jsonFile(path.join(stateDir, 'managed-owner.json'))
  const endpoint = new URL(value.endpoint)
  assert.ok(endpoint.protocol === 'http:' && endpoint.hostname === '127.0.0.1' && endpoint.port && endpoint.pathname === '/' && !endpoint.search && !endpoint.hash && !endpoint.username && !endpoint.password, 'Owned broker endpoint must be loopback HTTP')
  assert.ok(Number.isSafeInteger(value.pid) && value.pid > 0 && typeof value.adminToken === 'string' && value.adminToken.length >= 16, 'Invalid owned broker descriptor')
  assert.ok(owner.schema === 1 && owner.purpose === 'velmren-managed-broker' && owner.pid === value.pid && canonical(owner.stateDir) === canonical(stateDir) && canonical(owner.executable) === canonical(browserExecutable), 'Broker receipt must match this fresh QA state and installed browser')
  assert.ok(Date.parse(owner.startedAt) >= Date.parse(report.startedAt), 'Broker must have started during this QA run')
  if (descriptor) assert.equal(value.pid, descriptor.pid, 'All clients must reuse the original broker PID')
  return { endpoint: endpoint.origin, pid: value.pid, adminToken: value.adminToken }
}
const admin = async (method, args = {}, connection = descriptor) => {
  const response = await fetch(`${connection.endpoint}/rpc`, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000),
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${connection.adminToken}` },
    body: JSON.stringify({ method, args })
  })
  const value = await response.json()
  assert.ok(response.ok && value.ok === true, `Owned broker rejected ${method}`)
  return value.result
}
const snapshot = async () => {
  const raw = await ps(`
$ErrorActionPreference = 'Stop'
$all = @(Get-CimInstance Win32_Process)
$ids = [System.Collections.Generic.HashSet[int]]::new()
foreach ($item in ($env:VELMREN_QA_PIDS -split ',')) { if ($item) { [void]$ids.Add([int]$item) } }
foreach ($item in $all) {
  if ($item.CommandLine -and $item.CommandLine.IndexOf($env:VELMREN_QA_STATE, [StringComparison]::OrdinalIgnoreCase) -ge 0) { [void]$ids.Add([int]$item.ProcessId) }
}
do {
  $changed = $false
  foreach ($item in $all) { if ($ids.Contains([int]$item.ParentProcessId) -and $ids.Add([int]$item.ProcessId)) { $changed = $true } }
} while ($changed)
$result = @($all | Where-Object { $ids.Contains([int]$_.ProcessId) } | ForEach-Object {
  [ordered]@{ pid = [int]$_.ProcessId; parentPid = [int]$_.ParentProcessId; executable = $_.ExecutablePath; commandLine = $_.CommandLine; createdAt = $_.CreationDate.ToUniversalTime().ToString('o') }
})
ConvertTo-Json -InputObject $result -Compress -Depth 4
`, { VELMREN_QA_STATE: stateDir, VELMREN_QA_PIDS: [descriptor?.pid, ...peers.map(peer => peer.pid ?? peer.transport.pid), ...knownProcesses.keys()].filter(Boolean).join(',') })
  return JSON.parse(raw || '[]')
}
const hasArgument = (item, value) => item.commandLine?.toLowerCase().includes(value.toLowerCase())
const isExecutable = (item, value) => typeof item.executable === 'string' && canonical(item.executable) === canonical(value)
const remember = items => {
  for (const item of items) {
    if (knownProcesses.has(item.pid) && knownProcesses.get(item.pid).createdAt !== item.createdAt) continue
    if (Date.parse(item.createdAt) >= Date.parse(report.startedAt)) knownProcesses.set(item.pid, { pid: item.pid, createdAt: item.createdAt })
  }
}
const tool = async (peer, name, args = {}) => {
  const result = await peer.client.callTool({ name, arguments: args }, undefined, { timeout: 40000 })
  const item = result.content?.find(item => item.type === 'text')
  assert.equal(typeof item?.text, 'string', `${name} must return JSON text`)
  const value = JSON.parse(item.text)
  if (result.isError) {
    const error = new Error(`MCP tool failed: ${name}`)
    error.code = typeof value.code === 'string' ? value.code : 'TOOL_ERROR'
    throw error
  }
  return value
}
const act = async (index, actions, taskId = taskIds[index]) => {
  const observation = await tool(peers[index], 'velmren_observe', { taskId })
  const resolved = actions.map(({ name, ...action }) => {
    const element = observation.elements.find(element => element.name === name)
    assert.ok(element && element.disabled === false, `Missing enabled synthetic control: ${name}`)
    return { ...action, ref: element.ref }
  })
  return tool(peers[index], 'velmren_act', { taskId, observationId: observation.observationId, actions: resolved })
}
const endInput = async peer => {
  if (peer.eof) return
  peer.eof = true
  // SDK close() force-kills after two seconds. Send real EOF and require a natural
  // exit first; the pinned SDK exposes the spawned process as _process.
  const child = peer.transport._process
  assert.ok(child && child.exitCode === null, 'MCP relay must remain alive until stdin EOF')
  const started = Date.now()
  // A shared broker descendant can retain inherited Windows pipe handles after
  // the relay exits. Check process exit here and stream closure after broker idle.
  peer.stdioClosed = new Promise(resolve => child.once('close', (code, signal) => {
    peer.stdioCloseElapsedMs = Date.now() - started
    resolve({ code, signal })
  }))
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })))
  child.stdin.end()
  const outcome = await bounded(exited, 'natural PowerShell relay exit after EOF', 10000)
  peer.relayExitElapsedMs = Date.now() - started
  assert.equal(outcome.code, 0, 'MCP relay must exit successfully after stdin EOF')
  assert.equal(outcome.signal, null, 'EOF must not require terminating a relay')
  await peer.client.close()
}
const expectedTools = [
  'velmren_profile_login_start', 'velmren_profile_login_status', 'velmren_profile_login_finish',
  'velmren_create_task', 'velmren_sensitive', 'velmren_captcha', 'velmren_diagnostics', 'velmren_list_tasks', 'velmren_observe', 'velmren_act', 'velmren_navigate',
  'velmren_wait', 'velmren_screenshot', 'velmren_list_pages', 'velmren_list_frames', 'velmren_list_options', 'velmren_select_page', 'velmren_close_page',
  'velmren_handle_dialog', 'velmren_upload_files', 'velmren_request_human', 'velmren_resume', 'velmren_finish', 'velmren_cancel'
].sort()

try {
  const version = await ps(`
$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSEdition -ne 'Desktop' -or $PSVersionTable.PSVersion.Major -ne 5 -or $PSVersionTable.PSVersion.Minor -ne 1) { throw 'Windows PowerShell 5.1 is required' }
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$acl = [Security.AccessControl.DirectorySecurity]::new()
$acl.SetOwner($sid)
$acl.SetAccessRuleProtection($true, $false)
foreach ($identity in @($sid, [Security.Principal.SecurityIdentifier]::new('S-1-5-18'), [Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))) {
  $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($identity, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow'))
}
Set-Acl -LiteralPath $env:VELMREN_QA_OUTPUT -AclObject $acl
$actual = Get-Acl -LiteralPath $env:VELMREN_QA_OUTPUT
if (-not $actual.AreAccessRulesProtected) { throw 'Private QA directory ACL was not applied' }
$PSVersionTable.PSVersion.ToString()
`, { VELMREN_QA_OUTPUT: output })
  report.powershellVersion = version
  await mkdir(stateDir)
  fixture = await managedBrowserFixture()
  const policy = { allowedOrigins: [fixture.url], webCompatibility: true, webSocketPolicy: 'csp-secure-upgrades', maxActiveActions: 5, maxTasks: 8 }
  const policyFile = path.join(output, 'policy.json')
  await writeFile(policyFile, JSON.stringify(policy, null, 2), { flag: 'wx', mode: 0o600 })
  report.policy = policy
  pass('fresh QA state has a private Windows ACL and exact synthetic-origin policy')

  stage = 'five-installed-mcp-startups'
  await parallel(Array.from({ length: 5 }, (_, index) => async () => {
    const label = `managed-acceptance-${index + 1}`
    const transport = new StdioClientTransport({
      command: powershell,
      args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', entry, '-InstallRoot', installation, '-StateDir', stateDir, '-Policy', policyFile, '-Label', label],
      cwd: appRoot, stderr: 'pipe'
    })
    const peer = { label, transport, client: new Client({ name: label, version: '1.0.0' }), stderrBytes: 0, stderrHash: createHash('sha256') }
    peers[index] = peer
    transport.stderr.on('data', chunk => { peer.stderrBytes += chunk.length; peer.stderrHash.update(chunk) })
    const connecting = peer.client.connect(transport, { timeout: 120000 })
    peer.pid = transport.pid
    await bounded(connecting, 'installed MCP initialization', 130000)
    peer.pid = transport.pid
    assert.equal(peer.client.getServerVersion()?.name, 'velmren-agent', 'Installed server must identify itself')
    const tools = await peer.client.listTools()
    assert.deepEqual(tools.tools.map(tool => tool.name).sort(), expectedTools, 'Every managed connection must expose the complete MCP tool set')
    assert.ok(tools.tools.every(tool => tool.inputSchema?.type === 'object'), 'Every MCP tool must have its input schema')
  }))
  assert.equal(new Set(peers.map(peer => peer.pid)).size, 5, 'Five independent PowerShell relay processes are required')
  descriptor = await readOwnedDescriptor()
  report.brokerPid = descriptor.pid
  const status = await admin('broker_status')
  assert.equal(status.browserHealthy, true)
  assert.equal(status.maxTasks, 8)
  assert.equal(status.maxActiveActions, 5)
  assert.equal(status.webCompatibility, true)
  assert.deepEqual(status.allowedOrigins, policy.allowedOrigins)
  report.broker = { pid: descriptor.pid, browserVersion: status.browserVersion, policyIdentity: status.policyIdentity, browserHealthy: true }
  let processes = await snapshot()
  const brokers = processes.filter(item => isExecutable(item, nodeExecutable) && hasArgument(item, brokerScript) && hasArgument(item, stateDir))
  assert.deepEqual(brokers.map(item => item.pid), [descriptor.pid], 'Exactly one installed broker must own this fresh state')
  const browser = processes.filter(item => item.parentPid === descriptor.pid && isExecutable(item, browserExecutable) && hasArgument(item, path.join(stateDir, 'browser-profile')))
  assert.equal(browser.length, 1, 'Exactly one installed browser must belong to the broker')
  assert.ok(hasArgument(browser[0], '--no-startup-window') && hasArgument(browser[0], '--remote-debugging-pipe') && hasArgument(browser[0], '--velmren-agent-mode'), 'Browser must use the product background pipe mode')
  report.browserPid = browser[0].pid
  for (const peer of peers) {
    const children = processes.filter(item => item.parentPid === peer.pid && isExecutable(item, nodeExecutable) && hasArgument(item, mcpScript) && hasArgument(item, stateDir))
    assert.equal(children.length, 1, 'Each relay must run one installed managed MCP child')
    peer.mcpPid = children[0].pid
    peer.mcpCreatedAt = children[0].createdAt
  }
  const brokerLauncherIndex = peers.findIndex(peer => peer.mcpPid === brokers[0].parentPid)
  assert.ok(brokerLauncherIndex >= 0, 'The shared broker must descend from one managed MCP client')
  remember(processes)
  pass('five Windows PowerShell 5.1 relays use installed runtime files and one shared background broker', { brokerPid: descriptor.pid, browserPid: report.browserPid, toolCount: expectedTools.length })

  stage = 'five-owner-form-actions'
  const tasks = await parallel(peers.map((peer, index) => async () => {
    const task = await tool(peer, 'velmren_create_task', { url: `${fixture.url}/?peer=${index + 1}`, label: `Managed synthetic form ${index + 1}` })
    taskIds[index] = task.taskId
    peer.owner = task.owner
    const listed = await tool(peer, 'velmren_list_tasks')
    assert.deepEqual(listed.tasks.map(item => item.taskId), [task.taskId], 'A client must list only its own task')
    const observation = await tool(peer, 'velmren_observe', { taskId: task.taskId })
    const marker = /Session marker: ([0-9a-f-]{36})/.exec(observation.text)?.[1]
    assert.ok(marker, 'Synthetic task must expose its independent session marker')
    assert.equal((await readOwnedDescriptor()).pid, descriptor.pid)
    return { taskId: task.taskId, marker }
  }))
  assert.equal(new Set(peers.map(peer => peer.owner)).size, 5, 'Five distinct broker owner IDs are required')
  assert.ok(peers.every(peer => typeof peer.owner === 'string' && peer.owner !== 'admin'))
  assert.equal(new Set(tasks.map(task => task.marker)).size, 5, 'Task session storage must be isolated')
  await assert.rejects(tool(peers[0], 'velmren_observe', { taskId: taskIds[1] }), error => error.code === 'NOT_FOUND')
  await parallel(peers.map((peer, index) => async () => {
    const name = `Synthetic managed peer ${index + 1}`
    await act(index, [{ type: 'fill', name: 'Name', value: name }, { type: 'select', name: 'Category', value: 'advanced' }, { type: 'fill', name: 'Notes', value: `Installed MCP form ${index + 1}` }, { type: 'click', name: 'Save local record' }])
    const value = await tool(peer, 'velmren_wait', { taskId: taskIds[index], text: `Saved: ${name} / advanced / Installed MCP form ${index + 1}`, timeoutMs: 10000 })
    assert.equal(value.matched, true, 'Each synthetic form must show its own saved values')
  }))
  assert.deepEqual(fixture.submissions.map(item => JSON.parse(item.body)).sort((a, b) => a.name.localeCompare(b.name)), peers.map((_, index) => ({ name: `Synthetic managed peer ${index + 1}`, category: 'advanced', notes: `Installed MCP form ${index + 1}` })))
  report.clients = peers.map(peer => ({ label: peer.label, relayPid: peer.pid, mcpPid: peer.mcpPid, ownerHash: digest(peer.owner) }))
  pass('five distinct owners concurrently create, observe, fill, click and verify isolated synthetic forms')

  stage = 'page-and-worker-websocket-policy'
  await parallel(peers.map((peer, index) => async () => {
    await act(index, [{ type: 'click', name: 'Run WebSocket checks' }])
    for (const source of ['main', 'worker']) {
      const expected = `${source} WebSocket: echo synthetic-${source}-${index + 1}; denied blocked`
      assert.equal((await tool(peer, 'velmren_wait', { taskId: taskIds[index], text: expected, timeoutMs: 15000 })).matched, true, `${source} must exchange an allowed WebSocket echo and reject the denied origin`)
    }
  }))
  const expectedEchoes = peers.flatMap((_, index) => ['main', 'worker'].map(source => ({ source, peer: String(index + 1), message: `synthetic-${source}-${index + 1}` })))
  const sortEchoes = items => [...items].sort((a, b) => `${a.peer}:${a.source}`.localeCompare(`${b.peer}:${b.source}`))
  assert.deepEqual(sortEchoes(fixture.evidence.echoes), sortEchoes(expectedEchoes), 'Every page and dedicated worker must actually reach the allowed echo server')
  assert.equal(fixture.evidence.handshakes.length, 10)
  assert.equal(fixture.evidence.concurrentPendingEchoes, 10, 'All ten page/worker conversations must be in flight before the fixture releases their echoes')
  assert.deepEqual([...fixture.evidence.workerScripts].sort(), ['1', '2', '3', '4', '5'])
  assert.equal(fixture.evidence.deniedHandshakes, 0, 'Denied WebSockets must not send even a handshake')
  assert.equal(fixture.evidence.deniedRequests, 0, 'The second origin must receive no requests')
  report.webSockets = { allowedEchoes: fixture.evidence.echoes, allowedHandshakes: fixture.evidence.handshakes.length, dedicatedWorkers: fixture.evidence.workerScripts.length, concurrentPendingEchoes: fixture.evidence.concurrentPendingEchoes, deniedHandshakes: 0, deniedRequests: 0 }
  pass('five pages and five dedicated workers exchange allowed WebSocket echoes while denied-origin handshakes stay at zero')

  stage = 'managed-heartbeat'
  const leaseCheckStarted = Date.now()
  await delay(32000) // Exceed the 30s lease: working peers prove heartbeats renewed it.
  await parallel(peers.map((peer, index) => async () => {
    const listed = await tool(peer, 'velmren_list_tasks')
    assert.equal(listed.tasks.find(task => task.taskId === taskIds[index])?.state, 'agent-active')
    assert.match((await tool(peer, 'velmren_observe', { taskId: taskIds[index] })).text, /Saved: Synthetic managed peer/)
  }))
  pass('all five managed leases remain usable beyond their 30-second expiry', { elapsedMs: Date.now() - leaseCheckStarted })

  stage = 'one-client-eof-isolation'
  // Always close the broker's launching owner first, so this also covers relay
  // exit while a descendant keeps its inherited stdio handles open.
  const eofPeer = peers[brokerLauncherIndex]
  const completed = await tool(eofPeer, 'velmren_create_task', { url: fixture.url, label: 'Completed before owner EOF' })
  await tool(eofPeer, 'velmren_finish', { taskId: completed.taskId })
  await endInput(eofPeer)
  const afterEof = await eventually(() => admin('broker_status'), value => value.tasks.find(task => task.taskId === taskIds[brokerLauncherIndex])?.state === 'cancelled', 'EOF cancels its unfinished task')
  assert.equal(afterEof.tasks.find(task => task.taskId === completed.taskId)?.state, 'completed', 'EOF must preserve a completed task')
  const livePeers = peers.filter(peer => !peer.eof)
  for (const peer of livePeers) assert.equal(afterEof.tasks.find(task => task.taskId === taskIds[peers.indexOf(peer)])?.state, 'agent-active', 'EOF must preserve peer task state')
  await parallel(livePeers.map(peer => async () => {
    const index = peers.indexOf(peer)
    await act(index, [{ type: 'click', name: 'Change page' }])
    assert.equal((await tool(peer, 'velmren_wait', { taskId: taskIds[index], text: 'Changed page', timeoutMs: 10000 })).matched, true)
  }))
  assert.equal((await readOwnedDescriptor()).pid, descriptor.pid)
  pass('stdin EOF cancels only that owner’s unfinished task while four peers remain usable', { brokerLaunchingOwner: eofPeer.label, relayExitElapsedMs: eofPeer.relayExitElapsedMs })

  stage = 'natural-idle-shutdown'
  remember(await snapshot())
  const idleStarted = Date.now()
  await parallel(livePeers.map(peer => () => endInput(peer)))
  await eventually(async () => {
    const items = await snapshot()
    remember(items)
    return items.filter(item => knownProcesses.get(item.pid)?.createdAt === item.createdAt)
  }, items => items.length === 0, 'owned broker, browser and MCP process exit', Math.max(1, 45000 - (Date.now() - idleStarted)))
  const streamOutcomes = await bounded(Promise.all(peers.map(peer => peer.stdioClosed)), 'all relay stdio streams close after broker idle', Math.max(1, 45000 - (Date.now() - idleStarted)))
  for (const outcome of streamOutcomes) assert.deepEqual(outcome, { code: 0, signal: null })
  report.relayShutdown = peers.map(peer => ({ label: peer.label, relayExitElapsedMs: peer.relayExitElapsedMs, stdioCloseElapsedMs: peer.stdioCloseElapsedMs }))
  const idleElapsedMs = Date.now() - idleStarted
  assert.ok(idleElapsedMs <= 45000, 'Owned process idle exit must complete within 45 seconds')
  report.cleanup = { naturalIdleExit: true, idleElapsedMs, ownedProcessesRemaining: 0, adminShutdownUsed: false }
  pass('all MCP clients close naturally and owned broker/browser processes exit within 45 seconds', { idleElapsedMs })
  report.passed = true
} catch (error) {
  failure = error
  report.failure = { stage, name: error.name, code: typeof error.code === 'string' ? error.code : undefined, message: error instanceof assert.AssertionError ? error.message.split('\n')[0] : String(error.message).startsWith('Timeout:') ? error.message : 'Acceptance operation failed; see stage and retained private runtime evidence' }
} finally {
  if (!report.passed) {
    // Remember child identities even when initialization failed before normal
    // process inspection. This is a read-only query, never a process-name kill.
    try {
      const processes = await snapshot()
      remember(processes)
      for (const peer of peers) {
        peer.pid ??= peer.transport.pid
        const child = processes.find(item => item.parentPid === peer.pid && isExecutable(item, nodeExecutable) && hasArgument(item, mcpScript) && hasArgument(item, stateDir))
        if (child) { peer.mcpPid = child.pid; peer.mcpCreatedAt = child.createdAt }
      }
    } catch { report.cleanup.processInspectionFailed = true }
    // Only a verified broker receipt in this new QA state authorizes shutdown.
    try {
      const owned = await readOwnedDescriptor()
      const processes = await snapshot()
      const broker = processes.find(item => item.pid === owned.pid && isExecutable(item, nodeExecutable) && hasArgument(item, brokerScript) && hasArgument(item, stateDir))
      assert.ok(broker, 'Cannot identify the owned broker for cleanup')
      descriptor = owned
      remember(processes)
      await admin('shutdown', {}, owned)
      report.cleanup.adminShutdownUsed = true
    } catch { report.cleanup.adminShutdownUsed ??= false }
    await Promise.allSettled(peers.map(peer => peer.client.close()))
    // A relay failure may leave its MCP child orphaned. Never kill broker/browser
    // descendants: only exact MCP PID + creation time + installed script matches.
    try {
      const processes = await snapshot()
      for (const peer of peers) {
        const child = processes.find(item => item.pid === peer.mcpPid && item.createdAt === peer.mcpCreatedAt && isExecutable(item, nodeExecutable) && hasArgument(item, mcpScript) && hasArgument(item, stateDir))
        if (child) { try { process.kill(child.pid, 'SIGTERM') } catch {} }
      }
      await eventually(async () => {
        const items = await snapshot()
        remember(items)
        return items.filter(item => knownProcesses.get(item.pid)?.createdAt === item.createdAt)
      }, items => items.length === 0, 'failure cleanup of owned processes', 10000)
      report.cleanup.ownedProcessesRemaining = 0
    } catch {
      report.cleanup.ownedProcessesRemaining = 'unverified'
    }
  }
  if (fixture) {
    fixture.server.closeAllConnections()
    await bounded(fixture.close(), 'synthetic fixture close', 5000).catch(error => {
      report.cleanup.fixtureCloseFailed = true
      report.passed = false
      failure ??= error
      report.failure ??= { stage: 'fixture-cleanup', message: 'Synthetic fixture did not close within its bound' }
    })
  }
  report.stderr = peers.map(peer => ({ label: peer.label, bytes: peer.stderrBytes, sha256: peer.stderrHash.digest('hex') }))
  report.completedAt = new Date().toISOString()
  report.ownedProcesses = [...knownProcesses.values()]
  await writeFile(path.join(output, 'result.json'), JSON.stringify(report, null, 2), { mode: 0o600 })
}
if (failure) {
  console.error(`FAIL managed browser acceptance at ${stage}; private result: ${path.join(output, 'result.json')}`)
  process.exitCode = 1
} else console.log(`PASS managed browser acceptance: ${path.join(output, 'result.json')}`)

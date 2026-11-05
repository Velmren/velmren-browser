import http from 'node:http'
import path from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'
import { readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { diagnostic, parseManagedOptions, resolveManagedOptions, runManagedBroker } from '../../managed-runtime.mjs'
import { effectivePolicyIdentity } from '../../policy-identity.mjs'
import { AGENT_PROTOCOL } from '../../client.mjs'

async function startBroker({ stateDir, policy }) {
  if (policy.fail) throw new Error('Secret failure that must not escape: fake-admin-credential')
  if (policy.testStartupBarrier) {
    await writeFile(path.join(stateDir, 'fixture-launching'), String(process.pid))
    const deadline = Date.now() + 10000
    for (;;) {
      try { await readFile(path.join(stateDir, 'fixture-continue')); break } catch (error) { if (error.code !== 'ENOENT') throw error }
      if (Date.now() >= deadline) throw new Error('Fixture startup barrier timed out')
      await new Promise(resolve => setTimeout(resolve, 20))
    }
  }
  const clients = new Map()
  const policyIdentity = effectivePolicyIdentity(policy)
  let browserHealthy = true, releasedClients = 0, heartbeats = 0, profileLogin, agentProtocol = AGENT_PROTOCOL
  const descriptor = { pid: process.pid, adminToken: randomUUID(), endpoint: '' }
  const server = http.createServer(async (req, res) => {
    const token = req.headers.authorization?.replace(/^Bearer /, '')
    let body = ''
    for await (const chunk of req) body += chunk
    let request
    try { request = JSON.parse(body) } catch { res.writeHead(400); res.end(); return }
    const admin = token === descriptor.adminToken
    let result
    if (admin && request.method === 'broker_status') result = { tasks: [], policyIdentity, browserHealthy, clients: clients.size, releasedClients, heartbeats, profileLogin, agentProtocol }
    else if (admin && request.method === 'client_register') {
      if (request.args.policyIdentity !== policyIdentity || request.args.leaseMs !== 30000) { res.writeHead(400); res.end(JSON.stringify({ ok: false })); return }
      const clientId = randomUUID(), credential = randomUUID()
      clients.set(credential, clientId)
      result = { clientId, token: credential, leaseMs: 30000, recoverySecret: randomBytes(32).toString('base64url') }
    } else if (admin && request.method === 'set_agent_protocol') {
      agentProtocol = request.args.version
      result = { agentProtocol }
    } else if (admin && request.method === 'set_browser_health') {
      browserHealthy = request.args.healthy
      profileLogin = request.args.profileLogin
      result = { browserHealthy }
    } else if (admin && request.method === 'shutdown') {
      result = { stopping: true }
      setTimeout(() => { server.closeAllConnections(); server.close(() => process.exit(0)) }, 20)
    } else if (clients.has(token) && request.method === 'agent_protocol') result = { agentProtocol }
    else if (clients.has(token) && request.method === 'task_list') result = { tasks: [], owner: clients.get(token) }
    else if (clients.has(token) && request.method === 'client_heartbeat') { heartbeats++; result = { leaseMs: 30000 } }
    else if (clients.has(token) && request.method === 'client_release') { clients.delete(token); releasedClients++; result = { released: true } }
    else { res.writeHead(401); res.end(JSON.stringify({ ok: false })); return }
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ ok: true, result }))
  })
  await writeFile(path.join(stateDir, 'broker.lock'), String(process.pid), { flag: 'wx' })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  descriptor.endpoint = `http://127.0.0.1:${server.address().port}`
  const temp = path.join(stateDir, `connection-${process.pid}.tmp`)
  await writeFile(temp, JSON.stringify(descriptor))
  await rename(temp, path.join(stateDir, 'connection.json'))
  return { descriptor, server, close: async () => {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    await unlink(path.join(stateDir, 'connection.json'))
    await unlink(path.join(stateDir, 'broker.lock'))
    await writeFile(path.join(stateDir, 'fixture-closed'), String(process.pid))
  } }
}

try {
  const options = await resolveManagedOptions(parseManagedOptions(process.argv.slice(2)))
  process.once('disconnect', () => { void writeFile(path.join(options.stateDir, 'fixture-disconnected'), String(process.pid)) })
  await writeFile(path.join(options.stateDir, `fixture-helper-${process.pid}`), '')
  await runManagedBroker(options, { startBroker })
} catch (error) { process.stderr.write(diagnostic(error)); process.exit(1) }

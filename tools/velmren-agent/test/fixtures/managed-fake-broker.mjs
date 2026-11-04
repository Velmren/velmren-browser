import http from 'node:http'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { rename, writeFile } from 'node:fs/promises'
import { diagnostic, parseManagedOptions, resolveManagedOptions, runManagedBroker } from '../../managed-runtime.mjs'
import { effectivePolicyIdentity } from '../../policy-identity.mjs'

async function startBroker({ stateDir, policy }) {
  if (policy.fail) throw new Error('Secret failure that must not escape: fake-admin-credential')
  const clients = new Map()
  const policyIdentity = effectivePolicyIdentity(policy)
  let browserHealthy = true, releasedClients = 0, heartbeats = 0
  const descriptor = { pid: process.pid, adminToken: randomUUID(), endpoint: '' }
  const server = http.createServer(async (req, res) => {
    const token = req.headers.authorization?.replace(/^Bearer /, '')
    let body = ''
    for await (const chunk of req) body += chunk
    let request
    try { request = JSON.parse(body) } catch { res.writeHead(400); res.end(); return }
    const admin = token === descriptor.adminToken
    let result
    if (admin && request.method === 'broker_status') result = { tasks: [], policyIdentity, browserHealthy, clients: clients.size, releasedClients, heartbeats }
    else if (admin && request.method === 'client_register') {
      if (request.args.policyIdentity !== policyIdentity || request.args.leaseMs !== 30000) { res.writeHead(400); res.end(JSON.stringify({ ok: false })); return }
      const clientId = randomUUID(), credential = randomUUID()
      clients.set(credential, clientId)
      result = { clientId, token: credential, leaseMs: 30000 }
    } else if (admin && request.method === 'set_browser_health') {
      browserHealthy = request.args.healthy
      result = { browserHealthy }
    } else if (admin && request.method === 'shutdown') {
      result = { stopping: true }
      setTimeout(() => { server.closeAllConnections(); server.close(() => process.exit(0)) }, 20)
    } else if (clients.has(token) && request.method === 'task_list') result = { tasks: [], owner: clients.get(token) }
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
  return { descriptor, server, close: () => new Promise(resolve => server.close(resolve)) }
}

try {
  const options = await resolveManagedOptions(parseManagedOptions(process.argv.slice(2)))
  await runManagedBroker(options, { startBroker })
} catch (error) { process.stderr.write(diagnostic(error)); process.exit(1) }

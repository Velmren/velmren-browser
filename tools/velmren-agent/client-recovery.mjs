import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'

const digest = secret => createHash('sha256').update(secret).digest('hex')
const fail = () => { throw Object.assign(new Error('Scoped client recovery was rejected.'), { code: 'UNAUTHORIZED' }) }
const id = value => typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value)

// No bearer credentials, page content, URLs, or private input enter this file.
export class ClientRecoveryStore {
  constructor(stateDir, policyIdentity) {
    this.file = path.join(stateDir, 'client-recovery.json')
    this.policyIdentity = policyIdentity
    this.clients = new Map()
    this.queue = Promise.resolve()
    this.ready = this.load()
  }
  async load() {
    let raw
    try { raw = await readFile(this.file, 'utf8') } catch (error) { if (error.code === 'ENOENT') return; throw error }
    if (raw.length > 8 * 1024 * 1024) throw new Error('Client recovery storage exceeded its size bound')
    const value = JSON.parse(raw)
    if (value.schema !== 1 || !Array.isArray(value.clients)) throw new Error('Invalid client recovery storage')
    for (const client of value.clients) {
      if (!id(client.clientId) || !/^[a-f0-9]{64}$/.test(client.secretHash) || typeof client.policyIdentity !== 'string' || typeof client.revoked !== 'boolean' || !Array.isArray(client.tasks) || client.tasks.some(task => !id(task.taskId) || !['active', 'completed', 'cancelled'].includes(task.state))) throw new Error('Invalid client recovery record')
      this.clients.set(client.clientId, client)
    }
  }
  async change(update) {
    const work = this.queue.then(async () => {
      await this.ready
      const previous = structuredClone(this.clients)
      try {
        const result = update()
        await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 })
        const temp = `${this.file}.${randomUUID()}.tmp`
        await writeFile(temp, JSON.stringify({ schema: 1, clients: [...this.clients.values()] }), { flag: 'wx', mode: 0o600, flush: true })
        await rename(temp, this.file)
        return result
      } catch (error) { this.clients = previous; throw error }
    })
    this.queue = work.catch(() => {})
    return work
  }
  register(clientId) {
    const recoverySecret = randomBytes(32).toString('base64url')
    return this.change(() => {
      this.clients.set(clientId, { clientId, secretHash: digest(recoverySecret), policyIdentity: this.policyIdentity, revoked: false, tasks: [] })
      return recoverySecret
    })
  }
  async authenticate(clientId, secret) {
    await this.ready
    await this.queue
    const client = this.clients.get(clientId)
    if (!client || client.revoked || client.policyIdentity !== this.policyIdentity || typeof secret !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(secret)) fail()
    if (!timingSafeEqual(Buffer.from(client.secretHash, 'hex'), Buffer.from(digest(secret), 'hex'))) fail()
    return client
  }
  revoke(clientId) { return this.change(() => { const client = this.clients.get(clientId); if (client) client.revoked = true }) }
  async record(owner, taskId, state = 'active') {
    await this.ready
    if (!this.clients.has(owner)) return
    return this.change(() => {
      const tasks = this.clients.get(owner).tasks
      const task = tasks.find(task => task.taskId === taskId)
      if (task) task.state = state
      else tasks.push({ taskId, state })
    })
  }
  tasks(owner) {
    return [...this.clients.values()].filter(client => owner === 'admin' || owner === client.clientId).flatMap(client => client.tasks.map(task => ({
      taskId: task.taskId, owner: client.clientId, state: task.state === 'active' ? 'recovery-needed' : task.state,
      recoveryRequired: true, domRestored: false, reason: 'broker_restart', pages: []
    })))
  }
}

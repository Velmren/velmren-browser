import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

export const CLIENTS = ['codex', 'claude', 'scripts']
export const METHODS = [
  'task_create', 'task_list', 'task_observe', 'task_act', 'task_navigate',
  'task_wait', 'task_screenshot', 'task_request_human', 'task_finish', 'task_cancel'
]

export class BrokerError extends Error {
  constructor(message, code = 'BROKER_ERROR') {
    super(message)
    this.name = 'BrokerError'
    this.code = code
  }
}

export function parseOptions(argv, defaultClient = 'scripts') {
  const options = { client: defaultClient, positional: [] }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') options.help = true
    else if (arg === '--state-dir' || arg === '--client') {
      const value = argv[++i]
      if (!value || value.startsWith('--')) throw new Error(`${arg} needs a value`)
      options[arg === '--state-dir' ? 'stateDir' : 'client'] = value
    } else if (arg.startsWith('--')) throw new Error(`Unknown option: ${arg}`)
    else options.positional.push(arg)
  }
  if (!options.help && !options.stateDir) throw new Error('--state-dir is required')
  if (!CLIENTS.includes(options.client)) throw new Error('--client must be codex, claude, or scripts')
  return options
}

export async function readConnection(stateDir, client = 'scripts') {
  if (!stateDir) throw new Error('--state-dir is required')
  if (![...CLIENTS, 'admin'].includes(client)) throw new Error('Unknown client')
  let descriptor
  try {
    descriptor = JSON.parse(await readFile(resolve(stateDir, 'connection.json'), 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('No connection.json. Start the broker with this --state-dir first.')
    throw new Error('Cannot read a valid connection.json from --state-dir')
  }
  let endpoint
  try { endpoint = new URL(descriptor.endpoint) } catch { throw new Error('Invalid broker endpoint') }
  if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' ||
      endpoint.username || endpoint.password || endpoint.search || endpoint.hash ||
      endpoint.pathname !== '/' || !endpoint.port) {
    throw new Error('Broker endpoint must be http://127.0.0.1:<port>')
  }
  const token = client === 'admin' ? descriptor.adminToken : descriptor.clients?.[client]?.token
  if (typeof token !== 'string' || token.length < 1 || /[\r\n]/.test(token)) {
    throw new Error(`Missing or invalid credential for ${client}`)
  }
  return { endpoint: endpoint.origin, token, client }
}

function object(value, keys, name = 'args') {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new BrokerError(`${name} must be an object`, 'INVALID_ARGUMENTS')
  }
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) throw new BrokerError(`Unknown ${name} field: ${key}`, 'INVALID_ARGUMENTS')
  }
}

function string(value, name, max = 65536, allowEmpty = false) {
  if (typeof value !== 'string' || (!allowEmpty && !value.trim()) || value.length > max) {
    throw new BrokerError(`${name} must be ${allowEmpty ? 'a' : 'a nonempty'} string of at most ${max} characters`, 'INVALID_ARGUMENTS')
  }
}

export function validateArguments(method, args) {
  const keys = {
    task_create: ['url', 'label'], task_list: [], task_observe: ['taskId'],
    task_act: ['taskId', 'observationId', 'actions'], task_navigate: ['taskId', 'url'],
    task_wait: ['taskId', 'text', 'timeoutMs'], task_screenshot: ['taskId'],
    task_request_human: ['taskId', 'reason'], task_finish: ['taskId'], task_cancel: ['taskId']
  }
  if (!METHODS.includes(method)) throw new BrokerError('Unsupported task method', 'UNKNOWN_METHOD')
  object(args, keys[method])
  if (keys[method].includes('taskId')) string(args.taskId, 'taskId', 256)
  if (keys[method].includes('url')) {
    string(args.url, 'url', 8192)
    let url
    try { url = new URL(args.url) } catch { throw new BrokerError('url must be an absolute HTTP(S) URL', 'INVALID_ARGUMENTS') }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      throw new BrokerError('url must be an HTTP(S) URL without embedded credentials', 'INVALID_ARGUMENTS')
    }
  }
  if (args.label !== undefined) string(args.label, 'label', 200)
  if (method === 'task_request_human') string(args.reason, 'reason', 4000)
  if (method === 'task_wait') {
    string(args.text, 'text', 4000)
    if (args.timeoutMs !== undefined && (!Number.isInteger(args.timeoutMs) || args.timeoutMs < 1 || args.timeoutMs > 15000)) {
      throw new BrokerError('timeoutMs must be an integer from 1 to 15000', 'INVALID_ARGUMENTS')
    }
  }
  if (method === 'task_act') {
    string(args.observationId, 'observationId', 256)
    if (!Array.isArray(args.actions) || args.actions.length < 1 || args.actions.length > 20) {
      throw new BrokerError('actions must contain between 1 and 20 actions', 'INVALID_ARGUMENTS')
    }
    for (const action of args.actions) {
      object(action, ['type', 'ref', 'value', 'key'], 'action')
      if (!['click', 'fill', 'select', 'press'].includes(action.type)) throw new BrokerError('Unsupported action type', 'INVALID_ARGUMENTS')
      if (action.type !== 'press' || action.ref !== undefined) string(action.ref, 'ref', 256)
      if (['fill', 'select'].includes(action.type)) string(action.value, 'value', 65536, true)
      else if (action.value !== undefined) throw new BrokerError('Only fill/select accept value', 'INVALID_ARGUMENTS')
      if (action.type === 'press') string(action.key, 'key', 64)
      else if (action.key !== undefined) throw new BrokerError('Only press accepts key', 'INVALID_ARGUMENTS')
    }
  }
}

export function createClient(connection) {
  return {
    async call(method, args = {}, { signal } = {}) {
      validateArguments(method, args)
      let response
      try {
        response = await fetch(`${connection.endpoint}/rpc`, {
          method: 'POST', redirect: 'error',
          headers: { Authorization: `Bearer ${connection.token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ method, args }),
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(45000)]) : AbortSignal.timeout(45000)
        })
      } catch (error) {
        throw new BrokerError(
          error.name === 'AbortError' || error.name === 'TimeoutError'
            ? 'Broker request interrupted. Observe the task before retrying an action.'
            : 'Cannot reach the local broker. Check that it is running with this state directory.',
          'CONNECTION_ERROR'
        )
      }
      let payload
      try { payload = await response.json() } catch {
        throw new BrokerError(`Broker returned a non-JSON response (HTTP ${response.status})`, 'INVALID_RESPONSE')
      }
      if (!response.ok || payload?.ok !== true) {
        throw new BrokerError(typeof payload?.error === 'string' ? payload.error : `Broker request failed (HTTP ${response.status})`,
          typeof payload?.code === 'string' ? payload.code : 'BROKER_ERROR')
      }
      return payload.result
    }
  }
}

export async function connectClient(stateDir, client = 'scripts') {
  return createClient(await readConnection(stateDir, client))
}

export async function dashboardUrl(stateDir) {
  const { endpoint, token } = await readConnection(stateDir, 'admin')
  return `${endpoint}/#token=${encodeURIComponent(token)}`
}

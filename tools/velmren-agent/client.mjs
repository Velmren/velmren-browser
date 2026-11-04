import { readFile } from 'node:fs/promises'
import { resolve, isAbsolute } from 'node:path'
import { sanitizeActionResult, sanitizeWaitResult, unknownActionResult } from './action-result.mjs'

export const CLIENTS = ['codex', 'claude', 'scripts']
export const METHODS = [
  'task_create', 'task_list', 'task_observe', 'task_act', 'task_navigate',
  'task_wait', 'task_screenshot', 'task_request_human', 'task_resume', 'task_finish', 'task_cancel', 'task_upload_files',
  'task_list_pages', 'task_list_frames', 'task_list_options', 'task_select_page', 'task_close_page', 'task_handle_dialog', 'client_release', 'client_heartbeat',
  'profile_login_start', 'profile_login_status', 'profile_login_finish'
]

export class BrokerError extends Error {
  constructor(message, code = 'BROKER_ERROR', result, waitResult) {
    super(message)
    this.name = 'BrokerError'
    this.code = code
    const clean = sanitizeActionResult(result)
    if (clean) this.actionResult = clean
    const cleanWait = sanitizeWaitResult(waitResult)
    if (cleanWait) this.waitResult = cleanWait
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
    task_create: ['url', 'label'], task_list: [], task_observe: ['taskId', 'pageId', 'frameId', 'query', 'offset', 'limit', 'textOffset', 'textLimit'],
    task_act: ['taskId', 'pageId', 'frameId', 'observationId', 'actions'], task_navigate: ['taskId', 'pageId', 'url'],
    task_wait: ['taskId', 'pageId', 'frameId', 'text', 'predicate', 'timeoutMs'], task_screenshot: ['taskId', 'pageId'],
    task_request_human: ['taskId', 'pageId', 'reason', 'showWindow'], task_resume: ['taskId', 'handoffId', 'userConfirmed'], task_finish: ['taskId'], task_cancel: ['taskId'],
    task_list_pages: ['taskId'], task_list_frames: ['taskId', 'pageId'], task_list_options: ['taskId', 'pageId', 'frameId', 'observationId', 'ref', 'query', 'offset', 'limit'], task_select_page: ['taskId', 'pageId'], task_close_page: ['taskId', 'pageId'],
    task_handle_dialog: ['taskId', 'pageId', 'accept', 'promptText'], client_release: [], client_heartbeat: [],
    task_upload_files: ['taskId', 'pageId', 'frameId', 'observationId', 'ref', 'chooserId', 'files'],
    profile_login_start: ['url', 'userConfirmed'], profile_login_status: [], profile_login_finish: ['loginId', 'userConfirmed']
  }
  if (!METHODS.includes(method)) throw new BrokerError('Unsupported task method', 'UNKNOWN_METHOD')
  object(args, keys[method])
  if (keys[method].includes('taskId')) string(args.taskId, 'taskId', 256)
  if (args.pageId !== undefined || ['task_select_page', 'task_close_page'].includes(method)) string(args.pageId, 'pageId', 256)
  if (args.frameId !== undefined) string(args.frameId, 'frameId', 256)
  if (['task_observe', 'task_list_options'].includes(method)) {
    if (args.query !== undefined) string(args.query, 'query', 200, true)
    for (const [key, min, max] of [['offset', 0, Number.MAX_SAFE_INTEGER], ['limit', 1, method === 'task_observe' ? 150 : 100], ['textOffset', 0, Number.MAX_SAFE_INTEGER], ['textLimit', 0, 10000]]) {
      if (args[key] !== undefined && (!Number.isInteger(args[key]) || args[key] < min || args[key] > max)) throw new BrokerError(`${key} must be an integer from ${min} to ${max}`, 'INVALID_ARGUMENTS')
    }
  }
  if (method === 'task_list_options') {
    string(args.observationId, 'observationId', 256)
    string(args.ref, 'ref', 256)
  }
  const validateDialog = value => {
    if (typeof value.accept !== 'boolean') throw new BrokerError('accept must be boolean', 'INVALID_ARGUMENTS')
    if (value.promptText !== undefined) string(value.promptText, 'promptText', 65536, true)
  }
  if (method === 'task_handle_dialog') validateDialog(args)
  if (method === 'task_upload_files') {
    string(args.observationId, 'observationId', 256)
    if ((args.ref === undefined) === (args.chooserId === undefined)) throw new BrokerError('Provide exactly one input ref or chooserId', 'INVALID_ARGUMENTS')
    if (args.ref !== undefined) string(args.ref, 'ref', 256)
    if (args.chooserId !== undefined) string(args.chooserId, 'chooserId', 256)
    if (!Array.isArray(args.files) || args.files.length < 1 || args.files.length > 10) throw new BrokerError('files must contain between 1 and 10 absolute local file paths', 'INVALID_ARGUMENTS')
    for (const [index, file] of args.files.entries()) {
      string(file, `files[${index}]`, 4096)
      const parts = file.replace(/\\/g, '/').split('/')
      // Exclude UNC/device paths, alternate streams, wildcards, and Windows device names.
      if (!isAbsolute(file) || /^[\\/]{2}/.test(file) || /[\x00-\x1f*?]/.test(file) ||
          file.replace(/^[A-Za-z]:/, '').includes(':') ||
          (process.platform === 'win32' && !/^[A-Za-z]:[\\/]/.test(file)) ||
          parts.some(part => /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part) || /[. ]$/.test(part))) {
        throw new BrokerError(`files[${index}] must be an absolute local file path without wildcards, device names, or network paths`, 'INVALID_ARGUMENTS')
      }
    }
  }
  if (keys[method].includes('url')) {
    string(args.url, 'url', 8192)
    let url
    try { url = new URL(args.url) } catch { throw new BrokerError('url must be an absolute HTTP(S) URL', 'INVALID_ARGUMENTS') }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      throw new BrokerError('url must be an HTTP(S) URL without embedded credentials', 'INVALID_ARGUMENTS')
    }
  }
  if (args.label !== undefined) string(args.label, 'label', 200)
  if (method === 'task_request_human') {
    string(args.reason, 'reason', 4000)
    if (args.showWindow !== undefined && typeof args.showWindow !== 'boolean') throw new BrokerError('showWindow must be boolean', 'INVALID_ARGUMENTS')
  }
  if (method === 'task_resume') {
    string(args.handoffId, 'handoffId', 256)
    if (args.userConfirmed !== true) throw new BrokerError('Resume requires the user to confirm that the manual step is complete', 'INVALID_ARGUMENTS')
  }
  if (['profile_login_start', 'profile_login_finish'].includes(method)) {
    if (args.userConfirmed !== true) throw new BrokerError('Profile login requires explicit user confirmation of the requested transition', 'INVALID_ARGUMENTS')
    if (method === 'profile_login_finish') string(args.loginId, 'loginId', 256)
  }
  if (method === 'task_wait') {
    if ((args.text === undefined) === (args.predicate === undefined)) throw new BrokerError('Provide exactly one text or predicate', 'INVALID_ARGUMENTS')
    if (args.text !== undefined) string(args.text, 'text', 4000)
    if (args.predicate !== undefined) {
      object(args.predicate, ['observationId', 'ref', 'state', 'value'], 'predicate')
      string(args.predicate.observationId, 'predicate.observationId', 256)
      string(args.predicate.ref, 'predicate.ref', 256)
      if (!['exists', 'enabled', 'visible', 'value'].includes(args.predicate.state)) throw new BrokerError('Unsupported predicate state', 'INVALID_ARGUMENTS')
      if (args.predicate.state === 'value') string(args.predicate.value, 'predicate.value', 65536, true)
      else if (args.predicate.value !== undefined) throw new BrokerError('Only a value predicate accepts value', 'INVALID_ARGUMENTS')
    }
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
      if (action?.type === 'handleDialog') {
        object(action, ['type', 'accept', 'promptText'], 'action')
        validateDialog(action)
        continue
      }
      object(action, ['type', 'ref', 'value', 'key', 'checked'], 'action')
      if (!['click', 'fill', 'select', 'press', 'setChecked'].includes(action.type)) throw new BrokerError('Unsupported action type', 'INVALID_ARGUMENTS')
      if (action.type !== 'press' || action.ref !== undefined) string(action.ref, 'ref', 256)
      if (['fill', 'select'].includes(action.type)) string(action.value, 'value', 65536, true)
      else if (action.value !== undefined) throw new BrokerError('Only fill/select accept value', 'INVALID_ARGUMENTS')
      if (action.type === 'press') string(action.key, 'key', 64)
      else if (action.key !== undefined) throw new BrokerError('Only press accepts key', 'INVALID_ARGUMENTS')
      if (action.type === 'setChecked') {
        if (typeof action.checked !== 'boolean') throw new BrokerError('setChecked requires a boolean checked value', 'INVALID_ARGUMENTS')
      } else if (action.checked !== undefined) throw new BrokerError('Only setChecked accepts checked', 'INVALID_ARGUMENTS')
    }
  }
}

export function createClient(connection) {
  return {
    async call(method, args = {}, { signal } = {}) {
      validateArguments(method, args)
      const unknown = () => ['task_create', 'task_act', 'task_navigate', 'task_upload_files', 'task_handle_dialog', 'task_select_page', 'task_close_page', 'task_request_human', 'task_resume', 'task_finish', 'task_cancel', 'profile_login_start', 'profile_login_finish'].includes(method) ? unknownActionResult() : undefined
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
          'CONNECTION_ERROR', unknown()
        )
      }
      let payload
      try { payload = await response.json() } catch {
        throw new BrokerError(`Broker returned a non-JSON response (HTTP ${response.status})`, 'INVALID_RESPONSE', unknown())
      }
      if (!response.ok || payload?.ok !== true) {
        throw new BrokerError(typeof payload?.error === 'string' ? payload.error : `Broker request failed (HTTP ${response.status})`,
          typeof payload?.code === 'string' ? payload.code : 'BROKER_ERROR', sanitizeActionResult(payload?.actionResult) ?? unknown(), payload?.waitResult)
      }
      if (!Object.hasOwn(payload, 'result')) throw new BrokerError('Broker response is missing its result', 'INVALID_RESPONSE', unknown())
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

const $ = id => document.getElementById(id)
const fragment = location.hash.slice(1)
const token = fragment.startsWith('token=') ? new URLSearchParams(fragment).get('token') : fragment
if (fragment) history.replaceState(null, '', location.pathname)

const stateNames = {
  'agent-active': 'Agent active', paused: 'Paused', 'needs-human': 'Needs you',
  human: 'Human control', completed: 'Completed', cancelled: 'Cancelled'
}
const terminal = state => ['completed', 'cancelled'].includes(state)
const cards = new Map()
const busy = new Set()
let tasks = []
let selectedTaskId = null
let refreshing = false
let pollTimer
let disposed = false

function element(tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function announce(text) { $('announcement').textContent = text }
function showError(node, message) { node.textContent = message; node.hidden = !message }

let captchaSettings = null
let captchaBusy = false
let captchaTotals = null
const captchaLimits = [
  ['captcha-daily', 'maxRequestsPerDay', 1000],
  ['captcha-task', 'maxAttemptsPerTask', 10],
  ['captcha-concurrent', 'maxConcurrent', 5]
]

function captchaStats(stats) {
  return Object.fromEntries(['solutionsDelivered', 'failed', 'cancelled', 'uncertain'].map(name => [
    name, Number.isSafeInteger(stats?.[name]) && stats[name] >= 0 ? stats[name] : 0
  ]))
}

function captchaOutcomeText(stats) {
  const counts = captchaStats(stats)
  return `CAPTCHA solutions: ${counts.solutionsDelivered.toLocaleString()} · Failed: ${counts.failed.toLocaleString()} · Cancelled: ${counts.cancelled.toLocaleString()} · Uncertain: ${counts.uncertain.toLocaleString()}`
}

function renderCaptchaTotals(stats) {
  captchaTotals = captchaStats(stats)
  $('captcha-total').textContent = captchaTotals.solutionsDelivered.toLocaleString()
  $('captcha-outcomes').textContent = captchaOutcomeText(captchaTotals) + (stats?.persisted === false ? ' · Latest counts could not be saved' : '')
}

function updateCaptchaControls() {
  const unavailable = !captchaSettings?.storageAvailable
  $('captcha-fields').disabled = captchaBusy || unavailable
  $('captcha-save').disabled = captchaBusy || unavailable
  $('captcha-check').disabled = captchaBusy || unavailable || !captchaSettings?.hasKey || !!$('captcha-key').value
  $('captcha-remove').disabled = captchaBusy || !captchaSettings?.hasKey
  $('captcha-retry').disabled = captchaBusy
  $('captcha-form').setAttribute('aria-busy', String(captchaBusy))
}

function clearCaptchaValidation() {
  for (const id of ['captcha-key', ...captchaLimits.map(([id]) => id)]) {
    $(id).removeAttribute('aria-invalid')
    showError($(id + '-error'), '')
  }
}

function renderCaptchaSettings(result) {
  // Keep only fields used by this view; never retain or render credential data.
  if (result?.provider !== 'capsolver' || typeof result.enabled !== 'boolean' ||
      typeof result.hasKey !== 'boolean' || typeof result.storageAvailable !== 'boolean' ||
      !captchaLimits.every(([, name, max]) => Number.isInteger(result.limits?.[name]) && result.limits[name] >= 1 && result.limits[name] <= max) ||
      !['unchecked', 'valid', 'error'].includes(result.verification?.status) ||
      ![result.usage?.requestsLast24Hours, result.usage?.active].every(value => Number.isInteger(value) && value >= 0)) {
    throw new Error('Invalid settings response')
  }
  captchaSettings = { enabled: result.enabled, hasKey: result.hasKey, storageAvailable: result.storageAvailable }
  $('captcha-enabled').checked = result.enabled
  for (const [id, name] of captchaLimits) $(id).value = result.limits[name]
  $('captcha-key-state').textContent = result.hasKey ? 'A key is saved' : 'No key saved'
  $('captcha-summary').textContent = result.enabled ? 'Enabled · CapSolver' : 'Disabled · CapSolver'
  $('captcha-storage').hidden = result.storageAvailable
  $('captcha-account').hidden = false
  const verification = result.verification
  let message = !result.hasKey ? 'Save a key to check your CapSolver balance.'
    : verification.status === 'valid' ? 'Key verified'
    : verification.status === 'error' ? 'Key check failed. Check your saved key and CapSolver account.' : 'Key not checked'
  if (result.hasKey && verification.status === 'valid' && Number.isFinite(verification.balanceUsd) && verification.balanceUsd >= 0) {
    message += ` · Balance: ${verification.balanceUsd.toLocaleString(undefined, { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 4 })} USD`
  }
  const checkedAt = typeof verification.checkedAt === 'string' ? new Date(verification.checkedAt) : null
  if (result.hasKey && checkedAt && Number.isFinite(checkedAt.getTime())) message += ` · Checked ${checkedAt.toLocaleString()}`
  $('captcha-verification').textContent = message
  $('captcha-usage').textContent = `${result.usage.requestsLast24Hours} paid attempts in the last 24 hours · ${result.usage.active} active`
  if (!captchaTotals) renderCaptchaTotals(result.usage)
}

async function runCaptchaAction(action, args = {}) {
  if (captchaBusy || disposed) return
  const focus = document.activeElement
  captchaBusy = true
  $('captcha-key').value = ''
  showError($('captcha-error'), '')
  $('captcha-retry').hidden = true
  $('captcha-status').textContent = { get: 'Loading settings…', save: 'Saving settings…', check: 'Checking saved key and balance…', remove_key: 'Removing key…' }[action]
  updateCaptchaControls()
  try {
    const pending = rpc('captcha_settings', { action, ...args })
    delete args.key
    const result = await pending
    if (disposed) return
    renderCaptchaSettings(result)
    $('captcha-status').textContent = {
      get: 'Settings loaded.', save: 'Settings saved.',
      check: result.hasKey && result.verification.status === 'valid' ? 'Balance check completed.' : 'Balance check failed.',
      remove_key: !result.hasKey && !result.enabled ? 'Key removed. CapSolver is disabled.' : 'Settings updated. Review the saved key and enabled state.'
    }[action]
  } catch {
    if (disposed) return
    // A provider error must never echo a submitted key into dashboard content.
    showError($('captcha-error'), {
      get: 'Could not load CAPTCHA settings. Use the private admin dashboard link and try again.',
      save: 'Could not save settings. Check the key and limits, then try again. Re-enter a new key if you were replacing it.',
      check: 'Could not check the balance. Check your saved key, CapSolver account and connection, then try again.',
      remove_key: 'Could not remove the key. Try again.'
    }[action])
    if (action === 'check') $('captcha-verification').textContent = 'Latest balance check failed. The current balance is unavailable.'
    $('captcha-status').textContent = ''
    $('captcha-retry').hidden = action !== 'get'
    if (action === 'get') {
      captchaSettings = null
      $('captcha-summary').textContent = 'Unavailable · CapSolver'
      $('captcha-key-state').textContent = 'Key status unavailable'
      $('captcha-account').hidden = true
      $('captcha-storage').hidden = true
    }
  } finally {
    delete args.key
    $('captcha-key').value = ''
    captchaBusy = false
    updateCaptchaControls()
    if (!disposed && $('captcha-settings').open && document.activeElement === document.body && $('captcha-form').contains(focus)) {
      const next = !focus.matches(':disabled') ? focus : !$('captcha-save').disabled ? $('captcha-save') : $('captcha-settings-heading')
      next.focus({ preventScroll: true })
    }
  }
}

$('captcha-settings').addEventListener('toggle', () => {
  $('captcha-key').value = ''
  clearCaptchaValidation()
  if ($('captcha-settings').open) runCaptchaAction('get')
})
$('captcha-retry').addEventListener('click', () => runCaptchaAction('get'))
$('captcha-key').addEventListener('input', updateCaptchaControls)
$('captcha-form').addEventListener('submit', event => {
  event.preventDefault()
  if (captchaBusy || !captchaSettings?.storageAvailable) return
  clearCaptchaValidation()
  const args = { enabled: $('captcha-enabled').checked }
  let firstInvalid
  const invalid = (id, message) => {
    $(id).setAttribute('aria-invalid', 'true')
    showError($(id + '-error'), message)
    firstInvalid ||= $(id)
  }
  if (args.enabled && !captchaSettings.hasKey && !$('captcha-key').value.trim()) invalid('captcha-key', 'Enter your CapSolver API key before enabling the service.')
  for (const [id, name, max] of captchaLimits) {
    const value = Number($(id).value)
    if (!Number.isInteger(value) || value < 1 || value > max) invalid(id, `Enter a whole number from 1 to ${max.toLocaleString()}.`)
    else args[name] = value
  }
  if (firstInvalid) {
    $('captcha-status').textContent = 'Settings were not sent. Correct the highlighted fields.'
    firstInvalid.focus()
    return
  }
  if ($('captcha-key').value.trim()) args.key = $('captcha-key').value.trim()
  runCaptchaAction('save', args)
})
$('captcha-check').addEventListener('click', () => runCaptchaAction('check'))
$('captcha-remove').addEventListener('click', () => runCaptchaAction('remove_key'))

async function rpc(method, args = {}) {
  if (!token) throw new Error('Open the private dashboard link printed by the CLI. The link is required again after reloading this page.')
  const response = await fetch('/rpc', {
    method: 'POST', redirect: 'error', credentials: 'omit',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ method, args }), signal: AbortSignal.timeout(30000)
  })
  let payload
  try { payload = await response.json() } catch { throw new Error(`Unexpected broker response (HTTP ${response.status})`) }
  if (!response.ok || payload?.ok !== true) throw new Error(payload?.error || `Broker request failed (HTTP ${response.status})`)
  return payload.result
}

function taskButton(label, className, taskId, action) {
  const button = element('button', `button ${className}`, label)
  button.type = 'button'
  button.addEventListener('click', () => runTaskAction(taskId, action))
  return button
}

function makeCard(taskId) {
  const card = element('article', 'task-card')
  const top = element('div', 'task-top')
  const title = element('h3', 'task-title')
  const badge = element('span', 'badge')
  top.append(title, badge)
  const meta = element('div', 'task-meta')
  const owner = element('span')
  const id = element('code')
  const captchaCount = element('span', 'task-captcha-count')
  meta.append(owner, element('span', '', '·'), id, element('span', '', '·'), captchaCount)
  const url = element('p', 'url')
  const reason = element('p', 'human-reason')
  const blocked = element('p', 'blocked-origins')
  const pageLabel = element('label', 'filter-label', 'Page ')
  const pageSelect = element('select')
  pageSelect.id = `pages-${taskId}`
  pageLabel.htmlFor = pageSelect.id
  pageLabel.append(pageSelect)
  pageSelect.addEventListener('change', async () => {
    if (busy.has(taskId)) return
    busy.add(taskId); pageSelect.disabled = true
    try { renderObservation(taskId, await rpc('task_select_page', { taskId, pageId: pageSelect.value })) }
    catch (failure) { showError(error, failure.message) }
    finally { busy.delete(taskId); await refresh() }
  })
  const actions = element('div', 'task-actions')
  const buttons = {
    observe: taskButton('Observe', 'observe', taskId, 'observe'),
    show: taskButton('Show', '', taskId, 'show'),
    pause: taskButton('Pause', '', taskId, 'pause'),
    resume: taskButton('Resume', '', taskId, 'resume'),
    cancel: taskButton('Cancel', 'danger', taskId, 'cancel')
  }
  buttons.show.title = 'Show the task window and take manual control'
  buttons.resume.title = 'Return this task to the agent'
  actions.append(...Object.values(buttons))
  const error = element('p', 'inline-error')
  error.setAttribute('role', 'alert')
  error.hidden = true
  card.append(top, meta, url, pageLabel, reason, blocked, actions, error)
  $('tasks').append(card)
  return { card, title, badge, owner, id, captchaCount, url, pageLabel, pageSelect, reason, blocked, buttons, error }
}

function updateCard(task) {
  const id = task.taskId
  if (!cards.has(id)) cards.set(id, makeCard(id))
  const view = cards.get(id)
  view.card.dataset.state = task.state
  view.card.classList.toggle('selected', id === selectedTaskId)
  view.title.textContent = task.label || 'Untitled task'
  view.badge.textContent = stateNames[task.state] || task.state
  view.badge.dataset.state = task.state
  view.owner.textContent = task.owner || 'Local client'
  view.id.textContent = id
  view.captchaCount.textContent = `CAPTCHA solutions: ${captchaStats(task.captchaStats).solutionsDelivered.toLocaleString()}`
  view.url.textContent = task.url || 'Waiting for a page'
  view.reason.textContent = task.reason || (task.state === 'needs-human' ? 'Human input is needed. Choose Show to inspect the task.' : '')
  view.reason.hidden = !view.reason.textContent
  view.blocked.textContent = task.blockedOrigins?.length ? `Blocked by policy: ${task.blockedOrigins.join(', ')}` : ''
  view.blocked.hidden = !view.blocked.textContent
  const isBusy = busy.has(id)
  const pages = task.pages ?? []
  const pageSignature = JSON.stringify(pages.map(page => [page.pageId, page.title, page.url]))
  if (view.pageSelect.dataset.pages !== pageSignature) {
    view.pageSelect.replaceChildren(...pages.map((page, index) => {
      const option = element('option', '', `${index + 1}. ${page.title || page.url || 'New page'}`)
      option.value = page.pageId; option.title = page.url || ''
      return option
    }))
    view.pageSelect.dataset.pages = pageSignature
  }
  view.pageSelect.value = task.selectedPageId || ''
  view.pageSelect.disabled = isBusy || terminal(task.state)
  view.pageLabel.hidden = pages.length < 2
  view.buttons.observe.disabled = isBusy || terminal(task.state)
  view.buttons.show.disabled = isBusy || terminal(task.state)
  view.buttons.pause.disabled = isBusy || task.state !== 'agent-active'
  view.buttons.resume.disabled = isBusy || !['paused', 'needs-human', 'human'].includes(task.state)
  view.buttons.cancel.disabled = isBusy || terminal(task.state)
  view.card.setAttribute('aria-busy', String(isBusy))
}

function filterTasks() {
  const filter = $('filter').value
  let shown = 0
  for (const task of tasks) {
    const visible = filter === 'all' || (filter === 'working' && ['agent-active', 'paused'].includes(task.state)) ||
      (filter === 'human' && ['needs-human', 'human'].includes(task.state)) || (filter === 'finished' && terminal(task.state))
    cards.get(task.taskId).card.hidden = !visible
    if (visible) shown++
  }
  $('empty').hidden = shown !== 0
  $('empty-title').textContent = tasks.length ? 'No tasks in this view' : 'Your workspace is ready'
  $('empty-message').textContent = tasks.length ? 'Choose a different filter to see the rest of your workspace.' : 'Create a task from Codex, Claude, or the CLI. It will appear here with its progress and controls.'
}

function renderStatus(status) {
  renderCaptchaTotals(status.captchaStats)
  tasks = status.tasks ?? []
  const ids = new Set(tasks.map(task => task.taskId))
  for (const [id, view] of cards) if (!ids.has(id)) { view.card.remove(); cards.delete(id) }
  for (const task of tasks) updateCard(task)
  if (selectedTaskId && !ids.has(selectedTaskId)) {
    selectedTaskId = null
    $('inspection').hidden = true
    $('inspector-empty').hidden = false
    clearScreenshot()
  }
  const selected = tasks.find(task => task.taskId === selectedTaskId)
  $('inspection-captcha-outcomes').textContent = captchaOutcomeText(selected?.captchaStats)
  if (selected?.privacy?.active) protectInspection()
  $('screenshot').disabled = !selected || terminal(selected.state) || busy.has(selectedTaskId) || selected.privacy?.active === true
  $('inspect-again').disabled = !selected || terminal(selected.state) || busy.has(selectedTaskId)
  $('count-active').textContent = tasks.filter(task => task.state === 'agent-active').length
  $('count-human').textContent = tasks.filter(task => ['needs-human', 'human'].includes(task.state)).length
  $('count-paused').textContent = tasks.filter(task => task.state === 'paused').length
  $('count-total').textContent = tasks.length
  $('task-count').textContent = tasks.length
  $('capacity').textContent = status.maxTasks ? `Capacity · ${status.maxTasks} tasks` : 'Local broker'
  filterTasks()
}

function scheduleRefresh() {
  clearTimeout(pollTimer)
  if (!disposed && token && !document.hidden) pollTimer = setTimeout(refresh, 3000)
}

async function refresh() {
  if (refreshing || disposed) return
  refreshing = true
  $('refresh').disabled = true
  try {
    const status = await rpc('broker_status')
    renderStatus(status)
    showError($('notice'), '')
    $('connection-state').textContent = 'Connected locally'
    document.querySelector('.connection').classList.add('connected')
    $('updated').textContent = `Updated ${new Date().toLocaleTimeString()} · Refreshes every 3 seconds`
  } catch (error) {
    showError($('notice'), error.message)
    $('connection-state').textContent = token ? 'Disconnected' : 'Private link needed'
    document.querySelector('.connection').classList.remove('connected')
    $('updated').textContent = 'Updates paused · task information may be out of date'
  } finally {
    refreshing = false
    $('refresh').disabled = false
    $('tasks').setAttribute('aria-busy', 'false')
    scheduleRefresh()
  }
}

function clearScreenshot() {
  $('screenshot-view').hidden = true
  $('screenshot-image').removeAttribute('src')
}

function protectInspection() {
  clearScreenshot()
  $('page-text').textContent = 'Page content is protected during sensitive input.'
  $('inspection-title').textContent = 'Protected page'
  $('elements').replaceChildren()
  $('elements-summary').textContent = 'Page controls (protected)'
  $('downloads').replaceChildren()
  $('downloads-details').hidden = true
  dialogMessage.textContent = ''; promptInput.value = ''; dialogPanel.hidden = true
  $('screenshot').disabled = true
}

function renderObservation(taskId, observation) {
  selectedTaskId = taskId
  clearScreenshot()
  showError($('inspection-error'), '')
  $('inspector-empty').hidden = true
  $('inspection').hidden = false
  const task = tasks.find(task => task.taskId === taskId)
  $('inspection-captcha-outcomes').textContent = captchaOutcomeText(task?.captchaStats)
  if (observation.privacy?.active || task?.privacy?.active) {
    if (task && observation.privacy?.active) task.privacy = observation.privacy
    protectInspection()
    return
  }
  $('inspection-owner').textContent = `${task?.owner || 'Local client'} · ${stateNames[observation.state] || observation.state || ''}`
  $('inspection-title').textContent = observation.title || task?.label || 'Page observation'
  $('inspection-url').textContent = observation.url || ''
  $('inspection-stamp').textContent = `Observed ${new Date().toLocaleTimeString()} · This is a snapshot of the page`
  $('page-text').textContent = observation.text || 'No visible page text.'
  renderDialog(taskId, observation)
  $('elements').replaceChildren()
  for (const item of observation.elements ?? []) {
    const row = element('li')
    row.append(element('code', '', item.ref), element('span', '', ` · ${item.role || item.tag || 'element'}${item.disabled ? ' · disabled' : ''}`))
    row.append(element('span', 'element-info', item.name || item.type || 'Unnamed control'))
    $('elements').append(row)
  }
  $('elements-summary').textContent = `Page controls (${observation.elements?.length ?? 0})`
  $('downloads').replaceChildren()
  for (const download of observation.downloads ?? []) $('downloads').append(element('li', '', `${download.name || 'Download'} · ${download.state || 'unknown'}${download.path ? ` · ${download.path}` : ''}`))
  $('downloads-details').hidden = !observation.downloads?.length
  for (const task of tasks) updateCard(task)
  announce(`Observed ${task?.label || 'task'}. Page inspector updated.`)
}

const dialogPanel = element('fieldset')
dialogPanel.hidden = true
dialogPanel.append(element('legend', '', 'Page dialog'))
const dialogMessage = element('pre', 'page-text')
const promptLabel = element('label', '', 'Prompt response ')
const promptInput = element('input', 'button')
promptInput.id = 'page-prompt-response'; promptInput.type = 'text'; promptInput.autocomplete = 'off'
promptLabel.htmlFor = promptInput.id; promptLabel.append(promptInput)
const dialogActions = element('div', 'inspector-actions')
let dialogTaskId, dialogPageId
const dialogButtons = [true, false].map(accept => {
  const button = element('button', 'button', accept ? 'Accept dialog' : 'Dismiss dialog')
  button.type = 'button'
  button.addEventListener('click', async () => {
    if (!dialogTaskId || busy.has(dialogTaskId)) return
    const taskId = dialogTaskId, pageId = dialogPageId
    busy.add(taskId); dialogButtons.forEach(button => { button.disabled = true })
    try {
      const result = await rpc('task_handle_dialog', { taskId, pageId, accept, ...(promptLabel.hidden ? {} : { promptText: promptInput.value }) })
      renderObservation(taskId, result)
      announce(accept ? 'Page dialog accepted.' : 'Page dialog dismissed.')
    } catch (error) { showError($('inspection-error'), error.message) }
    finally { busy.delete(taskId); dialogButtons.forEach(button => { button.disabled = false }); await refresh() }
  })
  return button
})
dialogActions.append(...dialogButtons)
dialogPanel.append(dialogMessage, promptLabel, dialogActions)
$('inspection-error').after(dialogPanel)

function renderDialog(taskId, observation) {
  dialogPanel.hidden = !observation.dialog
  dialogTaskId = taskId; dialogPageId = observation.pageId
  if (!observation.dialog) return
  dialogMessage.textContent = `${observation.dialog.type}: ${observation.dialog.message}`
  promptLabel.hidden = observation.dialog.type !== 'prompt'
  promptInput.value = observation.dialog.defaultPrompt || ''
}

async function runTaskAction(taskId, action) {
  if (busy.has(taskId)) return
  const view = cards.get(taskId)
  busy.add(taskId)
  const task = tasks.find(task => task.taskId === taskId)
  if (task) updateCard(task)
  if (view) showError(view.error, '')
  try {
    if (action === 'observe') renderObservation(taskId, await rpc('task_observe', { taskId }))
    else {
      await rpc('task_control', { taskId, action })
      announce(`${task?.label || 'Task'}: ${action === 'show' ? 'shown for human control' : action + ' requested'}.`)
    }
  } catch (error) {
    if (view) showError(view.error, error.message)
    else showError($('inspection-error'), error.message)
  } finally {
    busy.delete(taskId)
    if (task) updateCard(task)
    await refresh()
  }
}

$('refresh').addEventListener('click', refresh)
$('filter').addEventListener('change', filterTasks)
$('inspect-again').addEventListener('click', () => selectedTaskId && runTaskAction(selectedTaskId, 'observe'))
$('screenshot').addEventListener('click', async () => {
  const taskId = selectedTaskId
  if (!taskId || busy.has(taskId)) return
  busy.add(taskId)
  $('screenshot').disabled = true
  $('screenshot').textContent = 'Capturing…'
  $('inspect-again').disabled = true
  showError($('inspection-error'), '')
  try {
    const result = await rpc('task_screenshot', { taskId })
    if (result.mimeType !== 'image/png' || typeof result.data !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(result.data)) throw new Error('The broker returned an invalid PNG screenshot.')
    if (selectedTaskId === taskId && !tasks.find(task => task.taskId === taskId)?.privacy?.active) {
      $('screenshot-image').src = `data:image/png;base64,${result.data}`
      $('screenshot-view').hidden = false
      $('screenshot-caption').textContent = `Captured ${new Date().toLocaleTimeString()} · This image does not refresh automatically`
      announce('Screenshot captured for the selected task.')
    }
  } catch (error) { showError($('inspection-error'), error.message) }
  finally {
    busy.delete(taskId)
    $('screenshot').textContent = 'Capture screenshot'
    await refresh()
  }
})
document.addEventListener('visibilitychange', () => {
  clearTimeout(pollTimer)
  if (!document.hidden) refresh()
})
window.addEventListener('pagehide', () => { disposed = true; clearTimeout(pollTimer); $('captcha-key').value = '' })
refresh()

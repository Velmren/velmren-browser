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
  meta.append(owner, element('span', '', '·'), id)
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
  return { card, title, badge, owner, id, url, pageLabel, pageSelect, reason, blocked, buttons, error }
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
  $('screenshot').disabled = !selected || terminal(selected.state) || busy.has(selectedTaskId)
  $('inspect-again').disabled = $('screenshot').disabled
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

function renderObservation(taskId, observation) {
  selectedTaskId = taskId
  clearScreenshot()
  showError($('inspection-error'), '')
  $('inspector-empty').hidden = true
  $('inspection').hidden = false
  const task = tasks.find(task => task.taskId === taskId)
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
    if (selectedTaskId === taskId) {
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
window.addEventListener('pagehide', () => { disposed = true; clearTimeout(pollTimer) })
refresh()

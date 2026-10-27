const title = 'Velmren QA'
const color = 'cyan'
const urls = [1, 2, 3].map(n => `http://localhost:47623/tab/${n}`)
const result = document.querySelector('#result')

function check(condition, message) {
  if (!condition) throw new Error(message)
}

async function inspect(groupId) {
  const group = await chrome.tabGroups.get(groupId)
  const tabs = await chrome.tabs.query({ groupId })
  return {
    group,
    urls: tabs.map(tab => tab.pendingUrl || tab.url).sort(),
    positions: tabs.map(tab => tab.index).sort((a, b) => a - b)
  }
}

async function createAndExercise() {
  check((await chrome.tabGroups.query({ title })).length === 0,
    'A test group already exists; use the restart check or a fresh QA profile.')
  const current = await chrome.tabs.getCurrent()
  const tabs = []
  for (const url of urls) {
    tabs.push(await chrome.tabs.create({ url, windowId: current.windowId, active: false }))
  }
  const groupId = await chrome.tabs.group({ tabIds: tabs.slice(0, 2).map(tab => tab.id) })
  await chrome.tabGroups.update(groupId, { title, color, collapsed: true })
  let state = await inspect(groupId)
  check(state.group.title === title && state.group.color === color && state.group.collapsed,
    'Name, color or collapse state was not applied.')
  check(state.urls.length === 2, 'Initial group must contain two tabs.')
  await chrome.tabs.group({ groupId, tabIds: tabs[2].id })
  check((await inspect(groupId)).urls.length === 3, 'Adding a tab failed.')
  await chrome.tabs.ungroup(tabs[2].id)
  check((await inspect(groupId)).urls.length === 2, 'Removing a tab failed.')
  await chrome.tabs.group({ groupId, tabIds: tabs[2].id })
  await chrome.tabGroups.update(groupId, { collapsed: false })
  await chrome.tabGroups.move(groupId, { index: 0 })
  state = await inspect(groupId)
  check(!state.group.collapsed, 'Expanding the group failed.')
  check(state.positions[0] === 0, 'Moving the group to the beginning failed.')
  check(JSON.stringify(state.urls) === JSON.stringify(urls), 'Final group membership differs.')
  return { status: 'PASS', check: 'create, rename, color, collapse, expand, membership, move', ...state }
}

async function verifyRestored() {
  const groups = await chrome.tabGroups.query({ title })
  check(groups.length === 1, `Expected one restored group; found ${groups.length}.`)
  const state = await inspect(groups[0].id)
  check(state.group.color === color, 'Restored group lost its color.')
  check(JSON.stringify(state.urls) === JSON.stringify(urls), 'Restored group lost tabs.')
  return { status: 'PASS', check: 'restart restoration', ...state }
}

async function run(checkFunction) {
  try {
    const report = await checkFunction()
    result.textContent = JSON.stringify(report, null, 2)
    return report
  } catch (error) {
    result.textContent = JSON.stringify({ status: 'FAIL', error: String(error) }, null, 2)
    throw error
  }
}

globalThis.velmrenGroups = { create: () => run(createAndExercise), restore: () => run(verifyRestored) }
document.querySelector('#create').addEventListener('click', () => globalThis.velmrenGroups.create())
document.querySelector('#restore').addEventListener('click', () => globalThis.velmrenGroups.restore())

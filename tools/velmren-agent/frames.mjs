import { AgentPage } from './page.mjs'

const unavailable = () => { const error = new Error('Frame not found in this page; list frames and observe again'); error.code = 'NOT_FOUND'; throw error }

function assertFrameLayout(owner) {
  const seen = new Set()
  for (let element = owner; element && !seen.has(element); element = element.assignedSlot || element.parentElement || element.getRootNode?.()?.host) {
    seen.add(element)
    const style = getComputedStyle(element)
    if (['transform', 'scale', 'rotate', 'translate', 'perspective'].some(key => style[key] && style[key] !== 'none') ||
        style.zoom && !['normal', '1', '100%'].includes(style.zoom)) {
      throw new Error('Frame or ancestor uses unsupported CSS transform or zoom; no input was sent')
    }
  }
}

// Membership comes from an owned page's live frame tree, never its profile.
export class PageFrames {
  constructor(root, sessions, frameOwner) {
    this.root = root; this.sessions = sessions; this.frameOwner = frameOwner; this.frames = new Map(); this.nodes = new Map()
    this.listener = message => {
      const id = message.params?.frame?.id ?? message.params?.frameId
      const frame = this.frames.get(id)
      const ownedSession = message.sessionId === root.sessionId || [...this.frames.values()].some(value => value.sessionId === message.sessionId)
      if (!ownedSession) return
      if (message.method === 'Page.frameDetached') this.remove(id)
      if (message.method === 'Page.frameNavigated') {
        if (id === root.frameId) this.clear()
        else if (frame) for (const child of [...this.frames.values()]) if (child.parentFrameId === id) this.remove(child.frameId)
      }
    }
    root.browser.on('protocol', this.listener)
  }
  remove(id) {
    for (const frame of [...this.frames.values()]) if (frame.parentFrameId === id) this.remove(frame.frameId)
    const frame = this.frames.get(id)
    if (frame) { frame.dispose(); frame.detached = true; this.frames.delete(id) }
    this.nodes.delete(id)
  }
  clear() { for (const id of [...this.frames.keys()]) this.remove(id); this.nodes.clear() }
  invalidateObservations() { for (const frame of this.frames.values()) { frame.observation = null; frame.chooser = null; frame.interceptFileChooser = this.root.interceptFileChooser } }
  detachSession(sessionId) { for (const frame of [...this.frames.values()]) if (frame.sessionId === sessionId) this.remove(frame.frameId) }
  current(frame) { return !this.root.disposed && !this.root.detached && !frame.disposed && !frame.detached && (frame === this.root || this.frames.get(frame.frameId) === frame) }
  async refresh() {
    if (!this.current(this.root)) unavailable()
    const nodes = new Map(), pending = [...this.sessions()].filter(entry => entry.type === 'iframe')
    const visit = (tree, sessionId, parentId) => {
      const frame = tree.frame
      nodes.set(frame.id, { ...frame, parentId: frame.parentId ?? parentId ?? null, sessionId })
      for (const child of tree.childFrames ?? []) visit(child, sessionId, frame.id)
    }
    visit((await this.root.send('Page.getFrameTree')).frameTree, this.root.sessionId)
    // An OOPIF tree may reveal further cross-process descendants.
    for (let changed = true; changed;) {
      changed = false
      for (let i = pending.length - 1; i >= 0; i--) {
        const entry = pending[i]
        const owner = this.frameOwner?.(entry.targetId)
        if (owner?.detached) continue
        const parentId = owner?.parentId
        if (!nodes.has(entry.targetId) && !nodes.has(parentId)) continue
        pending.splice(i, 1); changed = true
        await entry.ready
        if (![...this.sessions()].includes(entry)) continue
        const tree = await this.root.browser.send('Page.getFrameTree', {}, entry.sessionId)
        if (tree.frameTree.frame.id !== entry.targetId) continue
        visit(tree.frameTree, entry.sessionId, nodes.get(entry.targetId)?.parentId ?? parentId)
      }
    }
    for (const [id, frame] of this.frames) {
      const node = nodes.get(id)
      if (!node || frame.sessionId !== node.sessionId || frame.parentFrameId !== node.parentId || frame.loaderId !== node.loaderId || frame.disposed) this.remove(id)
    }
    this.nodes = nodes
    for (const [id, node] of nodes) {
      if (id === this.root.frameId) continue
      if (!this.frames.has(id)) {
        const frame = new AgentPage(this.root.browser, this.root.targetId, node.sessionId, { frameId: id, rootPage: this.root, parentFrameId: node.parentId })
        frame.loaderId = node.loaderId; frame.ready = Promise.resolve()
        this.frames.set(id, frame)
      }
      const frame = this.frames.get(id)
      frame.url = node.url; frame.frameName = node.name ?? ''; frame.interceptFileChooser = this.root.interceptFileChooser
    }
    return this.records()
  }
  records() {
    return [...this.nodes.values()].map(node => ({ frameId: node.id, parentFrameId: node.parentId, pageId: this.root.pageId,
      name: node.name ?? '', url: node.url ?? '', main: node.id === this.root.frameId }))
  }
  select(id) { const frame = id === undefined || id === this.root.frameId ? this.root : this.frames.get(id); if (!frame || !this.current(frame)) unavailable(); return frame }
  ancestors(frame) {
    const result = [], seen = new Set()
    while (frame !== this.root) {
      if (!this.current(frame) || seen.has(frame.frameId)) unavailable()
      seen.add(frame.frameId)
      if (!frame.parentFrameId) unavailable()
      const parent = this.select(frame.parentFrameId)
      result.push({ frame, parent }); frame = parent
    }
    return result
  }
  async ownerCall(frame, parent, fn, args) {
    if (!this.current(frame) || !this.current(parent)) unavailable()
    await parent.evaluate(() => true)
    const { backendNodeId } = await parent.send('DOM.getFrameOwner', { frameId: frame.frameId })
    const { object } = await parent.send('DOM.resolveNode', { backendNodeId, executionContextId: parent.world })
    if (!object?.objectId) unavailable()
    try {
      const functionDeclaration = `async function(...args) { ${assertFrameLayout.toString()}; assertFrameLayout(this); const result = await (${fn.toString()}).apply(this, args); assertFrameLayout(this); return result }`
      const result = await parent.send('Runtime.callFunctionOn', { objectId: object.objectId, functionDeclaration, arguments: [{ value: args }], awaitPromise: true, returnByValue: true })
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? 'Frame owner changed; observe again')
      if (!this.current(frame) || !this.current(parent)) unavailable()
      return result.result.value
    } finally { await parent.send('Runtime.releaseObject', { objectId: object.objectId }).catch(() => {}) }
  }
  async prepare(frame) {
    for (const { frame: child, parent } of this.ancestors(frame).reverse()) await this.ownerCall(child, parent, async function() {
      if (!this.isConnected || this.ownerDocument !== document) throw new Error('Frame owner is stale')
      this.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    })
  }
  async toRootPoint(frame, point) {
    const prepared = point
    for (const { frame: child, parent } of this.ancestors(frame)) point = await this.ownerCall(child, parent, function(point) {
      if (!this.isConnected || this.ownerDocument !== document) throw new Error('Frame owner is stale')
      const box = this.getBoundingClientRect(), style = getComputedStyle(this)
      const left = parseFloat(style.borderLeftWidth) + parseFloat(style.paddingLeft)
      const top = parseFloat(style.borderTopWidth) + parseFloat(style.paddingTop)
      const x = box.x + left + point.x, y = box.y + top + point.y
      if (!box.width || !box.height || x < 0 || y < 0 || x >= innerWidth || y >= innerHeight || x >= box.right || y >= box.bottom) throw new Error('Frame control is outside the visible viewport')
      let hit = document.elementFromPoint(x, y)
      while (hit?.shadowRoot?.elementFromPoint) { const inner = hit.shadowRoot.elementFromPoint(x, y); if (!inner || inner === hit) break; hit = inner }
      if (hit !== this) throw new Error('Frame is obscured')
      return { x, y }
    }, point)
    return { ...prepared, ...point }
  }
  dispose() { this.clear(); this.root.browser.off('protocol', this.listener) }
}

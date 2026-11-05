import { randomUUID } from 'node:crypto'
import { BrokerError } from './client.mjs'

const terminal = task => ['completed', 'cancelled'].includes(task.state)
const fail = message => { throw new BrokerError(message, 'INVALID_STATE') }

export async function requestHuman(broker, task, args, request) {
  if (terminal(task)) fail('Task already ended')
  const page = broker.page(task, args.pageId)
  const handoff = { id: randomUUID(), pageId: page.pageId, shown: false, visibility: {
    requested: args.showWindow === true, targetVisible: false, nativeWindowVerified: false, foregroundVerified: false
  } }
  task.handoff = handoff
  task.reason = args.reason
  broker.select(task, page)
  for (const current of broker.pages(task).values()) current.observation = null
  if (request) request.dispatched = true
  if (args.showWindow) {
    await broker.control(task, 'show', request)
    if (task.handoff === handoff && task.state === 'human') handoff.shown = true
  } else {
    const generation = task.controlGeneration = (task.controlGeneration ?? 0) + 1
    task.state = 'needs-human'
    await broker.serialize(task, async () => {
      if (generation !== task.controlGeneration || terminal(task)) return
      await broker.syncTaskFocus(task)
    }, request)
  }
  return broker.record(task)
}

export async function resumeHuman(broker, task, args, request) {
  const handoff = task.handoff
  if (args.userConfirmed !== true) fail('Wait for the user to confirm completion of the manual step')
  if (!handoff || handoff.id !== args.handoffId) fail('This handoff is no longer current; inspect the task before resuming')
  if (handoff.resuming || !['human', 'needs-human', 'paused'].includes(task.state)) fail('Task is not waiting for this human handoff')
  handoff.resuming = true
  try {
    await broker.control(task, 'resume', request)
    if (task.handoff === handoff && task.state === 'agent-active') task.handoff = null
    return broker.record(task)
  } finally {
    if (task.handoff === handoff) delete handoff.resuming
  }
}

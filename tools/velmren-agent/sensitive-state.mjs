import { randomUUID } from 'node:crypto'
import { BrokerError } from './client.mjs'

const fail = code => { throw new BrokerError('Sensitive output remains protected', code) }
export function beginSensitive(task, pages, { input = false } = {}) {
  if (!task.sensitive?.active) task.sensitive = { active: true, phaseId: randomUUID(), documents: new Map() }
  task.sensitiveHistory = true
  for (const page of pages) {
    if (input || !task.sensitive.documents.has(page.pageId)) task.sensitive.documents.set(page.pageId, page.documentId)
  }
  return sensitiveStatus(task)
}

export function sensitiveStatus(task, page) {
  if (!task.sensitiveHistory) return undefined
  return { active: task.sensitive?.active === true,
    ...(task.sensitive?.active ? { phaseId: task.sensitive.phaseId } : {}),
    ...(page?.documentId ? { documentId: page.documentId } : {}) }
}

export function rememberSensitiveDocument(task, page) {
  const phase = task.sensitive
  if (phase?.active && page?.documentId && !phase.documents.has(page.pageId)) phase.documents.set(page.pageId, page.documentId)
}

export function validateSensitiveEnd(task, pages, page, args) {
  const phase = task.sensitive
  if (!phase?.active || args.phaseId !== phase.phaseId) fail('SENSITIVE_PHASE_STALE')
  if (args.documentId !== page.documentId || !page.documentId) fail('SENSITIVE_DOCUMENT_CHANGED')
  if (pages.length !== 1 || pages[0] !== page || page.dialog) fail('SENSITIVE_DOCUMENTS_REMAIN')
  if (!phase.documents.has(page.pageId) || phase.documents.get(page.pageId) === page.documentId) fail('SENSITIVE_TRANSITION_REQUIRED')
  let origin
  try { origin = new URL(page.url).origin } catch { fail('SENSITIVE_ORIGIN_MISMATCH') }
  if (args.safeToReveal !== true || args.expectedOrigin !== origin) fail('SENSITIVE_ORIGIN_MISMATCH')
  return phase
}

export function clearSensitiveObservations(pages) {
  for (const current of pages) {
    current.observation = null; current.lastObservation = null; current.title = ''
    current.frames?.invalidateObservations()
  }
}

export function endSensitive(task, pages, page, args, { freshObservation = false } = {}) {
  const phase = validateSensitiveEnd(task, pages, page, args)
  // The caller explicitly identifies a safe new document. Navigation, popup
  // closure, and SPA route changes never remove protection by themselves.
  phase.active = false
  phase.documents.clear()
  if (!freshObservation) clearSensitiveObservations(pages)
  return sensitiveStatus(task, page)
}

import { randomUUID } from 'node:crypto'
import { BrokerError } from './client.mjs'

const fail = (code, reason) => { throw new BrokerError('Sensitive output remains protected', code, undefined, undefined,
  { diagnostic: { phase: 'validation', stage: 'sensitive_end', reason } }) }
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
  if (!phase?.active || args.phaseId !== phase.phaseId) fail('SENSITIVE_PHASE_STALE', 'phase-stale')
  if (args.documentId !== page.documentId || !page.documentId) fail('SENSITIVE_DOCUMENT_CHANGED', 'document-changed')
  if (pages.length !== 1 || pages[0] !== page) fail('SENSITIVE_DOCUMENTS_REMAIN', 'protected-documents-remain')
  if (page.dialog) fail('SENSITIVE_DOCUMENTS_REMAIN', 'dialog')
  if (!phase.documents.has(page.pageId)) fail('SENSITIVE_TRANSITION_REQUIRED', 'baseline-unavailable')
  if (phase.documents.get(page.pageId) === page.documentId) fail('SENSITIVE_TRANSITION_REQUIRED', 'new-document-required')
  let origin
  try { origin = new URL(page.url).origin } catch { fail('SENSITIVE_ORIGIN_MISMATCH', 'origin-mismatch') }
  if (args.safeToReveal !== true) fail('SENSITIVE_ORIGIN_MISMATCH', 'safe-reveal-required')
  if (args.expectedOrigin !== origin) fail('SENSITIVE_ORIGIN_MISMATCH', 'origin-mismatch')
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

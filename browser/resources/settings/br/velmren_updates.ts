/* Copyright (c) 2026 The Velmren Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { addWebUiListener, removeWebUiListener, sendWithPromise } from '//resources/js/cr.js'
import type { CrButtonElement } from '//resources/cr_elements/cr_button/cr_button.js'
import type { SettingsAboutPageElement } from '../about_page/about_page.js'

interface DeliveryStatus {
  supported: boolean
  phase: string
  availableVersion: string
  lastChecked: number
  relaunchBlocked: boolean
  errorCode?: string
}

const labels: Record<string, string> = {
  unknown: 'velmrenUpdateUnknownLabel', checking: 'velmrenUpdateCheckingLabel',
  available: 'velmrenUpdateAvailableLabel', downloading: 'velmrenUpdateDownloadingLabel',
  installing: 'velmrenUpdateInstallingLabel', ready: 'velmrenUpdateReadyLabel',
  'up-to-date': 'velmrenUpdateUpToDateLabel', error: 'velmrenUpdateErrorLabel'
}

class VelmrenUpdatesCard extends HTMLElement {
  host: SettingsAboutPageElement | null = null
  private listener: ReturnType<typeof addWebUiListener> | null = null
  private summary = document.createElement('p')
  private detail = document.createElement('p')
  private version = document.createElement('p')
  private checked = document.createElement('p')
  private checkButton: CrButtonElement = document.createElement('cr-button')
  private restartButton: CrButtonElement = document.createElement('cr-button')
  private built = false
  private generation = 0

  connectedCallback() {
    if (!this.host) return
    const generation = ++this.generation
    if (!this.built) {
      this.built = true
      this.style.cssText = 'display:block;padding:16px 0;border-top:1px solid var(--cr-separator-color);margin-top:16px'
      this.summary.setAttribute('role', 'status')
      this.summary.setAttribute('aria-live', 'polite')
      this.summary.style.fontWeight = '500'
      for (const line of [this.detail, this.version, this.checked]) line.className = 'secondary'
      const actions = document.createElement('div')
      actions.style.cssText = 'display:flex;gap:12px;flex-wrap:wrap;margin-top:16px'
      this.checkButton.textContent = this.host.i18n('velmrenUpdateCheckNow')
      this.restartButton.textContent = this.host.i18n('velmrenUpdateRelaunch')
      this.restartButton.classList.add('action-button')
      this.restartButton.hidden = true
      this.checkButton.addEventListener('click', () => {
        this.checkButton.disabled = true
        chrome.send('checkVelmrenUpdates')
      })
      this.restartButton.addEventListener('click', () => chrome.send('relaunchVelmrenForUpdate'))
      actions.append(this.checkButton, this.restartButton)
      this.append(this.summary, this.detail, this.version, this.checked, actions)
    }
    let receivedEvent = false
    this.listener = addWebUiListener('velmren-update-status-changed',
      (status: DeliveryStatus) => {
        if (generation !== this.generation) return
        receivedEvent = true
        this.renderStatus(status)
      })
    sendWithPromise<DeliveryStatus>('getVelmrenUpdateStatus')
      .then(status => {
        if (generation === this.generation && !receivedEvent) this.renderStatus(status)
      })
      .catch(() => {
        if (generation === this.generation && !receivedEvent) {
          this.renderStatus({ supported: false, phase: 'error',
            availableVersion: '', lastChecked: 0, relaunchBlocked: false })
        }
      })
  }

  disconnectedCallback() {
    ++this.generation
    if (this.listener) removeWebUiListener(this.listener)
    this.listener = null
  }

  private renderStatus(status: DeliveryStatus) {
    if (!this.host || !this.isConnected) return
    const phase = labels[status.phase] ? status.phase : 'unknown'
    const rejectedPayload = status.errorCode === 'activation-failed'
    this.summary.textContent = this.host.i18n(labels[phase])
    const busy = ['checking', 'available', 'downloading', 'installing'].includes(phase)
    const detailKey = phase === 'ready'
      ? (status.relaunchBlocked ? 'velmrenUpdateBlockedDetail' : 'velmrenUpdateReadyDetail')
      : busy ? 'velmrenUpdateBusyDetail'
      : phase === 'up-to-date' ? 'velmrenUpdateCurrentDetail'
      : rejectedPayload ? 'velmrenUpdateActivationErrorDetail'
      : phase === 'error' ? 'velmrenUpdateErrorDetail' : 'velmrenUpdateUnknownDetail'
    this.detail.textContent = this.host.i18n(detailKey)
    this.version.textContent = status.availableVersion
      ? `${this.host.i18n('velmrenUpdateVersionLabel')}: ${status.availableVersion}` : ''
    this.checked.textContent = status.lastChecked > 0
      ? `${this.host.i18n('velmrenUpdateLastChecked')}: ${new Intl.DateTimeFormat(
        undefined, { dateStyle: 'short', timeStyle: 'short' }).format(status.lastChecked)}` : ''
    this.checkButton.disabled = !status.supported || busy || rejectedPayload
    this.restartButton.hidden = phase !== 'ready'
    this.restartButton.disabled = status.relaunchBlocked || !status.supported
  }
}

customElements.define('velmren-updates-card', VelmrenUpdatesCard)

export function appendVelmrenUpdateCard(root: ShadowRoot, host: SettingsAboutPageElement) {
  if (root.querySelector('velmren-updates-card')) return
  const card = new VelmrenUpdatesCard()
  card.host = host
  root.querySelector('#release-notes')?.parentElement?.append(card)
}

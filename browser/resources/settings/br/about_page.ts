/* Copyright (c) 2020 The Brave Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { injectStyle } from '//resources/brave/lit_overriding.js'
import { css } from '//resources/lit/v3_0/lit.rollup.js'
import type { PropertyValues } from '//resources/lit/v3_0/lit.rollup.js'

import { SettingsAboutPageElement } from '../about_page/about_page.js'
// <if expr="not is_chromeos">
import { AboutPageBrowserProxyImpl } from '../about_page/about_page_browser_proxy.js'
// </if>
import { loadTimeData } from '../i18n_setup.js'

injectStyle(SettingsAboutPageElement, css`
  #release-notes {
    display: block;
    margin-inline-start: unset;
    text-decoration: none;
  }
`)

const buildBrowserVersionElement = (productVersion: string) => {
  const wrapper = document.createElement('div')
  wrapper.setAttribute('id', 'release-notes')
  wrapper.textContent = `Velmren Browser ${productVersion}`

  return wrapper
}

const buildChromiumVersionElement = (chromiumVersion: string) => {
  const chromiumElement = document.createElement('div')
  chromiumElement.classList.add("secondary")
  chromiumElement.textContent = `Chromium: ${chromiumVersion}`

  return chromiumElement
}

const modifyAboutPage = (root: ShadowRoot) => {
  if (!root.querySelector('#release-notes')) {
    const version =
      root.querySelector('#updateStatusMessage ~ .secondary')
    if (!version) {
      console.error('[Settings] Could not find version div')
      return
    }

    const browserVersionElement = buildBrowserVersionElement(
      loadTimeData.getString('velmrenProductVersion'))
    version.replaceWith(browserVersionElement)

    const chromiumVersionElement = buildChromiumVersionElement(
      loadTimeData.getString('velmrenChromiumVersion'))
    browserVersionElement.after(chromiumVersionElement)
  }

  // Help link shown if update fails
  const updateStatusMessageLink =
    root.querySelector<HTMLAnchorElement>('#updateStatusMessage a')
  if (updateStatusMessageLink) {
    updateStatusMessageLink.href = loadTimeData.getString('velmrenHelpUrl')
  }
}

// Reach upstream private/protected hooks through a typed view of the prototype.
const proto = SettingsAboutPageElement.prototype as unknown as {
  firstUpdated?: (changedProperties: PropertyValues) => void
  willUpdate: (changedProperties: PropertyValues) => void
  onHelpClick_: () => void
  startListening_: () => void
  getUpdateStatusMessage_: () => TrustedHTML
  shouldShowLearnMoreLink_: () => boolean
  shouldShowIcons_: () => boolean
  shouldShowThrobber_: () => boolean
  showUpdateStatus_: boolean
  showRelaunch_: boolean
  showButtonContainer_: boolean
}

proto.onHelpClick_ = () => {
  window.open(loadTimeData.getString('velmrenHelpUrl'), '_blank', 'noopener')
}

// <if expr="not is_chromeos">
if (loadTimeData.getBoolean('isVelmrenRelease')) {
  // Installed releases use VelmrenDelivery, not Omaha. Do not subscribe to or
  // request Omaha status, which cannot describe this installation's updates.
  AboutPageBrowserProxyImpl.prototype.pageReady = function() {}
  proto.startListening_ = function() {}
  proto.getUpdateStatusMessage_ = function(this: SettingsAboutPageElement) {
    return this.i18nAdvanced('velmrenAboutUpdates')
  }
  proto.shouldShowLearnMoreLink_ = () => false
  proto.shouldShowIcons_ = () => false
  proto.shouldShowThrobber_ = () => false

  const originalWillUpdate = proto.willUpdate
  proto.willUpdate = function(changedProperties: PropertyValues) {
    originalWillUpdate.call(this, changedProperties)
    // Apply before every render, including any late upstream status event.
    this.showUpdateStatus_ = true
    this.showRelaunch_ = false
    this.showButtonContainer_ = false
  }
}
// </if>

const originalFirstUpdated = proto.firstUpdated
proto.firstUpdated = function(
    this: SettingsAboutPageElement, changedProperties: PropertyValues) {
  originalFirstUpdated?.call(this, changedProperties)
  if (this.shadowRoot) {
    modifyAboutPage(this.shadowRoot)
  }
}

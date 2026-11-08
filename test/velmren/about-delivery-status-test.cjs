// Copyright (c) 2026 The Velmren Authors. All rights reserved.
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this file,
// You can obtain one at https://mozilla.org/MPL/2.0/.

// Runs the production override with upstream About code, its template and Lit.
// Native message delivery and settings services are faked; no browser is opened.
// Run from brave/: node test/velmren/about-delivery-status-test.cjs
// Add --typecheck to check against existing generated settings declarations.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { pathToFileURL } = require('node:url')
const { spawnSync } = require('node:child_process')
const { createHash } = require('node:crypto')
const ts = require('typescript')
const { JSDOM } = require('jsdom')

const brave = path.resolve(__dirname, '../..')
const chromium = path.dirname(brave)
const flags = {
  is_win: true,
  is_chromeos: false,
  is_macosx: false,
  _google_chrome: false,
  _is_chrome_for_testing_branded: false
}

function preprocess(source) {
  const enabled = [true]
  return source.split('\n').filter(line => {
    const start = line.match(/^\s*(?:\/\/\s*)?<if expr="([^"]+)">\s*$/)
    if (start) {
      const expression = start[1].replace(/\b\w+\b/g, token => {
        if (token === 'and') return '&&'
        if (token === 'or') return '||'
        if (token === 'not') return '!'
        assert.ok(Object.hasOwn(flags, token), `Unknown build flag ${token}`)
        return String(flags[token])
      })
      enabled.push(enabled.at(-1) && vm.runInNewContext(expression))
      return false
    }
    if (/^\s*(?:\/\/\s*)?<\/if>\s*$/.test(line)) {
      enabled.pop()
      return false
    }
    return enabled.at(-1)
  }).join('\n')
}

function loadTs(file, imports, transform = source => source) {
  const source = transform(preprocess(fs.readFileSync(file, 'utf8')))
  const result = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS },
    fileName: file,
    reportDiagnostics: true
  })
  assert.deepEqual(result.diagnostics, [], `TypeScript syntax: ${file}`)
  const module = { exports: {} }
  const script = new vm.Script(
    `(function(require, module, exports) { ${result.outputText}\n})`,
    { filename: file })
  script.runInThisContext()(specifier => {
    assert.ok(Object.hasOwn(imports, specifier), `Unmapped import: ${specifier}`)
    return imports[specifier]
  }, module, module.exports)
  return module.exports
}

async function runCase(installed, locale) {
  const dom = new JSDOM('', { url: 'https://settings.test/' })
  for (const key of ['window', 'document', 'customElements', 'HTMLElement',
    'Element', 'Node', 'ShadowRoot', 'Document', 'CSSStyleSheet', 'CustomEvent']) {
    globalThis[key] = dom.window[key]
  }
  const lit = await import(pathToFileURL(path.join(chromium,
    'third_party/node/node_modules/lit/index.js')).href)
  const { CrLitElement } = loadTs(path.join(chromium,
    'third_party/lit/v3_0/cr_lit_element.ts'), { 'lit/index.js': lit })
  const litModule = { ...lit, CrLitElement }
  const parseXml = source => new dom.window.DOMParser()
    .parseFromString(source, 'text/xml')
  const localized = (name, sourceFile = 'brave_settings_strings.grdp',
    bundle = 'brave_generated_resources') => {
    const english = parseXml(fs.readFileSync(
      path.join(brave, 'app', sourceFile), 'utf8'))
    const translated = locale === 'en' ? null : parseXml(fs.readFileSync(
      path.join(brave, `app/resources/${bundle}_${locale}.xtb`), 'utf8'))
    const source = english.querySelector(`[name="${name}"]`)
    assert.ok(source, `Missing source string ${name}`)
    const parts = (element, placeholder) => Array.from(element.childNodes)
      .map(node => node.nodeType === 3 ? node.textContent : placeholder(node))
      .join('').trim().replace(/\s+/g, ' ')
    // GRIT IDs hash presentable content: placeholders use their names.
    const presentable = parts(source, node => node.getAttribute('name'))
    const digest = createHash('md5').update(presentable).digest('hex')
    const id = String(BigInt(`0x${digest.slice(0, 16)}`) & 0x7fffffffffffffffn)
    const translation = translated?.querySelector(`[id="${id}"]`)
    if (locale === 'ru') assert.ok(translation, `Missing Russian ${name}`)
    if (locale === 'fr') assert.equal(translation, null, `Expected fallback ${name}`)
    const placeholders = Object.fromEntries(Array.from(source.children)
      .filter(node => node.tagName === 'ph')
      .map(node => [node.getAttribute('name'), parts(node, () => '')]))
    return parts(translation ?? source, node => placeholders[node.getAttribute('name')])
  }
  const guidance = localized('IDS_SETTINGS_VELMREN_ABOUT_UPDATES')
  const provider = fs.readFileSync(path.join(brave,
    'browser/ui/webui/settings/brave_settings_localized_strings_provider.cc'), 'utf8')
  const cppString = name => {
    const match = provider.match(new RegExp(`${name}\\[\\]\\s*=\\s*((?:u?"[^"\\n]*"\\s*)+);`))
    assert.ok(match, `Missing native URL constant ${name}`)
    return Array.from(match[1].matchAll(/u?("[^"\n]*")/g),
      part => JSON.parse(part[1])).join('')
  }
  const sourceUrl = cppString('kVelmrenSourceUrl')
  const buildUrl = cppString('kVelmrenBuildInstructionsUrl')
  const helpUrl = cppString(locale === 'ru' ? 'kVelmrenHelpRuUrl' : 'kVelmrenHelpUrl')
  const licenseUrls = [cppString('kVelmrenLicenseUrl'), 'chrome://credits/',
    buildUrl, sourceUrl]
  const strings = {
    isVelmrenRelease: installed,
    velmrenProductVersion: installed ? '0.1.0.4' : 'Development build',
    velmrenChromiumVersion: '156.0.8111.0',
    velmrenAboutUpdates: guidance,
    velmrenHelpUrl: helpUrl,
    aboutProductTitle: 'Velmren Browser',
    aboutProductCopyright: localized('IDS_ABOUT_VERSION_COPYRIGHT',
      'brave_strings.grd', 'brave_strings')
      .replace('{0,date,y}', '2026'),
    aboutProductLicense: localized('IDS_BRAVE_VERSION_UI_LICENSE',
      'brave_generated_resources.grd')
      .replace(/\$(\d)/g, (_, number) => licenseUrls[Number(number) - 1]),
    aboutGetHelpUsingChrome: localized('IDS_SETTINGS_GET_HELP_USING_CHROME',
      'settings_brave_strings.grdp', 'brave_strings'),
    isManaged: false,
    managedByIcon: '',
    aboutObsoleteNowOrSoon: false,
    aboutObsoleteEndOfTheLine: false,
    aboutBrowserVersion: 'Upstream version',
    aboutUpgradeCheckStarted: 'Checking for updates',
    aboutUpgradeRelaunch: 'Relaunch to finish updating',
    aboutUpgradeUpToDate: 'Browser is up to date',
    aboutUpgradeUpdating: 'Updating',
    aboutUpgradeUpdatingPercent: 'Updating $1'
  }
  // Consume the native provider's real string registrations, including locale
  // fallback, so an omitted WebUI resource does not get hidden by this fake.
  for (const match of provider.matchAll(
    /AddLocalizedString\("(velmrenUpdate\w+)",\s*(IDS_\w+)\)/g)) {
    strings[match[1]] = localized(match[2])
  }
  const loadTimeData = {
    getBoolean: key => {
      assert.equal(typeof strings[key], 'boolean', `Boolean key ${key}`)
      return strings[key]
    },
    getString: key => {
      assert.equal(typeof strings[key], 'string', `String key ${key}`)
      return strings[key]
    }
  }
  const messages = []
  const opened = []
  dom.window.open = (...args) => opened.push(args)
  const listeners = new Map()
  const deliveryListeners = new Map()
  const removedListeners = []
  const requests = []
  let listenerId = 0
  globalThis.chrome = { send: message => messages.push(message) }
  // Match Chromium cr-button's disabled-click suppression. Its layout/ripple
  // dependencies are outside the update card's behavior under test.
  customElements.define('cr-button', class extends HTMLElement {
    disabled = false
    constructor() {
      super()
      this.addEventListener('click', event => {
        if (this.disabled) event.stopImmediatePropagation()
      })
    }
  })
  const proxy = loadTs(path.join(chromium,
    'chrome/browser/resources/settings/about_page/about_page_browser_proxy.ts'), {})
  const imports = {
    '//resources/lit/v3_0/lit.rollup.js': litModule,
    'chrome://resources/lit/v3_0/lit.rollup.js': litModule,
    '../i18n_setup.js': { loadTimeData },
    '//resources/js/cr.js': {
      addWebUiListener: (eventName, callback) => {
        const listener = { eventName, uid: ++listenerId }
        deliveryListeners.set(listener, callback)
        return listener
      },
      removeWebUiListener: listener => {
        assert.ok(deliveryListeners.has(listener), 'Remove the registered listener')
        removedListeners.push(listener)
        return deliveryListeners.delete(listener)
      },
      sendWithPromise: message => {
        messages.push(message)
        return new Promise((resolve, reject) => requests.push({ resolve, reject }))
      }
    },
    './about_page_browser_proxy.js': proxy,
    '../about_page/about_page_browser_proxy.js': proxy,
    '../relaunch_mixin_lit.js': {
      RestartType: { RELAUNCH: 'relaunch' },
      RelaunchMixinLit: Base => class extends Base {
        shouldShowRelaunchDialog = false
        performRestart(type) { messages.push(type) }
      }
    },
    '/shared/settings/prefs2/pref_service_observer_mixin_lit.js': {
      PrefServiceObserverMixinLit: Base => Base
    },
    'chrome://resources/cr_elements/i18n_mixin_lit.js': {
      I18nMixinLit: Base => class extends Base {
        i18n(key) { return loadTimeData.getString(key) }
        i18nAdvanced(key) { return loadTimeData.getString(key) }
      }
    },
    'chrome://resources/cr_elements/web_ui_listener_mixin_lit.js': {
      WebUiListenerMixinLit: Base => class extends Base {
        addWebUiListener(name, callback) { listeners.set(name, callback) }
        disconnectedCallback() {
          super.disconnectedCallback()
          listeners.clear()
        }
      }
    },
    'chrome://resources/js/assert.js': { assert: value => assert.ok(value) },
    'chrome://resources/js/parse_html_subset.js': {
      sanitizeInnerHtml: value => value
    },
    './about_page.css.js': { getCss: () => [] }
  }
  for (const specifier of ['/shared/settings/prefs/prefs.js',
    '../relaunch_confirmation_dialog.js', '../settings_page/settings_section.js',
    'chrome://resources/cr_elements/cr_button/cr_button.js',
    'chrome://resources/cr_elements/cr_icon_button/cr_icon_button.js',
    'chrome://resources/cr_elements/cr_icon/cr_icon.js',
    'chrome://resources/cr_elements/cr_link_row/cr_link_row.js',
    'chrome://resources/cr_elements/icons.html.js']) {
    imports[specifier] = {}
  }
  imports['./about_page.html.js'] = loadTs(path.join(chromium,
    'chrome/browser/resources/settings/about_page/about_page.html.ts'), imports,
    source => source.replace(/\$i18n(?:Raw|Polymer)?\{([^}]+)\}/g,
      (_, key) => strings[key] ?? key))
  const pageModule = loadTs(path.join(chromium,
    'chrome/browser/resources/settings/about_page/about_page.ts'), imports)
  imports['../about_page/about_page.js'] = pageModule
  imports['//resources/brave/lit_overriding.js'] = loadTs(path.join(brave,
    'ui/webui/resources/lit_overriding.ts'), imports)
  imports['./velmren_updates.js'] = loadTs(path.join(brave,
    'browser/resources/settings/br/velmren_updates.ts'), imports)
  loadTs(path.join(brave, 'browser/resources/settings/br/about_page.ts'), imports)

  const page = document.createElement('settings-about-page')
  const visible = selector => {
    const element = page.shadowRoot.querySelector(selector)
    return element && !element.closest('[hidden]')
  }
  const assertIdentity = () => {
    const info = page.shadowRoot.querySelector('.info-sections')
    assert.ok(info.textContent.includes(strings.aboutProductCopyright))
    assert.ok(info.textContent.includes('Brave'))
    assert.ok(info.textContent.includes('Chromium'))
    assert.ok(!info.textContent.includes('Brave Software Inc'))
    assert.deepEqual(Array.from(info.querySelectorAll('a'), a => a.href),
      licenseUrls)
    assert.equal(page.shadowRoot.querySelector('.product-title').textContent,
      'Velmren Browser')
    assert.equal(page.shadowRoot.querySelector('#help').getAttribute('label'),
      locale === 'ru' ? 'Справка Velmren' : 'Velmren help')
    assert.equal(page.shadowRoot.querySelector('#updateStatusMessage a').href,
      helpUrl)
  }
  const assertInstalled = () => {
    assertIdentity()
    assert.ok(visible('#updateStatusMessage'))
    assert.equal(page.shadowRoot.querySelector('#updateStatusMessage [role="alert"]')
      .textContent, guidance)
    for (const selector of ['#updateStatusMessage a', '.icon-container',
      '#throbber', '#relaunch', '#buttonContainer', '.separator']) {
      assert.ok(!visible(selector), `Misleading update UI visible: ${selector}`)
    }
    assert.equal(page.shadowRoot.querySelectorAll('#release-notes').length, 1)
    assert.equal(page.shadowRoot.querySelector('#release-notes').textContent,
      'Velmren Browser 0.1.0.4')
    assert.ok(page.shadowRoot.textContent.includes('Chromium: 156.0.8111.0'))
    assert.ok(messages.every(message => message !== 'aboutPageReady'
      && message !== 'refreshUpdateStatus'), 'Installed builds never request Omaha')
    assert.equal(listeners.size, 0)
    assert.equal(page.shadowRoot.querySelectorAll('velmren-updates-card').length, 1)
  }
  document.body.append(page)
  if (installed) assertInstalled() // CrLitElement renders synchronously on connect.
  await page.updateComplete
  assertIdentity()
  page.shadowRoot.querySelector('#help').click()
  assert.deepEqual(opened, [[helpUrl, '_blank', 'noopener']])
  if (installed) {
    assertInstalled()
    for (const status of Object.values(proxy.UpdateStatus)) {
      // Even a late callback captured before the override cannot change the UI.
      page.onUpdateStatusChanged_({ status, progress: 50,
        message: 'Omaha error 1:0X80004005' })
      await page.updateComplete
      assertInstalled()
    }
    await assertDeliveryCard()
  } else {
    assert.deepEqual(messages, ['aboutPageReady', 'refreshUpdateStatus'])
    assert.equal(listeners.size, 1)
    listeners.get('update-status-changed')({ status: proxy.UpdateStatus.FAILED,
      message: 'Actual development updater failure' })
    await page.updateComplete
    assert.ok(visible('#updateStatusMessage a'))
    assert.equal(page.shadowRoot.querySelector('#updateStatusMessage [role="alert"]')
      .textContent, 'Actual development updater failure')
    assert.equal(page.shadowRoot.querySelector('#release-notes').textContent,
      'Velmren Browser Development build')
    assertIdentity()
    assert.equal(page.shadowRoot.querySelector('velmren-updates-card'), null)
    assert.equal(deliveryListeners.size, 0)
    assert.equal(requests.length, 0)
  }
  console.log(`PASS ${installed ? 'installed' : 'development'} ${locale}`)
  dom.window.close()

  async function assertDeliveryCard() {
    const failures = []
    const check = async (name, test) => {
      try {
        await test()
        console.log(`PASS ${locale}: ${name}`)
      } catch (error) {
        failures.push(name)
        console.error(`FAIL ${locale}: ${name}\n${error.stack}`)
      }
    }
    const card = page.shadowRoot.querySelector('velmren-updates-card')
    const [summary, detail, version, checked] = card.querySelectorAll('p')
    const [checkButton, restartButton] = card.querySelectorAll('cr-button')
    const status = (phase, overrides = {}) => ({
      supported: true, phase, installedVersion: '0.1.0.4',
      availableVersion: '', lastChecked: 0, relaunchBlocked: false,
      errorCode: '', ...overrides
    })
    const deliver = value => {
      assert.equal(deliveryListeners.size, 1, 'One active native listener')
      const [[listener, callback]] = deliveryListeners
      assert.equal(listener.eventName, 'velmren-update-status-changed')
      callback(value)
    }
    const initialRequest = requests[0]
    assert.ok(initialRequest, 'Fetch native status on mount')
    assert.deepEqual(messages, ['getVelmrenUpdateStatus'])
    initialRequest.resolve(status('unknown'))
    await Promise.resolve()
    await check('accessible native status and localized controls', () => {
      assert.equal(summary.getAttribute('role'), 'status')
      assert.equal(summary.getAttribute('aria-live'), 'polite')
      assert.equal(checkButton.textContent, strings.velmrenUpdateCheckNow)
      assert.equal(restartButton.textContent, strings.velmrenUpdateRelaunch)
    })
    const phases = [
      ['unknown', 'Unknown', 'Unknown', false],
      ['checking', 'Checking', 'Busy', true],
      ['available', 'Available', 'Busy', true],
      ['downloading', 'Downloading', 'Busy', true],
      ['installing', 'Installing', 'Busy', true],
      ['ready', 'Ready', 'Ready', false],
      ['up-to-date', 'UpToDate', 'Current', false],
      ['error', 'Error', 'Error', false]
    ]
    for (const [phase, label, explanation, busy] of phases) {
      await check(`${phase} native event`, () => {
        deliver(status(phase))
        assert.equal(summary.textContent, strings[`velmrenUpdate${label}Label`])
        assert.equal(detail.textContent, strings[`velmrenUpdate${explanation}Detail`])
        assert.equal(checkButton.disabled, busy)
        assert.equal(restartButton.hidden, phase !== 'ready')
        if (phase === 'ready') assert.equal(restartButton.disabled, false)
        assert.equal(version.textContent, '')
        assert.equal(checked.textContent, '')
        assertInstalled()
      })
    }
    await check('available version and real last-check timestamp', () => {
      const lastChecked = Date.UTC(2026, 10, 8, 12, 34)
      deliver(status('available', { availableVersion: '0.1.0.5', lastChecked }))
      assert.equal(version.textContent, `${strings.velmrenUpdateVersionLabel}: 0.1.0.5`)
      const formatted = new Intl.DateTimeFormat(undefined,
        { dateStyle: 'short', timeStyle: 'short' }).format(lastChecked)
      assert.equal(checked.textContent, `${strings.velmrenUpdateLastChecked}: ${formatted}`)
      deliver(status('unknown'))
      assert.equal(version.textContent, '', 'Clear a previous available version')
      assert.equal(checked.textContent, '', 'Do not invent a successful check')
    })
    await check('unknown phase stays truthful', () => {
      deliver(status('future-native-phase'))
      assert.equal(summary.textContent, strings.velmrenUpdateUnknownLabel)
      assert.equal(detail.textContent, strings.velmrenUpdateUnknownDetail)
      assert.equal(restartButton.hidden, true)
    })
    await check('Check now sends native action once while pending', () => {
      deliver(status('unknown'))
      const before = messages.length
      checkButton.click()
      assert.deepEqual(messages.slice(before), ['checkVelmrenUpdates'])
      assert.equal(checkButton.disabled, true)
      checkButton.click()
      assert.equal(messages.length, before + 1)
      deliver(status('checking'))
      assert.equal(checkButton.disabled, true)
      deliver(status('error'))
      assert.equal(checkButton.disabled, false, 'A failed check allows retry')
    })
    await check('restart is offered only when ready and unblocked', () => {
      const before = messages.length
      deliver(status('ready', { relaunchBlocked: true }))
      assert.equal(restartButton.hidden, false)
      assert.equal(restartButton.disabled, true)
      assert.equal(detail.textContent, strings.velmrenUpdateBlockedDetail)
      restartButton.click()
      assert.equal(messages.length, before)
      deliver(status('ready'))
      assert.equal(restartButton.disabled, false)
      restartButton.click()
      assert.deepEqual(messages.slice(before), ['relaunchVelmrenForUpdate'])
      deliver(status('up-to-date'))
      assert.equal(restartButton.hidden, true)
    })
    await check('unsupported installations disable update actions', () => {
      const before = messages.length
      deliver(status('unknown', { supported: false }))
      assert.equal(checkButton.disabled, true)
      assert.equal(restartButton.hidden, true)
      checkButton.click()
      deliver(status('ready', { supported: false }))
      assert.equal(restartButton.disabled, true)
      restartButton.click()
      assert.equal(messages.length, before)
    })
    await check('native diagnostic errors never appear as HTML or raw paths', () => {
      const diagnostic = '<img src=x onerror=alert(1)> E:\\private\\secret token=123'
      deliver(status('error', { errorCode: diagnostic, message: diagnostic }))
      assert.equal(detail.textContent, strings.velmrenUpdateErrorDetail)
      assert.ok(!card.textContent.includes(diagnostic))
      assert.equal(card.querySelector('img'), null)
    })
    await check('failed activation explains recovery and prevents retrying rejected payload', () => {
      assert.equal(typeof strings.velmrenUpdateActivationErrorDetail, 'string',
        'Native provider registers activation failure explanation')
      deliver(status('error', { errorCode: 'activation-failed' }))
      assert.equal(detail.textContent, strings.velmrenUpdateActivationErrorDetail)
      assert.equal(checkButton.disabled, true)
      assert.equal(restartButton.hidden, true)
    })
    await check('disconnect removes listener and ignores late promise completion', async () => {
      // Reconnect once to leave a fresh initial request pending.
      page.remove()
      assert.equal(deliveryListeners.size, 0)
      document.body.append(page)
      await page.updateComplete
      assert.equal(deliveryListeners.size, 1)
      const pending = requests.at(-1)
      deliver(status('unknown'))
      const previousContent = card.textContent
      page.remove()
      assert.equal(deliveryListeners.size, 0)
      pending.resolve(status('ready', { availableVersion: '0.1.0.5' }))
      await Promise.resolve()
      assert.equal(card.textContent, previousContent,
        'A disconnected card ignores its pending response')
      document.body.append(page)
      await page.updateComplete
      requests.at(-1).resolve(status('unknown'))
      await Promise.resolve()
      assertInstalled()
      assert.equal(deliveryListeners.size, 1)
      assert.equal(card.querySelectorAll('cr-button').length, 2,
        'Reconnect does not duplicate controls or click handlers')
      assert.ok(removedListeners.length >= 2)
    })
    await check('a prior mount response cannot overwrite the current mount', async () => {
      page.remove()
      document.body.append(page)
      await page.updateComplete
      const obsolete = requests.at(-1)
      page.remove()
      document.body.append(page)
      await page.updateComplete
      requests.at(-1).resolve(status('ready', { availableVersion: '0.1.0.5' }))
      await Promise.resolve()
      assert.equal(summary.textContent, strings.velmrenUpdateReadyLabel)
      obsolete.resolve(status('unknown'))
      await Promise.resolve()
      assert.equal(summary.textContent, strings.velmrenUpdateReadyLabel,
        'A response for the old connection cannot erase current ready state')
    })
    await check('a prior mount rejection or captured callback cannot overwrite current status', async () => {
      page.remove()
      document.body.append(page)
      await page.updateComplete
      const obsolete = requests.at(-1)
      const obsoleteCallback = Array.from(deliveryListeners.values())[0]
      page.remove()
      document.body.append(page)
      await page.updateComplete
      requests.at(-1).resolve(status('ready', { availableVersion: '0.1.0.5' }))
      await Promise.resolve()
      obsoleteCallback(status('error'))
      obsolete.reject(new Error('obsolete native request'))
      await Promise.resolve()
      await Promise.resolve()
      assert.equal(summary.textContent, strings.velmrenUpdateReadyLabel)
      assert.equal(restartButton.hidden, false)
      assert.equal(restartButton.disabled, false)
    })
    await check('a current-mount snapshot or rejection cannot erase a newer native event', async () => {
      for (const reject of [false, true]) {
        page.remove()
        document.body.append(page)
        await page.updateComplete
        const pending = requests.at(-1)
        deliver(status('ready', { availableVersion: '0.1.0.5' }))
        if (reject) pending.reject(new Error('obsolete snapshot diagnostics'))
        else pending.resolve(status('unknown'))
        await Promise.resolve()
        await Promise.resolve()
        assert.equal(summary.textContent, strings.velmrenUpdateReadyLabel)
        assert.equal(version.textContent, `${strings.velmrenUpdateVersionLabel}: 0.1.0.5`)
        assert.equal(restartButton.hidden, false)
        assert.equal(restartButton.disabled, false)
      }
    })
    await check('rejected initial native request has a safe error state', async () => {
      page.remove()
      document.body.append(page)
      await page.updateComplete
      requests.at(-1).reject(new Error('private native diagnostics'))
      await Promise.resolve()
      await Promise.resolve()
      assert.equal(summary.textContent, strings.velmrenUpdateErrorLabel)
      assert.equal(detail.textContent, strings.velmrenUpdateErrorDetail)
      assert.equal(checkButton.disabled, true)
      assert.equal(restartButton.hidden, true)
      assert.ok(!card.textContent.includes('private native diagnostics'))
    })
    page.remove()
    assert.equal(deliveryListeners.size, 0)
    assert.equal(listeners.size, 0)
    assert.equal(failures.length, 0, `Failed behavioral checks: ${failures.join(', ')}`)
  }
}

if (process.argv[2] === '--typecheck') {
  const configPath = path.join(chromium,
    'out/Release/gen/chrome/browser/resources/settings/tsconfig_build_ts.json')
  const config = ts.readConfigFile(configPath, ts.sys.readFile)
  assert.equal(config.error, undefined)
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys,
    path.dirname(configPath))
  assert.deepEqual(parsed.errors, [])
  const targets = ['about_page.ts', 'velmren_updates.ts'].map(name =>
    path.join(path.dirname(configPath), 'preprocessed/br', name))
  const sources = new Map(targets.map(target => [path.resolve(target),
    preprocess(fs.readFileSync(path.join(brave,
      'browser/resources/settings/br', path.basename(target)), 'utf8'))]))
  const options = { ...parsed.options, noEmit: true, incremental: false,
    composite: false, tsBuildInfoFile: undefined,
    paths: { ...parsed.options.paths,
      'lit/*': [path.join(chromium, 'third_party/node/node_modules/lit/*')],
      'lit-html/*': [path.join(chromium, 'third_party/node/node_modules/lit-html/*')]
    }
  }
  const host = ts.createCompilerHost(options)
  const originalReadFile = host.readFile
  const originalFileExists = host.fileExists
  host.fileExists = file => sources.has(path.resolve(file)) || originalFileExists(file)
  host.readFile = file => sources.get(path.resolve(file)) ?? originalReadFile(file)
  const declarations = parsed.fileNames.filter(file => file.endsWith('.d.ts'))
  const program = ts.createProgram([...targets, ...declarations], options, host)
  const diagnostics = ts.getPreEmitDiagnostics(program)
  if (diagnostics.length) {
    console.error(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
      getCanonicalFileName: file => file,
      getCurrentDirectory: () => brave,
      getNewLine: () => '\n'
    }))
    process.exitCode = 1
  } else {
    console.log('PASS TypeScript semantic check (no emit)')
  }
} else if (process.argv[2] === '--case') {
  runCase(process.argv[3] === 'installed', process.argv[4]).catch(error => {
    console.error(error)
    process.exitCode = 1
  })
} else {
  let failures = 0
  for (const [mode, locale] of [['installed', 'en'], ['installed', 'ru'],
    ['installed', 'fr'],
    ['development', 'en']]) {
    const result = spawnSync(process.execPath,
      ['--conditions=browser', __filename, '--case', mode, locale],
      { stdio: 'inherit' })
    if (result.status !== 0) {
      failures++
      console.error(`FAIL ${mode} ${locale}`)
    }
  }
  process.exitCode = failures ? 1 : 0
}

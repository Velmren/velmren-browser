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
  const english = parseXml(fs.readFileSync(path.join(brave,
    'app/brave_settings_strings.grdp'), 'utf8'))
    .querySelector('[name="IDS_SETTINGS_VELMREN_ABOUT_UPDATES"]')
    .textContent.trim()
  const russian = parseXml(fs.readFileSync(path.join(brave,
    'app/resources/brave_generated_resources_ru.xtb'), 'utf8'))
    .querySelector('[id="6293525090265146150"]').textContent
  const guidance = locale === 'ru' ? russian : english
  const strings = {
    isVelmrenRelease: installed,
    velmrenProductVersion: installed ? '0.1.0.4' : 'Development build',
    velmrenChromiumVersion: '156.0.8111.0',
    velmrenAboutUpdates: guidance,
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
  const listeners = new Map()
  globalThis.chrome = { send: message => messages.push(message) }
  const proxy = loadTs(path.join(chromium,
    'chrome/browser/resources/settings/about_page/about_page_browser_proxy.ts'), {})
  const imports = {
    '//resources/lit/v3_0/lit.rollup.js': litModule,
    'chrome://resources/lit/v3_0/lit.rollup.js': litModule,
    '../i18n_setup.js': { loadTimeData },
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
  loadTs(path.join(brave, 'browser/resources/settings/br/about_page.ts'), imports)

  const page = document.createElement('settings-about-page')
  const visible = selector => {
    const element = page.shadowRoot.querySelector(selector)
    return element && !element.closest('[hidden]')
  }
  const assertInstalled = () => {
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
    assert.deepEqual(messages, [])
    assert.equal(listeners.size, 0)
  }
  document.body.append(page)
  if (installed) assertInstalled() // CrLitElement renders synchronously on connect.
  await page.updateComplete
  if (installed) {
    assertInstalled()
    for (const status of Object.values(proxy.UpdateStatus)) {
      // Even a late callback captured before the override cannot change the UI.
      page.onUpdateStatusChanged_({ status, progress: 50,
        message: 'Omaha error 1:0X80004005' })
      await page.updateComplete
      assertInstalled()
    }
    page.remove()
    document.body.append(page)
    await page.updateComplete
    assertInstalled()
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
  }
  console.log(`PASS ${installed ? 'installed' : 'development'} ${locale}`)
  dom.window.close()
}

if (process.argv[2] === '--typecheck') {
  const configPath = path.join(chromium,
    'out/Release/gen/chrome/browser/resources/settings/tsconfig_build_ts.json')
  const config = ts.readConfigFile(configPath, ts.sys.readFile)
  assert.equal(config.error, undefined)
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys,
    path.dirname(configPath))
  assert.deepEqual(parsed.errors, [])
  const target = path.join(path.dirname(configPath), 'preprocessed/br/about_page.ts')
  const source = preprocess(fs.readFileSync(path.join(brave,
    'browser/resources/settings/br/about_page.ts'), 'utf8'))
  const options = { ...parsed.options, noEmit: true, incremental: false,
    composite: false, tsBuildInfoFile: undefined,
    paths: { ...parsed.options.paths,
      'lit/*': [path.join(chromium, 'third_party/node/node_modules/lit/*')],
      'lit-html/*': [path.join(chromium, 'third_party/node/node_modules/lit-html/*')]
    }
  }
  const host = ts.createCompilerHost(options)
  const originalReadFile = host.readFile
  host.readFile = file => path.resolve(file) === target
    ? source : originalReadFile(file)
  const declarations = parsed.fileNames.filter(file => file.endsWith('.d.ts'))
  const program = ts.createProgram([target, ...declarations], options, host)
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
  for (const [mode, locale] of [['installed', 'en'], ['installed', 'ru'],
    ['development', 'en']]) {
    const result = spawnSync(process.execPath,
      ['--conditions=browser', __filename, '--case', mode, locale],
      { stdio: 'inherit' })
    assert.equal(result.status, 0, `${mode} ${locale} failed`)
  }
}

import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { documentRoots, elementName, visibleDocumentText, observeDocument, listSelectOptions } from '../document-observation.mjs'

function fixture(count = 220) {
  const document = { body: { innerText: 'Start '.repeat(3000) + 'End of fixture' }, title: 'Fixture' }
  const elements = Array.from({ length: count }, (_, index) => ({
    name: `Control ${index + 1}`, tagName: 'INPUT', type: 'text', value: '', labels: [], isConnected: true, ownerDocument: document,
    getRootNode: () => document,
    getAttribute(name) { return name === 'aria-label' ? this.name : null }
  }))
  document.querySelectorAll = () => elements
  const context = vm.createContext({ document, location: { href: 'http://fixture/' },
    elementCapabilities: () => ({ hidden: false, disabled: false, fileInput: false, availableActions: ['fill'] }),
    fieldMetadata: () => ({}), MutationObserver: class { observe() {} disconnect() {} } })
  for (const fn of [documentRoots, elementName, visibleDocumentText, observeDocument, listSelectOptions]) vm.runInContext(`const ${fn.name} = ${fn.toString()}`, context)
  const run = (name, args = {}) => vm.runInContext(`${name}(${JSON.stringify(args)})`, context)
  return { run, context, elements }
}

test('search and offsets expose controls past 150 and replace only the current observation refs', () => {
  const f = fixture()
  const first = f.run('observeDocument')
  assert.equal(first.elements.length, 150); assert.equal(first.pagination.nextOffset, 150)
  const second = f.run('observeDocument', { offset: first.pagination.nextOffset })
  assert.equal(second.elements.length, 70); assert.equal(second.elements[0].name, 'Control 151')
  assert.equal(second.pagination.nextOffset, null)
  assert.equal(f.context.__velmrenAgent.refs.get('e1'), f.elements[150])
  const search = f.run('observeDocument', { query: 'cOnTrOl 180' })
  assert.equal(search.elements.length, 1); assert.equal(search.elements[0].name, 'Control 180')
  assert.equal(search.pagination.total, 1)
  assert.equal(f.context.__velmrenAgent.refs.get('e1'), f.elements[179])
})

test('text offsets reach the end without returning unbounded text', () => {
  const f = fixture(1)
  const first = f.run('observeDocument', { textLimit: 1000 })
  assert.equal(first.text.length, 1000); assert.equal(first.textPagination.nextOffset, 1000)
  const tail = f.run('observeDocument', { textOffset: first.textPagination.total - 200, textLimit: 1000 })
  assert.match(tail.text, /End of fixture$/); assert.equal(tail.text.length, 200)
  assert.equal(tail.textPagination.nextOffset, null)
})

test('search does not inspect private field values and read-only observations preserve retained refs', () => {
  const f = fixture(2)
  Object.assign(f.elements[0], { type: 'password', value: 'SecretNeedle123', name: 'Private field' })
  f.run('observeDocument')
  const refs = f.context.__velmrenAgent.refs
  const none = f.run('observeDocument', { query: 'SecretNeedle123', readOnly: true })
  assert.equal(none.elements.length, 0); assert.equal(f.context.__velmrenAgent.refs, refs)
  const password = f.run('observeDocument', { query: 'Private field' })
  assert.equal(password.elements[0].value, '[redacted]')
  assert.ok(!JSON.stringify(password).includes('SecretNeedle123'))
})

test('option pagination and search return full values and reject stale observations', () => {
  const f = fixture(1)
  const longValue = 'country-200-' + 'x'.repeat(400)
  Object.assign(f.elements[0], { tagName: 'SELECT', type: 'select-one', options: Array.from({ length: 200 }, (_, index) => ({
    value: index === 199 ? longValue : String(index + 1), label: `Country ${index + 1}`, selected: index === 199, disabled: false
  })) })
  f.run('observeDocument')
  const final = f.run('listSelectOptions', { ref: 'e1', revision: 0, offset: 150 })
  assert.equal(final.options.length, 50); assert.equal(final.pagination.nextOffset, null)
  assert.equal(final.options[49].value, longValue); assert.equal(final.options[49].selected, true)
  const search = f.run('listSelectOptions', { ref: 'e1', revision: 0, query: 'Country 200' })
  assert.equal(search.options.length, 1); assert.equal(search.options[0].value, longValue)
  assert.equal(f.context.__velmrenAgent.refs.get('e1'), f.elements[0])
  f.context.__velmrenAgent.revision++
  assert.throws(() => f.run('listSelectOptions', { ref: 'e1', revision: 0 }), /Page changed/)
})

test('large option values respect the response budget and over-limit values cannot be selected', () => {
  const f = fixture(1)
  Object.assign(f.elements[0], { tagName: 'SELECT', options: Array.from({ length: 70 }, (_, index) => ({ value: `${index}-${'v'.repeat(5000)}`, label: `Large ${index}`, disabled: false })) })
  f.elements[0].options.push({ value: 'v'.repeat(65537), label: 'Unsupported large value', disabled: false })
  f.run('observeDocument')
  let offset = 0, total = 0
  do {
    const page = f.run('listSelectOptions', { ref: 'e1', revision: 0, offset, limit: 100 })
    assert.ok(page.options.length > 0); total += page.options.length
    offset = page.pagination.nextOffset
    assert.ok(JSON.stringify(page).length < 110000)
  } while (offset !== null)
  assert.equal(total, 71)
  const unsupported = f.run('listSelectOptions', { ref: 'e1', revision: 0, query: 'Unsupported large' }).options[0]
  assert.equal(unsupported.valueComplete, false); assert.equal(unsupported.selectable, false)
  assert.ok(!Object.hasOwn(unsupported, 'value'))
})

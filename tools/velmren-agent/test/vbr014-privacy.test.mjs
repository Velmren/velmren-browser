import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { deflateSync } from 'node:zlib'
import { safePublicUrl, sanitizePublicResult, sanitizePublicError } from '../privacy.mjs'

const marker = 'VBR014_SYNTHETIC_PRIVATE_MARKER'
const origin = 'https://identity.example.test:8443'
const authUrl = `https://fixture-user:${marker}@identity.example.test:8443/oauth/${marker}?client_id=${marker}&code=${marker}&state=${marker}#${marker}`
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAEElEQVR4AQEFAPr/AP////8J+wP9o9FJCgAAAABJRU5ErkJggg=='
const id = '14aa0014-0014-4014-8014-000000000014'
const pageId = 'AABBCCDDEEFF00112233445566778899'
const clean = value => {
  assert.ok(!JSON.stringify(value).includes(marker), 'Synthetic URL content reached public output')
  return value
}
const variants = [
  authUrl,
  encodeURI(authUrl),
  encodeURIComponent(authUrl),
  encodeURIComponent(encodeURIComponent(authUrl)),
  authUrl.replaceAll('/', '\\/'),
  authUrl.replaceAll(':', '\\u003a').replaceAll('/', '\\u002f'),
  authUrl.replaceAll(':', '\\x3a').replaceAll('/', '\\x2f'),
  authUrl.replaceAll(':', '&#58;').replaceAll('/', '&#x2f;'),
  authUrl.replaceAll(':', '&colon;').replaceAll('/', '&sol;').replaceAll('&', '&amp;'),
  [...authUrl].map(char => `%${char.charCodeAt(0).toString(16).padStart(2, '0')}`).join('')
]

function pngChunk(type, bytes) {
  const body = Buffer.concat([Buffer.from(type), bytes]), length = Buffer.alloc(4), checksum = Buffer.alloc(4)
  let crc = 0xffffffff
  for (const byte of body) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1
  }
  length.writeUInt32BE(bytes.length); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0)
  return Buffer.concat([length, body, checksum])
}

function pngFixture({ width = 1, height = 1, depth = 8, color = 6, compression = 0, filter = 0, interlace = 0,
  scanlines = Buffer.from([0, 255, 255, 255, 255]), compressed = deflateSync(scanlines), palette } = {}) {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width); header.writeUInt32BE(height, 4)
  header[8] = depth; header[9] = color; header[10] = compression; header[11] = filter; header[12] = interlace
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), pngChunk('IHDR', header),
    ...(palette ? [pngChunk('PLTE', palette)] : []), pngChunk('IDAT', compressed), pngChunk('IEND', Buffer.alloc(0))]).toString('base64')
}

test('VBR-014 reduces literal and encoded OAuth URLs in every recursive string position', () => {
  for (const url of variants) {
    const input = { url, title: `Continue ${url}`, text: `Open ${url}`, pages: [{ title: url }],
      metadata: { arbitrary: [url, { label: url, description: url, note: `Retry ${url}`, [url]: url }] },
      dialog: { message: url }, downloads: [{ name: url, path: url }],
      helperText: url, errorText: url, validationMessage: url, alt: url,
      error: url, cleanupError: url, code: url }
    const output = clean(sanitizePublicResult(input))
    assert.equal(output.url, origin)
    assert.equal(output.title, `Continue ${origin}`)
    assert.equal(output.text, `Open ${origin}`)
    assert.equal(output.pages[0].title, origin)
    assert.equal(output.metadata.arbitrary[0], origin)
    assert.equal(output.metadata.arbitrary[1][origin], origin)
    assert.equal(output.code, 'BROKER_ERROR')
    assert.equal(output.error, 'Browser operation failed.')
    assert.deepEqual(sanitizePublicResult(output), output)
    assert.equal(safePublicUrl(url), origin)
  }
})

test('VBR-014 handles encoded whitespace, malformed URL tails and non-HTTP schemes without echoing input', () => {
  for (const text of [
    `https://identity.example.test/path%20${marker}?value=%ZZ${marker}`,
    `https://[broken/${marker}`, `https:///${marker}`, `https:\\\\identity.example.test\\${marker}`,
    `//identity.example.test/${marker}`, `custom://identity.example.test/${marker}`,
    `data:text/plain,${marker}`, `javascript:${marker}`, `mailto:${marker}@example.test`,
    encodeURIComponent(`https://identity.example.test/path\t${marker}\n${marker}`),
    `https%3A%2F%2Fidentity.example.test%2F${marker}%E0%A4%A`,
    `https://identity.example.test/%u0000${marker}`
  ]) clean(sanitizePublicResult({ text, title: text, nested: [{ arbitrary: text }] }))
  let deeplyEncoded = authUrl
  for (let index = 0; index < 40; index++) deeplyEncoded = encodeURIComponent(deeplyEncoded)
  clean(sanitizePublicResult({ text: deeplyEncoded }))
  assert.equal(sanitizePublicResult({ text: 'Normal text %20 with &amp; escaped values and 12:30 time.' }).text,
    'Normal text %20 with &amp; escaped values and 12:30 time.')
})

test('VBR-014 finds URLs after underscores, letters and arbitrary adjacent prefixes', () => {
  for (const prefix of ['callback_', 'callback__', '0_', 'callback', 'prefix-', 'prefix.', 'wrapped(', 'текст']) {
    for (const url of variants) {
      const text = prefix + url
      const output = clean(sanitizePublicResult({ title: text, nested: [{ annotation: text, [text]: text }] }))
      assert.equal(output.title, prefix + origin)
      assert.equal(output.nested[0].annotation, prefix + origin)
      assert.equal(output.nested[0][prefix + origin], prefix + origin)
    }
  }
})

test('VBR-014 preserves validated PNG bytes through repeated raw and MCP image projection', () => {
  const hash = value => createHash('sha256').update(Buffer.from(value, 'base64')).digest('hex')
  assert.ok(png.includes('//'))
  for (const block of [{ mimeType: 'image/png', data: png }, { type: 'image', mimeType: 'image/png', data: png }]) {
    let result = { content: [block], title: authUrl }
    for (let pass = 0; pass < 5; pass++) result = clean(sanitizePublicResult(result))
    assert.equal(result.content[0].data, png)
    assert.equal(hash(result.content[0].data), hash(png))
    assert.deepEqual(sanitizePublicResult(block, { sensitive: true }), {})
  }
  for (const block of [
    { mimeType: 'image/png', data: `//${marker}` },
    { type: 'text', mimeType: 'image/png', data: authUrl },
    { type: 'image', mimeType: 'image/png', data: encodeURIComponent(authUrl) },
    { type: 'image', mimeType: 'image/jpeg', data: authUrl }
  ]) clean(sanitizePublicResult(block))
  assert.notEqual(sanitizePublicResult({ type: 'text', mimeType: 'image/png', data: png }).data, png)
  const broken = Buffer.from(png, 'base64'); broken[29] ^= 1
  assert.notEqual(sanitizePublicResult({ type: 'image', mimeType: 'image/png', data: broken.toString('base64') }).data, broken.toString('base64'))
})

test('VBR-014 PNG exemption accepts actual RGB, RGBA, grayscale, palette and interlaced pixels', () => {
  const palette = Buffer.from([0, 0, 0, 255, 255, 255])
  for (const options of [
    {}, { color: 2, scanlines: Buffer.from([0, 255, 255, 255]) },
    { color: 0, scanlines: Buffer.from([0, 128]) },
    { depth: 16, scanlines: Buffer.from([0, 255, 255, 255, 255, 255, 255, 255, 255]) },
    { color: 3, depth: 1, width: 2, palette, scanlines: Buffer.from([0, 64]) },
    { color: 3, depth: 8, height: 2, palette, scanlines: Buffer.from([0, 0, 2, 1]) },
    { interlace: 1 }
  ]) {
    const data = pngFixture(options), block = { type: 'image', mimeType: 'image/png', data }
    assert.deepEqual(sanitizePublicResult(block), block)
  }
})

test('VBR-014 PNG exemption rejects invalid streams, pixel formats and bounded inflation violations', () => {
  for (const options of [
    { compressed: Buffer.from(`https://example.test/${marker}`) },
    { compressed: Buffer.concat([deflateSync(Buffer.from([0, 255, 255, 255, 255])), Buffer.from(authUrl)]) },
    { compressed: deflateSync(Buffer.alloc(1024 * 1024)) },
    { width: 32769 }, { width: 32768, height: 32768 },
    { width: 8192, height: 2048, depth: 16 },
    { scanlines: Buffer.from([0, 255]) }, { scanlines: Buffer.from([5, 255, 255, 255, 255]) },
    { depth: 3 }, { color: 5 }, { compression: 1 }, { filter: 1 }, { interlace: 2 },
    { color: 3, scanlines: Buffer.from([0, 0]) },
    { color: 3, palette: Buffer.from([0, 0, 0]), scanlines: Buffer.from([0, 1]) }
  ]) {
    const data = pngFixture(options)
    const output = clean(sanitizePublicResult({ type: 'image', mimeType: 'image/png', data }))
    assert.equal(output.data, undefined, 'Invalid declared PNG must not escape as binary or text')
  }
})

test('VBR-014 keeps fixed error categories and safe operation context in both privacy modes', () => {
  const diagnostic = { reason: 'navigation', phase: 'navigate', networkError: 'ERR_CONNECTION_REFUSED' }
  for (const sensitive of [false, true]) {
    const error = Object.assign(new Error(authUrl), { code: 'NAVIGATION_FAILED', taskId: id, pageId,
      frameId: authUrl, diagnostic: { ...diagnostic, extra: authUrl }, stack: authUrl, cause: new Error(authUrl) })
    const output = clean(sanitizePublicError(error, { sensitive }))
    assert.equal(output.code, 'NAVIGATION_FAILED')
    assert.equal(output.taskId, id)
    assert.equal(output.pageId, pageId)
    assert.equal(output.frameId, undefined)
    assert.deepEqual(output.diagnostic, diagnostic)
    assert.deepEqual(sanitizePublicResult(error, { sensitive }), output)
    assert.deepEqual(sanitizePublicResult({ diagnostic: { ...diagnostic, extra: authUrl } }, { sensitive }), { diagnostic })
    clean(sanitizePublicError({ message: authUrl, code: authUrl, diagnostic: { reason: authUrl, phase: authUrl } }, { sensitive }))
  }
  for (const code of ['ELEMENT_DISABLED', 'ELEMENT_HIDDEN', 'NAVIGATION_FAILED', 'NAVIGATION_TIMEOUT', 'BROWSER_CLOSED']) {
    assert.equal(sanitizePublicError({ code, message: authUrl }).code, code)
  }
})

test('VBR-014 ignores getters and non-string error message coercion', () => {
  let reads = 0
  const message = { toString() { reads++; return `Task is paused; agent actions are paused${authUrl}` } }
  const list = []
  Object.defineProperty(list, 0, { enumerable: true, get() { reads++; return authUrl } })
  const image = { type: 'image', data: authUrl }
  Object.defineProperty(image, 'mimeType', { enumerable: true, get() { reads++; return 'image/png' } })
  clean(sanitizePublicResult({ list, image }))
  clean(sanitizePublicError({ message }))
  assert.equal(reads, 0)
})

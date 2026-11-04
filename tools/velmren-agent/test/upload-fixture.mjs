import http from 'node:http'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const crc32 = bytes => {
  let crc = 0xffffffff
  for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)) }
  return (crc ^ 0xffffffff) >>> 0
}
const zip = entries => {
  const chunks = [], directory = []
  let offset = 0
  for (const [name, text] of entries) {
    const filename = Buffer.from(name), bytes = Buffer.from(text), crc = crc32(bytes)
    const local = Buffer.alloc(30), central = Buffer.alloc(46)
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(bytes.length, 18); local.writeUInt32LE(bytes.length, 22); local.writeUInt16LE(filename.length, 26)
    central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(bytes.length, 20); central.writeUInt32LE(bytes.length, 24); central.writeUInt16LE(filename.length, 28); central.writeUInt32LE(offset, 42)
    chunks.push(local, filename, bytes); directory.push(central, filename)
    offset += local.length + filename.length + bytes.length
  }
  const index = Buffer.concat(directory), end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(index.length, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...chunks, index, end])
}
const pdf = marker => {
  const stream = `BT /F1 12 Tf 72 720 Td (Synthetic resume ${marker}) Tj ET`
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`]
  let output = '%PDF-1.4\n', offsets = [0]
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(output)); output += `${index + 1} 0 obj\n${object}\nendobj\n` })
  const xref = Buffer.byteLength(output)
  output += `xref\n0 ${offsets.length}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(output)
}

export async function uploadFixture(directory) {
  await mkdir(directory)
  const samples = [], expected = new Map(), evidence = { uploads: [], failures: [], parallelPeak: 0 }
  for (let agent = 0; agent < 5; agent++) {
    const marker = randomUUID()
    const contents = {
      pdf: pdf(marker), txt: Buffer.from(`Synthetic CV fixture only. ${marker}\n`),
      docx: zip([
        ['[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'],
        ['_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'],
        ['word/document.xml', `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Synthetic CV ${marker}</w:t></w:r></w:p></w:body></w:document>`]
      ])
    }
    const sample = {}
    for (const [extension, bytes] of Object.entries(contents)) {
      const name = `agent-${agent}-synthetic.${extension}`, filename = path.join(directory, name)
      await writeFile(filename, bytes, { flag: 'wx' })
      const metadata = { name, size: bytes.length, sha256: sha256(bytes), agent }
      expected.set(name, metadata); sample[extension] = { path: filename, ...metadata }
    }
    samples.push(sample)
  }
  const barrier = []
  let barrierTimer
  const release = () => {
    clearTimeout(barrierTimer)
    for (const done of barrier.splice(0)) done()
  }
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`)
      const agent = Number(url.searchParams.get('agent'))
      if (!Number.isInteger(agent) || agent < 0 || agent >= 5) throw new Error('Invalid synthetic owner')
      if (req.method === 'POST' && url.pathname === '/upload') {
        const record = { agent, control: url.searchParams.get('control'), startedAt: Date.now(), files: [] }
        const chunks = []; let length = 0
        for await (const chunk of req) { length += chunk.length; if (length > 1024 * 1024) throw new Error('Fixture upload exceeded its bound'); chunks.push(chunk) }
        const form = await new Request(url, { method: 'POST', headers: { 'Content-Type': req.headers['content-type'] }, body: Buffer.concat(chunks) }).formData()
        for (const value of form.getAll('files')) {
          if (typeof value === 'string') throw new Error('Expected multipart file')
          const bytes = Buffer.from(await value.arrayBuffer()), reference = expected.get(value.name)
          const actual = { name: value.name, size: bytes.length, sha256: sha256(bytes) }
          if (!reference || reference.agent !== agent || actual.size !== reference.size || actual.sha256 !== reference.sha256) throw new Error('Synthetic upload bytes or owner did not match')
          record.files.push(actual)
        }
        const expectedExtensions = { visible: ['pdf'], hidden: ['txt'], custom: ['docx'], multiple: ['txt', 'docx'], parallel: ['pdf'] }[record.control]
        if (!expectedExtensions || record.files.length !== expectedExtensions.length || record.files.some((file, index) => {
          const reference = samples[agent][expectedExtensions[index]]
          return file.name !== reference.name || file.size !== reference.size || file.sha256 !== reference.sha256
        })) throw new Error('Received multipart file list did not exactly match the selected fixture files')
        evidence.uploads.push(record)
        if (record.control === 'parallel') await new Promise(resolve => {
          barrier.push(resolve); evidence.parallelPeak = Math.max(evidence.parallelPeak, barrier.length)
          if (barrier.length === 1) barrierTimer = setTimeout(() => { evidence.failures.push('Five-upload barrier timed out'); release() }, 15000)
          if (barrier.length === 5) release()
        })
        record.completedAt = Date.now()
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ verified: true, files: record.files })); return
      }
      if (req.method !== 'GET' || url.pathname !== '/') { res.writeHead(404); res.end(); return }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(`<!doctype html><html><head><title>Synthetic upload acceptance</title><style>body{font:18px sans-serif;padding:30px}label,button,input,p{display:block;margin:12px}</style></head><body>
<h1>Agent ${agent} synthetic upload fixture</h1>
<form id="visible-form"><label for="visible">Visible CV</label><input id="visible" type="file" name="visible" accept=".pdf,.txt,.docx"><button>Submit visible CV</button></form>
<label for="hidden">Hidden CV</label><input id="hidden" type="file" style="display:none" accept=".pdf,.txt,.docx">
<button id="custom">Custom upload button</button>
<label for="multiple">Multiple attachments</label><input id="multiple" type="file" multiple>
<fieldset disabled><label for="disabled">Disabled CV</label><input id="disabled" type="file"></fieldset>
<label for="parallel">Parallel attachment</label><input id="parallel" type="file">
<button id="change">Change page</button><p id="changed"></p><div id="results"></div>
<script>
const owner=${agent};
async function upload(input, control) {
  const form=new FormData(); for(const file of input.files)form.append('files',file);
  const response=await fetch('/upload?agent='+owner+'&control='+control,{method:'POST',body:form});
  const result=await response.json(); const p=document.createElement('p');
  p.textContent=response.ok&&result.verified?'Received '+control:'Upload failed '+control; document.getElementById('results').append(p);
}
document.getElementById('visible-form').onsubmit=event=>{event.preventDefault();void upload(document.getElementById('visible'),'visible')};
for(const id of ['hidden','multiple','parallel'])document.getElementById(id).onchange=event=>void upload(event.target,id);
document.getElementById('custom').onclick=()=>{const input=document.createElement('input');input.type='file';input.setAttribute('aria-label','Custom file');input.onchange=()=>void upload(input,'custom');input.click()};
document.getElementById('change').onclick=()=>document.getElementById('changed').textContent='Document changed';
</script></body></html>`)
    } catch (error) { evidence.failures.push(error.message); res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: error.message })) }
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  return { origin: `http://127.0.0.1:${server.address().port}`, samples, evidence, close: async () => { release(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) } }
}

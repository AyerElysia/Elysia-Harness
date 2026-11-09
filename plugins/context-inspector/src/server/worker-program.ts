/** Pure-JavaScript worker: no TS loader, application services or model requests. */
export const WORKER_PROGRAM = String.raw`
const { parentPort, workerData } = require('node:worker_threads')
const fs = require('node:fs/promises')
const { constants } = require('node:fs')
const { join } = require('node:path')
function fail(code) { const error = new Error(code); error.publicCode = code; throw error }
function object(value) { return typeof value === 'object' && value !== null && !Array.isArray(value) }
async function run() {
  const { dir, requestId, sessionId, maxArchiveBytes } = workerData
  if (typeof requestId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,180}$/.test(requestId) || requestId.includes('..')) fail('invalid-request')
  let file
  try { file = await fs.open(join(dir, requestId + '.json'), constants.O_RDONLY | constants.O_NOFOLLOW) }
  catch { fail('archive-unavailable') }
  let raw
  try {
    const before = await file.stat()
    if (!before.isFile() || before.size < 1) fail('archive-invalid')
    if (before.size > maxArchiveBytes) fail('archive-too-large')
    raw = Buffer.alloc(before.size)
    let position = 0
    while (position < raw.length) {
      const result = await file.read(raw, position, raw.length - position, position)
      if (result.bytesRead === 0) fail('archive-invalid')
      position += result.bytesRead
    }
    const extra = await file.read(Buffer.alloc(1), 0, 1, position)
    const after = await file.stat()
    if (extra.bytesRead !== 0 || after.size !== before.size || after.mtimeMs !== before.mtimeMs) fail('archive-invalid')
  } finally { await file.close() }
  let record
  try { record = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)) }
  catch { fail('archive-invalid') }
  if (!object(record) || record.id !== requestId || typeof record.recordedAt !== 'string'
    || !Number.isFinite(Date.parse(record.recordedAt)) || typeof record.loop !== 'boolean' || !object(record.request)) fail('archive-invalid')
  const request = record.request
  if (request.sessionId !== sessionId) fail('archive-unavailable')
  if (typeof request.provider !== 'string' || typeof request.model !== 'string'
    || !Array.isArray(request.messages) || (request.tools !== undefined && !Array.isArray(request.tools))) fail('archive-invalid')
  const tools = request.tools === undefined ? [] : request.tools
  const system = {
    system: request.system === undefined ? null : request.system,
    messages: request.messages.filter(message => object(message) && (message.role === 'system' || message.role === 'developer')),
  }
  const strings = {
    system: JSON.stringify(system, null, 2), messages: JSON.stringify(request.messages, null, 2),
    tools: JSON.stringify(tools, null, 2),
  }
  const sections = {}
  const transfers = []
  for (const section of ['system', 'messages', 'tools', 'raw']) {
    const bytes = section === 'raw' ? raw : Buffer.from(strings[section], 'utf8')
    const array = Uint8Array.from(bytes)
    sections[section] = array.buffer
    transfers.push(array.buffer)
  }
  const sizes = Object.fromEntries(Object.entries(sections).map(([key, bytes]) => [key, { bytes: bytes.byteLength }]))
  parentPort.postMessage({
    ok: true,
    metadata: { requestId, sessionId, recordedAt: record.recordedAt, provider: request.provider,
      model: request.model, messageCount: request.messages.length, toolCount: tools.length,
      loop: record.loop, sections: sizes },
    sections,
  }, transfers)
}
run().catch(error => {
  const codes = ['invalid-request', 'archive-unavailable', 'archive-invalid', 'archive-too-large']
  parentPort.postMessage({ ok: false, code: codes.includes(error.publicCode) ? error.publicCode : 'archive-invalid' })
}).finally(() => parentPort.close())
`

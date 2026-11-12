/** ASR HTTP boundary and WAV framing (no native inference or network destinations besides loopback). */
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { request } from 'node:http'
import test from 'node:test'
import { createAsrServer, MIN_BYTES, MAX_BYTES, pcmToWave } from './asr_local.mjs'

const key = 'test-capability-not-a-real-key-123456'
const authority = 'asr.test'
const audio = Buffer.alloc(MIN_BYTES, 1)

async function fixture(t, transcribe, ready) {
  const server = createAsrServer({ key, authority, transcribe, ready })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => { server.close(); server.closeAllConnections() })
  const port = server.address().port
  return (path, { method = 'POST', headers = {}, body = audio } = {}) => new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers: {
      Host: authority,
      Authorization: 'Bearer ' + key,
      ...(method === 'POST' ? { 'Content-Type': 'application/octet-stream', 'Content-Length': body.length } : {}),
      ...headers,
    } }, (res) => {
      let raw = ''
      res.setEncoding('utf8')
      res.on('data', (part) => { raw += part })
      res.on('end', () => resolve([res.statusCode, JSON.parse(raw)]))
    })
    req.on('error', reject)
    req.end(method === 'POST' ? body : undefined)
  })
}

test('converts only bounded mono PCM to canonical 16kHz WAV', () => {
  const wav = pcmToWave(audio)
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF')
  assert.equal(wav.readUInt16LE(22), 1)
  assert.equal(wav.readUInt32LE(24), 16000)
  assert.equal(wav.readUInt16LE(34), 16)
  assert.deepEqual(wav.subarray(44), audio)
  for (const size of [0, MIN_BYTES - 2, MIN_BYTES + 1, MAX_BYTES + 2]) {
    assert.throws(() => pcmToWave(Buffer.alloc(size)), /asr_bad_audio/u)
  }
})

test('only accepts exact local host, no browser origin and valid capability', async (t) => {
  let invocations = 0
  const call = await fixture(t, () => { invocations++; return '你好' })
  assert.deepEqual(await call('/health', { method: 'GET' }), [200, { ready: true }])
  assert.deepEqual(await call('/transcribe', { headers: { Host: 'elsewhere.test' } }), [403, { error: 'asr_forbidden' }])
  assert.deepEqual(await call('/transcribe', { headers: { Origin: 'http://elsewhere.test' } }), [403, { error: 'asr_forbidden' }])
  assert.deepEqual(await call('/transcribe', { headers: { Authorization: 'Bearer ' + 'z'.repeat(key.length) } }), [401, { error: 'asr_unauthorized' }])
  assert.deepEqual(await call('/transcribe', { headers: { 'Content-Type': 'audio/wav' } }), [415, { error: 'asr_bad_media' }])
  assert.deepEqual(await call('/transcribe', { body: Buffer.alloc(MIN_BYTES + 1) }), [400, { error: 'asr_bad_audio' }])
  assert.deepEqual(await call('/transcribe?x=1'), [404, { error: 'asr_not_found' }])
  assert.equal(invocations, 0)
  assert.deepEqual(await call('/transcribe'), [200, { text: '你好' }])
  assert.equal(invocations, 1)
})

test('one in-flight request, empty transcript allowed, buffer cleared on settlement', async (t) => {
  let input
  const started = Promise.withResolvers()
  const finish = Promise.withResolvers()
  const call = await fixture(t, async (pcm) => {
    input = pcm
    started.resolve()
    return await finish.promise
  })
  const first = call('/transcribe')
  await started.promise
  assert.equal(input[0], 1)
  assert.deepEqual(await call('/transcribe'), [503, { error: 'asr_busy' }])
  finish.resolve('  ')
  assert.deepEqual(await first, [200, { text: '' }])
  assert.equal(input[0], 0)
})

test('fixed failures do not expose native data', async (t) => {
  let available = false
  const call = await fixture(t, () => { throw Error('must not expose fixture content') }, () => available)
  assert.deepEqual(await call('/health', { method: 'GET' }), [503, { ready: false }])
  assert.deepEqual(await call('/transcribe'), [503, { error: 'asr_not_ready' }])
  available = true
  assert.deepEqual(await call('/transcribe'), [500, { error: 'asr_inference_failed' }])
})

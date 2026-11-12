/**
 * Exercise the unchanged chat transport against a loopback Breeze endpoint.
 * Only metadata and hashes are printed. Deployment reference text is private.
 */
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { performance } from 'node:perf_hooks'
import { parseBreezeSettings, requestBreeze } from '../../plugins/conscious-mind/src/breeze-tts.ts'

const endpoint = process.argv[2] ?? 'http://127.0.0.1:7863'
const url = new URL(endpoint)
if (url.hostname !== '127.0.0.1' || !['7862', '7863', '7864'].includes(url.port) || url.protocol !== 'http:' || url.pathname !== '/' || url.search || url.username || url.password) {
  throw new Error('Only the owned loopback Breeze endpoints are allowed')
}
const output = process.argv[3]
if (output && !/^\/home\/ayerelysia\/Elysia\/Elysium\/runtime\/breeze-official-20261112\/[a-z0-9-]+\.wav$/u.test(output)) {
  throw new Error('Output must be a new WAV in the owned migration runtime directory')
}
const source = await readFile('/home/ayerelysia/Elysia/Elysium/config/plugins/tts_voice_plugin/config.toml', 'utf8')
const settings = parseBreezeSettings(source)
settings.server = endpoint
const sha = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex')
const reference = await readFile(settings.referenceAudioPath)
const started = performance.now()
let firstPcmMs: number | null = null
let upstreamStatus: number | null = null
let chunks = 0
const observedFetch: typeof fetch = async (input, init) => {
  const response = await fetch(input, init)
  upstreamStatus = response.status
  if (!response.ok || !response.body) return response
  const reader = response.body.getReader()
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read()
        if (next.done) { controller.close(); return }
        firstPcmMs ??= Math.round(performance.now() - started)
        chunks++
        controller.enqueue(next.value)
      } catch (error) { controller.error(error) }
    },
    async cancel(reason) { await reader.cancel(reason) },
  })
  return new Response(stream, { status: response.status, headers: response.headers })
}
const result = await requestBreeze(settings, '[笑]这是一条官方语音服务测试，参考音色保持不变。', {
  client: 'official-migration-smoke',
  expression: '自然、轻快地完成这次简短测试。',
  requestTimeoutMs: 120000,
  fetchImpl: observedFetch,
})
if (output) await writeFile(output, result.audio, { flag: 'wx', mode: 0o600 })
console.log(JSON.stringify({
  endpoint,
  upstreamStatus,
  elapsedMs: Math.round(performance.now() - started),
  firstPcmMs,
  chunks,
  bytes: result.audio.byteLength,
  sampleRate: result.sampleRate,
  durationMs: result.durationMs,
  mediaType: result.mediaType,
  referenceSha256: sha(reference),
  referenceTextSha256: sha(settings.referenceText),
  instructionSha256: sha(settings.instruction),
  wavSha256: sha(result.audio),
  output: output ?? null,
}))

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { ELYSIUM_BREEZE_CONFIG } from '@elysia/conscious-mind/src/breeze-tts.ts'
import { BreezeStreamError, loadBreezeSettings, streamBreeze } from '../src/breeze-stream.ts'

const output = resolve(process.argv[2] ?? '../../breeze-realtime-review/results/plugin-q8-interruption.wav')
const reportPath = output.replace(/\.wav$/u, '.json')
const settings = await loadBreezeSettings(ELYSIUM_BREEZE_CONFIG, 'http://127.0.0.1:7865')
const started = performance.now()
const interruption = new AbortController()
const first = streamBreeze(settings, '这是一段用于验证实时通话插话的长句。当用户开始说话时，旧语音应当立即停止，下一次合成也应当能够很快恢复，而不是被已经取消的请求一直占用。', { signal: interruption.signal, timeoutMs: 60_000 })[Symbol.asyncIterator]()
let firstChunkMs = 0
let firstChunkBytes = 0
let cancelled = false
try {
  const chunk = await first.next()
  if (chunk.done || !chunk.value.audio.byteLength) throw new Error('No initial PCM chunk')
  firstChunkMs = performance.now() - started
  firstChunkBytes = chunk.value.audio.byteLength
  await new Promise(resolve => setTimeout(resolve, 500))
  interruption.abort()
  try {
    await first.next()
  } catch (error) {
    cancelled = error instanceof BreezeStreamError && error.code === 'aborted'
  }
  if (!cancelled) throw new Error('The interrupted stream did not report its cancellation')
} finally {
  interruption.abort()
  try { await first.return?.() } catch { /* cancellation is asserted above */ }
}
const recoveryStarted = performance.now()
let recovery: ReturnType<typeof streamBreeze> | undefined
let recoveryAcceptedMs = 0
let attempts = 0
const retryStatuses: number[] = []
const chunks: Uint8Array[] = []
let sampleRate = 0
while (performance.now() - recoveryStarted < 15_000) {
  attempts++
  try {
    const candidate = streamBreeze(settings, '插话之后，我回来了。', { timeoutMs: 60_000 })
    const firstRecoveryChunk = await candidate.next()
    if (firstRecoveryChunk.done || !firstRecoveryChunk.value.audio.byteLength) throw new Error('Recovery produced no initial PCM')
    recovery = candidate
    recoveryAcceptedMs = performance.now() - recoveryStarted
    sampleRate = firstRecoveryChunk.value.sampleRate
    chunks.push(firstRecoveryChunk.value.audio)
    break
  } catch (error) {
    if (!(error instanceof BreezeStreamError) || error.code !== 'http' || error.status !== 409) throw error
    retryStatuses.push(error.status)
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}
if (!recovery) throw new Error('Recovery admission timed out')
for await (const chunk of recovery) {
  if (sampleRate !== chunk.sampleRate) throw new Error('Sample rate changed')
  chunks.push(chunk.audio)
}
if (sampleRate !== 24_000) throw new Error('Recovery produced an invalid sample rate')
const pcm = Buffer.concat(chunks.map(chunk => Buffer.from(chunk)))
const wav = Buffer.alloc(44 + pcm.length)
wav.write('RIFF', 0); wav.writeUInt32LE(36 + pcm.length, 4); wav.write('WAVEfmt ', 8)
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22)
wav.writeUInt32LE(sampleRate, 24); wav.writeUInt32LE(sampleRate * 2, 28)
wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(pcm.length, 40)
pcm.copy(wav, 44)
await mkdir(dirname(output), { recursive: true })
await writeFile(output, wav)
const report = {
  service: 'http://127.0.0.1:7865',
  implementation: 'plugins/voice-call/src/breeze-stream.ts',
  settingsSource: ELYSIUM_BREEZE_CONFIG,
  firstChunkMs: Math.round(firstChunkMs * 1000) / 1000,
  firstChunkBytes,
  interruptedAfterAdditionalMs: 500,
  cancellationObserved: cancelled,
  cancellationNote: 'Caller AbortSignal and response-body cancellation were observed. HTTP has no separate server cancellation acknowledgement.',
  recoveryAcceptedMs: Math.round(recoveryAcceptedMs * 1000) / 1000,
  recoveryTotalMs: Math.round((performance.now() - recoveryStarted) * 1000) / 1000,
  recoveryAttempts: attempts,
  retryStatuses,
  recoveryBytes: pcm.length,
  recoveryDurationMs: pcm.length / 2 / sampleRate * 1000,
  sampleRate,
  output,
}
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`)
console.log(JSON.stringify(report, null, 2))

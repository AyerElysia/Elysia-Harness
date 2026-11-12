import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { basename, isAbsolute } from 'node:path'
import { parseBreezeSettings, type BreezeSettings } from '@elysia/conscious-mind/src/breeze-tts.ts'

export type { BreezeSettings }
export interface BreezePcmChunk { audio: Uint8Array; sampleRate: number }
export interface BreezeStreamOptions { signal?: AbortSignal; fetchImpl?: typeof fetch; timeoutMs?: number }
export class BreezeStreamError extends Error {
  constructor(readonly code: string, readonly status?: number) {
    super(`Breeze stream failed (${code}${status === undefined ? '' : `; HTTP ${status}`}).`)
    this.name = 'BreezeStreamError'
  }
}

/** Only deployment code supplies these values; no model/browser voice selectors exist. */
export async function loadBreezeSettings(configPath: string, serverUrl?: string): Promise<BreezeSettings> {
  try {
    if (!isAbsolute(configPath)) throw new BreezeStreamError('invalid-config-path')
    const parsed = parseBreezeSettings(await readFile(configPath, 'utf8'))
    const settings = serverUrl === undefined ? parsed : { ...parsed, server: serverUrl }
    validateSettings(settings)
    return Object.freeze(settings)
  } catch (error) { throw error instanceof BreezeStreamError ? error : new BreezeStreamError('invalid-config') }
}
function validateSettings(settings: BreezeSettings) {
  let url: URL
  try { url = new URL(settings.server) } catch { throw new BreezeStreamError('invalid-service') }
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !['7862', '7865'].includes(url.port)
    || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new BreezeStreamError('invalid-service')
  if (settings.styleName !== 'default' || !settings.referenceAudioPath || !isAbsolute(settings.referenceAudioPath)
    || !settings.referenceText || !settings.instruction || !Number.isSafeInteger(settings.maxTextLength) || settings.maxTextLength <= 0
    || !Number.isFinite(settings.timeoutMs) || settings.timeoutMs <= 0 || !Number.isFinite(settings.cfgScale) || settings.cfgScale <= 0 || settings.cfgScale > 5
    || !Number.isSafeInteger(settings.seed) || settings.seed < -1 || settings.seed > 0x7fffffff) throw new BreezeStreamError('invalid-settings')
}
function seedFor(settings: BreezeSettings, text: string): number {
  if (settings.seed >= 0) return settings.seed
  return createHash('blake2s256').update(`default\0${text}`, 'utf8').digest().readUInt32LE(0) & 0x7fffffff
}
async function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  let abort = () => {}
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(new BreezeStreamError('aborted'))
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
  })
  try { return await Promise.race([pending, cancelled]) }
  finally { signal.removeEventListener('abort', abort) }
}

/** One admitted POST, raw mono s16le PCM, with a single end-to-end deadline. */
export async function* streamBreeze(settings: BreezeSettings, text: string, options: BreezeStreamOptions = {}): AsyncIterable<BreezePcmChunk> {
  validateSettings(settings)
  if (typeof text !== 'string' || text.length === 0 || Array.from(text).length > settings.maxTextLength) throw new BreezeStreamError('invalid-text-length')
  const timeoutMs = Math.floor(Math.min(settings.timeoutMs, options.timeoutMs ?? settings.timeoutMs))
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new BreezeStreamError('invalid-timeout')
  const controller = new AbortController(); let timedOut = false; let complete = false
  const callerAbort = () => controller.abort()
  options.signal?.addEventListener('abort', callerAbort, { once: true })
  if (options.signal?.aborted) callerAbort()
  const timer = setTimeout(() => { timedOut = true; controller.abort() }, timeoutMs)
  timer.unref?.()
  const signal = controller.signal
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  const cancelReader = () => { void reader?.cancel().catch(() => {}) }
  signal.addEventListener('abort', cancelReader, { once: true })
  try {
    signal.throwIfAborted()
    const reference = await readFile(settings.referenceAudioPath, { signal })
    signal.throwIfAborted()
    const form = new FormData()
    form.set('text', text)
    form.set('instruction', settings.instruction)
    form.set('cfg_scale', String(settings.cfgScale))
    form.set('ref_text', settings.referenceText)
    form.set('seed', String(seedFor(settings, text)))
    const referenceBytes = Uint8Array.from(reference)
    form.set('ref_audio', new Blob([referenceBytes.buffer], { type: 'audio/wav' }), basename(settings.referenceAudioPath))
    signal.throwIfAborted()
    const pending = (options.fetchImpl ?? fetch)(`${settings.server.replace(/\/+$/u, '')}/v1/audio/speech`, {
      method: 'POST', body: form, signal,
      headers: { 'X-Breeze-Client': 'voice-call', 'X-Breeze-Timeout-Ms': String(timeoutMs) },
    }).then(response => {
      if (signal.aborted) { void response.body?.cancel().catch(() => {}); signal.throwIfAborted() }
      return response
    })
    const response = await abortable(pending, signal)
    signal.throwIfAborted()
    if (!response.ok) { void response.body?.cancel().catch(() => {}); throw new BreezeStreamError('http', response.status) }
    const mediaType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
    const sampleFormat = response.headers.get('x-sample-format')?.trim().toLowerCase()
    const rateHeader = response.headers.get('x-sample-rate') ?? ''
    const sampleRate = Number(rateHeader)
    if (mediaType !== 'audio/pcm' || sampleFormat !== 's16le' || !/^\d+$/u.test(rateHeader) || !Number.isSafeInteger(sampleRate) || sampleRate <= 0 || !response.body) {
      void response.body?.cancel().catch(() => {}); throw new BreezeStreamError('invalid-pcm-format')
    }
    reader = response.body.getReader()
    let carry: number | undefined; let bytes = 0
    while (true) {
      const { done, value } = await abortable(reader.read(), signal)
      signal.throwIfAborted()
      if (done) break
      if (value.byteLength === 0) continue
      let pcm = value
      if (carry !== undefined) { pcm = new Uint8Array(value.byteLength + 1); pcm[0] = carry; pcm.set(value, 1); carry = undefined }
      const aligned = pcm.byteLength - pcm.byteLength % 2
      if (aligned !== pcm.byteLength) carry = pcm[pcm.byteLength - 1]
      if (aligned) { bytes += aligned; yield { audio: pcm.subarray(0, aligned), sampleRate }; signal.throwIfAborted() }
    }
    if (carry !== undefined || bytes === 0) throw new BreezeStreamError('invalid-pcm-length')
    signal.throwIfAborted(); complete = true
  } catch (error) {
    if (timedOut) throw new BreezeStreamError('timeout')
    if (signal.aborted) throw new BreezeStreamError('aborted')
    throw error instanceof BreezeStreamError ? error : new BreezeStreamError('transport')
  } finally {
    clearTimeout(timer); options.signal?.removeEventListener('abort', callerAbort); signal.removeEventListener('abort', cancelReader)
    if (!complete) { controller.abort(); cancelReader() }
    try { reader?.releaseLock() } catch { /* a carrier may still be settling cancellation */ }
  }
}

/** Mechanical, lossless splitting. maxChars is in Unicode code points, as Breeze counts them. */
export function splitSpeechText(text: string, maxChars: number): string[] {
  if (!Number.isSafeInteger(maxChars) || maxChars <= 0) throw new BreezeStreamError('invalid-segment-limit')
  const characters = Array.from(text); const units: string[] = []
  for (let index = 0; index < characters.length; index++) {
    if (characters[index] !== '[') { units.push(characters[index]!); continue }
    let depth = 1; let end = index + 1
    for (; end < characters.length && depth; end++) { if (characters[end] === '[') depth++; else if (characters[end] === ']') depth-- }
    // An unfinished event remains literal text, never silently discarded.
    if (depth) { units.push(characters[index]!); continue }
    const event = characters.slice(index, end).join('')
    if (Array.from(event).length > maxChars) throw new BreezeStreamError('event-exceeds-segment-limit')
    units.push(event); index = end - 1
  }
  const result: string[] = []; let pending = ''; let length = 0
  for (const unit of units) {
    const count = Array.from(unit).length
    if (length && length + count > maxChars) { result.push(pending); pending = ''; length = 0 }
    pending += unit; length += count
    if (/^[。！？!?；;\n]$/u.test(unit) || length === maxChars) { result.push(pending); pending = ''; length = 0 }
  }
  if (pending) result.push(pending)
  return result
}

import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadBreezeSettings, splitSpeechText, streamBreeze, type BreezeSettings } from '../src/breeze-stream.js'

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'voice-breeze-fake-')); directories.push(directory)
  const referenceAudioPath = join(directory, 'fake-reference.wav')
  await writeFile(referenceAudioPath, Uint8Array.of(82, 73, 70, 70), { mode: 0o600 })
  const settings: BreezeSettings = { server: 'http://127.0.0.1:7862', timeoutMs: 500, maxTextLength: 1000, styleName: 'default', referenceAudioPath, referenceText: 'fake reference transcript', instruction: 'fake fixed expression', cfgScale: 3.8, seed: -1 }
  return { directory, settings }
}
const headers = { 'Content-Type': 'audio/pcm', 'X-Sample-Format': 's16le', 'X-Sample-Rate': '24000' }
function response(chunks: number[][], extraHeaders: Record<string, string> = {}) {
  return new Response(new ReadableStream<Uint8Array>({ start(controller) { for (const bytes of chunks) controller.enqueue(Uint8Array.from(bytes)); controller.close() } }), { headers: { ...headers, ...extraHeaders } })
}
async function collect(settings: BreezeSettings, fetchImpl: typeof fetch, options: { signal?: AbortSignal; timeoutMs?: number } = {}) {
  const chunks = []
  for await (const chunk of streamBreeze(settings, '你好[笑]。', { ...options, fetchImpl })) chunks.push(chunk)
  return chunks
}

describe('Breeze PCM streaming (fake only)', () => {
  it('loads only the existing trusted default style via the public parser', async () => {
    const { directory, settings } = await fixture(); const path = join(directory, 'config.toml')
    await writeFile(path, `[tts]\nbackend = "breeze_tts2"\nserver = "http://127.0.0.1:7862"\ntimeout = 2\nmax_text_length = 80\n\n[[tts_styles]]\nstyle_name = "other"\nrefer_wav_path = "/not-used"\n\n[[tts_styles]]\nstyle_name = "default"\nrefer_wav_path = ${JSON.stringify(settings.referenceAudioPath)}\nprompt_text = "fake reference transcript"\nbreeze_instruction = "fake fixed expression"\nbreeze_cfg_scale = 3.8\nbreeze_seed = -1\n`, { mode: 0o600 })
    const loaded = await loadBreezeSettings(path)
    expect(loaded).toEqual({ ...settings, timeoutMs: 2000, maxTextLength: 80 }); expect(Object.isFrozen(loaded)).toBe(true)
  })
  it('overrides only the voice-only service URL with the dedicated Q8 endpoint', async () => {
    const { directory, settings } = await fixture(); const path = join(directory, 'config.toml')
    await writeFile(path, `[tts]\nbackend = "breeze_tts2"\nserver = "http://127.0.0.1:7862"\ntimeout = 2\nmax_text_length = 80\n\n[[tts_styles]]\nstyle_name = "default"\nrefer_wav_path = ${JSON.stringify(settings.referenceAudioPath)}\nprompt_text = "fake reference transcript"\nbreeze_instruction = "fake fixed expression"\nbreeze_cfg_scale = 3.8\nbreeze_seed = -1\n`, { mode: 0o600 })
    const loaded = await loadBreezeSettings(path, 'http://127.0.0.1:7865')
    expect(loaded).toEqual({ ...settings, server: 'http://127.0.0.1:7865', timeoutMs: 2000, maxTextLength: 80 })
    expect(Object.isFrozen(loaded)).toBe(true)
  })
  it('keeps all fixed form fields and reference bytes and matches the existing stable seed hash', async () => {
    const { settings } = await fixture()
    const fetchImpl = vi.fn(async (_url: any, init?: RequestInit) => {
      expect(_url).toBe('http://127.0.0.1:7862/v1/audio/speech'); expect(init?.method).toBe('POST')
      expect(init?.headers).toEqual({ 'X-Breeze-Client': 'voice-call', 'X-Breeze-Timeout-Ms': '500' })
      const form = init!.body as FormData
      expect([...form.keys()].sort()).toEqual(['cfg_scale', 'instruction', 'ref_audio', 'ref_text', 'seed', 'text'])
      expect(form.get('text')).toBe('你好[笑]。'); expect(form.get('instruction')).toBe(settings.instruction)
      expect(form.get('cfg_scale')).toBe('3.8'); expect(form.get('ref_text')).toBe(settings.referenceText)
      expect(form.get('seed')).toBe(String(createHash('blake2s256').update('default\0你好[笑]。', 'utf8').digest().readUInt32LE(0) & 0x7fffffff))
      expect(new Uint8Array(await (form.get('ref_audio') as File).arrayBuffer())).toEqual(Uint8Array.of(82, 73, 70, 70))
      return response([[1, 2], [3, 4]])
    }) as unknown as typeof fetch
    const chunks = await collect(settings, fetchImpl)
    expect(chunks.map(chunk => [...chunk.audio])).toEqual([[1, 2], [3, 4]])
    expect(chunks.every(chunk => chunk.sampleRate === 24000)).toBe(true); expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
  it('uses a configured nonrandom seed unchanged', async () => {
    const { settings } = await fixture(); settings.seed = 123
    const fetchImpl = vi.fn(async (_url: any, init?: RequestInit) => { expect((init!.body as FormData).get('seed')).toBe('123'); return response([[1, 2]]) }) as unknown as typeof fetch
    await collect(settings, fetchImpl)
  })
  it('carries odd-byte boundaries without changing or WAV-wrapping PCM', async () => {
    const { settings } = await fixture()
    const chunks = await collect(settings, vi.fn(async () => response([[1], [2, 3, 4], [], [5], [6]])) as unknown as typeof fetch)
    expect(chunks.map(chunk => [...chunk.audio])).toEqual([[1, 2, 3, 4], [5, 6]])
    expect(chunks.every(chunk => chunk.audio.byteLength % 2 === 0)).toBe(true)
  })
  it.each([{ chunks: [] }, { chunks: [[1]] }, { chunks: [[1, 2, 3]] }])('rejects an empty or terminal odd PCM stream (%j)', async ({ chunks }) => {
    const { settings } = await fixture()
    await expect(collect(settings, vi.fn(async () => response(chunks)) as unknown as typeof fetch)).rejects.toThrow('invalid-pcm-length')
  })
  it.each([
    { 'Content-Type': 'audio/pcm-fake' }, { 'Content-Type': 'audio/wav' }, { 'X-Sample-Format': 'float32' }, { 'X-Sample-Rate': '0' }, { 'X-Sample-Rate': '24000.5' }, { 'X-Sample-Rate': '2e4' },
  ])('rejects unsupported audio headers (%j)', async extraHeaders => {
    const { settings } = await fixture()
    await expect(collect(settings, vi.fn(async () => response([[1, 2]], extraHeaders)) as unknown as typeof fetch)).rejects.toThrow('invalid-pcm-format')
  })
  it('never retries a 409 or leaks its response body', async () => {
    const { settings } = await fixture(); const fetchImpl = vi.fn(async () => new Response('private text and config', { status: 409 })) as unknown as typeof fetch
    await expect(collect(settings, fetchImpl)).rejects.toThrow('HTTP 409'); expect(fetchImpl).toHaveBeenCalledTimes(1)
    try { await collect(settings, fetchImpl) } catch (error) { expect(String(error)).not.toContain('private') }
  })
  it('aborts a read, cancels the reader, and never reports partial audio as successful completion', async () => {
    const { settings } = await fixture(); const controller = new AbortController(); const cancelled = vi.fn()
    const fetchImpl = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({ start(stream) { stream.enqueue(Uint8Array.of(1, 2)) }, cancel: cancelled }), { headers })) as unknown as typeof fetch
    const iterator = streamBreeze(settings, 'text', { fetchImpl, signal: controller.signal })[Symbol.asyncIterator]()
    expect((await iterator.next()).value?.audio).toEqual(Uint8Array.of(1, 2))
    const pending = iterator.next(); controller.abort()
    await expect(pending).rejects.toThrow('aborted'); expect(cancelled).toHaveBeenCalledTimes(1)
  })
  it('times out a stalled read and cancels it', async () => {
    const { settings } = await fixture(); const cancelled = vi.fn()
    const fetchImpl = vi.fn(async () => new Response(new ReadableStream({ cancel: cancelled }), { headers })) as unknown as typeof fetch
    await expect(collect(settings, fetchImpl, { timeoutMs: 20 })).rejects.toThrow('timeout'); expect(cancelled).toHaveBeenCalledTimes(1)
  })
  it('times out a custom fetch that ignores abort and does not replay the POST', async () => {
    const { settings } = await fixture(); const fetchImpl = vi.fn(() => new Promise<Response>(() => {})) as unknown as typeof fetch
    await expect(collect(settings, fetchImpl, { timeoutMs: 20 })).rejects.toThrow('timeout'); expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
  it('does not submit anything for an already aborted call or a nonshared service', async () => {
    const { settings } = await fixture(); const controller = new AbortController(); controller.abort(); const fetchImpl = vi.fn() as unknown as typeof fetch
    await expect(collect(settings, fetchImpl, { signal: controller.signal })).rejects.toThrow('aborted')
    await expect(collect({ ...settings, server: 'http://127.0.0.1:7863' }, fetchImpl)).rejects.toThrow('invalid-service')
    expect(fetchImpl).not.toHaveBeenCalled()
  })
  it('preserves every code point and native bracket event when mechanically splitting', () => {
    const text = '你好[笑]。 这是😀😀测试！\n[soft [nested] event]结束。'
    const parts = splitSpeechText(text, 24)
    expect(parts.join('')).toBe(text); expect(parts.every(part => Array.from(part).length <= 24)).toBe(true)
    expect(parts.some(part => part.includes('[soft [nested] event]'))).toBe(true)
    expect(splitSpeechText('😀😀😀', 2)).toEqual(['😀😀', '😀'])
    expect(splitSpeechText('未闭合[笑', 3).join('')).toBe('未闭合[笑')
    expect(splitSpeechText('', 3)).toEqual([])
    expect(() => splitSpeechText('[很长的原生事件]', 3)).toThrow('event-exceeds-segment-limit')
    expect(() => splitSpeechText('text', 0)).toThrow('invalid-segment-limit')
  })
})

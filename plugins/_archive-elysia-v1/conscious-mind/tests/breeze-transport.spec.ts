import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { requestBreeze, BreezeTts, type BreezeSettings } from '../src/breeze-tts.ts'

const dir = mkdtempSync(join(tmpdir(), 'elyharn-breeze-transport-'))
const referenceAudioPath = join(dir, 'reference.wav')
writeFileSync(referenceAudioPath, new Uint8Array([82, 73, 70, 70]))
const settings: BreezeSettings = { server: 'http://fixture.invalid', timeoutMs: 10_000, maxTextLength: 100, styleName: 'default', referenceAudioPath, referenceText: 'fixture reference', instruction: 'fixed fixture voice', cfgScale: 3.8, seed: 7 }
const headers = { 'content-type': 'audio/pcm', 'x-sample-format': 's16le', 'x-sample-rate': '24000' }
afterAll(() => rmSync(dir, { recursive: true, force: true }))
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })

function streaming() {
  let controller!: ReadableStreamDefaultController<Uint8Array>
  const cancel = vi.fn()
  const body = new ReadableStream<Uint8Array>({ start(c) { controller = c }, cancel })
  return { body, response: new Response(body, { headers }), cancel, chunk: (bytes: number[]) => controller.enqueue(new Uint8Array(bytes)), end: () => controller.close(), fail: () => controller.error(new Error('fixture truncated stream')) }
}

describe('one shared Breeze HTTP transport', () => {
  it('waits for all chunks and wraps complete PCM without changing the reference voice', async () => {
    const stream = streaming()
    let init: RequestInit | undefined
    const fetchImpl: typeof fetch = async (_url, options) => { init = options; return stream.response }
    let done = false
    const result = requestBreeze(settings, 'fixture text', { fetchImpl, expression: 'quietly' }).then(value => { done = true; return value })
    await vi.waitFor(() => expect(stream.body.locked).toBe(true))
    stream.chunk([1]); await Promise.resolve(); expect(done).toBe(false)
    stream.chunk([0, 2, 0]); stream.end()
    const speech = await result
    expect([...speech.audio.subarray(44)]).toEqual([1, 0, 2, 0])
    expect(speech.mediaType).toBe('audio/wav')
    const form = init?.body as FormData
    expect(form.get('ref_text')).toBe('fixture reference')
    expect(form.get('seed')).toBe('7')
    expect(String(form.get('instruction'))).toContain('fixed fixture voice')
    expect(new Headers(init?.headers).get('X-Breeze-Client')).toBe('conscious-mind')
  })

  it('rejects a broken PCM stream instead of returning a partial WAV', async () => {
    const stream = streaming()
    const result = requestBreeze(settings, 'fixture', { fetchImpl: async () => stream.response })
    await vi.waitFor(() => expect(stream.body.locked).toBe(true))
    stream.chunk([1, 0]); stream.fail()
    await expect(result).rejects.toThrow('truncated')
  })

  it('cancels a stalled body and returns no audio even if the carrier ignores the signal', async () => {
    const stream = streaming(), controller = new AbortController()
    let sentSignal: AbortSignal | null | undefined
    const result = requestBreeze(settings, 'fixture', { signal: controller.signal, fetchImpl: async (_url, init) => { sentSignal = init?.signal; return stream.response } })
    await vi.waitFor(() => expect(stream.body.locked).toBe(true))
    stream.chunk([1, 0]); controller.abort()
    await expect(result).rejects.toMatchObject({ name: 'AbortError' })
    expect(sentSignal?.aborted).toBe(true)
    expect(stream.cancel).toHaveBeenCalledTimes(1)
    expect(stream.body.locked).toBe(false)
  })

  it('uses one deadline across waiting for headers and reading PCM, without resetting at 200', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const stream = streaming()
    let respond!: (response: Response) => void
    const fetchImpl = vi.fn(async () => new Promise<Response>(resolve => { respond = resolve }))
    const result = requestBreeze(settings, 'fixture', { fetchImpl }).catch(error => error as Error)
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1))
    await vi.advanceTimersByTimeAsync(8000); respond(stream.response)
    await vi.waitFor(() => expect(stream.body.locked).toBe(true))
    await vi.advanceTimersByTimeAsync(2000)
    expect(await result).toMatchObject({ name: 'TimeoutError' })
    expect(stream.cancel).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('cancels a late response after pre-header caller cancellation', async () => {
    const stream = streaming(), controller = new AbortController()
    let respond!: (response: Response) => void
    const fetchImpl = vi.fn(async () => new Promise<Response>(resolve => { respond = resolve }))
    const result = requestBreeze(settings, 'fixture', { signal: controller.signal, fetchImpl })
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1))
    controller.abort(); await expect(result).rejects.toMatchObject({ name: 'AbortError' })
    respond(stream.response)
    await vi.waitFor(() => expect(stream.cancel).toHaveBeenCalledTimes(1))
  })

  it.each([409, 503, 504])('reports HTTP %i without retrying or echoing the private body', async status => {
    const fetchImpl = vi.fn(async () => new Response('private body must not escape', { status, headers: { 'Retry-After': '2' } }))
    const result = await requestBreeze(settings, 'fixture', { fetchImpl }).catch(error => error as Error)
    expect(result).toBeInstanceOf(Error)
    expect((result as Error).message).toContain(String(status))
    expect((result as Error).message).not.toContain('private body')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it.each([{ bytes: [] }, { bytes: [1] }])('refuses empty or odd-length PCM: $bytes', async ({ bytes }) => {
    await expect(requestBreeze(settings, 'fixture', { fetchImpl: async () => new Response(new Uint8Array(bytes), { headers }) })).rejects.toThrow(/PCM/u)
  })

  it('uses the lower config/request budget and clears its timer on success', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    let init: RequestInit | undefined
    await requestBreeze(settings, 'fixture', { requestTimeoutMs: 60_000, fetchImpl: async (_url, options) => { init = options; return new Response(new Uint8Array([1, 0]), { headers }) } })
    expect(new Headers(init?.headers).get('X-Breeze-Timeout-Ms')).toBe('10000')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('rejects an invalid engineering label before file or HTTP work', async () => {
    const fetchImpl = vi.fn()
    await expect(requestBreeze(settings, 'fixture', { client: 'private:identifier', fetchImpl })).rejects.toThrow(/标签/u)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('rejects an already cancelled wrapper before config I/O or HTTP', async () => {
    const fetchImpl = vi.fn(), controller = new AbortController(); controller.abort()
    await expect(new BreezeTts('/not-a-real-config', fetchImpl).synthesize('fixture', undefined, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

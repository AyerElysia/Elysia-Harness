import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { BreezeVoice, clausesOf, timelineOf } from '../src/body/breeze'
import type { VoiceSettings } from '../src/body/breeze'
import { createSpeechAdapter, DEFAULT_VOICE } from '../src/body/tts'

/** A reference clip only has to exist and be readable; Breeze is faked here. */
const refDir = mkdtempSync(join(tmpdir(), 'livestream-voice-'))
const refPath = join(refDir, 'ref.wav')
writeFileSync(refPath, Buffer.from('RIFF....WAVEfmt ', 'utf8'))

const voice: VoiceSettings = {
  server: 'http://127.0.0.1:7862/',
  instruction: '保持参考音色',
  referenceAudioPath: refPath,
  referenceText: '参考',
  cfgScale: 3.8,
  seed: 42,
  timeoutMs: 5000,
  maxTextLength: 50,
}

function fakeFetch(pcm: Uint8Array, sampleRate = 24000): typeof fetch {
  return (async () => new Response(Uint8Array.from(pcm), {
    status: 200,
    headers: { 'content-type': 'audio/pcm', 'x-sample-format': 's16le', 'x-sample-rate': String(sampleRate) },
  })) as unknown as typeof fetch
}

afterAll(() => rmSync(refDir, { recursive: true, force: true }))

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('clause splitting', () => {
  it('splits on sentence enders and keeps the punctuation', () => {
    expect(clausesOf('你好呀。今天过得好吗？')).toEqual(['你好呀。', '今天过得好吗？'])
  })

  it('returns nothing for blank input', () => {
    expect(clausesOf('   ')).toEqual([])
  })
})

describe('subtitle timing', () => {
  it('covers the whole duration without gaps', () => {
    const timing = timelineOf(['一二三四。', '五六七八九十。'], 1000)
    expect(timing[0]?.start).toBe(0)
    expect(timing.at(-1)?.end).toBe(1000)
    expect(timing[1]?.start).toBe(timing[0]?.end)
  })

  it('gives a longer clause a longer share', () => {
    const timing = timelineOf(['短。', '这一句明显长很多很多很多。'], 1000)
    expect((timing[1]?.end ?? 0) - (timing[1]?.start ?? 0)).toBeGreaterThan((timing[0]?.end ?? 0) - (timing[0]?.start ?? 0))
  })

  it('returns nothing when there is nothing to time', () => {
    expect(timelineOf([], 1000)).toEqual([])
  })
})

describe('seed handling', () => {
  it('turns the config sentinel -1 into a stable positive seed', async () => {
    const seen: number[] = []
    const capture = (async (_url: string, init?: RequestInit) => {
      seen.push(Number((init?.body as FormData).get('seed')))
      return new Response(new Uint8Array(480), { status: 200, headers: { 'content-type': 'audio/pcm', 'x-sample-format': 's16le', 'x-sample-rate': '24000' } })
    }) as unknown as typeof fetch
    const client = new BreezeVoice('/nonexistent', capture)
    await client.speak('同一句话。', { voice: { ...voice, seed: -1 } })
    await client.speak('同一句话。', { voice: { ...voice, seed: -1 } })
    await client.speak('另一句话。', { voice: { ...voice, seed: -1 } })
    expect(seen[0]).toBeGreaterThanOrEqual(0)
    expect(seen[0]).toBe(seen[1])
    expect(seen[2]).not.toBe(seen[0])
  })

  it('keeps an explicit non-negative seed as given', async () => {
    let sent = -1
    const capture = (async (_url: string, init?: RequestInit) => {
      sent = Number((init?.body as FormData).get('seed'))
      return new Response(new Uint8Array(480), { status: 200, headers: { 'content-type': 'audio/pcm', 'x-sample-format': 's16le', 'x-sample-rate': '24000' } })
    }) as unknown as typeof fetch
    await new BreezeVoice('/nonexistent', capture).speak('嗯。', { voice: { ...voice, seed: 12345 } })
    expect(sent).toBe(12345)
  })
})

describe('breeze voice', () => {
  it('sends the deployment instruction and returns a WAV with duration', async () => {
    const pcm = new Uint8Array(24000 * 2) // exactly one second at 24 kHz s16le
    const client = new BreezeVoice('/nonexistent', fakeFetch(pcm))
    const line = await client.speak('你好呀。', { voice })
    expect(line.ms).toBe(1000)
    expect(line.timing).toHaveLength(1)
    expect(line.wav.byteLength).toBe(pcm.byteLength + 44)
    expect(String.fromCharCode(...line.wav.subarray(0, 4))).toBe('RIFF')
  })

  it('adds an expression direction without letting it replace the voice instruction', async () => {
    let seen: FormData | undefined
    const capture = (async (_url: string, init?: RequestInit) => {
      seen = init?.body as FormData
      return new Response(new Uint8Array(480), { status: 200, headers: { 'content-type': 'audio/pcm', 'x-sample-format': 's16le', 'x-sample-rate': '24000' } })
    }) as unknown as typeof fetch
    const client = new BreezeVoice('/nonexistent', capture)
    await client.speak('嗯。', { voice, expression: '轻快一点' })
    const instruction = String(seen?.get('instruction'))
    expect(instruction).toContain('保持参考音色')
    expect(instruction).toContain('轻快一点')
  })

  it('refuses a line over the configured limit before any request', async () => {
    const client = new BreezeVoice('/nonexistent', fakeFetch(new Uint8Array(2)))
    await expect(client.speak('字'.repeat(60), { voice })).rejects.toThrow(/上限/u)
  })

  it('surfaces a server status without echoing its body', async () => {
    const failing = (async () => new Response('模型没起来', { status: 503 })) as unknown as typeof fetch
    const client = new BreezeVoice('/nonexistent', failing)
    await expect(client.speak('你好', { voice })).rejects.toThrow(/503/u)
  })

  it('refuses a response that is not s16le', async () => {
    const wrong = (async () => new Response(new Uint8Array(4), { status: 200, headers: { 'content-type': 'audio/pcm', 'x-sample-format': 'mp3' } })) as unknown as typeof fetch
    const client = new BreezeVoice('/nonexistent', wrong)
    await expect(client.speak('你好', { voice })).rejects.toThrow(/音频格式/u)
  })
})

describe('shared Breeze admission', () => {
  it('submits concurrent calls directly to the shared service instead of a local queue', async () => {
    const pending: Array<(response: Response) => void> = []
    const capture = vi.fn(async () => new Promise<Response>(resolve => { pending.push(resolve) }))
    const client = new BreezeVoice('/nonexistent', capture)
    const first = client.speak('第一句。', { voice })
    const second = client.speak('第二句。', { voice })
    await vi.waitFor(() => expect(pending).toHaveLength(2))
    for (const resolve of pending) resolve(await fakeFetch(new Uint8Array(480))('http://fixture.invalid'))
    await Promise.all([first, second])
    expect(capture).toHaveBeenCalledTimes(2)
  })

  it('does not fetch when the caller is already cancelled', async () => {
    const capture = vi.fn(fakeFetch(new Uint8Array(480)))
    const controller = new AbortController(); controller.abort()
    await expect(new BreezeVoice('/nonexistent', capture).speak('取消的。', { voice, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
    expect(capture).not.toHaveBeenCalled()
  })

  it.each([409, 503, 504])('does not blindly retry an HTTP %i synthesis POST', async status => {
    const capture = vi.fn(async () => new Response('private service detail', { status }))
    const client = new BreezeVoice('/nonexistent', capture)
    await expect(client.speak('请求失败。', { voice })).rejects.toThrow(String(status))
    expect(capture).toHaveBeenCalledTimes(1)
  })

  it('labels its caller and applies an explicit whole-request budget without changing voice fields', async () => {
    let init: RequestInit | undefined
    const capture: typeof fetch = async (_url, options) => { init = options; return fakeFetch(new Uint8Array(480))('http://fixture.invalid') }
    await new BreezeVoice('/nonexistent', capture, { requestTimeoutMs: 1000 }).speak('你好。', { voice })
    const headers = new Headers(init?.headers)
    expect(headers.get('X-Breeze-Client')).toBe('dsh-livestream')
    expect(headers.get('X-Breeze-Timeout-Ms')).toBe('1000')
    expect((init?.body as FormData).get('ref_text')).toBe('参考')
  })
})

describe('upstream speech adapter with local Breeze', () => {
  const configPath = join(refDir, 'config.toml')
  writeFileSync(configPath, [
    '[tts]', 'backend = "breeze_tts2"', 'server = "http://127.0.0.1:7862"', 'timeout = 5', 'max_text_length = 50',
    '[[tts_styles]]', 'style_name = "default"', 'refer_wav_path = ' + JSON.stringify(refPath),
    'prompt_text = "参考"', 'breeze_instruction = "保持参考音色"', 'breeze_cfg_scale = 3.8', 'breeze_seed = 42',
  ].join('\n'))

  it('returns WAV and an explicitly estimated Unicode-safe subtitle timeline', async () => {
    const capture = vi.fn(fakeFetch(new Uint8Array(48_000)))
    const speak = createSpeechAdapter(configPath, capture)
    const result = await speak('你好😀。 下一句。', new AbortController().signal, DEFAULT_VOICE)
    expect(result).toMatchObject({ audioMime: 'audio/wav', durationMs: 1000, timingSource: 'estimated', words: [] })
    expect(Array.from(result.audio.subarray(0, 4))).toEqual([82, 73, 70, 70])
    expect(result.timeline.at(-1)).toEqual({ chars: [...'你好😀。 下一句。'].length, atMs: 1000 })
    const [, init] = capture.mock.calls[0]!
    expect((init?.body as FormData).get('instruction')).toBe('保持参考音色')
    expect(capture).toHaveBeenCalledTimes(1)
  })

  it('refuses a guest/cloud voice before reading config or contacting any server', async () => {
    const capture = vi.fn(fakeFetch(new Uint8Array(480)))
    const speak = createSpeechAdapter('/nonexistent', capture)
    await expect(speak('公开测试', new AbortController().signal, 'guest-voice-unconfigured')).rejects.toThrow(/音色/u)
    expect(capture).not.toHaveBeenCalled()
  })

  it('fails unavailable local config without a cloud fallback', async () => {
    const capture = vi.fn(fakeFetch(new Uint8Array(480)))
    const speak = createSpeechAdapter('/nonexistent', capture)
    await expect(speak('公开测试', new AbortController().signal)).rejects.toThrow()
    expect(capture).not.toHaveBeenCalled()
  })
})

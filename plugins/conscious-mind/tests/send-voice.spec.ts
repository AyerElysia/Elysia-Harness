import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BreezeTts, parseBreezeSettings, pcm16MonoToWav } from '../src/breeze-tts.ts'
import { OutboundDeliveryUnknown, OutboundVoice } from '../src/outbound.ts'
import { defineSendVoiceTool, deliverSendVoice } from '../src/send-voice.ts'
import type { SendVoiceArgs } from '../src/send-voice.ts'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

function args(patch: Partial<SendVoiceArgs> = {}): SendVoiceArgs {
  return {
    channel: 'kook',
    conversation: 'kook:direct:42',
    text: ' 妈妈，我在呀。[笑] ',
    expression_instruction: ' 再轻柔一点 ',
    ...patch,
  }
}

function synthesizer(audio = new Uint8Array([1, 2, 3, 4])) {
  return {
    synthesize: vi.fn(async () => ({ audio, mediaType: 'audio/wav' as const })),
  }
}

describe('BreezeTTS deployment contract', () => {
  it('uses only the default trusted voice and wraps mono PCM16 as WAV', () => {
    const settings = parseBreezeSettings(`
[tts]
backend = "breeze_tts2"
server = "http://127.0.0.1:7862/"
timeout = 1200
max_text_length = 1000
[[tts_styles]]
style_name = "default"
refer_wav_path = "/voice/ref.wav"
prompt_text = "固定参考文本"
breeze_instruction = "保持固定音色"
breeze_cfg_scale = 3.8
breeze_seed = -1
[[tts_styles]]
style_name = "happy"
refer_wav_path = "/voice/other.wav"
`)
    expect(settings).toMatchObject({
      server: 'http://127.0.0.1:7862', timeoutMs: 1_200_000, maxTextLength: 1000,
      referenceAudioPath: '/voice/ref.wav', referenceText: '固定参考文本', cfgScale: 3.8, seed: -1,
    })
    const wav = pcm16MonoToWav(new Uint8Array([1, 0, 2, 0]), 24_000)
    expect(Buffer.from(wav).subarray(0, 4).toString()).toBe('RIFF')
    expect(Buffer.from(wav).readUInt32LE(24)).toBe(24_000)
    expect(Buffer.from(wav).readUInt16LE(22)).toBe(1)
    expect(wav.byteLength).toBe(48)
  })

  it('preserves vocal events and appends expression control without exposing voice selection', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'elysia-breeze-'))
    directories.push(dir)
    const configPath = join(dir, 'config.toml')
    const referencePath = join(dir, 'ref.wav')
    await writeFile(referencePath, new Uint8Array([1, 2, 3, 4]))
    await writeFile(configPath, `
[tts]
backend = "breeze_tts2"
server = "http://127.0.0.1:7862"
timeout = 1200
max_text_length = 1000
[[tts_styles]]
style_name = "default"
refer_wav_path = "${referencePath}"
prompt_text = "固定参考文本"
breeze_instruction = "保持固定音色"
breeze_cfg_scale = 3.8
breeze_seed = 7
`)
    let form: FormData | undefined
    const tts = new BreezeTts(configPath, async (_url, init) => {
      form = init?.body as FormData
      return new Response(new Uint8Array([1, 0, 2, 0]), {
        status: 200,
        headers: { 'content-type': 'audio/pcm', 'x-sample-rate': '24000', 'x-sample-format': 's16le' },
      })
    })
    const voice = await tts.synthesize('妈妈，[笑]我在。', '轻柔一点')
    expect(voice.mediaType).toBe('audio/wav')
    expect(form?.get('text')).toBe('妈妈，[笑]我在。')
    expect(form?.get('ref_text')).toBe('固定参考文本')
    expect(form?.get('cfg_scale')).toBe('3.8')
    expect(form?.get('seed')).toBe('7')
    expect(String(form?.get('instruction'))).toContain('保持固定音色\n本次只调整表达方式，不改变参考音色、年龄感、身份或声线。\n本次表达控制：轻柔一点')
    expect(form?.get('ref_audio')).toBeInstanceOf(File)
  })
})

describe('send_voice tool and delivery', () => {
  it('publishes exactly the Breeze-facing schema', () => {
    const ctx = new Context()
    const tool = defineSendVoiceTool(new OutboundVoice(ctx), synthesizer())
    expect(tool.parameters.required).toEqual(['channel', 'conversation', 'text'])
    expect(tool.parameters.properties).not.toHaveProperty('path')
    expect(tool.parameters.properties).not.toHaveProperty('voice_style')
    expect(tool.parameters.properties).not.toHaveProperty('text_language')
    expect(tool.parameters.properties).not.toHaveProperty('ref_audio')
    expect(tool.description).toContain('[笑]')
    expect(tool.description).toContain('send_file')
    return ctx.fiber.dispose()
  })

  it('synthesizes once and sends the resulting audio through the selected channel', async () => {
    const ctx = new Context()
    try {
      const outbound = new OutboundVoice(ctx)
      const tts = synthesizer()
      const send = vi.fn(async () => ({ messageId: 'voice-1' }))
      outbound.register('kook', send)
      const result = await deliverSendVoice(outbound, tts, args())
      expect(tts.synthesize).toHaveBeenCalledOnce()
      expect(tts.synthesize).toHaveBeenCalledWith('妈妈，我在呀。[笑]', '再轻柔一点', undefined)
      expect(send).toHaveBeenCalledWith({
        conversation: 'kook:direct:42', audio: new Uint8Array([1, 2, 3, 4]), mediaType: 'audio/wav',
      })
      expect(result).toEqual({ status: 'sent', textCharacters: 10, audioBytes: 4, messageId: 'voice-1' })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('does not synthesize for an unavailable channel and does not retry synthesis or sending on failure', async () => {
    const ctx = new Context()
    try {
      const outbound = new OutboundVoice(ctx)
      const tts = synthesizer()
      expect(await deliverSendVoice(outbound, tts, args({ channel: 'qq' }))).toEqual({
        status: 'send-failed', error: '渠道未登记或不支持语音: qq',
      })
      expect(tts.synthesize).not.toHaveBeenCalled()
      outbound.register('kook', async () => { throw new Error('平台拒绝') })
      const failed = await deliverSendVoice(outbound, tts, args())
      expect(failed).toMatchObject({ status: 'send-failed', textCharacters: 10, audioBytes: 4, error: '平台拒绝' })
      expect(tts.synthesize).toHaveBeenCalledOnce()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('distinguishes synthesis failure and unknown delivery without losing audio metadata', async () => {
    const ctx = new Context()
    try {
      const outbound = new OutboundVoice(ctx)
      outbound.register('kook', async () => { throw new OutboundDeliveryUnknown() })
      const broken = { synthesize: vi.fn(async () => { throw new Error('Breeze 离线') }) }
      expect(await deliverSendVoice(outbound, broken, args())).toEqual({
        status: 'synthesis-failed', textCharacters: 10, error: 'Breeze 离线',
      })
      expect(await deliverSendVoice(outbound, synthesizer(), args())).toEqual({
        status: 'unknown', textCharacters: 10, audioBytes: 4, error: '投递状态未知',
      })
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

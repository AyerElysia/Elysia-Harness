/**
 * Minimal Breeze TTS 2 client for Elysia's fixed local voice. Deployment-owned
 * reference audio and sampling fields come from Elysium's existing TTS config;
 * the model can only supply spoken text and one expression direction.
 * @module @elysia/conscious-mind/breeze-tts
 */

import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'

export const ELYSIA_ROOT = process.env.ELYSIA_ROOT ?? '/home/ayerelysia/Elysia'
export const ELYSIUM_BREEZE_CONFIG = process.env.ELYSIA_BREEZE_CONFIG
  ?? join(ELYSIA_ROOT, 'Elysium/config/plugins/tts_voice_plugin/config.toml')

export interface BreezeSettings {
  server: string
  timeoutMs: number
  maxTextLength: number
  styleName: string
  referenceAudioPath: string
  referenceText: string
  instruction: string
  cfgScale: number
  seed: number
}

export interface SynthesizedVoice {
  audio: Uint8Array
  mediaType: 'audio/wav'
}

export interface VoiceSynthesizer {
  synthesize(text: string, expressionInstruction?: string, signal?: AbortSignal): Promise<SynthesizedVoice>
}

function section(source: string, name: string): string {
  const match = source.match(new RegExp(`(?:^|\\n)\\[${name}\\]\\n([\\s\\S]*?)(?=\\n\\[|$)`))
  return match?.[1] ?? ''
}

function field(body: string, key: string): string | number | undefined {
  const match = body.match(new RegExp(`^${key}\\s*=\\s*(.+)$`, 'm'))
  const raw = match?.[1]?.trim()
  if (raw === undefined) return undefined
  if (raw.startsWith('"') && raw.endsWith('"')) {
    const value: unknown = JSON.parse(raw)
    if (typeof value !== 'string') throw new Error(`配置 ${key} 必须是字符串`)
    return value
  }
  const value = Number(raw)
  return Number.isFinite(value) ? value : raw
}

function stringField(body: string, key: string, fallback = ''): string {
  const value = field(body, key)
  return typeof value === 'string' ? value.trim() : fallback
}

function numberField(body: string, key: string, fallback: number): number {
  const value = field(body, key)
  return typeof value === 'number' ? value : fallback
}

/** Parse only the trusted Breeze fields used by this transport. */
export function parseBreezeSettings(source: string): BreezeSettings {
  const tts = section(source, 'tts')
  if (stringField(tts, 'backend') !== 'breeze_tts2') throw new Error('TTS 后端不是 breeze_tts2')
  const styles = source.split('[[tts_styles]]').slice(1)
  const style = styles.find(block => stringField(block, 'style_name') === 'default')
  if (style === undefined) throw new Error('Breeze 配置缺少 default 音色')
  const settings: BreezeSettings = {
    server: stringField(tts, 'server').replace(/\/+$/u, ''),
    timeoutMs: numberField(tts, 'timeout', 180) * 1000,
    maxTextLength: numberField(tts, 'max_text_length', 1000),
    styleName: 'default',
    referenceAudioPath: stringField(style, 'refer_wav_path'),
    referenceText: stringField(style, 'prompt_text'),
    instruction: stringField(style, 'breeze_instruction'),
    cfgScale: numberField(style, 'breeze_cfg_scale', 3.8),
    seed: numberField(style, 'breeze_seed', -1),
  }
  const url = new URL(settings.server)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Breeze 服务地址必须使用 HTTP(S)')
  if (!Number.isFinite(settings.timeoutMs) || settings.timeoutMs <= 0) throw new Error('Breeze timeout 必须为正数')
  if (!Number.isInteger(settings.maxTextLength) || settings.maxTextLength < 1) throw new Error('Breeze max_text_length 无效')
  if (settings.referenceAudioPath.length === 0 || settings.referenceText.length === 0 || settings.instruction.length === 0) {
    throw new Error('Breeze 固定音色配置不完整')
  }
  if (!Number.isFinite(settings.cfgScale) || settings.cfgScale <= 0 || settings.cfgScale > 5) throw new Error('Breeze cfg_scale 无效')
  if (!Number.isInteger(settings.seed) || settings.seed < -1 || settings.seed > 2_147_483_647) throw new Error('Breeze seed 无效')
  return settings
}

function stableSeed(styleName: string, text: string, configured: number): number {
  if (configured >= 0) return configured
  const digest = createHash('blake2s256').update(`${styleName}\0${text}`, 'utf8').digest()
  return digest.readUInt32LE(0) & 0x7fffffff
}

/** Wrap Breeze's mono signed-16-bit little-endian PCM in a canonical WAV header. */
export function pcm16MonoToWav(pcm: Uint8Array, sampleRate: number): Uint8Array {
  if (!Number.isInteger(sampleRate) || sampleRate < 1) throw new Error('Breeze 返回无效采样率')
  if (pcm.byteLength === 0 || pcm.byteLength % 2 !== 0) throw new Error('Breeze 返回无效 s16le PCM')
  const wav = Buffer.alloc(44 + pcm.byteLength)
  wav.write('RIFF', 0)
  wav.writeUInt32LE(36 + pcm.byteLength, 4)
  wav.write('WAVEfmt ', 8)
  wav.writeUInt32LE(16, 16)
  wav.writeUInt16LE(1, 20)
  wav.writeUInt16LE(1, 22)
  wav.writeUInt32LE(sampleRate, 24)
  wav.writeUInt32LE(sampleRate * 2, 28)
  wav.writeUInt16LE(2, 32)
  wav.writeUInt16LE(16, 34)
  wav.write('data', 36)
  wav.writeUInt32LE(pcm.byteLength, 40)
  wav.set(pcm, 44)
  return wav
}

/** One lazy-loaded client; synthesis never mutates the trusted voice settings. */
export class BreezeTts implements VoiceSynthesizer {
  private settingsPromise?: Promise<BreezeSettings>

  constructor(
    readonly configPath = ELYSIUM_BREEZE_CONFIG,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private settings(): Promise<BreezeSettings> {
    this.settingsPromise ??= readFile(this.configPath, 'utf8').then(parseBreezeSettings)
    return this.settingsPromise
  }

  async synthesize(text: string, expressionInstruction?: string, signal?: AbortSignal): Promise<SynthesizedVoice> {
    const settings = await this.settings()
    const characters = Array.from(text).length
    if (characters > settings.maxTextLength) {
      throw new Error(`口语超过 ${settings.maxTextLength} 字上限（当前 ${characters} 字）`)
    }
    const expression = expressionInstruction?.trim() ?? ''
    if (expression.length > 1000) throw new Error('expression_instruction 不能超过 1000 字符')
    const instruction = expression.length === 0 ? settings.instruction : [
      settings.instruction,
      '本次只调整表达方式，不改变参考音色、年龄感、身份或声线。',
      `本次表达控制：${expression}`,
    ].join('\n')
    const reference = await readFile(settings.referenceAudioPath)
    const form = new FormData()
    form.set('text', text)
    form.set('instruction', instruction)
    form.set('cfg_scale', String(settings.cfgScale))
    form.set('ref_text', settings.referenceText)
    form.set('seed', String(stableSeed(settings.styleName, text, settings.seed)))
    const referenceBytes = Uint8Array.from(reference)
    form.set('ref_audio', new Blob([referenceBytes.buffer], { type: 'audio/wav' }), basename(settings.referenceAudioPath))

    const timeout = AbortSignal.timeout(settings.timeoutMs)
    const response = await this.fetchImpl(`${settings.server}/v1/audio/speech`, {
      method: 'POST',
      body: form,
      signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
    })
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 1000)
      throw new Error(`BreezeTTS 请求失败: HTTP ${response.status}${detail.length > 0 ? ` ${detail}` : ''}`)
    }
    const contentType = response.headers.get('content-type')?.toLowerCase() ?? ''
    const sampleFormat = response.headers.get('x-sample-format')?.toLowerCase()
    const sampleRate = Number(response.headers.get('x-sample-rate'))
    if (!contentType.startsWith('audio/pcm') || sampleFormat !== 's16le') {
      throw new Error('BreezeTTS 返回了不支持的音频格式')
    }
    const pcm = new Uint8Array(await response.arrayBuffer())
    return { audio: pcm16MonoToWav(pcm, sampleRate), mediaType: 'audio/wav' }
  }
}

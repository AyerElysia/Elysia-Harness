/**
 * Breeze voice for the livestream surface. The synthesiser is the same local
 * Breeze server and the same deployment-owned reference clip the conscious
 * mind already uses; this module adds what a stage needs and send_voice does
 * not: an audio duration and a subtitle timeline.
 *
 * Breeze returns streamed s16le PCM and no alignment, so timing here is
 * **estimated** from character counts after splitting on punctuation. It is
 * good enough to highlight a subtitle roughly in step with the voice; it is
 * not word-level measurement and must not be presented as such.
 * @module @elysia/dsh-livestream/body/breeze
 */

import { access, readFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { parseBreezeSettings, requestBreeze, type BreezeSettings } from '@elysia/conscious-mind/src/breeze-tts.ts'
/** Deployment settings only: model callers cannot select another reference voice. */
export type VoiceSettings = Omit<BreezeSettings, 'styleName'>

/** A synthesised segment, ready to send to a stage. */
export interface SynthesizedLine {
  /** Canonical WAV containing the whole line. */
  wav: Uint8Array
  /** Playback length in milliseconds. */
  ms: number
  /** Estimated per-clause timing; see the module note. */
  timing: { text: string; start: number; end: number }[]
}

/** Splitting points: sentence enders and clause separators, kept with their clause. */
const CLAUSE_SPLIT = /(?<=[。！？!?…；;\n])/u

/** Characters that get no speaking time of their own. */
const SILENT = /[\s"'“”‘’（）()《》【】\[\]—…·]/gu

/**
 * Split text into clauses the stage can highlight in turn.
 * @param text - one spoken line.
 * @returns non-empty clauses in reading order.
 */
export function clausesOf(text: string): string[] {
  return text
    .split(CLAUSE_SPLIT)
    .map(clause => clause.trim())
    .filter(clause => clause.length > 0)
}

/**
 * Weight one clause by how long it takes to say, not by how many characters
 * it has: punctuation costs time, whitespace does not.
 * @param clause - one clause of a line.
 */
function weight(clause: string): number {
  const spoken = clause.replace(SILENT, '')
  const pauses = clause.length - spoken.length
  return Math.max(1, spoken.length + pauses * 0.6)
}

/**
 * Distribute a known total duration across clauses by weight.
 * @param clauses - {@link clausesOf} output.
 * @param totalMs - measured duration of the whole line.
 */
export function timelineOf(clauses: readonly string[], totalMs: number): { text: string; start: number; end: number }[] {
  if (clauses.length === 0) return []
  const weights = clauses.map(weight)
  const sum = weights.reduce((left, right) => left + right, 0)
  let cursor = 0
  return clauses.map((text, index) => {
    const span = Math.round((weights[index]! / sum) * totalMs)
    const start = cursor
    cursor = index === clauses.length - 1 ? totalMs : Math.min(totalMs, cursor + span)
    return { text, start, end: cursor }
  })
}

/** Stage projection over the common client; the shared server owns all admission/queueing. */
export class BreezeVoice {
  private settingsPromise: Promise<BreezeSettings> | undefined

  constructor(
    readonly configPath: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly options: { requestTimeoutMs?: number } = {},
  ) {}

  private settings(override: VoiceSettings | undefined): Promise<BreezeSettings> {
    if (override !== undefined) return Promise.resolve(settingsFrom(override))
    this.settingsPromise ??= readFile(this.configPath, 'utf8').then(parseBreezeSettings)
    return this.settingsPromise
  }

  /** Check deployment inputs without making a synthesis request. */
  async ready(): Promise<void> {
    const settings = await this.settings(undefined)
    await access(settings.referenceAudioPath, constants.R_OK)
  }

  async speak(
    text: string,
    opts: { voice?: VoiceSettings; expression?: string; signal?: AbortSignal } = {},
  ): Promise<SynthesizedLine> {
    opts.signal?.throwIfAborted()
    const settings = await this.settings(opts.voice)
    const speech = await requestBreeze(settings, text, {
      expression: opts.expression, signal: opts.signal, fetchImpl: this.fetchImpl,
      client: 'dsh-livestream', requestTimeoutMs: this.options.requestTimeoutMs,
    })
    return { wav: speech.audio, ms: speech.durationMs, timing: timelineOf(clausesOf(text), speech.durationMs) }
  }
}

/** Project the plugin's own config onto the fields Breeze needs. */
function settingsFrom(voice: VoiceSettings): BreezeSettings {
  return {
    server: voice.server.replace(/\/+$/u, ''),
    timeoutMs: voice.timeoutMs,
    maxTextLength: voice.maxTextLength,
    styleName: 'default',
    referenceAudioPath: voice.referenceAudioPath,
    referenceText: voice.referenceText,
    instruction: voice.instruction,
    cfgScale: voice.cfgScale,
    seed: voice.seed,
  }
}

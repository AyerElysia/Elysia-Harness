/**
 * Standing-prompt prefix for Elysia's conscious mind.
 *
 * The section text callback is synchronous, and a `complete` section is fixed
 * before the async `system-prompt/assemble` waterfall. Each assemble therefore
 * re-reads the directory with a synchronous read. There is no file watcher.
 * @module @elysia/conscious-mind
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { isAbsolute, resolve } from 'node:path'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import { StandingPromptError, assertStandingFileName, loadStandingPrompt } from './load.ts'
import { InboundPending } from './pending.ts'
import { OutboundText, OutboundVoice } from './outbound.ts'
import { BreezeTts, ELYSIUM_BREEZE_CONFIG } from './breeze-tts.ts'
import { defineSendTextTool } from './send-text.ts'
import { defineSendVoiceTool } from './send-voice.ts'
import { createMainSessionTurn } from './main-session.ts'

export { StandingPromptError, loadStandingPrompt }
export { OutboundDeliveryUnknown, OutboundText, OutboundVoice } from './outbound.ts'
export type { OutboundDelivery, OutboundReceipt, OutboundSend, OutboundSendVoice, OutboundVoiceDelivery } from './outbound.ts'
export { BreezeTts, ELYSIUM_BREEZE_CONFIG, parseBreezeSettings, pcm16MonoToWav } from './breeze-tts.ts'
export type { BreezeSettings, SynthesizedVoice, VoiceSynthesizer } from './breeze-tts.ts'
export { defineSendTextTool, deliverSendText, splitOutboundText } from './send-text.ts'
export type { SendTextArgs, SendTextResult, SentSegment } from './send-text.ts'
export { defineSendVoiceTool, deliverSendVoice } from './send-voice.ts'
export type { SendVoiceArgs, SendVoiceResult } from './send-voice.ts'
export { InboundPending, COLLECT_MS, takeConversationBatch } from './pending.ts'
export type { PendingTurn } from './pending.ts'
export { inboundEventText } from './inbound.ts'
export type { InboundContentPart, InboundEvent, InboundEventInput, InboundEventInputContent } from './inbound.ts'
export { createSendTextTurn } from './turn.ts'
export type { SendTextTurn } from './turn.ts'
export { definePassTool } from './pass.ts'
export type { PassArgs, PassResult } from './pass.ts'
export { MAIN_SESSION_CWD, MAIN_SESSION_ID, composeMainAgent, createMainSessionTurn, formatInboundBatch, formatInboundEvent } from './main-session.ts'

/** Section name restored as the whole system prompt. */
export const STANDING_PROMPT_SECTION = 'elysia:standing-prompts'

/** Cordis plugin name. */
export const name = 'elysia-conscious-mind'

/** Prompt registry for the prefix. Tools attach when `tools` is present. */
export const inject = ['systemPrompt']

/** Plugin config: standing files and the existing Breeze deployment config. */
export interface Config {
  /** Absolute directory, or a path relative to the process cwd at mount time. */
  baseDir: string
  /** File names inside `baseDir`, concatenated in this order. */
  files: string[]
  /** Files that abort the turn when missing or empty. Defaults to `SOUL.md`. */
  required?: string[]
  /** Existing Elysium BreezeTTS config, loaded lazily on the first synthesis. */
  breezeConfigPath?: string
}

/** Runtime schema for the standing-prompt directory. */
export const Config: z<Config> = z.object({
  baseDir: z.string().required(),
  files: z.array(z.string()).required(),
  required: z.array(z.string()).default(['SOUL.md']),
  breezeConfigPath: z.string().default(ELYSIUM_BREEZE_CONFIG),
})

/**
 * Register the standing-prompt directory as the complete system prompt.
 * @param ctx - context that already provides `systemPrompt`.
 * @param config - directory, ordered file names, required files, and Breeze config.
 */
export function apply(ctx: Context, config: Config): void {
  const required = config.required ?? ['SOUL.md']
  for (const fileName of config.files) assertStandingFileName(fileName)
  for (const fileName of required) {
    assertStandingFileName(fileName)
    if (!config.files.includes(fileName)) {
      throw new StandingPromptError(`required standing prompt is not listed: ${fileName}`)
    }
  }
  const baseDir = isAbsolute(config.baseDir) ? config.baseDir : resolve(process.cwd(), config.baseDir)
  const outbound = new OutboundText(ctx)
  const outboundVoice = new OutboundVoice(ctx)
  const breeze = new BreezeTts(config.breezeConfigPath ?? ELYSIUM_BREEZE_CONFIG)
  const pending = new InboundPending(ctx)
  ctx.effect(() => () => pending.stop())
  ctx.inject(['agents', 'agentDefaultModel', 'agentLoop', 'sessionPersistence'], scoped => {
    pending.replyWith(createMainSessionTurn(scoped))
  })
  ctx.effect(() => ctx.systemPrompt.section({
    name: STANDING_PROMPT_SECTION,
    order: 0,
    complete: true,
    interpolate: false,
    text: () => loadStandingPrompt(baseDir, config.files, required),
  }), 'elysia-conscious-mind.section()')
  const tools = ctx.reflect.get('tools', false) as Context['tools'] | undefined
  if (tools !== undefined) {
    ctx.effect(() => tools.register(defineSendTextTool(outbound)), 'elysia-conscious-mind.send_text()')
    ctx.effect(() => tools.register(defineSendVoiceTool(outboundVoice, breeze)), 'elysia-conscious-mind.send_voice()')
  } else {
    ctx.inject(['tools'], scoped => {
      scoped.effect(() => scoped.tools.register(defineSendTextTool(outbound)), 'elysia-conscious-mind.send_text()')
      scoped.effect(() => scoped.tools.register(defineSendVoiceTool(outboundVoice, breeze)), 'elysia-conscious-mind.send_voice()')
    })
  }
}

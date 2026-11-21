/**
 * Elysia's conscious-mind runtime: pending, outbound tools, and one long agent.
 * Standing prompts are mounted only inside that agent's scope, never globally.
 * @module @elysia/conscious-mind
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import { InboundPending } from './pending.ts'
import { OutboundText, OutboundVoice } from './outbound.ts'
import { BreezeTts, ELYSIUM_BREEZE_CONFIG } from './breeze-tts.ts'
import { defineSendTextTool } from './send-text.ts'
import { defineSendVoiceTool } from './send-voice.ts'
import { createMainSessionTurn } from './main-session.ts'
import * as PlanHost from '@elysia/proactive-system/plan-host'

export { StandingPromptError, loadStandingPrompt } from './load.ts'
export { STANDING_PROMPT_SECTION } from './standing-prompts.ts'
export type { Config as StandingPromptPluginConfig } from './standing-prompts.ts'
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
export type { MainSessionConfig, MainSessionTurn } from './main-session.ts'
export { mountFileCapabilities } from './file-capabilities.ts'

/** Cordis plugin name. */
export const name = 'elysia-conscious-mind'

/** Prompt registry required by the scoped main-agent composition. */
export const inject = ['systemPrompt']

/** Main-agent standing files and the existing Breeze deployment config. */
export interface Config {
  /** IANA fallback clock zone for IM and scheduled inputs. Defaults to Asia/Shanghai. */
  timeZone?: string
  /** Absolute directory, or a path relative to the process cwd at mount time. */
  baseDir: string
  /** File names inside `baseDir`, concatenated in this order. */
  files: string[]
  /** Files that abort the turn when missing or empty. Defaults to `SOUL.md`. */
  required?: string[]
  /** Existing Elysium BreezeTTS config, loaded lazily on the first synthesis. */
  breezeConfigPath?: string
  /** Elysia's only recursively readable and writable workspace. */
  workspaceDir?: string
  /** Maintenance-only standing-prompt backup directory. */
  backupDir?: string
  /** Maximum UTF-8 bytes in one standing prompt. */
  maxPromptBytes?: number
  /** Enable scoped native reminders with a main-owner startup gate. Defaults to false. */
  scheduledPlans?: boolean
  /** Maximum retained backups per standing prompt. */
  backupRetention?: number
}

/** Runtime schema for the main agent's standing-prompt directory. */
export const Config: z<Config> = z.object({
  timeZone: z.string().default('Asia/Shanghai'),
  baseDir: z.string().required(),
  files: z.array(z.string()).required(),
  required: z.array(z.string()).default(['SOUL.md']),
  breezeConfigPath: z.string().default(ELYSIUM_BREEZE_CONFIG),
  workspaceDir: z.string().default('/home/ayerelysia/Elysia/Data/workspace'),
  backupDir: z.string().default('/home/ayerelysia/Elysia/Elysium/Elysia-Harness/homes/web/standing-prompt-backups'),
  maxPromptBytes: z.number().default(65536),
  backupRetention: z.number().default(20),
  scheduledPlans: z.boolean().default(false),
})

/**
 * Mount channels, pending, and outbound tools without contributing a global prompt.
 * @param ctx - deployment context with `systemPrompt` and optional tool/agent services.
 * @param config - main-agent standing files and Breeze config.
 */
export function apply(ctx: Context, config: Config): void {
  const outbound = new OutboundText(ctx)
  const outboundVoice = new OutboundVoice(ctx)
  const breeze = new BreezeTts(config.breezeConfigPath ?? ELYSIUM_BREEZE_CONFIG)
  const pending = new InboundPending(ctx)
  ctx.effect(() => () => pending.stop())
  ctx.inject(['agents', 'agentDefaultModel', 'agentLoop', 'sessionPersistence'], async scoped => {
    const turn = createMainSessionTurn(scoped, {
      baseDir: config.baseDir,
      files: config.files,
      required: config.required ?? ['SOUL.md'],
      complete: true,
      timeZone: config.timeZone ?? 'Asia/Shanghai',
      scheduledPlans: config.scheduledPlans ?? false,
      ...config.workspaceDir === undefined ? {} : { workspaceDir: config.workspaceDir },
      ...config.backupDir === undefined ? {} : { backupDir: config.backupDir },
      ...config.maxPromptBytes === undefined ? {} : { maxPromptBytes: config.maxPromptBytes },
      ...config.backupRetention === undefined ? {} : { backupRetention: config.backupRetention },
    })
    pending.replyWith(turn)
    if (config.scheduledPlans === true) await scoped.plugin(PlanHost, { ready: turn.ready })
  })
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

/**
 * The conscious mind's long session. One agent, one session id, driven by the
 * Harness agent loop — not by a side fetch to a chat-completions endpoint.
 *
 * A pending batch becomes one user message in that session, then the agent
 * runs until idle. She answers through send_text, stays silent through pass,
 * and nothing in the runtime forces either choice.
 * @module @elysia/conscious-mind/main-session
 */

import type { Context } from '@deepseek-ai/cordis'
import { resolve } from 'node:path'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import { createUserMessage, type ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-tools'
import type { InboundEvent } from './inbound.ts'
import type { PendingTurn } from './pending.ts'
import { definePassTool } from './pass.ts'
import { StandingPromptError } from './load.ts'
import * as StandingPrompt from './standing-prompts.ts'
import type { Config as StandingPromptConfig } from './standing-prompts.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Ready concrete agent factory; injected without importing its source tree. */
    agentLoop: unknown
    /** Durable session storage required before the main agent can resume. */
    sessionPersistence: unknown
  }
}

/** The one persistent session of the conscious mind. Resume first, create once. */
export const MAIN_SESSION_ID = brandString<SessionId>('elysia-conscious-mind')

/** Stable identity anchor. Never change this for an existing main session. */
export const MAIN_SESSION_CWD = '/home/ayerelysia/Elysia/Elysium/Elysia-Harness/homes/web/conscious-mind'

/** Render event metadata immediately before its original text and image parts. */
export function formatInboundEvent(message: InboundEvent, index: number): string {
  const sender = message.senderName.length > 0
    ? `${message.senderName}(${message.senderId})`
    : message.senderId
  const id = message.messageId.length > 0 ? ` ｜ 消息id ${message.messageId}` : ''
  return `[${index + 1}] 渠道 ${message.channel} ｜ 会话 ${message.conversation}${id}\n${sender}：`
}

/** Render one batch as native text and durable image blocks in arrival order. */
export function formatInboundBatch(batch: readonly InboundEvent[]): ContentBlock[] {
  const content: ContentBlock[] = []
  const appendText = (text: string): void => {
    const last = content.at(-1)
    if (last?.type === 'text') last.text += text
    else content.push({ type: 'text', text })
  }
  batch.forEach((message, index) => {
    appendText(`${index === 0 ? '' : '\n\n'}${formatInboundEvent(message, index)}`)
    for (const part of message.content) {
      if (part.type === 'text') appendText(part.text)
      else content.push({ type: 'image', attachment: part.attachment })
    }
  })
  return content
}

interface MainAgentComposition {
  fingerprint: string
  ready: Promise<void>
  complete: boolean
}

const mainCompositions = new WeakMap<Context, MainAgentComposition>()

function fixedPromptConfig(config: StandingPromptConfig): StandingPromptConfig {
  if (config.baseDir.length === 0) throw new StandingPromptError('standing prompt baseDir must not be empty')
  return {
    baseDir: resolve(config.baseDir),
    files: [...config.files],
    required: [...config.required ?? ['SOUL.md']],
    complete: config.complete ?? true,
  }
}

/**
 * Compose the main agent's scoped prompt and tools. The same fixed standing
 * composition is used on create and resume; other sessions select their own.
 */
export function composeMainAgent(agentCtx: Context, promptConfig: StandingPromptConfig): Promise<void> {
  let config: StandingPromptConfig
  try {
    config = fixedPromptConfig(promptConfig)
  } catch (error) {
    return Promise.reject(error)
  }
  const fingerprint = JSON.stringify(config)
  const existing = mainCompositions.get(agentCtx)
  if (existing !== undefined) {
    if (existing.fingerprint !== fingerprint) {
      return Promise.reject(new Error('主意识作用域已使用不同的固定提示词组合，拒绝替换'))
    }
    return existing.ready
  }
  const composition: MainAgentComposition = { fingerprint, ready: Promise.resolve(), complete: false }
  mainCompositions.set(agentCtx, composition)
  composition.ready = (async () => {
    const prompt = await agentCtx.plugin(StandingPrompt, config)
    let removePass: (() => void) | undefined
    let removeRestriction: (() => void) | undefined
    try {
      removePass = agentCtx.tools.register(definePassTool())
      removeRestriction = agentCtx.tools.restrict({ allow: ['send_text', 'send_voice', 'read_image'] })
      agentCtx.effect(() => () => {
        if (mainCompositions.get(agentCtx) === composition) mainCompositions.delete(agentCtx)
      }, 'elysia-conscious-mind.composition()')
      composition.complete = true
    } catch (error) {
      removeRestriction?.()
      removePass?.()
      await prompt.dispose()
      throw error
    }
  })().catch((error: unknown) => {
    if (mainCompositions.get(agentCtx) === composition) mainCompositions.delete(agentCtx)
    throw error
  })
  return composition.ready
}

async function resumeOrCreateMainAgent(ctx: Context, promptConfig: StandingPromptConfig): Promise<AgentHandle> {
  const borrowed = (): AgentHandle | undefined => {
    const agent = ctx.agents.get(MAIN_SESSION_ID)
    if (agent === undefined) return undefined
    const composition = mainCompositions.get(agent.ctx)
    if (composition?.complete !== true || composition.fingerprint !== JSON.stringify(fixedPromptConfig(promptConfig))) {
      throw new Error('已存在的主意识实例尚未完成本插件的提示词与工具隔离装配，拒绝借用；请关闭该实例后由主意识重新恢复')
    }
    return { agent, dispose: async () => {} }
  }
  const existing = borrowed()
  if (existing !== undefined) return existing
  const setup = (agentCtx: Context): Promise<void> => composeMainAgent(agentCtx, promptConfig)
  const agentOptions = ctx.agentDefaultModel.currentSelection()
  const meta = { cwd: MAIN_SESSION_CWD }
  try {
    return await ctx.agents.resume({ resumeSessionId: MAIN_SESSION_ID, agentOptions, setup })
  } catch (error) {
    // The web UI may have resumed the visible session while resume was loading.
    // Reuse that live Agent instead of trying to create the same id again.
    const concurrent = borrowed()
    if (concurrent !== undefined) return concurrent
    process.stderr.write(`主意识 resume 失败：${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}\n`)
    return await ctx.agents.create({ sessionId: MAIN_SESSION_ID, agentOptions, setup, meta })
  }
}

/**
 * Build the pending turn that drives the long session through the Harness
 * agent registry. The handle is memoized; a failed resume/create is retried
 * on the next batch instead of wedging the queue.
 * @param ctx - context providing `agents` and the scoped tool world.
 * @param promptConfig - fixed standing composition for this existing main session.
 * @returns the pending-turn handler.
 */
export function createMainSessionTurn(ctx: Context, selectedPromptConfig: StandingPromptConfig): PendingTurn {
  const promptConfig = fixedPromptConfig(selectedPromptConfig)
  let mainAgent: Promise<AgentHandle> | undefined
  const ensure = (): Promise<AgentHandle> => {
    mainAgent ??= resumeOrCreateMainAgent(ctx, promptConfig).catch((error: unknown) => {
      mainAgent = undefined
      throw error
    })
    return mainAgent
  }
  // Resume with our scoped setup before the Web UI can adopt the visible
  // session under its default preset. Waiting for the first inbound batch is
  // too late: that path used to borrow an unscoped, 32-tool agent. Global
  // read_image may mount slightly later than agentLoop, so retry until the
  // complete scoped world is ready instead of falling back to that preset.
  let preheatRetry: ReturnType<typeof setTimeout> | undefined
  const preheat = (): void => {
    void ensure().catch((error: unknown) => {
      process.stderr.write(`主意识预热失败：${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}\n`)
      preheatRetry = setTimeout(preheat, 1000)
      preheatRetry.unref()
    })
  }
  preheat()
  ctx.effect(() => () => {
    if (preheatRetry !== undefined) clearTimeout(preheatRetry)
    void mainAgent?.then(handle => handle.dispose()).catch(() => {})
  }, 'elysia-conscious-mind.main-session()')
  return async batch => {
    const handle = await ensure()
    handle.agent.followup(createUserMessage({
      content: formatInboundBatch(batch),
      source: { kind: 'user' },
    }))
    await handle.agent.whenIdle()
  }
}

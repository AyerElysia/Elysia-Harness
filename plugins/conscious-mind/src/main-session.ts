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
import { brandString } from '@deepseek-ai/dsh-brand'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import { createUserMessage, type ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-tools'
import type { InboundEvent } from './inbound.ts'
import type { PendingTurn } from './pending.ts'
import { definePassTool } from './pass.ts'

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

/**
 * Compose the main agent's scoped world: pass exists only here. Global tools
 * are limited to send_text and read_image; code, file mutation,
 * and search stay masked.
 */
export function composeMainAgent(agentCtx: Context): void {
  agentCtx.tools.register(definePassTool())
  agentCtx.tools.restrict({ allow: ['send_text', 'read_image'] })
}

async function resumeOrCreateMainAgent(ctx: Context): Promise<AgentHandle> {
  const borrowed = (): AgentHandle | undefined => {
    const agent = ctx.agents.get(MAIN_SESSION_ID)
    return agent === undefined ? undefined : { agent, dispose: async () => {} }
  }
  const existing = borrowed()
  if (existing !== undefined) return existing
  const setup = (agentCtx: Context): void => { composeMainAgent(agentCtx) }
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
 * @returns the pending-turn handler.
 */
export function createMainSessionTurn(ctx: Context): PendingTurn {
  let mainAgent: Promise<AgentHandle> | undefined
  const ensure = (): Promise<AgentHandle> => {
    mainAgent ??= resumeOrCreateMainAgent(ctx).catch((error: unknown) => {
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

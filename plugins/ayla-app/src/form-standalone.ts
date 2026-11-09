/**
 * The standalone form: the plugin's own fixed session and its own send_text.
 *
 * This form exists so the channel works in any dsh, without the conscious mind
 * (REQUIREMENTS.zh.md §4). It owns one session id, one cwd, and one tool; it
 * installs no standing prompt, because the workspace AGENTS.md is already
 * injected by dsh and a second prompt would compete with it.
 *
 * The tool is registered inside the agent scope, never globally: a global
 * send_text would hand every unrelated session in the host a tool that posts
 * into Ayla.
 * @module @elysia/ayla-app/form-standalone
 */

import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { Agent, AgentHandle, AgentOptions } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-tools'
import type { InboundEvent } from './inbound.ts'
import { defineSendTextTool } from './outbound.ts'
import type { AylaSend } from './outbound.ts'

/** The one session the standalone form uses. Never change it for an existing install. */
export const AYLA_SESSION_ID = brandString<SessionId>('ayla-channel')

/**
 * Render event metadata immediately before its original text and image parts.
 * @param message - one admitted event.
 * @param index - position in the batch, used as the visible ordinal.
 * @returns the header line ending in a full-width colon.
 */
export function formatInboundEvent(message: InboundEvent, index: number): string {
  const sender = message.senderName.length > 0
    ? `${message.senderName}(${message.senderId})`
    : message.senderId
  const id = message.messageId.length > 0 ? ` ｜ 消息id ${message.messageId}` : ''
  return `[${String(index + 1)}] 渠道 ${message.channel} ｜ 会话 ${message.conversation}${id}\n${sender}：`
}

/**
 * Render one batch as native text and durable image blocks in arrival order.
 * @param batch - events waiting at this moment.
 * @returns message content for the session.
 */
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
 * Compose the standalone agent's scoped world.
 *
 * `agentCtx` is the agent scope, so the registration disappears with the
 * agent and never appears in the host's global tool table.
 * @param agentCtx - unpublished agent scope.
 * @param sender - resolves the current Ayla sender per call, so a reconnect
 *   after the agent was created is picked up.
 */
export function composeAylaAgent(agentCtx: Context, sender: () => AylaSend | undefined): void {
  agentCtx.tools.register(defineSendTextTool(sender))
}

/**
 * The default model a host offers for an agent created without one.
 *
 * Probed with `ctx.get` rather than declared in `inject`: the plugin must mount
 * in a dsh that has no default-model plugin, and an agent created without a
 * selection is still a valid agent.
 */
export interface AylaModelPort {
  currentSelection(): AgentOptions
}

/** What the standalone form needs from the plugin. */
export interface StandaloneFormOptions {
  /** Working directory for the session; empty uses the process cwd. */
  cwd: string
  /** Current Ayla sender, re-read per delivery so a reconnect is picked up. */
  sender(): AylaSend | undefined
  /** Default model selection, or undefined when the host has none. */
  model?: AylaModelPort
  /** Logger for resume/create failures. */
  logger: { info(message: string): void; warn(message: string): void }
}

/** A pending-turn handler in the shape the plugin's inbound path needs. */
export type StandaloneTurn = (batch: readonly InboundEvent[]) => Promise<void>

function sessionCwd(configured: string): string {
  const value = configured.trim()
  return value.length > 0 ? value : process.cwd()
}

/**
 * Build the standalone pending-turn handler.
 *
 * The agent is memoized; a failed resume or create is cleared so the next
 * batch retries instead of wedging the queue forever.
 * @param ctx - context providing `agents`.
 * @param options - cwd, sender lookup, optional default model, and logger.
 * @returns a handler that queues one user message per batch and waits for idle.
 */
export function createStandaloneTurn(ctx: Context, options: StandaloneFormOptions): StandaloneTurn {
  const cwd = sessionCwd(options.cwd)
  let handle: Promise<AgentHandle> | undefined

  const borrowed = (): AgentHandle | undefined => {
    const agent: Agent | undefined = ctx.agents.get(AYLA_SESSION_ID)
    return agent === undefined ? undefined : { agent, dispose: async () => {} }
  }

  const open = async (): Promise<AgentHandle> => {
    const live = borrowed()
    if (live !== undefined) return live
    const setup = (agentCtx: Context): void => { composeAylaAgent(agentCtx, options.sender) }
    const agentOptions = options.model?.currentSelection()
    const meta = { cwd }
    const selection = agentOptions === undefined ? {} : { agentOptions }
    try {
      return await ctx.agents.resume({ resumeSessionId: AYLA_SESSION_ID, ...selection, setup })
    } catch (error) {
      // The web UI may have adopted the session while resume was loading.
      const concurrent = borrowed()
      if (concurrent !== undefined) return concurrent
      options.logger.warn('Ayla session resume 失败，改为新建: ' + (error instanceof Error ? error.message : String(error)))
      return await ctx.agents.create({ sessionId: AYLA_SESSION_ID, ...selection, setup, meta })
    }
  }

  const ensure = (): Promise<AgentHandle> => {
    handle ??= open().catch((error: unknown) => {
      handle = undefined
      throw error
    })
    return handle
  }

  ctx.effect(() => () => {
    const current = handle
    handle = undefined
    void current?.then(entry => entry.dispose()).catch(() => {
      // Disposal of an agent that never opened has nothing left to release.
    })
  }, 'elysia-ayla-app.standalone-session()')

  return async batch => {
    if (batch.length === 0) return
    const entry = await ensure()
    entry.agent.followup(createUserMessage({
      content: formatInboundBatch(batch),
      source: { kind: 'user' },
    }))
    await entry.agent.whenIdle()
  }
}

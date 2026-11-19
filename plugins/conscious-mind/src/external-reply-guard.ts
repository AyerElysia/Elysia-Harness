import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type ToolResultMessage } from '@deepseek-ai/dsh-llm'
import type { SessionSeq } from '@deepseek-ai/dsh-session'
import { hasPlatformDialogueInput } from './reply-origin.ts'

const REPLY_TOOLS = new Set(['send_text', 'send_voice', 'pass'])
const CORRECTION = [
  '本轮包含外部渠道消息，但还没有调用 send_text、send_voice 或 pass。',
  'DSH 正文不会投递到外部渠道。必须选择其中一个工具：回复文字用 send_text，回复语音用 send_voice，不回复用 pass。',
  '如果本轮也有 DSH 输入，可以在完成工具选择后继续用正文回应 DSH。',
].join('\n')

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'elysia-external-reply-guard': {
      kind: 'elysia-external-reply-guard'
      form: 'notice'
      summary: string
    }
  }
}

/**
 * The tool value a result message renders as its single text block, or undefined
 * when the content is not JSON: pruning and surface replacement may rewrite an
 * old result into prose, and no reply tool puts a second text block there.
 */
function parseToolValue(message: ToolResultMessage): Record<string, unknown> | undefined {
  const block = message.content.find(entry => entry.type === 'text')
  if (block?.type !== 'text') return undefined
  try {
    const value: unknown = JSON.parse(block.text)
    return value !== null && typeof value === 'object' ? value as Record<string, unknown> : undefined
  } catch {
    // Unreadable content is not evidence of failure; the caller keeps the choice standing.
    return undefined
  }
}

/**
 * Whether one reply tool result proves that nothing was delivered. A channel-level
 * full failure reports `sent: []` on an otherwise successful call, so isError alone
 * would let a dropped platform message end the turn silently.
 */
function showsFailedDelivery(name: string, message: ToolResultMessage): boolean {
  if (message.isError === true) return true
  if (name === 'pass') return false
  const value = parseToolValue(message)
  if (value === undefined) return false
  if (name === 'send_text') {
    const sent = value['sent']
    return Array.isArray(sent) && sent.length === 0
  }
  // 'unknown' is an undelivered-but-not-failed outcome; only these two statuses lose the message.
  const status = value['status']
  return status === 'synthesis-failed' || status === 'send-failed'
}

/**
 * Whether the active turn has completed any explicit external-reply tool choice.
 * A refused, failed, or wholly undelivered send is not a choice: the turn must stay
 * able to retry, otherwise the platform message is dropped without a visible reply.
 */
export function hasExternalReplyToolChoice(agent: Pick<Agent, 'session'>): boolean {
  const { session } = agent
  const results = new Map<string, ToolResultMessage>()
  for (let seq = Number(session.seq) - 1; seq >= 0; seq--) {
    const event = session.eventAt(seq as SessionSeq)
    if (event?.type === 'turn/end' || event?.type === 'turn/start') return false
    if (event?.type === 'tool/result') {
      results.set(String(event.data.message.toolCallId), event.data.message)
      continue
    }
    if (event?.type === 'tool/call' && REPLY_TOOLS.has(event.data.name)) {
      const message = results.get(String(event.data.callId))
      if (message !== undefined && !showsFailedDelivery(event.data.name, message)) return true
    }
  }
  return false
}

/** Require an explicit send/pass choice before a turn containing platform input can stop. */
export function installExternalReplyGuard(ctx: Context): () => void {
  const corrected = new WeakMap<Agent, number>()
  return ctx.on('agent/turn-stopping', ({ agent, turn, signal }) => {
    if (signal.aborted || corrected.get(agent) === turn) return
    if (!hasPlatformDialogueInput(agent) || hasExternalReplyToolChoice(agent)) return
    corrected.set(agent, turn)
    agent.steer(createUserMessage({
      content: [{ type: 'text', text: CORRECTION }],
      source: {
        kind: 'elysia-external-reply-guard',
        form: 'notice',
        summary: '外部消息需要发送或静默选择',
      },
    }))
  })
}

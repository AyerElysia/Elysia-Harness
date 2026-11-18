import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
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

/** Whether the active turn has completed any explicit external-reply tool choice. */
export function hasExternalReplyToolChoice(agent: Pick<Agent, 'session'>): boolean {
  const { session } = agent
  const results = new Set<string>()
  for (let seq = Number(session.seq) - 1; seq >= 0; seq--) {
    const event = session.eventAt(seq as SessionSeq)
    if (event?.type === 'turn/end' || event?.type === 'turn/start') return false
    if (event?.type === 'tool/result') {
      results.add(String(event.data.message.toolCallId))
      continue
    }
    if (event?.type === 'tool/call' && REPLY_TOOLS.has(event.data.name) && results.has(String(event.data.callId))) return true
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

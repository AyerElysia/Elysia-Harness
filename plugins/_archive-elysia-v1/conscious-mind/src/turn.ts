/**
 * One reply for a pending batch. The channel comes from the messages, not from
 * the caller.
 * @module @elysia/conscious-mind/turn
 */

import { inboundEventText, type InboundEvent } from './inbound.ts'
import type { PendingTurn } from './pending.ts'
import { outboundContent, readToolArguments, spokenReply, type ModelToolMessage } from './reply-args.ts'
import type { SendTextArgs, SendTextResult } from './send-text.ts'

/** Model endpoint used to answer a batch. */
export interface SendTextTurn {
  baseURL: string
  apiKey: string
  model: string
  parameters: unknown
  execute(args: SendTextArgs): Promise<SendTextResult>
}

const RETRY_BAD_CONTENT = '上一次 send_text 的 content 不能发给对方。content 只能是一句给对方看的话，不要写参数名、引号、string="true" 或 XML 标签。请重新调用 send_text。'

interface Completion {
  message: ModelToolMessage | undefined
  args: Record<string, unknown>
  raw: string
}

function batchPrompt(batch: readonly InboundEvent[]): string {
  const first = batch[0]
  const lines = batch.map(message => `${message.senderName || message.senderId}：${inboundEventText(message)}`)
  return `渠道 ${first?.channel ?? ''}\n会话 ${first?.conversation ?? ''}\n这一批先后到达，还没回复：\n${lines.join('\n')}\n用一次 send_text 回到这一个会话。content 必须是对方能看见的非空文字。`
}

async function complete(turn: SendTextTurn, system: string, batch: readonly InboundEvent[], correction?: string): Promise<Completion> {
  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: batchPrompt(batch) },
  ]
  if (correction !== undefined) messages.push({ role: 'user', content: correction })
  const response = await fetch(`${turn.baseURL}/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${turn.apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: turn.model,
      temperature: 0.8,
      messages,
      tools: [{
        type: 'function',
        function: {
          name: 'send_text',
          description: '把文字发到外部渠道。content 里的换行会拆成多条消息。content 和 thought 都必须非空。',
          parameters: turn.parameters,
        },
      }],
      tool_choice: { type: 'function', function: { name: 'send_text' } },
    }),
  })
  if (!response.ok) throw new Error(`模型请求失败 ${response.status}: ${(await response.text()).slice(0, 400)}`)
  const body = await response.json() as { choices?: { message?: ModelToolMessage }[] }
  const message = body.choices?.[0]?.message
  const read = readToolArguments(message)
  return { message, args: read.args, raw: read.raw }
}

function toSendArgs(completion: Completion, batch: readonly InboundEvent[]): SendTextArgs {
  const parsed = completion.args
  const latest = batch.at(-1)
  const replyTo = latest?.messageId ?? ''
  return {
    channel: latest?.channel ?? '',
    conversation: latest?.conversation ?? '',
    content: outboundContent(parsed),
    thought: String(parsed.thought ?? '').trim() || '回这句',
    mood: String(parsed.mood ?? ''),
    decision: String(parsed.decision ?? ''),
    expected_response: String(parsed.expected_response ?? ''),
    ...(replyTo.length > 0 ? { reply_to: replyTo } : {}),
  }
}

function logRejected(completion: Completion): void {
  const assistant = typeof completion.message?.content === 'string' ? completion.message.content : ''
  process.stderr.write(`send_text 正文拒绝 content=${JSON.stringify(outboundContent(completion.args))} raw=${completion.raw || '(无参数)'} assistant=${assistant || '(无)'}\n`)
}

async function modelReply(turn: SendTextTurn, system: string, batch: readonly InboundEvent[]): Promise<SendTextArgs | undefined> {
  const first = await complete(turn, system, batch)
  const firstSpoken = spokenReply(outboundContent(first.args))
  if (firstSpoken !== undefined) return { ...toSendArgs(first, batch), content: firstSpoken }
  logRejected(first)
  const second = await complete(turn, system, batch, RETRY_BAD_CONTENT)
  const secondSpoken = spokenReply(outboundContent(second.args))
  if (secondSpoken === undefined) {
    logRejected(second)
    return undefined
  }
  return { ...toSendArgs(second, batch), content: secondSpoken }
}

/**
 * Reply to any channel's batch through send_text.
 * @param turn - model endpoint and the send_text tool.
 * @param system - standing prompt for this turn.
 * @returns a pending-turn handler.
 */
export function createSendTextTurn(turn: SendTextTurn, system: () => Promise<string>): PendingTurn {
  return async batch => {
    const sendArgs = await modelReply(turn, await system(), batch)
    if (sendArgs === undefined) {
      process.stderr.write('回复未发送\n')
      return
    }
    const result = await turn.execute(sendArgs)
    process.stderr.write(`回复 ${JSON.stringify(result)}\n`)
  }
}

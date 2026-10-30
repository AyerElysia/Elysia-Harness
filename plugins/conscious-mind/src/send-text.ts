/**
 * send_text: one conscious-mind action that delivers text through a registered channel.
 * @module @elysia/conscious-mind/send-text
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { OutboundDeliveryUnknown } from './outbound.ts'
import type { OutboundText } from './outbound.ts'

/** Arguments the model must supply. `reply_to` may be omitted. */
export interface SendTextArgs {
  channel: string
  conversation: string
  thought: string
  mood: string
  decision: string
  expected_response: string
  content: string
  reply_to?: string
}

/** One segment a channel accepted. */
export interface SentSegment {
  index: number
  text: string
  messageId?: string
}

/** Canonical tool result. `sent` lists only segments the channel accepted. */
export interface SendTextResult {
  sent: SentSegment[]
  stoppedAt?: number
  error?: string
}

const PLACEHOLDER_ONLY = /^(?:\.{2,}|。{2,}|…+|⋯+|··+)$/u

/**
 * Split outbound text on newlines. Blank lines and placeholder-only lines are dropped.
 * @param content - model-supplied message body.
 * @returns non-empty segments in send order.
 */
export function splitOutboundText(content: string): string[] {
  return content
    .replaceAll('\r\n', '\n')
    .replaceAll('\r', '\n')
    .split('\n')
    .map(segment => segment.trim())
    .filter(segment => segment.length > 0 && !PLACEHOLDER_ONLY.test(segment))
}

function failure(error: string, sent: SentSegment[] = [], stoppedAt?: number): SendTextResult {
  return {
    sent,
    ...(stoppedAt === undefined ? {} : { stoppedAt }),
    error,
  }
}

/**
 * Deliver one validated send_text call. Inner fields other than `thought` are
 * recorded by the tool arguments themselves; this function only sends `content`.
 * @param outbound - channel registry.
 * @param args - schema-checked arguments. `thought` emptiness is checked here.
 * @returns segments accepted by the channel, and where a later segment stopped.
 */
export async function deliverSendText(outbound: OutboundText, args: SendTextArgs): Promise<SendTextResult> {
  if (args.thought.trim().length === 0) return failure('thought 必须是非空字符串')
  const channel = args.channel.trim()
  const conversation = args.conversation.trim()
  if (channel.length === 0) return failure('channel 不能为空')
  if (conversation.length === 0) return failure('conversation 不能为空')

  const rawSegments = args.content
    .replaceAll('\r\n', '\n')
    .replaceAll('\r', '\n')
    .split('\n')
    .map(segment => segment.trim())
    .filter(segment => segment.length > 0)
  if (rawSegments.length === 0) return failure('发送内容为空')
  const segments = rawSegments.filter(segment => !PLACEHOLDER_ONLY.test(segment))
  if (segments.length === 0) return failure('发送内容不能只是省略号或占位符')

  const send = outbound.sender(channel)
  if (send === undefined) return failure(`渠道未登记: ${channel}`)

  const replyTo = args.reply_to?.trim()
  const sent: SentSegment[] = []
  for (const [index, text] of segments.entries()) {
    try {
      const receipt = await send({
        conversation,
        text,
        ...(index === 0 && replyTo !== undefined && replyTo.length > 0 ? { replyTo } : {}),
      })
      const segment: SentSegment = { index, text }
      if (receipt.messageId !== undefined && receipt.messageId.length > 0) segment.messageId = receipt.messageId
      sent.push(segment)
    } catch (error) {
      const message = error instanceof OutboundDeliveryUnknown
        ? '投递状态未知'
        : error instanceof Error ? error.message : '发送失败'
      return failure(message, sent, index)
    }
  }
  return { sent }
}

/** Model-facing send_text tool bound to one outbound registry. */
export function defineSendTextTool(outbound: OutboundText) {
  return defineTool({
    name: 'send_text',
    description: '把文字发到外部渠道。assistant 正文不会出现在任何渠道上。只用于文字：对方要求语音、想听声音时，不要调用本工具解释或代替，必须改用 send_voice；以本轮实际工具表为准，不要沿用过去没有语音工具的旧判断。先写 thought、mood、decision、expected_response，最后写 content。content 里的换行会拆成多条消息。thought 必须是这次真实的非空思考。',
    parameters: {
      channel: { type: 'string', required: true, description: '渠道名，例如 qq、feishu、kook。必须是已经登记的渠道。' },
      conversation: { type: 'string', required: true, description: '这个渠道上的哪一段对话。入口消息里带着，回复时照抄。' },
      thought: { type: 'string', required: true, description: '这次表达自己写下的内心活动。必须非空。不要从 reasoning 或 content 回填，也不要写进发出去的正文。' },
      mood: { type: 'string', required: true, description: '此刻的心情。没有明确情绪时传空字符串，不要编造默认情绪。' },
      decision: { type: 'string', required: true, description: '决定如何回应。不适用时传空字符串，不要复制 content。' },
      expected_response: { type: 'string', required: true, description: '预期对方看到后的反应。没有明确预期时传空字符串。' },
      content: { type: 'string', required: true, description: '最后才写的、发给对方的纯文本。换行拆成多条消息。不要写入 thought、reason 等元信息。' },
      reply_to: { type: 'string', description: '要引用的消息 id。只挂在拆分后的第一段。私聊默认省略。' },
    },
    isConcurrencySafe: () => false,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          sent: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                index: { type: 'integer', required: true },
                text: { type: 'string', required: true },
                messageId: { type: 'string' },
              },
            },
          },
          stoppedAt: { type: 'integer' },
          error: { type: 'string' },
        },
      },
      render(_args, value): ContentBlock[] {
        return [{ type: 'text', text: JSON.stringify(value) }]
      },
    },
    execute(args): Promise<SendTextResult> {
      return deliverSendText(outbound, args)
    },
  })
}

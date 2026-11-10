/**
 * One Ayla text delivery: conversation → frame → settled result.
 *
 * The plugin speaks the same send_text contract the conscious mind uses, so the
 * model sees one tool either way (REQUIREMENTS.zh.md §8.6). A reply is never
 * retried: a lost segment stays lost, and the model sees the failure.
 * @module @elysia/ayla-app/outbound
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { parseAylaConversation } from './conversation.ts'
import type { ReplyInput } from './protocol.ts'

/** Ayla accepted the attempt but the result could not be observed. Do not retry. */
export class OutboundDeliveryUnknown extends Error {
  constructor(message = '投递状态未知') {
    super(message)
    this.name = 'OutboundDeliveryUnknown'
  }
}

/** Ayla refused the reply with an error frame. The code is the backend's own. */
export class AylaReplyRejected extends Error {
  constructor(readonly code: string, readonly detail: string) {
    super(detail.length > 0 ? `Ayla 拒绝回复: ${code} (${detail})` : `Ayla 拒绝回复: ${code}`)
    this.name = 'AylaReplyRejected'
  }
}

/** One segment handed to the Ayla socket. */
export interface AylaDelivery {
  /** Ayla conversation id, such as `ayla:private:17`. */
  conversation: string
  /** One already-split message body. */
  text: string
  /** Ayla message id being quoted; only the first segment carries it. */
  replyTo?: string
}

/** Send one segment. Throws when delivery cannot be confirmed. */
export type AylaSend = (delivery: AylaDelivery) => Promise<{ messageId: string }>

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

/** Ayla's channel name as the model sees it. */
export const AYLA_CHANNEL = 'ayla'

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
    ...stoppedAt === undefined ? {} : { stoppedAt },
    error,
  }
}

/**
 * Deliver one validated send_text call.
 *
 * A segment that fails stops the call: later segments would arrive out of
 * order and misrepresent what she said.
 * @param resolveSend - looks up the channel sender at call time; undefined while the socket is down.
 * @param args - schema-checked arguments. `thought` emptiness is checked here.
 * @returns segments accepted by the channel, and where a later segment stopped.
 */
export async function deliverSendText(
  resolveSend: () => AylaSend | undefined,
  args: SendTextArgs,
): Promise<SendTextResult> {
  if (args.thought.trim().length === 0) return failure('thought 必须是非空字符串')
  const channel = args.channel.trim()
  const conversation = args.conversation.trim()
  if (channel.length === 0) return failure('channel 不能为空')
  if (channel !== AYLA_CHANNEL) return failure(`渠道未登记: ${channel}`)
  if (conversation.length === 0) return failure('conversation 不能为空')
  const send = resolveSend()
  if (send === undefined) return failure('Ayla 通道未连接')

  const rawSegments = args.content
    .replaceAll('\r\n', '\n')
    .replaceAll('\r', '\n')
    .split('\n')
    .map(segment => segment.trim())
    .filter(segment => segment.length > 0)
  if (rawSegments.length === 0) return failure('发送内容为空')
  const segments = rawSegments.filter(segment => !PLACEHOLDER_ONLY.test(segment))
  if (segments.length === 0) return failure('发送内容不能只是省略号或占位符')

  const replyTo = args.reply_to?.trim()
  const sent: SentSegment[] = []
  for (const [index, text] of segments.entries()) {
    try {
      const receipt = await send({
        conversation,
        text,
        ...index === 0 && replyTo !== undefined && replyTo.length > 0 ? { replyTo } : {},
      })
      const segment: SentSegment = { index, text }
      if (receipt.messageId.length > 0) segment.messageId = receipt.messageId
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

/**
 * Build the reply frame input for one segment.
 * @param delivery - one segment from {@link deliverSendText}.
 * @param clientMessageId - unique per send attempt.
 * @returns the frame input for `buildReply`.
 */
export function replyInput(delivery: AylaDelivery, clientMessageId: string): ReplyInput {
  return {
    clientMessageId,
    conversation: parseAylaConversation(delivery.conversation),
    content: delivery.text,
    ...delivery.replyTo === undefined ? {} : { replyTo: delivery.replyTo },
  }
}

/**
 * Model-facing send_text tool bound to one Ayla channel.
 *
 * The sender is resolved per call, so a tool registered while the socket was
 * down starts working once it reconnects instead of reporting the channel as
 * unavailable for the life of the agent.
 * @param resolveSend - looks up the current sender.
 * @returns the tool definition.
 */
export function defineSendTextTool(resolveSend: () => AylaSend | undefined) {
  return defineTool({
    name: 'send_text',
    description: '把文字发到外部渠道。assistant 正文不会出现在任何渠道上。只用于文字：对方要求语音、想听声音时，不要调用本工具解释或代替。先写 thought、mood、decision、expected_response，最后写 content。content 里的换行会拆成多条消息。thought 必须是这次真实的非空思考。',
    parameters: {
      channel: { type: 'string', required: true, description: '渠道名，这里是 ayla。' },
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
      return deliverSendText(resolveSend, args)
    },
  })
}

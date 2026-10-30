/**
 * send_voice: synthesize one spoken expression through BreezeTTS and deliver it
 * through the registered channel without exposing reference-voice controls.
 * @module @elysia/conscious-mind/send-voice
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { OutboundDeliveryUnknown } from './outbound.ts'
import type { OutboundVoice } from './outbound.ts'
import type { VoiceSynthesizer } from './breeze-tts.ts'

export interface SendVoiceArgs {
  channel: string
  conversation: string
  text: string
  expression_instruction?: string
}

export interface SendVoiceResult {
  status: 'sent' | 'synthesis-failed' | 'send-failed' | 'unknown'
  textCharacters?: number
  audioBytes?: number
  messageId?: string
  error?: string
}

function failure(
  status: SendVoiceResult['status'],
  error: string,
  details: Omit<SendVoiceResult, 'status' | 'error'> = {},
): SendVoiceResult {
  return { status, ...details, error }
}

/** Validate, synthesize once, and attempt one platform delivery. */
export async function deliverSendVoice(
  outbound: OutboundVoice,
  synthesizer: VoiceSynthesizer,
  args: SendVoiceArgs,
  signal?: AbortSignal,
): Promise<SendVoiceResult> {
  const channel = args.channel.trim()
  const conversation = args.conversation.trim()
  const text = args.text.trim()
  const expression = args.expression_instruction?.trim()
  if (channel.length === 0) return failure('send-failed', 'channel 不能为空')
  if (conversation.length === 0) return failure('send-failed', 'conversation 不能为空')
  if (text.length === 0) return failure('synthesis-failed', 'text 不能为空')
  if (expression !== undefined && expression.length > 1000) {
    return failure('synthesis-failed', 'expression_instruction 不能超过 1000 字符')
  }
  const send = outbound.sender(channel)
  if (send === undefined) return failure('send-failed', `渠道未登记或不支持语音: ${channel}`)

  const textCharacters = Array.from(text).length
  let voice: Awaited<ReturnType<VoiceSynthesizer['synthesize']>>
  try {
    voice = await synthesizer.synthesize(text, expression, signal)
  } catch (error) {
    return failure('synthesis-failed', error instanceof Error ? error.message : String(error), { textCharacters })
  }
  const audioBytes = voice.audio.byteLength
  if (audioBytes === 0) return failure('synthesis-failed', 'BreezeTTS 返回空音频', { textCharacters })
  try {
    const receipt = await send({
      conversation,
      audio: voice.audio,
      mediaType: voice.mediaType,
      ...(signal === undefined ? {} : { signal }),
    })
    return {
      status: 'sent',
      textCharacters,
      audioBytes,
      ...(receipt.messageId === undefined || receipt.messageId.length === 0 ? {} : { messageId: receipt.messageId }),
    }
  } catch (error) {
    const unknown = error instanceof OutboundDeliveryUnknown
    return failure(unknown ? 'unknown' : 'send-failed', unknown ? '投递状态未知' : error instanceof Error ? error.message : String(error), {
      textCharacters,
      audioBytes,
    })
  }
}

/** Model-facing Breeze-specific voice action. */
export function defineSendVoiceTool(outbound: OutboundVoice, synthesizer: VoiceSynthesizer) {
  return defineTool({
    name: 'send_voice',
    description: '把口语通过 BreezeTTS 合成为爱莉固定的本地音色，并发送到指定外部会话。对方说“发个语音”“想听你的声音”或明确要求 send_voice 时，直接调用本工具，不要先用 send_text 解释。text 可以直接包含 [笑]、[叹气]、[咳嗽]、[清嗓子]，这些会作为真实声音事件演绎，不会逐字念出。可选 expression_instruction 只调整本次情绪、语气、速度和停顿，不能改变音色。已有音频不要调用本工具，改用 send_file。QQ 平台角色语音不能代替爱莉的本地音色。',
    parameters: {
      channel: { type: 'string', required: true, description: '已登记且支持语音的渠道名。' },
      conversation: { type: 'string', required: true, description: '该渠道上的会话 ID，照抄入站事件。' },
      text: { type: 'string', required: true, description: '交给 BreezeTTS 合成的口语；可包含其原生声音事件标记。' },
      expression_instruction: { type: 'string', description: '可选的本次情绪、语气、速度、停顿等表达控制；会附加到可信 Breeze instruction 后，不能覆盖参考音色。' },
    },
    isConcurrencySafe: () => false,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string', required: true, enum: ['sent', 'synthesis-failed', 'send-failed', 'unknown'] },
          textCharacters: { type: 'integer' },
          audioBytes: { type: 'integer' },
          messageId: { type: 'string' },
          error: { type: 'string' },
        },
      },
      render(_args, value): ContentBlock[] {
        return [{ type: 'text', text: JSON.stringify(value) }]
      },
    },
    execute(args, exec): Promise<SendVoiceResult> {
      return deliverSendVoice(outbound, synthesizer, args, exec.signal)
    },
  })
}

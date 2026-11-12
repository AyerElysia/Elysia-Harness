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
    description: '把口语通过 BreezeTTS 合成为爱莉固定的本地音色，并投递到支持语音的已登记外部会话。DSH 会话内打字或通话时，普通回应直接写在当前会话正文。在外部渠道收到语音回复请求时，使用本次入站实际标注的渠道和会话。只有当前 DSH 用户明确要求向指定外部渠道及收件人发送语音时，才传 explicit_request: true 来请求界面确认。此字段只发起确认，实际投递须经用户在界面批准。DSH 普通回应和外部消息的原路回复均省略该字段。历史渠道或历史会话不能当作当前收件人。text 可以直接包含 [笑]、[叹气]、[咳嗽]、[清嗓子]，这些会作为真实声音事件演绎，不会逐字念出。可选 expression_instruction 只调整本次情绪、语气、速度和停顿，不能改变音色。已有音频不要调用本工具，改用 send_file。QQ 平台角色语音不能代替爱莉的本地音色。',
    parameters: {
      channel: { type: 'string', required: true, description: '已登记且支持语音的渠道名。' },
      conversation: { type: 'string', required: true, description: '外部渠道上的会话 ID。回复时采用本次入站的会话；另行投递时采用当前用户指定的会话。' },
      explicit_request: { type: 'boolean', description: '仅在当前 DSH 用户明确指定外部渠道和收件人并请求投递时传 true，以发起界面确认。该字段不授予发送权限。普通 DSH 回应和外部原路回复均省略。' },
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

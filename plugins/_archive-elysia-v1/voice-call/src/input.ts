/** Exact provider input facts, without fabricating a transcript or retaining raw audio. */
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { RealtimeEvent } from './realtime.ts'
import type { VoiceAgent } from './session.ts'

export type VoiceAudioCommit = Extract<RealtimeEvent, { type: 'audio_committed' }>
export interface VoiceAudioInputSource {
  readonly kind: 'elysia-voice-input-event'
  readonly form: 'notice'
  readonly summary: string
  readonly actor: 'infrastructure'
  readonly provider: 'openai-realtime'
  readonly event: 'input_audio_buffer.committed'
  readonly occurrenceId: string
  readonly sessionId: string
  readonly callId: string
  readonly epoch: number
  readonly itemId: string
  readonly previousItemId?: string
  readonly receivedAt: number
  readonly inputOrigin: 'browser-audio-input'
  readonly rawAudioStored: false
  readonly transcript: 'unavailable'
  readonly replayable: false
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'elysia-voice-input-event': VoiceAudioInputSource
  }
}

interface AcceptedInput { readonly previousItemId: string | undefined; readonly promise: Promise<void> }
const accepted = new WeakMap<VoiceAgent, Map<string, AcceptedInput>>()
const validId = (id: string) => typeof id === 'string' && /^[A-Za-z0-9_-]{1,160}$/u.test(id)

/** Construct an attributed event notice, not words purportedly spoken by a person. */
export function voiceAudioCommitMessage(agent: VoiceAgent, event: VoiceAudioCommit, callId: string, epoch: number): UserMessage {
  if (event.type !== 'audio_committed' || !validId(event.itemId) || !validId(callId)
    || (event.previousItemId !== undefined && !validId(event.previousItemId))
    || !Number.isSafeInteger(epoch) || epoch < 0) throw new Error('Invalid voice audio commit identity')
  const occurrenceId = `${callId}:${epoch}:${event.itemId}`
  return createUserMessage({
    // There is no legally obtained transcript. The diagnostic summary is SOURCE
    // metadata; it is not a fabricated human sentence or model-visible content.
    content: [],
    source: {
      kind: 'elysia-voice-input-event', form: 'notice',
      summary: '实时输入音频已提交；原声不保存，未取得可核验转写，历史不可回放或还原原话。',
      actor: 'infrastructure', provider: 'openai-realtime', event: 'input_audio_buffer.committed',
      occurrenceId, sessionId: agent.id, callId, epoch, itemId: event.itemId,
      ...(event.previousItemId === undefined ? {} : { previousItemId: event.previousItemId }),
      receivedAt: Date.now(), inputOrigin: 'browser-audio-input',
      rawAudioStored: false, transcript: 'unavailable', replayable: false,
    },
  })
}

/** Append once, checkpoint the existing native inbox, then wake; never duplicate the input. */
export function acceptVoiceAudioCommit(agent: VoiceAgent, event: VoiceAudioCommit, callId: string, epoch: number): Promise<void> {
  const message = voiceAudioCommitMessage(agent, event, callId, epoch)
  const key = `${callId}:${epoch}:${event.itemId}`
  let byOccurrence = accepted.get(agent)
  if (!byOccurrence) { byOccurrence = new Map(); accepted.set(agent, byOccurrence) }
  const existing = byOccurrence.get(key)
  if (existing) {
    if (existing.previousItemId !== event.previousItemId) return Promise.reject(new Error('Conflicting voice input occurrence'))
    return existing.promise
  }
  const promise = agent.acceptInput(message)
  byOccurrence.set(key, { previousItemId: event.previousItemId, promise })
  return promise
}

/** Browser-only, in-memory protocol for DSH voice calls. */
export const SESSION_ID = 'elysia-gemini-cascade'
export const MAIN_SESSION_ID = 'elysia-conscious-mind'
export type VoiceSessionId = typeof SESSION_ID | typeof MAIN_SESSION_ID
export function isVoiceSession(sessionId: unknown): sessionId is VoiceSessionId {
  return sessionId === SESSION_ID || sessionId === MAIN_SESSION_ID
}
export const API = '/api/elysia-gemini-cascade/'
export const INPUT_TOPIC = 'elysia.cascade.input.v1'
export const EVENT_TOPIC = 'elysia.cascade.events.v1'
export const AUDIO_TRACK = 'elysia-breeze'
const utf8 = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })
export type InputMode = 'direct-audio' | 'local-asr'
export type WorkerPhase = 'listening' | 'transcribing' | 'thinking' | 'speaking' | 'closed'
type WorkerEvent =
  | { type: 'state'; turn: number; state: WorkerPhase }
  | { type: 'user'; turn: number; input: 'voice'; hasTranscript: boolean }
  | { type: 'user'; turn: number; input: 'text' }
  | { type: 'error'; turn: number; code?: string }
  | { type: 'interrupted'; turn: number }

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

export function decodeEvent(bytes: Uint8Array): WorkerEvent | undefined {
  if (bytes.length === 0 || bytes.length > 13_000) return
  let value: Record<string, unknown> | undefined
  try { value = record(JSON.parse(decoder.decode(bytes))) } catch { return }
  if (!value || typeof value.turn !== 'number' || !Number.isSafeInteger(value.turn) || value.turn < 0) return
  const { type, turn } = value
  if (type === 'state') {
    const state = value.state
    if (state === 'listening' || state === 'transcribing' || state === 'thinking' || state === 'speaking' || state === 'closed') {
      return { type, turn, state }
    }
  } else if (type === 'user') {
    const input = value.input
    // The native conversation stream owns all message bodies. Room events
    // only tell call controls whether a final voice transcription is absent.
    if (input === 'voice') return {
      type, turn, input,
      hasTranscript: typeof value.text === 'string' && value.text.length <= 2000 && value.text.trim() !== '',
    }
    if (input === 'text') return { type, turn, input }
  } else if (type === 'error') {
    const code = typeof value.code === 'string' && /^(?:gemini_[a-z_]{1,40}|breeze_failed|asr_(?:no_speech|timeout|busy|failed))$/u.test(value.code)
      ? value.code : undefined
    return { type, turn, ...(code === undefined ? {} : { code }) }
  } else if (type === 'interrupted') {
    return { type, turn }
  }
}

export function turnErrorNotice(code?: string): string {
  if (code === 'gemini_timeout') return '模型渠道未及时返回回复；通话仍在，你可以继续说或挂断。'
  if (code === 'breeze_failed') return '爱莉的语音未能合成；通话仍在。'
  if (code === 'asr_no_speech') return '这次没有识别到文字，可以再说一遍。'
  if (code === 'asr_timeout') return '本地语音识别超时，通话仍在。'
  if (code === 'asr_busy' || code === 'asr_failed') return '这一轮本地语音识别未完成，可以再试。'
  if (code?.startsWith('gemini_')) return '模型渠道没有返回可播放的回复；通话仍在。'
  return '这一轮未能完成。通话仍在时可以继续说。'
}

export function encodeText(raw: string): Uint8Array<ArrayBuffer> | undefined {
  const text = raw.trim()
  if (!text || utf8.encode(text).byteLength > 2048) return
  return utf8.encode(JSON.stringify({ type: 'text', text }))
}

export function parseOpened(value: unknown, sessionId: VoiceSessionId = SESSION_ID): { sessionId: VoiceSessionId; inputMode: InputMode } {
  const result = record(value)
  if (result?.sessionId !== sessionId) throw new Error('invalid_cascade_session')
  const inputMode = result.inputMode
  if (inputMode !== 'local-asr' && (inputMode !== 'direct-audio' || sessionId === MAIN_SESSION_ID)) throw new Error('invalid_cascade_input_mode')
  return { sessionId, inputMode }
}

export function parseToken(value: unknown, hostname: string) {
  const result = record(value)
  if (!result || typeof result.serverUrl !== 'string' || typeof result.participantToken !== 'string'
    || typeof result.roomName !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/u.test(result.roomName)
    || typeof result.callToken !== 'string' || !/^[A-Za-z0-9._-]{24,200}$/u.test(result.callToken)
    || !/^[A-Za-z0-9._-]{24,4000}$/u.test(result.participantToken)) throw new Error('invalid_cascade_token')
  const endpoint = new URL(result.serverUrl)
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash
    || (endpoint.protocol !== 'wss:' && endpoint.protocol !== 'ws:')
    || (endpoint.protocol === 'ws:' && !['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname))
    || (endpoint.protocol === 'wss:' && endpoint.hostname !== hostname)) throw new Error('invalid_cascade_endpoint')
  return { serverUrl: endpoint.href, participantToken: result.participantToken, roomName: result.roomName, callToken: result.callToken }
}

export const INITIAL: Snapshot = {
  phase: 'idle', sessionId: null, inputMode: null, muted: false, playbackBlocked: false,
  notice: '', workerReady: false, micReady: false,
}
export type Snapshot = Readonly<{
  phase: 'idle' | 'disclosure' | 'consent' | 'connecting' | 'microphone' | 'waiting' | Exclude<WorkerPhase, 'closed'>
  sessionId: VoiceSessionId | null
  inputMode: InputMode | null
  muted: boolean; playbackBlocked: boolean; workerReady: boolean; micReady: boolean
  notice: string
}>

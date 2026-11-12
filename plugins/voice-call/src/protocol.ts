/** Shared, secret-free call protocol. Capabilities travel only in request headers. */
export const VOICE_API_PREFIX = '/api/voice-call'
export const VOICE_CAPABILITY_HEADER = 'X-Elysia-Voice-Capability'
export const VOICE_SESSION_ID = 'elysia-voice-call'
export const REALTIME_MODEL = 'gpt-realtime-2.1-mini'
export const MAX_CALL_MS = 10 * 60_000
export const CLIENT_LEASE_MS = 20_000
export const HEARTBEAT_MS = 5_000

export interface VoiceUsage {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  complete: boolean
}
export interface VoiceState {
  enabled: boolean
  credentialConfigured: boolean
  sessionId: string
  callId: string | null
  epoch: number
  connection: 'idle' | 'connecting' | 'ready' | 'closing' | 'ended' | 'failed'
  capture: 'inactive' | 'muted' | 'sending'
  generation: 'idle' | 'generating' | 'failed'
  playback: 'idle' | 'buffering' | 'playing' | 'stopped'
  expiresAt: number | null
  rawAudioRecorded: false
  contextPolicy: 'current-call-only'
  errorCode: string | null
  usage: VoiceUsage
}
export interface VoiceStartRequest {
  requestId: string
  sdp: string
  privacyMode: 'no-raw-audio'
}
export interface VoiceStartResult {
  callId: string
  capability: string
  sdp: string
  epoch: number
  sessionId: string
  expiresAt: number
}
export type VoiceControlAction = 'mute' | 'unmute' | 'stop-playback' | 'hangup' | 'heartbeat'
export interface VoiceControlRequest {
  callId: string
  epoch: number
  action: VoiceControlAction
}
export interface VoicePlaybackReceipt {
  callId: string
  epoch: number
  segmentId: string
  playedFrames: number
  fullyPlayed: boolean
}
interface VoiceEventBase { callId: string; epoch: number; seq: number; at: number }
export type VoiceEvent = VoiceEventBase & (
  | { type: 'state'; state: VoiceState }
  | { type: 'text'; responseId: string; text: string; stage: 'generated' }
  | { type: 'pcm'; segmentId: string; chunkIndex: number; sampleRate: number; channels: 1; format: 's16le'; audio: string }
  | { type: 'segment-end'; segmentId: string; frames: number; responseId: string }
  | { type: 'output-stop'; reason: string }
  | { type: 'error'; code: string }
  | { type: 'end'; reason: string }
)
export type VoiceEventPayload =
  | { type: 'state'; state: VoiceState }
  | { type: 'text'; responseId: string; text: string; stage: 'generated' }
  | { type: 'pcm'; segmentId: string; chunkIndex: number; sampleRate: number; channels: 1; format: 's16le'; audio: string }
  | { type: 'segment-end'; segmentId: string; frames: number; responseId: string }
  | { type: 'output-stop'; reason: string }
  | { type: 'error'; code: string }
  | { type: 'end'; reason: string }

function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_request')
  const result = value as Record<string, unknown>
  if (Object.keys(result).some(key => !keys.includes(key))) throw new Error('unexpected_request_field')
  return result
}
function id(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/u.test(value)) throw new Error('invalid_id')
  return value
}
function epoch(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('invalid_epoch')
  return value
}
export function parseStart(value: unknown): VoiceStartRequest {
  const body = record(value, ['requestId', 'sdp', 'privacyMode'])
  const requestId = id(body.requestId)
  if (typeof body.sdp !== 'string' || body.sdp.length < 10 || body.sdp.length > 64 * 1024 || !body.sdp.startsWith('v=')) throw new Error('invalid_sdp')
  if (body.privacyMode !== 'no-raw-audio') throw new Error('privacy_confirmation_required')
  return { requestId, sdp: body.sdp, privacyMode: body.privacyMode }
}
export function parseControl(value: unknown): VoiceControlRequest {
  const body = record(value, ['callId', 'epoch', 'action'])
  if (!['mute', 'unmute', 'stop-playback', 'hangup', 'heartbeat'].includes(String(body.action))) throw new Error('invalid_action')
  return { callId: id(body.callId), epoch: epoch(body.epoch), action: body.action as VoiceControlAction }
}
export function parsePlayback(value: unknown): VoicePlaybackReceipt {
  const body = record(value, ['callId', 'epoch', 'segmentId', 'playedFrames', 'fullyPlayed'])
  if (typeof body.playedFrames !== 'number' || !Number.isSafeInteger(body.playedFrames) || body.playedFrames < 0 || body.playedFrames > 24_000 * 60 * 10) throw new Error('invalid_playback_frames')
  if (typeof body.fullyPlayed !== 'boolean') throw new Error('invalid_playback_status')
  return { callId: id(body.callId), epoch: epoch(body.epoch), segmentId: id(body.segmentId), playedFrames: body.playedFrames, fullyPlayed: body.fullyPlayed }
}
export function encodeVoiceEvent(event: VoiceEvent): Uint8Array {
  return new TextEncoder().encode('event: voice-call\ndata: ' + JSON.stringify(event) + '\n\n')
}
export function idleVoiceState(enabled = false, credentialConfigured = false): VoiceState {
  return {
    enabled, credentialConfigured, sessionId: VOICE_SESSION_ID, callId: null, epoch: 0,
    connection: 'idle', capture: 'inactive', generation: 'idle', playback: 'idle',
    expiresAt: null, rawAudioRecorded: false, contextPolicy: 'current-call-only',
    errorCode: null, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, complete: true },
  }
}

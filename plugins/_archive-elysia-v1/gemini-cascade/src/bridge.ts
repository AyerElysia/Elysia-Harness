/** The browser is never a source of persisted voice replies. */
import { timingSafeEqual } from 'node:crypto'

export const SESSION = 'elysia-gemini-cascade'
export const MAIN_SESSION = 'elysia-conscious-mind'
export const PREFIX = '/api/elysia-gemini-cascade'
export const ROOM = /^elysia-gemini-cascade-[a-f0-9]{32}$/u
export const LIMIT = 24_576
export const MAX_SPOKEN_LENGTH = 2400
export type WorkerEvent =
  | { roomName: string; turn: number; type: 'user'; input: 'voice' | 'text'; text?: string }
  | { roomName: string; turn: number; type: 'poll'; seq: number }
  | { roomName: string; turn: number; type: 'done' | 'delta'; text: string }
  | { roomName: string; turn: number; type: 'interrupted' | 'error' | 'closed' }

export function equalSecret(actual: unknown, expected: string): boolean {
  if (typeof actual !== 'string' || actual.length !== expected.length) return false
  const a = Buffer.from(actual), b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}
export function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
export type InputMode = 'local-asr' | 'direct-audio'

export function acceptsCallMode(requested: unknown, configured: InputMode): boolean {
  return requested === configured || (requested === undefined && configured === 'direct-audio')
}

export function workerEvent(raw: unknown, inputMode: InputMode = 'direct-audio'): WorkerEvent {
  if (!record(raw) || typeof raw.roomName !== 'string' || !ROOM.test(raw.roomName)
    || typeof raw.turn !== 'number' || !Number.isSafeInteger(raw.turn) || raw.turn < 0 || raw.turn > 256
    || Object.keys(raw).some(key => !['roomName', 'turn', 'type', 'input', 'text', 'code', 'seq'].includes(key))) {
    throw new Error('invalid_worker_event')
  }
  const base = { roomName: raw.roomName, turn: raw.turn }
  if (raw.type === 'poll' && inputMode === 'local-asr' && raw.turn > 0 && Object.keys(raw).length === 4
    && typeof raw.seq === 'number' && Number.isSafeInteger(raw.seq) && raw.seq >= 0 && raw.seq <= MAX_SPOKEN_LENGTH) {
    return { ...base, type: 'poll', seq: raw.seq }
  }
  if (Object.hasOwn(raw, 'seq')) throw new Error('invalid_worker_cursor')
  if (raw.type === 'closed') return { ...base, type: 'closed' }
  if (raw.turn === 0) throw new Error('invalid_worker_turn')
  if (raw.type === 'interrupted' || raw.type === 'error') return { ...base, type: raw.type }
  if (raw.type === 'delta' && typeof raw.text === 'string' && raw.text.length > 0 && raw.text.length <= 512) {
    return { ...base, type: 'delta', text: raw.text }
  }
  if (raw.type === 'done' && typeof raw.text === 'string' && raw.text.trim() && raw.text.length <= 4096) {
    return { ...base, type: 'done', text: raw.text }
  }
  if (raw.type === 'user' && raw.input === 'voice') {
    if (raw.text === undefined) return { ...base, type: 'user', input: 'voice' }
    if (inputMode === 'local-asr' && typeof raw.text === 'string' && raw.text.trim() && raw.text.length <= 2000) {
      return { ...base, type: 'user', input: 'voice', text: raw.text }
    }
  }
  if (raw.type === 'user' && raw.input === 'text' && typeof raw.text === 'string' && raw.text.trim() && raw.text.length <= 2000) {
    return { ...base, type: 'user', input: 'text', text: raw.text }
  }
  throw new Error('invalid_worker_event')
}

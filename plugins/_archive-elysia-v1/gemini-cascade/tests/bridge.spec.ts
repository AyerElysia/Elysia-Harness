import { describe, expect, it } from 'vitest'
import { acceptsCallMode, equalSecret, workerEvent } from '../src/bridge.ts'
const roomName = 'elysia-gemini-cascade-' + 'a'.repeat(32)
describe('private cascade worker event contract', () => {
  it('does not persist a fictitious transcript or any audio bytes', () => {
    const user = { roomName, type: 'user', turn: 1, input: 'voice' }
    expect(workerEvent(user)).toEqual(user)
    expect(() => workerEvent({ ...user, text: 'invented' })).toThrow()
    expect(() => workerEvent({ ...user, audio: 'raw' })).toThrow()
  })
  it('binds ASR consent and validates transcript only for that mode', () => {
    const voice = { roomName, type: 'user', turn: 1, input: 'voice', text: '爱莉，你好' }
    expect(workerEvent(voice, 'local-asr')).toEqual(voice)
    expect(() => workerEvent(voice)).toThrow()
    expect(() => workerEvent({ ...voice, text: 'x'.repeat(2001) }, 'local-asr')).toThrow()
    expect(acceptsCallMode(undefined, 'local-asr')).toBe(false)
    expect(acceptsCallMode('direct-audio', 'local-asr')).toBe(false)
    expect(acceptsCallMode('local-asr', 'local-asr')).toBe(true)
  })
  it('permits only bounded private cursors for local ASR', () => {
    const poll = { roomName, type: 'poll', turn: 1, seq: 0 }
    expect(workerEvent(poll, 'local-asr')).toEqual(poll)
    expect(() => workerEvent(poll)).toThrow()
    for (const seq of [-1, 0.5, 2401, '0']) {
      expect(() => workerEvent({ ...poll, seq }, 'local-asr')).toThrow()
    }
    expect(() => workerEvent({ ...poll, turn: 0 }, 'local-asr')).toThrow()
    expect(() => workerEvent({ ...poll, text: 'inject' }, 'local-asr')).toThrow()
  })
  it('accepts only the reserved room and bounded provider text', () => {
    expect(workerEvent({ roomName, type: 'done', turn: 1, text: 'hi' }).type).toBe('done')
    expect(() => workerEvent({ roomName, type: 'done', turn: 1, text: 'x'.repeat(4097) })).toThrow()
    expect(() => workerEvent({ roomName: 'other', type: 'closed', turn: 0 })).toThrow()
  })
  it('rejects missing and different-length capabilities', () => {
    expect(equalSecret(undefined, 'abc')).toBe(false)
    expect(equalSecret('abcd', 'abc')).toBe(false)
    expect(equalSecret('abd', 'abc')).toBe(false)
    expect(equalSecret('abc', 'abc')).toBe(true)
  })
})

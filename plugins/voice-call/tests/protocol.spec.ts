import { describe, it, expect } from 'vitest'
import { parseStart, parseControl, parsePlayback, encodeVoiceEvent, idleVoiceState } from '../src/protocol.ts'

describe('call boundary', () => {
  it('requires no-raw-audio and rejects caller model/prompt overrides', () => {
    const start = { requestId: 'request-1', sdp: 'v=0\r\na=example', privacyMode: 'no-raw-audio' }
    expect(parseStart(start)).toEqual(start)
    expect(() => parseStart({ ...start, model: 'another' })).toThrow('unexpected')
    expect(() => parseStart({ ...start, privacyMode: 'record' })).toThrow('privacy')
    expect(() => parseStart({ ...start, sdp: '' })).toThrow('sdp')
    expect(() => parseStart({ ...start, sdp: 'v=' + 'x'.repeat(65535) })).toThrow('sdp')
  })
  it('only accepts owned control actions, bounded ids and epochs', () => {
    expect(parseControl({ callId: 'call_1', epoch: 2, action: 'hangup' }).action).toBe('hangup')
    expect(() => parseControl({ callId: 'c', epoch: 0, action: 'response.create' })).toThrow('action')
    expect(() => parseControl({ callId: '../other', epoch: 0, action: 'mute' })).toThrow('id')
    expect(() => parseControl({ callId: 'c', epoch: -1, action: 'mute' })).toThrow('epoch')
  })
  it('validates receipts without accepting client text or capabilities in JSON', () => {
    const receipt = { callId: 'c', epoch: 1, segmentId: 's', playedFrames: 24000, fullyPlayed: true }
    expect(parsePlayback(receipt)).toEqual(receipt)
    expect(() => parsePlayback({ ...receipt, text: 'client invented' })).toThrow('unexpected')
    expect(() => parsePlayback({ ...receipt, playedFrames: -1 })).toThrow('frames')
  })
  it('public state and events do not contain call capabilities', () => {
    const state = idleVoiceState(true, true)
    const event = encodeVoiceEvent({ type: 'state', state, callId: 'c', epoch: 1, seq: 1, at: 0 })
    expect(new TextDecoder().decode(event)).toContain('event: voice-call')
    expect(new TextDecoder().decode(event)).not.toContain('capability')
    expect(state.rawAudioRecorded).toBe(false)
  })
})

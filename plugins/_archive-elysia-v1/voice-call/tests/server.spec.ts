import { describe, expect, it } from 'vitest'
import { voiceRoutes, type VoiceHttpController } from '../src/server.ts'
import { idleVoiceState, type VoiceEvent, VOICE_CAPABILITY_HEADER } from '../src/protocol.ts'
function fixture() {
  let ended = 0
  let callback: ((event: VoiceEvent) => boolean | void) | undefined
  const owner: VoiceHttpController = {
    getState: () => idleVoiceState(true, true),
    start: async (_body, signal) => { signal?.throwIfAborted(); return { callId: 'call-1', capability: 'only-in-memory', sdp: 'v=0', epoch: 0, sessionId: 'voice', expiresAt: 1 } },
    control: async (_body, cap) => { if (cap !== 'secret') throw Object.assign(new Error('private upstream text'), { code: 'invalid_capability' }); return idleVoiceState(true, true) },
    playback: async () => undefined,
    subscribeEvents: (_id, cap, receive) => { if (cap !== 'secret') throw Object.assign(new Error('secret value must not leak'), { code: 'invalid_capability' }); callback = receive; return { end: async () => { ended++ } } },
  }
  const routes = voiceRoutes(owner)
  const fetch = (name: string, init?: RequestInit, query = '') => routes.find(route => route.path.endsWith('/' + name))!.fetch(new Request('http://localhost/api/voice-call/' + name + query, init))
  return { fetch, owner, ended: () => ended, push: (event: VoiceEvent) => callback!(event) }
}
const event = (type: 'end' = 'end'): VoiceEvent => ({ type, callId: 'call-1', epoch: 0, seq: 0, at: 0, reason: 'finished' })
describe('owner-authenticated voice routes', () => {
  it('reports bounded upstream status without forwarding private error text', async () => {
    const f = fixture()
    f.owner.start = async () => { throw Object.assign(new Error('NEVER EXPOSE private error text'), { code: 'start_failed_provider_create', upstreamStatus: 401 }) }
    const response = await f.fetch('start', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    expect(response.status).toBe(502)
    expect(await response.json()).toEqual({ error: 'start_failed_provider_create', upstreamStatus: 401 })
    f.owner.start = async () => { throw Object.assign(new Error('NEVER EXPOSE'), { code: 'start_failed_provider_create', upstreamStatus: 600 }) }
    const invalid = await f.fetch('start', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    expect(await invalid.json()).toEqual({ error: 'start_failed_provider_create' })
  })
  it('mount and state never dial and return raw state', async () => {
    const f = fixture()
    expect(await (await f.fetch('state')).json()).toEqual(idleVoiceState(true, true))
  })
  it('accepts raw start JSON and passes request abort', async () => {
    const f = fixture()
    const result = await f.fetch('start', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    expect(result.status).toBe(200); expect((await result.json()).callId).toBe('call-1')
  })
  it('refuses malformed and oversized input before owner access', async () => {
    const f = fixture()
    expect((await f.fetch('start', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' })).status).toBe(400)
    expect((await f.fetch('start', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' })).status).toBe(400)
    expect((await f.fetch('start', { method: 'POST', headers: { 'content-type': 'application/json' }, body: ' '.repeat(262145) })).status).toBe(400)
  })
  it('does not accept capabilities in URLs or leak error messages', async () => {
    const f = fixture()
    expect((await f.fetch('state', undefined, '?capability=secret')).status).toBe(400)
    const response = await f.fetch('events', undefined, '?callId=call-1')
    expect(response.status).toBe(403)
    const denied = await f.fetch('events', { headers: { [VOICE_CAPABILITY_HEADER]: 'wrong' } }, '?callId=call-1')
    expect(denied.status).toBe(403); expect(await denied.text()).not.toContain('secret value')
  })
  it('request signal disconnect closes the real call even without stream cancel', async () => {
    const f = fixture(); const controller = new AbortController()
    const response = await f.fetch('events', { signal: controller.signal, headers: { [VOICE_CAPABILITY_HEADER]: 'secret' } }, '?callId=call-1')
    expect(response.status).toBe(200)
    controller.abort()
    await Promise.resolve()
    expect(f.ended()).toBe(1)
    expect(await response.text()).toBe('')
  })
  it('reader cancel closes owner; terminal event closes stream', async () => {
    const f = fixture()
    const response = await f.fetch('events', { headers: { [VOICE_CAPABILITY_HEADER]: 'secret' } }, '?callId=call-1')
    await response.body!.cancel()
    expect(f.ended()).toBe(1)
    const g = fixture()
    const terminal = await g.fetch('events', { headers: { [VOICE_CAPABILITY_HEADER]: 'secret' } }, '?callId=call-1')
    expect(g.push(event())).toBe(true)
    expect(await terminal.text()).toContain('event: voice-call')
    expect(g.ended()).toBe(0)
  })
  it('backpressure is bounded and reports refusal', async () => {
    const f = fixture()
    await f.fetch('events', { headers: { [VOICE_CAPABILITY_HEADER]: 'secret' } }, '?callId=call-1')
    const value: VoiceEvent = { type: 'pcm', callId: 'call-1', epoch: 0, seq: 1, at: 0, segmentId: 's', chunkIndex: 0, sampleRate: 24000, channels: 1, format: 's16le', audio: 'a'.repeat(200000) }
    expect(f.push(value)).toBe(true)
    expect(f.push(value)).toBe(true)
    expect(f.push(value)).toBe(false)
  })
  it('playback reply has only the ack envelope', async () => {
    const f = fixture()
    expect(await (await f.fetch('playback', { method: 'POST', headers: { 'content-type': 'application/json', [VOICE_CAPABILITY_HEADER]: 'secret' }, body: '{}' })).json()).toEqual({ ok: true })
  })
})

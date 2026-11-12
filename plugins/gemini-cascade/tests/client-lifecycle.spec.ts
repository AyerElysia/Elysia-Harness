import type { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CascadeController } from '../src/client/controller.ts'
import { EVENT_TOPIC, INPUT_TOPIC, MAIN_SESSION_ID, SESSION_ID } from '../src/client/protocol.ts'

const fake = vi.hoisted(() => ({
  rooms: [] as EventEmitter[],
  mic: vi.fn(),
  publishTrack: vi.fn(),
  publishData: vi.fn(),
  connect: vi.fn(),
  disconnect: vi.fn(),
  startAudio: vi.fn(),
  trackStop: vi.fn(),
  fetch: vi.fn(),
}))
vi.mock('livekit-client', async () => {
  const { EventEmitter } = await import('node:events')
  class Room extends EventEmitter {
    name = 'gemini-room'
    canPlaybackAudio = true
    connect = fake.connect
    disconnect = fake.disconnect
    startAudio = fake.startAudio
    localParticipant = { publishTrack: fake.publishTrack, publishData: fake.publishData }
    constructor() { super(); fake.rooms.push(this) }
  }
  return {
    Room, createLocalAudioTrack: fake.mic,
    RoomEvent: {
      Disconnected: 'disconnected', Reconnecting: 'reconnecting', DataReceived: 'data',
      AudioPlaybackStatusChanged: 'audioStatus', TrackSubscribed: 'subscribed',
      TrackUnsubscribed: 'unsubscribed', ParticipantDisconnected: 'participantLeft',
    },
    Track: { Kind: { Audio: 'audio' }, Source: { Microphone: 'microphone' } },
    ParticipantKind: { AGENT: 4 },
  }
})

const participant = { kind: 4, identity: 'agent' }
const token = {
  serverUrl: 'ws://127.0.0.1:18780', participantToken: 'p'.repeat(36),
  roomName: 'gemini-room', callToken: 'k'.repeat(32),
}
const wire = (object: object) => new TextEncoder().encode(JSON.stringify(object))

describe('DSH Gemini cascade call browser owner', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    fake.rooms.length = 0
    fake.connect.mockResolvedValue(undefined)
    fake.disconnect.mockResolvedValue(undefined)
    fake.startAudio.mockResolvedValue(undefined)
    fake.publishTrack.mockResolvedValue(undefined)
    fake.publishData.mockResolvedValue(undefined)
    fake.mic.mockResolvedValue({ stop: fake.trackStop })
    fake.fetch.mockImplementation(async (url: string) => {
      if (url.endsWith('/open')) return Response.json({ sessionId: SESSION_ID, inputMode: 'local-asr' })
      if (url.endsWith('/start')) return Response.json(token)
      if (url.endsWith('/stop')) return Response.json({ ok: true })
      throw new Error('unexpected_route')
    })
    vi.stubGlobal('window', { isSecureContext: true, location: { hostname: '127.0.0.1' } })
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: () => undefined } })
    vi.stubGlobal('fetch', fake.fetch)
  })
  afterEach(() => { vi.unstubAllGlobals() })

  it('opens and waits for consent without microphone or token; hangup frees local media immediately', async () => {
    const unseat = vi.fn()
    const ui = new CascadeController(() => unseat)
    await expect(ui.openSession(new AbortController().signal)).resolves.toBe(SESSION_ID)
    const checking = ui.requestConsent()
    expect(ui.getSnapshot().phase).toBe('disclosure')
    await ui.start()
    await checking
    expect(ui.getSnapshot().phase).toBe('consent')
    expect(ui.getSnapshot().inputMode).toBe('local-asr')
    expect(fake.fetch).toHaveBeenCalledTimes(2)
    expect(fake.mic).not.toHaveBeenCalled()
    await ui.start()
    const startCall = fake.fetch.mock.calls.find(([url]) => url.endsWith('/start'))
    expect(JSON.parse(startCall![1].body as string)).toEqual({ sessionId: SESSION_ID, inputMode: 'local-asr' })
    expect(fake.mic).toHaveBeenCalledTimes(1)
    expect(fake.connect).toHaveBeenCalledWith('ws://127.0.0.1:18780/', token.participantToken, { autoSubscribe: true, maxRetries: 0 })
    expect(ui.getSnapshot().phase).toBe('waiting')
    fake.rooms[0]!.emit('data', wire({ type: 'state', turn: 0, state: 'listening' }), participant, undefined, EVENT_TOPIC)
    expect(ui.getSnapshot().phase).toBe('listening')
    await expect(ui.sendText('你好')).resolves.toBe(true)
    expect(fake.publishData).toHaveBeenCalledWith(wire({ type: 'text', text: '你好' }), {
      reliable: true, topic: INPUT_TOPIC, destinationIdentities: ['agent'],
    })
    ui.end('通话已结束。')
    expect(ui.getSnapshot().phase).toBe('idle')
    expect(fake.trackStop).toHaveBeenCalledTimes(1)
    expect(fake.disconnect).toHaveBeenCalledWith(true)
    expect(unseat).toHaveBeenCalledTimes(1)
    const stopCall = fake.fetch.mock.calls.find(([url]) => url.endsWith('/stop'))
    expect(JSON.parse(stopCall![1].body as string)).toEqual({
      sessionId: SESSION_ID, roomName: token.roomName, callToken: token.callToken,
    })
    ui.dispose()
  })

  it('stops a mic permission result that arrives after cancel, without publishing or retrying', async () => {
    let resolve!: (track: { stop: () => void }) => void
    const permission = new Promise<{ stop: () => void }>(next => { resolve = next })
    fake.mic.mockReturnValueOnce(permission)
    const ui = new CascadeController(() => () => {})
    await ui.requestConsent()
    const starting = ui.start()
    await vi.waitFor(() => expect(fake.mic).toHaveBeenCalledOnce())
    ui.end()
    resolve({ stop: fake.trackStop })
    await starting
    expect(fake.trackStop).toHaveBeenCalledOnce()
    expect(fake.publishTrack).not.toHaveBeenCalled()
    expect(fake.connect).toHaveBeenCalledOnce()
    expect(ui.getSnapshot().phase).toBe('idle')
    ui.dispose()
  })

  it('keeps main voice in the native composer and scopes start/stop to the same session', async () => {
    fake.fetch.mockResolvedValueOnce(Response.json({ sessionId: MAIN_SESSION_ID, inputMode: 'local-asr' }))
    const reserveIsolatedSeat = vi.fn(() => () => {})
    const ui = new CascadeController(reserveIsolatedSeat)
    await ui.requestConsent(MAIN_SESSION_ID)
    expect(ui.getSnapshot()).toMatchObject({ phase: 'consent', sessionId: MAIN_SESSION_ID, inputMode: 'local-asr' })
    expect(reserveIsolatedSeat).not.toHaveBeenCalled()
    expect(fake.mic).not.toHaveBeenCalled()
    expect(JSON.parse(fake.fetch.mock.calls[0]![1].body as string)).toEqual({ sessionId: MAIN_SESSION_ID })
    // A different surface cannot replace a consent/call already owned by main.
    await ui.requestConsent(SESSION_ID)
    expect(fake.fetch).toHaveBeenCalledOnce()
    await ui.start()
    expect(JSON.parse(fake.fetch.mock.calls[1]![1].body as string)).toEqual({ sessionId: MAIN_SESSION_ID, inputMode: 'local-asr' })
    expect(fake.mic).toHaveBeenCalledOnce()
    const room = fake.rooms[0]!
    room.emit('data', wire({ type: 'state', turn: 1, state: 'speaking' }), participant, undefined, EVENT_TOPIC)
    await expect(ui.sendText('走原生主意识输入框')).resolves.toBe(false)
    expect(fake.publishData).not.toHaveBeenCalled()
    room.emit('data', wire({ type: 'interrupted', turn: 1 }), participant, undefined, EVENT_TOPIC)
    expect(ui.getSnapshot().notice).toContain('主意识仍可继续文字回复')
    ui.end('通话已结束。')
    expect(ui.getSnapshot()).toMatchObject({ phase: 'idle', sessionId: MAIN_SESSION_ID })
    expect(fake.trackStop).toHaveBeenCalledOnce()
    expect(JSON.parse(fake.fetch.mock.calls[2]![1].body as string)).toEqual({
      sessionId: MAIN_SESSION_ID, roomName: token.roomName, callToken: token.callToken,
    })
    await ui.requestConsent(SESSION_ID)
    expect(ui.getSnapshot()).toMatchObject({ phase: 'consent', sessionId: SESSION_ID, notice: '' })
    expect(reserveIsolatedSeat).toHaveBeenCalledOnce()
    ui.dispose()
  })

  it('main consent never enables direct audio or trusts a disclosure for the isolated session', async () => {
    const ui = new CascadeController(() => () => {})
    for (const result of [
      { sessionId: MAIN_SESSION_ID, inputMode: 'direct-audio' },
      { sessionId: SESSION_ID, inputMode: 'local-asr' },
    ]) {
      fake.fetch.mockResolvedValueOnce(Response.json(result))
      await ui.requestConsent(MAIN_SESSION_ID)
      expect(ui.getSnapshot()).toMatchObject({ phase: 'disclosure', sessionId: MAIN_SESSION_ID, inputMode: null })
      expect(ui.getSnapshot().notice).toContain('未开启麦克风')
      await ui.start()
      ui.end()
    }
    expect(fake.fetch).toHaveBeenCalledTimes(2)
    expect(fake.mic).not.toHaveBeenCalled()
    expect(fake.connect).not.toHaveBeenCalled()
    ui.dispose()
  })

  it('refuses microphone and token when host does not confirm the mode', async () => {
    fake.fetch.mockResolvedValueOnce(Response.json({ sessionId: SESSION_ID }))
    const ui = new CascadeController(() => () => {})
    await ui.requestConsent()
    expect(ui.getSnapshot().phase).toBe('disclosure')
    expect(ui.getSnapshot().notice).toMatch(/无法确认/u)
    await ui.start()
    expect(fake.fetch).toHaveBeenCalledOnce()
    expect(fake.mic).not.toHaveBeenCalled()
    expect(fake.connect).not.toHaveBeenCalled()
    ui.dispose()
  })

  it('reports unavailability without storing voice text in direct-audio mode', async () => {
    fake.fetch.mockResolvedValueOnce(Response.json({ sessionId: SESSION_ID, inputMode: 'direct-audio' }))
    const ui = new CascadeController(() => () => {})
    await ui.requestConsent()
    await ui.start()
    fake.rooms[0]!.emit('data', wire({ type: 'user', turn: 1, input: 'voice', text: 'unexpected' }), participant, undefined, EVENT_TOPIC)
    expect(ui.getSnapshot().notice).toMatch(/不提供语音转写/u)
    expect(ui.getSnapshot()).not.toHaveProperty('voiceText')
    ui.dispose()
  })

  it('discards unrelated sender/topic and stale interrupted data, and closes on reconnect', async () => {
    const ui = new CascadeController(() => () => {})
    await ui.requestConsent()
    await ui.start()
    const room = fake.rooms[0]!
    const emit = (value: object, sender = participant, topic = EVENT_TOPIC) => room.emit('data', wire(value), sender, undefined, topic)
    emit({ type: 'state', turn: 0, state: 'listening' }, { kind: 1, identity: 'not-agent' })
    expect(ui.getSnapshot().workerReady).toBe(false)
    emit({ type: 'state', turn: 0, state: 'listening' }, participant, 'unrelated')
    expect(ui.getSnapshot().workerReady).toBe(false)
    emit({ type: 'state', turn: 1, state: 'transcribing' })
    expect(ui.getSnapshot().phase).toBe('transcribing')
    emit({ type: 'user', turn: 1, input: 'voice', text: '请讲个故事' })
    expect(ui.getSnapshot().notice).toBe('')
    expect(ui.getSnapshot()).not.toHaveProperty('voiceText')
    expect(ui.getSnapshot()).not.toHaveProperty('text')
    emit({ type: 'state', turn: 1, state: 'speaking' })
    emit({ type: 'delta', turn: 1, text: '听到的' })
    emit({ type: 'interrupted', turn: 1 })
    emit({ type: 'delta', turn: 1, text: '不该再显示' })
    expect(ui.getSnapshot().notice).toMatch(/已打断/u)
    emit({ type: 'state', turn: 2, state: 'thinking' })
    emit({ type: 'done', turn: 1, text: '过时回复' })
    emit({ type: 'user', turn: 1, input: 'voice', text: '过时转写' })
    expect(ui.getSnapshot().notice).toBe('')
    emit({ type: 'user', turn: 2, input: 'voice' })
    expect(ui.getSnapshot().notice).toMatch(/没有取得语音转写/u)
    emit({ type: 'error', turn: 2, code: 'asr_timeout' })
    expect(ui.getSnapshot().notice).toMatch(/本地语音识别超时/u)
    room.emit('reconnecting')
    expect(ui.getSnapshot().phase).toBe('idle')
    expect(fake.disconnect).toHaveBeenCalledOnce()
    expect(fake.connect).toHaveBeenCalledOnce()
    ui.dispose()
  })
})

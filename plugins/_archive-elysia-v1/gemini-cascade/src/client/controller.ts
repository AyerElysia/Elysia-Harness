import {
  Room, RoomEvent, Track, ParticipantKind, createLocalAudioTrack,
  type LocalAudioTrack, type RemoteAudioTrack,
} from 'livekit-client'
import {
  API, AUDIO_TRACK, EVENT_TOPIC, INITIAL, INPUT_TOPIC, MAIN_SESSION_ID, SESSION_ID,
  decodeEvent, encodeText, isVoiceSession, parseOpened, parseToken, turnErrorNotice, type Snapshot, type VoiceSessionId,
} from './protocol.ts'

type BrowserFetch = (path: string, init: RequestInit) => Promise<Response>
const MAX_CALL_MS = 10 * 60 * 1000
const CONNECT_TIMEOUT_MS = 25_000
const WORKER_TIMEOUT_MS = 22_000
type Call = {
  readonly sessionId: VoiceSessionId
  readonly room: Room; readonly abort: AbortController
  readonly elements: Map<RemoteAudioTrack, HTMLMediaElement>
  microphone?: LocalAudioTrack
  control?: { roomName: string; callToken: string }
  workerId?: string
  expires?: ReturnType<typeof setTimeout>
  deadline?: ReturnType<typeof setTimeout>
  workerTimer?: ReturnType<typeof setTimeout>
  turn: number; interrupted: boolean; changingMute: boolean; sending: boolean
}

function pageFetch(path: string, init: RequestInit): Promise<Response> {
  const shell = (globalThis as { __DSH_TRANSPORT__?: { fetch?: BrowserFetch } }).__DSH_TRANSPORT__?.fetch
  return shell ? shell(path.slice(1), init) : fetch(path, { ...init, credentials: 'same-origin' })
}

async function api(name: 'open' | 'start', body: object, signal: AbortSignal): Promise<unknown> {
  const response = await pageFetch(API + name, {
    method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body), signal,
  })
  if (!response.ok) {
    void response.body?.cancel().catch(() => {})
    throw new Error(response.status === 409 ? 'cascade_busy' : 'cascade_host_failed')
  }
  if (!response.body || !/^application\/json\b/iu.test(response.headers.get('content-type') ?? '')) {
    void response.body?.cancel().catch(() => {})
    throw new Error('cascade_host_failed')
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let length = 0, json = ''
  try {
    for (;;) {
      signal.throwIfAborted()
      const part = await reader.read()
      if (part.done) break
      length += part.value.byteLength
      if (length > 8_192) throw new Error('cascade_host_failed')
      json += decoder.decode(part.value, { stream: true })
    }
    signal.throwIfAborted()
    return JSON.parse(json + decoder.decode()) as unknown
  } finally { void reader.cancel().catch(() => {}) }
}

export class CascadeController {
  private snapshot: Snapshot = INITIAL
  private listeners = new Set<() => void>()
  private call: Call | undefined
  private disposed = false
  private disclosureRequest: AbortController | undefined
  private closeSeat: (() => void) | undefined
  constructor(private readonly reserveSeat: () => () => void) {}
  getSnapshot = (): Snapshot => this.snapshot
  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn)
    return () => { this.listeners.delete(fn) }
  }
  private patch(update: Partial<Snapshot>): void {
    this.snapshot = { ...this.snapshot, ...update }
    for (const fn of [...this.listeners]) fn()
  }
  async openSession(signal: AbortSignal): Promise<string> {
    if (this.disposed) throw new Error('cascade_unavailable')
    return parseOpened(await api('open', {}, signal)).sessionId
  }
  requestConsent = async (sessionId: VoiceSessionId = SESSION_ID): Promise<void> => {
    if (this.disposed || this.call || this.snapshot.phase !== 'idle' || !isVoiceSession(sessionId)) return
    const owner = new AbortController()
    this.disclosureRequest = owner
    if (sessionId === SESSION_ID) this.closeSeat = this.reserveSeat()
    this.patch({ ...INITIAL, phase: 'disclosure', sessionId })
    try {
      const signal = AbortSignal.any([owner.signal, AbortSignal.timeout(12000)])
      const { inputMode } = parseOpened(await api('open', sessionId === MAIN_SESSION_ID ? { sessionId } : {}, signal), sessionId)
      if (this.disclosureRequest === owner) this.patch({ phase: 'consent', inputMode })
    } catch {
      if (this.disclosureRequest === owner) this.patch({
        notice: sessionId === MAIN_SESSION_ID
          ? '主意识通话暂不可用，未开启麦克风。你仍可在这里打字。'
          : '无法确认语音处理方式，未开启麦克风。关闭后可以手动再试。',
      })
    } finally {
      if (this.disclosureRequest === owner) this.disclosureRequest = undefined
    }
  }
  start = async (): Promise<void> => {
    const { phase, inputMode, sessionId } = this.snapshot
    if (this.disposed || this.call || phase !== 'consent' || inputMode === null || sessionId === null) return
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      this.patch({ notice: '请在本机或安全的浏览器页面开启麦克风。' })
      return
    }
    const room = new Room({ reconnectPolicy: { nextRetryDelayInMs: () => null }, stopLocalTrackOnUnpublish: true })
    const owner: Call = {
      sessionId, room, abort: new AbortController(), elements: new Map(), turn: -1, interrupted: false, changingMute: false, sending: false,
    }
    this.call = owner
    owner.expires = setTimeout(() => this.end('本次通话已到 10 分钟上限。', owner), MAX_CALL_MS)
    owner.deadline = setTimeout(() => this.end('连接或麦克风授权超时。可以手动再试。', owner), CONNECT_TIMEOUT_MS)
    room.on(RoomEvent.Disconnected, () => this.end('通话连接已断开。不会自动重拨。', owner))
    room.on(RoomEvent.Reconnecting, () => this.end('通话连接已断开。不会自动重拨。', owner))
    room.on(RoomEvent.AudioPlaybackStatusChanged, () => {
      if (this.call === owner) this.patch({ playbackBlocked: !room.canPlaybackAudio })
    })
    room.on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
      if (this.call !== owner || track.kind !== Track.Kind.Audio || publication.trackName !== AUDIO_TRACK
        || participant.kind !== ParticipantKind.AGENT || (owner.workerId && owner.workerId !== participant.identity)) return
      owner.workerId = participant.identity
      const audio = track as RemoteAudioTrack
      if (owner.elements.has(audio)) return
      const node = audio.attach()
      node.hidden = true
      document.body.appendChild(node)
      owner.elements.set(audio, node)
      clearTimeout(owner.workerTimer)
      this.patch({ playbackBlocked: !room.canPlaybackAudio, workerReady: true,
        ...(this.snapshot.phase === 'waiting' ? { phase: 'listening' } : {}) })
    })
    room.on(RoomEvent.TrackUnsubscribed, track => this.detach(owner, track as RemoteAudioTrack))
    room.on(RoomEvent.ParticipantDisconnected, participant => {
      if (participant.identity === owner.workerId) this.end('爱莉已离开通话。', owner)
    })
    room.on(RoomEvent.DataReceived, (payload, participant, _kind, topic) => {
      if (this.call !== owner || topic !== EVENT_TOPIC || participant?.kind !== ParticipantKind.AGENT
        || (owner.workerId && owner.workerId !== participant.identity)) return
      const event = decodeEvent(payload)
      if (!event || event.turn < owner.turn) return
      owner.workerId = participant.identity
      if (event.turn > owner.turn) {
        owner.turn = event.turn
        owner.interrupted = false
        this.patch({ notice: '' })
      }
      if (event.type === 'state') {
        if (event.state === 'closed') { this.end('本次通话已结束。', owner); return }
        clearTimeout(owner.workerTimer)
        this.patch({ phase: event.state, workerReady: true })
      } else if (event.type === 'interrupted') {
        owner.interrupted = true
        this.patch({ notice: sessionId === MAIN_SESSION_ID ? '已打断语音播放；主意识仍可继续文字回复。' : '上一条回复已打断。' })
      } else if (event.type === 'error') {
        this.patch({ notice: turnErrorNotice(event.code) })
      } else if (!owner.interrupted && event.type === 'user' && event.input === 'voice') {
        if (inputMode === 'direct-audio') this.patch({ notice: '此模式不提供语音转写。' })
        else if (!event.hasTranscript) this.patch({ notice: '本轮没有取得语音转写。' })
      }
    })
    this.patch({ phase: 'connecting', notice: '' })
    // Try playback activation inside the explicit user gesture. If blocked, the
    // call control presents a separate user gesture; it never requests capture.
    void room.startAudio().catch(() => {})
    try {
      const value = await api('start', { sessionId, inputMode }, owner.abort.signal)
      const token = parseToken(value, window.location.hostname)
      const control = { roomName: token.roomName, callToken: token.callToken }
      if (this.call !== owner) { void stopHost(sessionId, control); return }
      owner.control = control
      await room.connect(token.serverUrl, token.participantToken, { autoSubscribe: true, maxRetries: 0 })
      if (this.call !== owner) { void room.disconnect(true).catch(() => {}); return }
      if (room.name !== token.roomName) throw new Error('cascade_room_mismatch')
      this.patch({ phase: 'microphone' })
      const track = await createLocalAudioTrack({ echoCancellation: true, noiseSuppression: true, autoGainControl: true })
      if (this.call !== owner) { track.stop(); return }
      owner.microphone = track
      // SDK 2.22's LocalAudioTrack declaration narrows an optional processor
      // member; publish the exact SDK-created track rather than cloning it.
      const publishable = track as unknown as Parameters<typeof room.localParticipant.publishTrack>[0]
      await room.localParticipant.publishTrack(publishable, { source: Track.Source.Microphone })
      if (this.call !== owner) return
      clearTimeout(owner.deadline)
      const current = this.getSnapshot()
      this.patch({ micReady: true, ...(current.phase === 'microphone' && current.workerReady ? { phase: 'listening' } : {}) })
      if (!this.snapshot.workerReady) {
        this.patch({ phase: 'waiting' })
        owner.workerTimer = setTimeout(() => this.end('通话服务没有及时响应，可以手动再试。', owner), WORKER_TIMEOUT_MS)
      }
    } catch (error) {
      const denied = error instanceof Error && ['NotAllowedError', 'PermissionDeniedError'].includes(error.name)
      const missing = error instanceof Error && ['NotFoundError', 'DevicesNotFoundError'].includes(error.name)
      const busy = error instanceof Error && error.message === 'cascade_busy'
      this.end(denied ? '未取得麦克风权限。' : missing ? '没有找到可用的麦克风。'
        : busy ? '另一个通话还在结束，请稍后手动再试。' : '无法开始通话。不会自动重拨。', owner)
    }
  }
  async sendText(raw: string): Promise<boolean> {
    const owner = this.call
    if (!owner?.workerId || owner.sessionId !== SESSION_ID || !this.snapshot.workerReady || !this.snapshot.micReady || owner.sending) return false
    const bytes = encodeText(raw)
    if (!bytes) { this.patch({ notice: '请缩短这条消息后再发。' }); return false }
    owner.sending = true
    try {
      await owner.room.localParticipant.publishData(bytes, {
        reliable: true, topic: INPUT_TOPIC, destinationIdentities: [owner.workerId],
      })
      return this.call === owner
    } catch {
      if (this.call === owner) this.patch({ notice: '文字未发送，可以手动再试。' })
      return false
    } finally { owner.sending = false }
  }
  toggleMute = async (): Promise<void> => {
    const owner = this.call
    const track = owner?.microphone
    if (!track || owner.changingMute) return
    owner.changingMute = true
    try {
      if (track.isMuted) await track.unmute(); else await track.mute()
      if (this.call === owner) this.patch({ muted: track.isMuted })
    } catch {
      if (this.call === owner) this.patch({ notice: '静音切换失败；可挂断以关闭麦克风。' })
    } finally { owner.changingMute = false }
  }
  enablePlayback = async (): Promise<void> => {
    const owner = this.call
    if (!owner) return
    try { await owner.room.startAudio() } catch { /* Browser can still deny playback. */ }
    if (this.call === owner) this.patch({ playbackBlocked: !owner.room.canPlaybackAudio })
  }
  private detach(owner: Call, track: RemoteAudioTrack): void {
    const node = owner.elements.get(track)
    if (!node) return
    owner.elements.delete(track)
    try { track.detach(node) } catch { /* The room may have already detached it. */ }
    finally { node.remove() }
  }
  end = (notice = '', owner = this.call): void => {
    if (owner !== this.call) return
    this.call = undefined
    this.disclosureRequest?.abort()
    this.disclosureRequest = undefined
    if (owner) {
      owner.abort.abort()
      clearTimeout(owner.expires); clearTimeout(owner.deadline); clearTimeout(owner.workerTimer)
      try { owner.microphone?.stop() } catch { /* Browser may have revoked the track already. */ }
      for (const track of owner.elements.keys()) this.detach(owner, track)
      void owner.room.disconnect(true).catch(() => {})
      if (owner.control) void stopHost(owner.sessionId, owner.control)
    }
    this.patch({ ...INITIAL, sessionId: notice ? this.snapshot.sessionId : null, notice })
    const release = this.closeSeat
    this.closeSeat = undefined
    release?.()
  }
  dispose = (): void => { this.disposed = true; this.end(); this.listeners.clear() }
}

async function stopHost(sessionId: VoiceSessionId, control: NonNullable<Call['control']>): Promise<void> {
  try {
    const response = await pageFetch(API + 'stop', {
      method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, ...control }), signal: AbortSignal.timeout(3000),
    })
    void response.body?.cancel().catch(() => {})
  } catch { /* Local microphone and playback are already stopped. */ }
}

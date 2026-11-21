import { HEARTBEAT_MS, idleVoiceState, VOICE_SESSION_ID } from '../protocol.ts'
import type { VoiceEvent, VoiceStartResult, VoiceState } from '../protocol.ts'
import { PcmPlayer } from './pcm-player.ts'
import type { CallPlayer, PcmReceipt } from './pcm-player.ts'
import { VoiceTransport } from './transport.ts'
import { diagnoseStart, type VoiceStartDiagnostic, type VoiceStartStage } from './diagnostics.ts'
export interface VoiceView {
  state: VoiceState
  starting: boolean
  microphone: 'inactive' | 'muted' | 'sending'
  playback: 'idle' | 'buffering' | 'playing' | 'stopped'
  text: string
  error: string | null
  diagnostic: VoiceStartDiagnostic | null
}
export interface BrowserPorts {
  secure(): boolean
  media(): Promise<MediaStream>
  peer(): RTCPeerConnection
  player(receipt: (value: PcmReceipt) => void, status: (value: 'playing' | 'idle' | 'failed') => void): CallPlayer
}
const browserPorts: BrowserPorts = {
  secure: () => globalThis.isSecureContext === true,
  media: () => navigator.mediaDevices.getUserMedia({ audio: { echoCancellation:true,noiseSuppression:true,autoGainControl:true } }),
  peer: () => new RTCPeerConnection(),
  player: (receipt,status) => new PcmPlayer(receipt,status),
}
export class VoiceController {
  private current: VoiceView = { state:idleVoiceState(),starting:false,microphone:'inactive',playback:'idle',text:'',error:null,diagnostic:null }
  private readonly listeners = new Set<() => void>()
  private version = 0
  private stream: MediaStream | null = null
  private peer: RTCPeerConnection | null = null
  private player: CallPlayer | null = null
  private call: VoiceStartResult | null = null
  private life: AbortController | null = null
  private heartbeat: ReturnType<typeof setInterval> | null = null
  private setupTimer: ReturnType<typeof setTimeout> | null = null
  private eventTimer: ReturnType<typeof setTimeout> | null = null
  private ready = false
  private muted = false
  private enabling = false
  private lastSeq: number | null = null
  private epoch = 0
  private disposed = false
  readonly snapshot = (): VoiceView => this.current
  readonly subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  constructor(private readonly transport: Pick<VoiceTransport,'state'|'start'|'control'|'playback'|'follow'> = new VoiceTransport(), private readonly ports: BrowserPorts = browserPorts) {}
  private patch(value: Partial<VoiceView>): void {
    this.current = { ...this.current,...value }
    for (const listener of this.listeners) listener()
  }
  async load(): Promise<void> {
    try { const state = await this.transport.state(); if (!this.disposed && !this.call) this.patch({state}) }
    catch { if (!this.disposed) this.patch({error:'voice_state_unavailable',diagnostic:null}) }
  }
  async start(privacyAccepted: boolean): Promise<void> {
    if (this.disposed || this.call || this.current.starting) return
    if (!privacyAccepted) { this.patch({error:'privacy_confirmation_required',diagnostic:null}); return }
    if (!this.ports.secure()) { this.patch({error:'microphone_requires_https_or_localhost',diagnostic:null}); return }
    const version = ++this.version
    const life = new AbortController(); this.life = life
    this.muted = false; this.ready = false; this.lastSeq = null; this.epoch = 0
    this.patch({starting:true,error:null,diagnostic:null,text:'',microphone:'inactive',playback:'idle',
      state:{...this.current.state,connection:'connecting',callId:null}})
    let stage: VoiceStartStage = 'audio_prepare'
    try {
      const player = this.ports.player(receipt => this.ack(receipt),status => {
        if (version !== this.version) return
        if (status === 'failed') void this.stop('pcm_player_failed')
        else this.patch({playback:status})
      })
      this.player = player
      await player.prepare()
      if (version !== this.version || life.signal.aborted) { player.dispose(); return }
      stage = 'microphone'
      const stream = await this.ports.media()
      if (version !== this.version || life.signal.aborted) { for (const track of stream.getTracks()) track.stop(); return }
      this.stream = stream
      for (const track of stream.getTracks()) {
        track.enabled = false
        track.onended = () => { if (version === this.version) void this.stop('microphone_disconnected') }
      }
      this.patch({microphone:'muted'})
      stage = 'webrtc_offer'
      const peer = this.ports.peer(); this.peer = peer
      peer.onconnectionstatechange = () => {
        if (version !== this.version) return
        if (peer.connectionState === 'failed' || peer.connectionState === 'disconnected' || peer.connectionState === 'closed') void this.stop('webrtc_connection_lost')
        else if (peer.connectionState === 'connected') void this.maybeEnable()
      }
      for (const track of stream.getAudioTracks()) peer.addTrack(track,stream)
      peer.createDataChannel('oai-events') // No client generation/configuration commands.
      const offer = await peer.createOffer()
      await peer.setLocalDescription(offer)
      stage = 'ice_gathering'
      await this.waitIce(peer,life.signal)
      if (version !== this.version || life.signal.aborted) return
      const sdp = peer.localDescription?.sdp
      if (!sdp) throw new Error('missing_local_sdp')
      stage = 'server_start'
      const result = await this.transport.start({requestId:crypto.randomUUID(),sdp,privacyMode:'no-raw-audio'},life.signal)
      if (version !== this.version || life.signal.aborted) {
        void this.transport.control({callId:result.callId,epoch:result.epoch,action:'hangup'},result.capability).catch(() => {})
        return
      }
      if (!result.callId || !result.capability || typeof result.sdp !== 'string' || !Number.isSafeInteger(result.epoch) || result.sessionId !== VOICE_SESSION_ID) throw new Error('invalid_call_start')
      this.call = result; this.epoch = result.epoch; this.player?.reset(this.epoch)
      this.setupTimer = setTimeout(() => {
        this.setupTimer = null
        if (version === this.version && (!this.ready || peer.connectionState !== 'connected')) void this.stop('voice_connection_timeout')
      },15_000)
      this.armEventDeadline()
      this.heartbeat = setInterval(() => { void this.control('heartbeat').catch(() => { void this.stop('voice_heartbeat_failed') }) },HEARTBEAT_MS)
      void this.transport.follow(result.callId,result.capability,life.signal,event => {
        if (version === this.version) this.receive(event)
      }).catch(() => { if (version === this.version && !life.signal.aborted) void this.stop('voice_event_stream_lost') })
      stage = 'webrtc_answer'
      await peer.setRemoteDescription({type:'answer',sdp:result.sdp})
      if (version !== this.version || life.signal.aborted) return
      this.patch({starting:false})
      await this.maybeEnable()
    } catch (error) {
      if (version === this.version && !life.signal.aborted) await this.stop('voice_start_failed_' + stage,diagnoseStart(stage,error))
    }
  }
  private async waitIce(peer: RTCPeerConnection,signal: AbortSignal): Promise<void> {
    if (peer.iceGatheringState === 'complete') return
    await new Promise<void>((resolve,reject) => {
      const finish = (error?: Error) => {
        clearTimeout(timer); peer.removeEventListener('icegatheringstatechange',changed); signal.removeEventListener('abort',aborted)
        if (error) reject(error); else resolve()
      }
      const changed = () => { if (peer.iceGatheringState === 'complete') finish() }
      const aborted = () => finish(new Error('call_cancelled'))
      const timer = setTimeout(() => finish(new DOMException('','TimeoutError')),10_000)
      peer.addEventListener('icegatheringstatechange',changed); signal.addEventListener('abort',aborted,{once:true})
      if (signal.aborted) aborted(); else changed()
    })
  }
  private async maybeEnable(): Promise<void> {
    if (this.ready && this.peer?.connectionState === 'connected' && this.setupTimer) { clearTimeout(this.setupTimer); this.setupTimer = null }
    if (!this.call || !this.ready || this.peer?.connectionState !== 'connected' || this.muted || this.enabling || this.current.microphone === 'sending' || this.life?.signal.aborted) return
    this.enabling = true
    const version = this.version
    try {
      await this.control('unmute')
      if (version !== this.version || this.muted || this.life?.signal.aborted) return
      for (const track of this.stream?.getAudioTracks() ?? []) track.enabled = true
      this.patch({microphone:'sending'})
    } catch { if (version === this.version) await this.stop('voice_unmute_failed') }
    finally { if (version === this.version) this.enabling = false }
  }
  private armEventDeadline(): void {
    if (this.eventTimer) clearTimeout(this.eventTimer)
    const version = this.version
    this.eventTimer = setTimeout(() => {
      this.eventTimer = null
      if (version === this.version) void this.stop('voice_event_stream_timeout')
    },15_000)
  }
  receive(event: VoiceEvent): void {
    if (!this.call || event.callId !== this.call.callId) return
    if (this.lastSeq !== null && event.seq <= this.lastSeq) return
    if (this.lastSeq !== null && event.seq !== this.lastSeq + 1) { void this.stop('voice_event_sequence_gap'); return }
    this.lastSeq = event.seq
    if (event.epoch < this.epoch) return
    this.armEventDeadline()
    if (event.epoch > this.epoch) { this.epoch = event.epoch; this.player?.reset(this.epoch); this.patch({playback:'stopped'}) }
    try {
      switch (event.type) {
        case 'state':
          this.ready = event.state.connection === 'ready'
          this.patch({state:event.state})
          if (['failed','ended','closing'].includes(event.state.connection)) void this.stop(event.state.errorCode)
          else void this.maybeEnable()
          break
        case 'text': this.patch({text:event.text}); break
        case 'pcm': this.player?.pcm(event); this.patch({playback:'buffering'}); break
        case 'segment-end': this.player?.end(event); break
        case 'output-stop': this.player?.reset(this.epoch); this.patch({playback:'stopped'}); break
        case 'error': void this.stop(event.code); break
        case 'end': void this.stop(null); break
        default: void this.stop('unknown_voice_event')
      }
    } catch { void this.stop('invalid_audio_stream') }
  }
  private ack(receipt: PcmReceipt): void {
    const call = this.call
    if (!call || receipt.epoch !== this.epoch) return
    void this.transport.playback({callId:call.callId,...receipt},call.capability).catch(() => { void this.stop('voice_playback_receipt_failed') })
  }
  private async control(action: 'heartbeat' | 'mute' | 'unmute' | 'stop-playback'): Promise<VoiceState> {
    const call = this.call
    if (!call) throw new Error('call_not_active')
    const version = this.version
    const state = await this.transport.control({callId:call.callId,epoch:this.epoch,action},call.capability)
    if (version === this.version && this.call === call) {
      if (state.epoch > this.epoch) { this.epoch = state.epoch; this.player?.reset(this.epoch) }
      this.patch({state})
    }
    return state
  }
  async setMuted(muted: boolean): Promise<void> {
    this.muted = muted
    for (const track of this.stream?.getAudioTracks() ?? []) track.enabled = false
    this.patch({microphone:this.stream ? 'muted' : 'inactive'})
    if (!this.call) return
    try { if (muted) await this.control('mute'); else await this.maybeEnable() }
    catch { await this.stop('voice_mute_failed') }
  }
  async stopPlayback(): Promise<void> {
    if (!this.call) return
    const pending = this.control('stop-playback')
    this.player?.reset(this.epoch + 1); this.patch({playback:'stopped'})
    try { await pending }
    catch { await this.stop('voice_stop_playback_failed') }
  }
  async stop(error: string | null = null, diagnostic: VoiceStartDiagnostic | null = null): Promise<void> {
    const call = this.call
    // Repeated cleanup/pagehide must not erase the first failure after resources are gone.
    const preserveFailure = !call && !this.current.starting && this.current.error !== null
    const finalError = preserveFailure ? this.current.error : error
    const finalDiagnostic = preserveFailure ? this.current.diagnostic : diagnostic
    this.version++; this.call = null; this.ready = false; this.enabling = false
    if (this.heartbeat) clearInterval(this.heartbeat); this.heartbeat = null
    if (this.setupTimer) clearTimeout(this.setupTimer); this.setupTimer = null
    if (this.eventTimer) clearTimeout(this.eventTimer); this.eventTimer = null
    for (const track of this.stream?.getTracks() ?? []) { track.onended = null; track.enabled = false; track.stop() }
    this.stream = null
    if (this.peer) { this.peer.onconnectionstatechange = null; this.peer.close() }; this.peer = null
    this.player?.dispose(); this.player = null
    this.life?.abort(); this.life = null
    this.patch({starting:false,microphone:'inactive',playback:'stopped',error:finalError,diagnostic:finalDiagnostic,
      state:{...this.current.state,callId:null,capture:'inactive',connection:finalError ? 'failed' : 'ended'}})
    if (call) {
      try { await this.transport.control({callId:call.callId,epoch:this.epoch,action:'hangup'},call.capability) } catch {}
    }
  }
  dispose(): void { this.disposed = true; void this.stop(null); this.listeners.clear() }
}

import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import type { VoiceAgent, VoiceDriver, RecordedVoiceResponse } from './session.ts'
import { createDriver, RealtimeError, type RealtimeCall, type RealtimeEvent, type RealtimeTransport } from './realtime.ts'
import { loadBreezeSettings, streamBreeze, splitSpeechText, type BreezeSettings } from './breeze-stream.ts'
import { CLIENT_LEASE_MS, MAX_CALL_MS, idleVoiceState, parseControl, parsePlayback, parseStart,
  type VoiceEvent, type VoiceEventPayload, type VoiceState, type VoiceStartResult, type VoicePlaybackReceipt } from './protocol.ts'
import type { VoiceActivity } from './activity.ts'
import { BROWSER_START_TIMEOUT_MS, LOCAL_OPERATION_TIMEOUT_MS, PROVIDER_SETUP_TIMEOUT_MS, SERVER_START_TIMEOUT_MS,
  type ProviderSetupPhase, type StartupPhase } from './startup-budget.ts'
export type { VoiceActivity } from './activity.ts'

export class VoiceCallError extends Error {
  constructor(readonly code: string, readonly upstreamStatus?: number) { super(`Voice call failed (${code}).`); this.name = 'VoiceCallError' }
}
export type ExportedVoiceAgentHandle = Pick<VoiceAgent, 'cancel' | 'whenIdle'>
export type ControllerRecordedResponse = Pick<RecordedVoiceResponse, 'message' | 'turn' | 'step' | 'signal' | 'seq'>
export interface OpenedVoiceAgent {
  agent: ExportedVoiceAgentHandle
  initialInstructions: string
  close(): Promise<void>
}
export interface VoiceControllerDependencies {
  enabled: boolean
  credentialConfigured: boolean
  breezeConfigPath: string
  breezeServerUrl?: string
  realtime: Pick<RealtimeTransport, 'create'>
  resolveApiKey(signal: AbortSignal): Promise<string>
  openAgent(input: { driver: VoiceDriver; onRecordedResponse(response: ControllerRecordedResponse): Promise<void>; signal: AbortSignal }): Promise<OpenedVoiceAgent>
  /** Must checkpoint the attributed source input before waking the native Agent. */
  acceptAudioCommit(agent: ExportedVoiceAgentHandle, event: Extract<RealtimeEvent, { type: 'audio_committed' }>, callId: string, epoch: number): Promise<void>
  /** Durable infrastructure authority, never a fabricated assistant/persona message. */
  recordActivity(event: VoiceActivity): Promise<void>
  loadSettings?: typeof loadBreezeSettings
  synthesize?: typeof streamBreeze
  now?: () => number
  operationTimeoutMs?: number
}
interface Segment {
  id: string; responseId: string; epoch: number; text: string; frames: number; complete: boolean
  reportedFrames: number; reported: boolean; fullyReported: boolean; projected: boolean
}
interface StartAttempt { status: 'starting' | 'ready' | 'failed' | 'ended'; promise: Promise<VoiceStartResult>; result?: VoiceStartResult }
interface CallOwner {
  id: string; requestId: string; capability: Buffer; lifetime: AbortController; state: VoiceState
  provider?: RealtimeCall; opened?: OpenedVoiceAgent; settings?: BreezeSettings
  sink: ((event: VoiceEvent) => boolean | void) | undefined; subscriberClaimed: boolean; seq: number; lastStateAt: number
  heartbeatAt: number; leaseTimer?: ReturnType<typeof setInterval>; maxTimer?: ReturnType<typeof setTimeout>
  disposeProvider?: () => void; breeze: AbortController | undefined; closing?: Promise<void>; stopped: boolean
  serial: Promise<void>; commits: Set<string>; turns: Map<string, { epoch: number; responseId?: string }>
  segments: Segment[]; projectionCursor: number
  acquisitions: Set<Promise<unknown>>
  background: Set<Promise<void>>; auditFailed: boolean; agentRegistered: boolean
  startupPhase?: StartupPhase; providerSetupPhase?: ProviderSetupPhase; startupTimedOut?: boolean
  providerSetupCleanupUnconfirmed?: boolean
}

function copied(state: VoiceState): VoiceState { return { ...state, usage: { ...state.usage } } }
function parse<T>(reader: (raw: unknown) => T, raw: unknown): T {
  try { return reader(raw) } catch { throw new VoiceCallError('invalid_request') }
}
function safeReason(reason: string): string {
  return ['client_hangup', 'client_disconnect', 'server_close', 'client_lease_expired', 'max_duration', 'provider_error', 'persistence_failed', 'event_backpressure', 'event_stream_lost', 'start_aborted', 'start_failed', 'start_timeout', 'generation_failed', 'playback_failed'].includes(reason)
    || /^start_failed_(?:breeze_config|agent_prepare|credential_resolve|provider_create|call_ready)$/u.test(reason) ? reason : 'server_close'
}

/** One in-memory call owner. Native Session/persistence authority remains injected. */
export class VoiceCallController {
  private current: CallOwner | undefined
  private state: VoiceState
  private attempts = new Map<string, StartAttempt>()
  private readonly now: () => number
  constructor(private readonly deps: VoiceControllerDependencies) {
    this.state = idleVoiceState(deps.enabled, deps.credentialConfigured)
    this.now = deps.now ?? Date.now
  }
  getState(): VoiceState { return copied(this.state) }
  updateCredentialConfigured(configured: boolean): void {
    this.state = { ...this.state, credentialConfigured: configured }
    if (this.current) { this.current.state = { ...this.current.state, credentialConfigured: configured }; this.changed(this.current) }
  }
  private set(owner: CallOwner, patch: Partial<VoiceState>) {
    owner.state = { ...owner.state, ...patch }
    if (this.current === owner) this.state = owner.state
  }
  private emit(owner: CallOwner, payload: VoiceEventPayload) {
    if (!owner.sink) return
    const event = { ...payload, callId: owner.id, epoch: owner.state.epoch, seq: ++owner.seq, at: this.now() } as VoiceEvent
    try { if (owner.sink(event) === false) this.fail(owner, 'event_backpressure') }
    catch { this.fail(owner, 'event_stream_lost') }
  }
  private changed(owner: CallOwner) { owner.lastStateAt = this.now(); this.emit(owner, { type: 'state', state: copied(owner.state) }) }
  private async bounded<T>(pending: Promise<T>, signal?: AbortSignal, budget = LOCAL_OPERATION_TIMEOUT_MS): Promise<T> {
    if (signal?.aborted) { void pending.catch(() => {}); throw new VoiceCallError('operation_aborted') }
    let abort = () => {}
    let timer: ReturnType<typeof setTimeout> | undefined
    const guard = new Promise<never>((_resolve, reject) => {
      abort = () => reject(new VoiceCallError('operation_aborted'))
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) abort()
      timer = setTimeout(() => reject(new VoiceCallError('operation_timeout')), this.deps.operationTimeoutMs ?? budget)
    })
    try { return await Promise.race([pending, guard]) }
    finally { clearTimeout(timer); signal?.removeEventListener('abort', abort) }
  }
  private async record(owner: CallOwner, type: string, details?: VoiceActivity['details'], _duringClose = false, epoch = owner.state.epoch) {
    const event: VoiceActivity = { source: 'voice-call-controller', callId: owner.id, epoch, type, at: this.now(), details: { ...details, agentRegistered: owner.agentRegistered } }
    try { await this.bounded(this.deps.recordActivity(event)) }
    catch { owner.auditFailed = true; throw new VoiceCallError('persistence_failed') }
  }
  private serialized<T>(owner: CallOwner, task: () => Promise<T>): Promise<T> {
    const result = owner.serial.then(task)
    owner.serial = result.then(() => {}, () => {})
    return result
  }
  private authenticate(callId: string, capability: string): CallOwner {
    const owner = this.current
    const supplied = typeof capability === 'string' ? Buffer.from(capability, 'utf8') : Buffer.alloc(0)
    if (!owner || owner.id !== callId || owner.stopped || supplied.byteLength !== owner.capability.byteLength || !timingSafeEqual(supplied, owner.capability)) throw new VoiceCallError('unauthorized_capability')
    return owner
  }
  private checkEpoch(owner: CallOwner, epoch: number): 'current' | 'old' {
    if (epoch > owner.state.epoch) throw new VoiceCallError('invalid_future_epoch')
    return epoch === owner.state.epoch ? 'current' : 'old'
  }

  async start(raw: unknown, signal?: AbortSignal): Promise<VoiceStartResult> {
    const input = parse(parseStart, raw)
    if (signal?.aborted) throw new VoiceCallError('start_aborted')
    const previous = this.attempts.get(input.requestId)
    if (previous) {
      if (previous.status === 'failed') throw new VoiceCallError('start_failed')
      if (previous.status === 'ended') throw new VoiceCallError('start_ended')
      // A duplicate request owns only its wait, never the original resources.
      return this.bounded(previous.promise, signal, BROWSER_START_TIMEOUT_MS)
    }
    if (!this.deps.enabled) throw new VoiceCallError('disabled')
    if (!this.state.credentialConfigured) throw new VoiceCallError('credential_missing')
    if (this.current && (!this.current.stopped || this.current.state.connection === 'closing' || this.current.state.errorCode === 'cleanup_failed')) throw new VoiceCallError('call_busy')
    if (this.attempts.size >= 256) throw new VoiceCallError('start_history_limit')
    const owner: CallOwner = {
      id: randomUUID(), requestId: input.requestId, capability: Buffer.from(randomBytes(32).toString('base64url'), 'utf8'),
      lifetime: new AbortController(), state: { ...idleVoiceState(true, true), connection: 'connecting', callId: null, expiresAt: this.now() + MAX_CALL_MS },
      subscriberClaimed: false, sink: undefined, seq: 0, lastStateAt: this.now(), heartbeatAt: this.now(), stopped: false, breeze: undefined, serial: Promise.resolve(), commits: new Set(), turns: new Map(), segments: [], projectionCursor: 0, acquisitions: new Set(), background: new Set(), auditFailed: false, agentRegistered: false,
    }
    owner.state.callId = owner.id; this.current = owner; this.state = owner.state
    let attempt!: StartAttempt
    const promise = this.begin(owner, input.sdp, signal).then(result => {
      if (owner.stopped) { attempt.status = 'ended'; throw new VoiceCallError('start_ended') }
      attempt.status = 'ready'; attempt.result = result; return result
    }, error => { attempt.status = 'failed'; throw error })
    attempt = { status: 'starting', promise }; this.attempts.set(input.requestId, attempt)
    return promise
  }
  private async begin(owner: CallOwner, sdp: string, requestSignal?: AbortSignal): Promise<VoiceStartResult> {
    owner.startupPhase ??= 'breeze_config'
    const deadline = setTimeout(() => {
      if (owner.stopped) return
      owner.startupTimedOut = true
      owner.lifetime.abort()
    }, SERVER_START_TIMEOUT_MS)
    deadline.unref?.()
    const abort = () => {
      clearTimeout(deadline)
      owner.lifetime.abort()
      void this.end(owner, owner.startupTimedOut ? 'start_timeout' : 'start_aborted', owner.startupTimedOut === true).catch(() => {})
    }
    const check = () => { if (owner.stopped || owner.lifetime.signal.aborted) throw new VoiceCallError('start_aborted') }
    const enter = async (next: StartupPhase) => {
      check()
      owner.startupPhase = next
      await this.record(owner, 'startup-phase', { startupPhase: next })
      check()
    }
    requestSignal?.addEventListener('abort', abort, { once: true })
    if (requestSignal?.aborted) abort()
    try {
      check()
      await this.record(owner, 'call-start-requested', { requestId: owner.requestId, rawAudioRecorded: false,
        expiresAt: owner.state.expiresAt!, startupPhase: 'breeze_config' })
      check()
      owner.settings = await this.bounded((this.deps.loadSettings ?? loadBreezeSettings)(this.deps.breezeConfigPath, this.deps.breezeServerUrl), owner.lifetime.signal)
      await enter('agent_prepare')
      const driver: VoiceDriver = { run: request => this.drive(owner, request) }
      const opening = this.deps.openAgent({ driver, onRecordedResponse: response => this.recorded(owner, response), signal: owner.lifetime.signal })
      owner.acquisitions.add(opening)
      void opening.then(opened => {
        owner.opened = opened; owner.agentRegistered = true; owner.acquisitions.delete(opening)
        if (owner.stopped) void opened.close().then(() => { owner.agentRegistered = false }, () => this.lateCleanupFailed(owner))
      }, () => { owner.acquisitions.delete(opening) })
      owner.opened = await this.bounded(opening, owner.lifetime.signal)
      await enter('credential_resolve')
      let apiKey = await this.bounded(this.deps.resolveApiKey(owner.lifetime.signal), owner.lifetime.signal)
      try {
        if (!apiKey.trim()) throw new VoiceCallError('credential_missing')
        await enter('provider_create')
        const creating = this.deps.realtime.create({
          sdp, instructions: owner.opened.initialInstructions, apiKey, signal: owner.lifetime.signal,
          onSetupPhase: next => { if (!owner.lifetime.signal.aborted) owner.providerSetupPhase = next },
        })
        owner.acquisitions.add(creating)
        void creating.then(provider => {
          owner.provider = provider; owner.acquisitions.delete(creating)
          if (owner.stopped) void provider.close().catch(() => this.lateCleanupFailed(owner))
        }, error => {
          owner.acquisitions.delete(creating)
          if (error instanceof RealtimeError && error.code === 'setup-cleanup-unconfirmed') {
            owner.providerSetupCleanupUnconfirmed = true
            if (owner.stopped) this.lateCleanupFailed(owner)
          }
        })
        owner.provider = await this.bounded(creating, owner.lifetime.signal, PROVIDER_SETUP_TIMEOUT_MS)
      } finally { apiKey = '' }
      await enter('call_ready')
      owner.disposeProvider = owner.provider.subscribe(event => this.providerEvent(owner, event))
      await this.record(owner, 'call-ready', { providerCallId: owner.provider.callId, rawAudioRecorded: false })
      check()
      clearTimeout(deadline)
      this.set(owner, { connection: 'ready', capture: 'muted' }); this.changed(owner)
      owner.heartbeatAt = this.now()
      owner.leaseTimer = setInterval(() => {
        if (this.now() - owner.heartbeatAt >= CLIENT_LEASE_MS) void this.end(owner, 'client_lease_expired').catch(() => {})
        else if (this.now() - owner.lastStateAt >= 5_000) this.changed(owner)
      }, 1000)
      owner.maxTimer = setTimeout(() => { void this.end(owner, 'max_duration').catch(() => {}) }, Math.max(0, owner.state.expiresAt! - this.now()))
      owner.leaseTimer.unref?.(); owner.maxTimer.unref?.()
      return { callId: owner.id, capability: owner.capability.toString('utf8'), sdp: owner.provider.sdp, epoch: owner.state.epoch, sessionId: owner.state.sessionId, expiresAt: owner.state.expiresAt! }
    } catch (error) {
      clearTimeout(deadline)
      const code = error instanceof VoiceCallError && error.code === 'persistence_failed' ? 'persistence_failed'
        : owner.startupTimedOut ? 'start_timeout' : requestSignal?.aborted ? 'start_aborted' : `start_failed_${owner.startupPhase ?? 'breeze_config'}`
      const status = owner.providerSetupPhase === 'create_http' && error instanceof RealtimeError ? error.status : undefined
      const upstreamStatus = status !== undefined && Number.isInteger(status) && status >= 400 && status <= 599 ? status : undefined
      try { await this.end(owner, code, true, upstreamStatus) }
      catch { throw new VoiceCallError('cleanup_failed') }
      throw new VoiceCallError(code, upstreamStatus)
    } finally { clearTimeout(deadline); requestSignal?.removeEventListener('abort', abort) }
  }
  private lateCleanupFailed(owner: CallOwner) { this.set(owner, { connection: 'failed', errorCode: 'cleanup_failed' }) }
  private async *drive(owner: CallOwner, request: Parameters<VoiceDriver['run']>[0]) {
    if (owner.stopped || !owner.provider) throw new VoiceCallError('provider_unavailable')
    const key = `${request.turn}:${request.step}`; const slot: { epoch: number; responseId?: string } = { epoch: owner.state.epoch }
    owner.turns.set(key, slot)
    this.set(owner, { generation: 'generating' }); this.changed(owner)
    let failed = false; let sawUsage = false
    try {
      await this.record(owner, 'prompt-rendered', { turn: request.turn, step: request.step, promptHash: createHash('sha256').update(request.instructions, 'utf8').digest('hex') })
      request.signal.throwIfAborted()
      for await (const chunk of createDriver(owner.provider).run(request)) {
        if (chunk.type === 'usage') sawUsage = true
        if (chunk.type === 'finish' && (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted')) failed = true
        yield chunk
      }
    } catch (error) { if (!request.signal.aborted) this.fail(owner, 'generation_failed'); throw error }
    finally {
      const id = owner.provider.lastSettledResponseId
      if (id) slot.responseId = id
      if (!id || request.signal.aborted) owner.turns.delete(key)
      if (!sawUsage) this.set(owner, { usage: { ...owner.state.usage, complete: false } })
      if (!owner.stopped && slot.epoch === owner.state.epoch) { this.set(owner, { generation: 'idle' }); this.changed(owner) }
      if (failed && !request.signal.aborted && slot.epoch === owner.state.epoch) this.fail(owner, 'generation_failed')
    }
  }

  subscribeEvents(callId: string, capability: string, listener: (event: VoiceEvent) => boolean | void): { end(reason?: string): Promise<void> } {
    const owner = this.authenticate(callId, capability)
    if (owner.subscriberClaimed) throw new VoiceCallError('event_owner_conflict')
    owner.subscriberClaimed = true; owner.sink = listener
    this.changed(owner)
    return { end: reason => this.end(owner, safeReason(reason ?? 'client_disconnect')) }
  }
  private providerEvent(owner: CallOwner, event: RealtimeEvent) {
    if (owner.stopped) return
    if (event.type === 'speech_started') { void this.interrupt(owner, 'speech_started').catch(() => this.fail(owner, 'persistence_failed')); return }
    if (event.type === 'error') { this.fail(owner, 'provider_error'); return }
    if (event.type === 'usage') {
      const usage = event.usage; const input = usage.inputTokens + (usage.cacheReadTokens ?? 0)
      const total = usage.totalTokens ?? input + usage.outputTokens
      void this.serialized(owner, async () => {
        await this.record(owner, 'provider-usage', { responseId: event.responseId, inputTokens: input, outputTokens: usage.outputTokens, totalTokens: total, usageComplete: true })
        const old = owner.state.usage
        this.set(owner, { usage: { inputTokens: old.inputTokens + input, outputTokens: old.outputTokens + usage.outputTokens, totalTokens: old.totalTokens + total, complete: old.complete } })
        if (!owner.stopped) this.changed(owner)
      }).catch(() => this.fail(owner, 'persistence_failed'))
      return
    }
    if (event.type === 'audio_committed') {
      if (!/^[A-Za-z0-9_-]{1,128}$/u.test(event.itemId)) { this.fail(owner, 'provider_error'); return }
      const epoch = owner.state.epoch
      if (owner.commits.has(event.itemId)) return
      if (owner.commits.size >= 1024) { this.fail(owner, 'generation_failed'); return }
      owner.commits.add(event.itemId)
      void this.serialized(owner, async () => {
        await this.recordInputFact(owner, epoch, event.itemId)
        if (owner.stopped || epoch !== owner.state.epoch || !owner.opened) {
          await this.record(owner, 'audio-commit-cancelled', { inputItemId: event.itemId, code: owner.stopped ? 'call_ended' : 'old_epoch', rawAudioRecorded: false })
          return
        }
        await this.bounded(this.deps.acceptAudioCommit(owner.opened.agent, event, owner.id, epoch))
      }).catch(() => { owner.auditFailed = true; this.fail(owner, 'persistence_failed') })
    }
  }
  private async recordInputFact(owner: CallOwner, epoch: number, itemId: string) {
    try {
      await this.bounded(this.deps.recordActivity({ source: 'voice-call-controller', callId: owner.id, epoch, at: this.now(), type: 'audio-committed', details: { inputItemId: itemId, rawAudioRecorded: false, agentRegistered: owner.agentRegistered } }))
    } catch { owner.auditFailed = true; throw new VoiceCallError('persistence_failed') }
  }
  private interrupt(owner: CallOwner, reason: string): Promise<void> {
    if (owner.stopped) return Promise.resolve()
    this.set(owner, { epoch: owner.state.epoch + 1, playback: 'stopped', generation: 'idle' })
    owner.breeze?.abort()
    owner.opened?.agent.cancel({ kind: 'user' }, { keepInbox: true })
    owner.segments = []; owner.projectionCursor = 0
    this.emit(owner, { type: 'output-stop', reason }); this.changed(owner)
    const cancel = owner.provider?.cancelActive() ?? Promise.resolve()
    const audit = this.record(owner, 'output-interrupted', { reason, playbackStatus: 'stopped' })
    const task = Promise.all([this.bounded(cancel), audit]).then(() => {}, () => { throw new VoiceCallError('interrupt_failed') })
    owner.background.add(task)
    void task.then(() => owner.background.delete(task), () => owner.background.delete(task))
    return task
  }
  private async recorded(owner: CallOwner, response: ControllerRecordedResponse): Promise<void> {
    const key = `${response.turn}:${response.step}`; const slot = owner.turns.get(key)
    if (!slot || !slot.responseId || owner.stopped || slot.epoch !== owner.state.epoch || response.signal.aborted) { owner.turns.delete(key); throw new VoiceCallError('output_cancelled') }
    if (!owner.settings || !owner.provider || response.message.content.some(block => block.type !== 'text')) { owner.turns.delete(key); this.fail(owner, 'generation_failed'); throw new VoiceCallError('invalid_recorded_response') }
    const text = response.message.content.map(block => block.type === 'text' ? block.text : '').join('')
    if (!text) { owner.turns.delete(key); return }
    const controller = new AbortController(); owner.breeze = controller
    const abort = () => controller.abort()
    owner.lifetime.signal.addEventListener('abort', abort, { once: true }); response.signal.addEventListener('abort', abort, { once: true })
    if (owner.lifetime.signal.aborted || response.signal.aborted) abort()
    try {
      await this.record(owner, 'output-generated', { responseId: slot.responseId, turn: response.turn, step: response.step, nativeSeq: response.seq })
      if (controller.signal.aborted || slot.epoch !== owner.state.epoch) throw new VoiceCallError('output_cancelled')
      if (!owner.sink) throw new VoiceCallError('event_stream_lost')
      this.emit(owner, { type: 'text', responseId: slot.responseId, text, stage: 'generated' })
      for (const part of splitSpeechText(text, Math.min(160, owner.settings.maxTextLength))) {
        controller.signal.throwIfAborted()
        const segment: Segment = { id: `seg_${randomUUID().replaceAll('-', '')}`, responseId: slot.responseId, epoch: slot.epoch, text: part, frames: 0, complete: false, reportedFrames: 0, reported: false, fullyReported: false, projected: false }
        owner.segments.push(segment); this.set(owner, { playback: 'buffering' }); this.changed(owner)
        let chunkIndex = 0
        for await (const chunk of (this.deps.synthesize ?? streamBreeze)(owner.settings, part, { signal: controller.signal })) {
          if (controller.signal.aborted || owner.stopped || slot.epoch !== owner.state.epoch) throw new VoiceCallError('output_cancelled')
          if (!chunk.audio.byteLength || chunk.audio.byteLength % 2 || chunk.sampleRate !== 24_000) throw new VoiceCallError('invalid_pcm')
          segment.frames += chunk.audio.byteLength / 2
          for (let offset = 0; offset < chunk.audio.byteLength; offset += 32_768) {
            if (controller.signal.aborted || owner.stopped) throw new VoiceCallError('output_cancelled')
            this.emit(owner, { type: 'pcm', segmentId: segment.id, chunkIndex: chunkIndex++, sampleRate: chunk.sampleRate, channels: 1, format: 's16le', audio: Buffer.from(chunk.audio.subarray(offset, offset + 32_768)).toString('base64') })
          }
        }
        controller.signal.throwIfAborted()
        if (segment.frames === 0) throw new VoiceCallError('invalid_pcm')
        segment.complete = true
        await this.record(owner, 'segment-generated', { segmentId: segment.id, responseId: segment.responseId, plannedFrames: segment.frames, sampleRate: 24_000, nativeSeq: response.seq, turn: response.turn, step: response.step })
        if (controller.signal.aborted || slot.epoch !== owner.state.epoch) throw new VoiceCallError('output_cancelled')
        this.emit(owner, { type: 'segment-end', segmentId: segment.id, frames: segment.frames, responseId: segment.responseId })
      }
    } catch (error) {
      if (controller.signal.aborted || owner.stopped || slot.epoch !== owner.state.epoch || response.signal.aborted) {
        if (!owner.stopped) await this.record(owner, 'output-cancelled', { responseId: slot.responseId, playbackStatus: 'unknown', nativeSeq: response.seq, turn: response.turn, step: response.step })
        throw new VoiceCallError('output_cancelled')
      }
      this.fail(owner, error instanceof VoiceCallError && error.code === 'persistence_failed' ? 'persistence_failed' : 'generation_failed')
      throw new VoiceCallError('generation_failed')
    } finally {
      owner.lifetime.signal.removeEventListener('abort', abort); response.signal.removeEventListener('abort', abort)
      if (owner.breeze === controller) owner.breeze = undefined
      owner.turns.delete(key)
    }
  }

  async control(raw: unknown, capability: string): Promise<VoiceState> {
    const input = parse(parseControl, raw); const owner = this.authenticate(input.callId, capability)
    this.checkEpoch(owner, input.epoch)
    if (input.action === 'hangup') {
      let auditFailed = false
      try { await this.record(owner, 'client-control', { action: input.action, clientReported: true }) } catch { auditFailed = true }
      await this.end(owner, 'client_hangup', auditFailed)
      if (auditFailed) throw new VoiceCallError('persistence_failed')
      return this.getState()
    }
    if (input.action === 'stop-playback') {
      try { await this.interrupt(owner, 'client_stop_playback'); return this.getState() }
      catch { this.fail(owner, 'generation_failed'); throw new VoiceCallError('interrupt_failed') }
    }
    return this.serialized(owner, async () => {
      if (owner.stopped) throw new VoiceCallError('call_ended')
      await this.record(owner, 'client-control', { action: input.action, clientReported: true })
      if (input.action === 'heartbeat') owner.heartbeatAt = this.now()
      else this.set(owner, { capture: input.action === 'mute' ? 'muted' : 'sending' })
      this.changed(owner); return this.getState()
    }).catch(() => { this.fail(owner, 'persistence_failed'); throw new VoiceCallError('persistence_failed') })
  }
  async playback(raw: unknown, capability: string): Promise<VoiceState> {
    const input = parse(parsePlayback, raw); const owner = this.authenticate(input.callId, capability)
    if (this.checkEpoch(owner, input.epoch) === 'old') return this.getState()
    const segment = owner.segments.find(item => item.id === input.segmentId && item.epoch === input.epoch)
    if (!segment) throw new VoiceCallError('invalid_playback_receipt')
    return this.serialized(owner, () => this.acceptPlayback(owner, input, segment)).catch(error => {
      if (error instanceof VoiceCallError && error.code === 'invalid_playback_receipt') throw error
      this.fail(owner, 'playback_failed'); throw new VoiceCallError('playback_failed')
    })
  }
  private async acceptPlayback(owner: CallOwner, input: VoicePlaybackReceipt, segment: Segment): Promise<VoiceState> {
    if (input.playedFrames < segment.reportedFrames || input.playedFrames > segment.frames || (input.fullyPlayed && (!segment.complete || input.playedFrames !== segment.frames))) throw new VoiceCallError('invalid_playback_receipt')
    if (segment.fullyReported || (segment.reported && segment.reportedFrames === input.playedFrames && !input.fullyPlayed)) return this.getState()
    await this.record(owner, 'playback-client-reported', { segmentId: segment.id, responseId: segment.responseId, playedFrames: input.playedFrames, fullyPlayed: input.fullyPlayed, clientReported: true, playbackStatus: input.fullyPlayed ? 'client-reported-full' : 'partial' }, false, input.epoch)
    if (owner.stopped || input.epoch !== owner.state.epoch) return this.getState()
    segment.reported = true; segment.reportedFrames = input.playedFrames; segment.fullyReported = input.fullyPlayed
    try {
      while (owner.projectionCursor < owner.segments.length) {
        const next = owner.segments[owner.projectionCursor]!
        if (!next.complete || !next.fullyReported) break
        if (!next.projected) {
          await this.bounded(owner.provider!.appendPlayed({ responseId: next.responseId, segmentId: next.id, text: next.text, epoch: next.epoch }), owner.lifetime.signal)
          await this.record(owner, 'playback-projected', { segmentId: next.id, responseId: next.responseId, clientReported: true, playbackStatus: 'client-reported-full' }, false, next.epoch)
          next.projected = true
          if (owner.stopped || input.epoch !== owner.state.epoch) return this.getState()
        }
        owner.projectionCursor++
      }
    } catch { this.fail(owner, 'playback_failed'); throw new VoiceCallError('playback_failed') }
    this.set(owner, { playback: owner.segments.every(item => item.fullyReported) ? 'idle' : 'playing' }); this.changed(owner)
    return this.getState()
  }
  private fail(owner: CallOwner, code: string) { void this.end(owner, safeReason(code), true).catch(() => {}) }
  close(reason = 'server_close'): Promise<void> { return this.current ? this.end(this.current, safeReason(reason)) : Promise.resolve() }
  private end(owner: CallOwner, reason: string, failed = false, upstreamStatus?: number): Promise<void> {
    if (owner.closing) return owner.closing
    const latch = Promise.withResolvers<void>()
    owner.closing = latch.promise
    owner.stopped = true; owner.lifetime.abort(); owner.breeze?.abort()
    clearInterval(owner.leaseTimer); clearTimeout(owner.maxTimer)
    owner.disposeProvider?.()
    this.set(owner, { connection: 'closing', capture: 'inactive', playback: 'stopped', generation: 'idle', ...(failed ? { errorCode: reason, usage: { ...owner.state.usage, complete: false } } : {}) })
    this.emit(owner, { type: 'output-stop', reason }); this.changed(owner)
    const attempt = this.attempts.get(owner.requestId)
    if (attempt) { attempt.status = failed ? 'failed' : 'ended'; delete attempt.result }
    owner.opened?.agent.cancel({ kind: 'user' }, { keepInbox: true })
    void (async () => {
      let cleanupFailed = false
      let providerHangup = owner.provider?.close()
      // Observe an early hangup failure immediately while admissions drain.
      void providerHangup?.catch(() => {})
      try { await this.bounded(Promise.allSettled([...owner.acquisitions])) } catch { cleanupFailed = true }
      providerHangup ??= owner.provider?.close()
      const drains = await Promise.allSettled([this.bounded(owner.serial), ...[...owner.background].map(task => this.bounded(task))])
      cleanupFailed ||= drains.some(result => result.status === 'rejected') || owner.auditFailed || owner.providerSetupCleanupUnconfirmed === true
      const providerResult = providerHangup ? await Promise.allSettled([this.bounded(providerHangup)]) : []
      cleanupFailed ||= providerResult.some(result => result.status === 'rejected')
      try { if (owner.opened) { await this.bounded(owner.opened.close()); owner.agentRegistered = false } } catch { cleanupFailed = true }
      try {
        await this.record(owner, 'call-ended', {
          reason,
          ...(owner.startupPhase === undefined ? {} : { startupPhase: owner.startupPhase, startupTimedOut: owner.startupTimedOut === true }),
          ...(owner.providerSetupPhase === undefined ? {} : { providerSetupPhase: owner.providerSetupPhase }),
          ...(upstreamStatus === undefined ? {} : { httpStatus: upstreamStatus }),
          providerCreated: !!owner.provider,
          providerHangupConfirmed: !!owner.provider && providerResult[0]?.status === 'fulfilled',
          cleanupFailed,
        }, true)
      } catch { cleanupFailed = true }
      this.set(owner, { connection: cleanupFailed || failed ? 'failed' : 'ended', errorCode: cleanupFailed ? 'cleanup_failed' : failed ? reason : null })
      if (cleanupFailed || failed) this.emit(owner, { type: 'error', code: cleanupFailed ? 'cleanup_failed' : reason })
      this.changed(owner); this.emit(owner, { type: 'end', reason: cleanupFailed ? 'cleanup_failed' : reason })
      owner.capability.fill(0); owner.sink = undefined; owner.segments = []; owner.turns.clear()
      if (cleanupFailed) throw new VoiceCallError('cleanup_failed')
    })().then(latch.resolve, latch.reject)
    return owner.closing
  }
}

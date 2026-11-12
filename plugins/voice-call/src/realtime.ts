import { randomUUID } from 'node:crypto'
import type { StreamChunk, TokenUsage, UserMessage } from '@deepseek-ai/dsh-llm'
import { REALTIME_OPERATION_TIMEOUT_MS, type ProviderSetupPhase } from './startup-budget.ts'

export const REALTIME_MODEL = 'gpt-realtime-2.1-mini' as const
const API = 'https://api.openai.com/v1/realtime/calls'
// Leave headroom inside the controller's 10s cleanup gate.
const HANGUP_TIMEOUT_MS = 8_000

export interface RealtimeSocket {
  on(event: 'open' | 'message' | 'error' | 'close', listener: (...args: any[]) => void): unknown
  off(event: 'open' | 'message' | 'error' | 'close', listener: (...args: any[]) => void): unknown
  send(data: string): void
  close(): void
  readonly readyState?: number
}
export interface RealtimeDependencies {
  fetchImpl: typeof fetch
  socketFactory: (url: string, options: { headers: { Authorization: string } }) => RealtimeSocket
  timeoutMs?: number
  responseTimeoutMs?: number
}
export interface PlayedSegment {
  responseId: string
  segmentId: string
  text: string
  epoch?: number
}
export type RealtimeEvent =
  | { type: 'speech_started'; itemId?: string; audioStartMs?: number }
  | { type: 'audio_committed'; itemId: string; previousItemId?: string }
  | { type: 'usage'; responseId: string; usage: TokenUsage }
  | { type: 'error'; code: string; message: string }

/** Intentionally never incorporates an upstream message, SDP, SOUL, or credential. */
export class RealtimeError extends Error {
  constructor(readonly code: string, readonly status?: number) {
    super(`Realtime operation failed (${code}${status === undefined ? '' : `; HTTP ${status}`}).`)
    this.name = 'RealtimeError'
  }
}
type Json = Record<string, any>
type Waiter = { resolve: () => void; reject: (error: RealtimeError) => void; timer: ReturnType<typeof setTimeout> }
type Block = { index: number; text: string; ended: boolean }
type Active = {
  token: string; responseId?: string; queue: ChunkQueue; blocks: Map<string, Block>
  timer?: ReturnType<typeof setTimeout>; disposeAbort?: () => void; done: boolean
}
type Generated = { text: string; played: number; segments: Map<string, string> }

class ChunkQueue implements AsyncIterable<StreamChunk> {
  private values: StreamChunk[] = []
  private waiting: ((value: IteratorResult<StreamChunk>) => void) | undefined
  private ended = false
  push(value: StreamChunk) {
    if (this.ended) return
    if (this.waiting) { const resolve = this.waiting; this.waiting = undefined; resolve({ value, done: false }) }
    else this.values.push(value)
  }
  end() {
    this.ended = true
    if (this.waiting) { this.waiting({ value: undefined, done: true }); this.waiting = undefined }
  }
  [Symbol.asyncIterator](): AsyncIterator<StreamChunk> {
    return { next: () => {
      const value = this.values.shift()
      if (value) return Promise.resolve({ value, done: false })
      if (this.ended) return Promise.resolve({ value: undefined, done: true })
      return new Promise(resolve => { this.waiting = resolve })
    } }
  }
}

function settings(instructions: string): Json {
  return {
    type: 'realtime', model: REALTIME_MODEL, instructions,
    output_modalities: ['text'], tools: [], tool_choice: 'none',
    audio: { input: { turn_detection: { type: 'server_vad', create_response: false, interrupt_response: false } } },
  }
}
function validSettings(session: Json, instructions: string): boolean {
  const vad = session?.audio?.input?.turn_detection
  return session?.type === 'realtime' && session.model === REALTIME_MODEL && session.instructions === instructions
    && Array.isArray(session.output_modalities) && session.output_modalities.length === 1 && session.output_modalities[0] === 'text'
    && Array.isArray(session.tools) && session.tools.length === 0 && session.tool_choice === 'none'
    && vad?.type === 'server_vad' && vad.create_response === false && vad.interrupt_response === false
}
function nonblank(value: string, code: string, max: number) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new RealtimeError(code)
}
function usageOf(raw: Json | undefined): TokenUsage | undefined {
  if (!raw || !Number.isSafeInteger(raw.input_tokens) || raw.input_tokens < 0 || !Number.isSafeInteger(raw.output_tokens) || raw.output_tokens < 0) return
  const cached = raw.input_token_details?.cached_tokens ?? 0
  if (!Number.isSafeInteger(cached) || cached < 0 || cached > raw.input_tokens) return
  return {
    inputTokens: raw.input_tokens - cached, outputTokens: raw.output_tokens,
    cacheReadTokens: cached,
    ...(Number.isSafeInteger(raw.total_tokens) && raw.total_tokens >= 0 ? { totalTokens: raw.total_tokens } : {}),
  }
}
async function request(deps: RealtimeDependencies, url: string, init: RequestInit, signal?: AbortSignal,
  budget = REALTIME_OPERATION_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController()
  const abort = () => controller.abort()
  if (signal?.aborted) throw new RealtimeError('aborted')
  signal?.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(abort, deps.timeoutMs ?? budget)
  try {
    const response = await deps.fetchImpl(url, { ...init, signal: controller.signal })
    if (!response.ok) {
      void response.body?.cancel().catch(() => {})
      throw new RealtimeError('http', response.status)
    }
    return response
  } catch (error) {
    if (error instanceof RealtimeError) throw error
    throw new RealtimeError(signal?.aborted ? 'aborted' : controller.signal.aborted ? 'timeout' : 'network')
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort) }
}
async function readSdp(response: Response, deps: RealtimeDependencies, signal?: AbortSignal): Promise<string> {
  const reader = response.body?.getReader()
  if (!reader) throw new RealtimeError('invalid-answer-sdp')
  let rejectRead!: (error: RealtimeError) => void
  const stopped = new Promise<never>((_resolve, reject) => { rejectRead = reject })
  const abort = () => { rejectRead(new RealtimeError(signal?.aborted ? 'aborted' : 'answer-timeout')); void reader.cancel().catch(() => {}) }
  const timer = setTimeout(abort, deps.timeoutMs ?? REALTIME_OPERATION_TIMEOUT_MS)
  signal?.addEventListener('abort', abort, { once: true })
  if (signal?.aborted) abort()
  const decoder = new TextDecoder(); let text = ''; let bytes = 0
  try {
    while (true) {
      const chunk = await Promise.race([reader.read(), stopped])
      if (chunk.done) break
      bytes += chunk.value.byteLength
      if (bytes > 65_536) throw new RealtimeError('invalid-answer-sdp')
      text += decoder.decode(chunk.value, { stream: true })
    }
    text += decoder.decode(); nonblank(text, 'invalid-answer-sdp', 65_536); return text
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); void reader.cancel().catch(() => {}) }
}

async function hangup(deps: RealtimeDependencies, callId: string, apiKey: string): Promise<void> {
  const response = await request(deps, `${API}/${encodeURIComponent(callId)}/hangup`, {
    method: 'POST', headers: { Authorization: `Bearer ${apiKey}` },
  }, undefined, HANGUP_TIMEOUT_MS)
  void response.body?.cancel().catch(() => {})
}

/** Dependencies are explicit so offline tests cannot accidentally invoke a provider. */
export class RealtimeTransport {
  constructor(private readonly deps: RealtimeDependencies) {}
  async create(input: { sdp: string; instructions: string; apiKey: string; signal?: AbortSignal; onSetupPhase?: (phase: ProviderSetupPhase) => void }): Promise<RealtimeCall> {
    nonblank(input.sdp, 'invalid-sdp', 65_536)
    nonblank(input.instructions, 'invalid-instructions', 262_144)
    nonblank(input.apiKey, 'missing-credential', 16_384)
    const body = new FormData()
    body.set('sdp', input.sdp)
    body.set('session', JSON.stringify(settings(input.instructions)))
    input.onSetupPhase?.('create_http')
    const response = await request(this.deps, API, { method: 'POST', headers: { Authorization: `Bearer ${input.apiKey}` }, body }, input.signal)
    let location: URL
    try { location = new URL(response.headers.get('location') ?? '', API) }
    catch { void response.body?.cancel().catch(() => {}); throw new RealtimeError('missing-call-location') }
    const match = /^\/v1\/realtime\/calls\/([A-Za-z0-9_-]+)$/.exec(location.pathname)
    if (location.origin !== 'https://api.openai.com' || location.search || location.hash || !match) {
      void response.body?.cancel().catch(() => {})
      throw new RealtimeError('invalid-call-location')
    }
    let sdp: string
    try { input.onSetupPhase?.('answer_sdp'); sdp = await readSdp(response, this.deps, input.signal) }
    catch (error) {
      void response.body?.cancel().catch(() => {})
      try { await hangup(this.deps, match[1]!, input.apiKey) } catch { throw new RealtimeError('setup-cleanup-unconfirmed') }
      throw error instanceof RealtimeError ? error : new RealtimeError('invalid-answer-sdp')
    }
    const call = new RealtimeCall(this.deps, match[1]!, sdp, input.apiKey)
    try { await call.connect(input.instructions, input.signal, input.onSetupPhase); return call }
    catch (error) {
      try { await call.close() } catch { throw new RealtimeError('setup-cleanup-unconfirmed') }
      throw error instanceof RealtimeError ? error : new RealtimeError('sideband-setup')
    }
  }
}

export class RealtimeCall {
  private socket?: RealtimeSocket
  private listeners = new Set<(event: RealtimeEvent) => void>()
  private update: (Waiter & { instructions: string }) | undefined
  private itemWaiters = new Map<string, Waiter>()
  private active: Active | undefined
  private retired = new Set<string>()
  private generated = new Map<string, Generated>()
  private settledResponseId: string | undefined
  private instructions = ''
  private closed = false
  private closing?: Promise<void>
  private openWaiter: Waiter | undefined
  private readonly onOpen = () => this.openWaiter?.resolve()
  private readonly onMessage = (data: unknown) => this.receive(data)
  private readonly onSocketError = () => this.fail('sideband-error')
  private readonly onSocketClose = () => { if (!this.closed) this.fail('sideband-closed') }
  constructor(private readonly deps: RealtimeDependencies, readonly callId: string, readonly sdp: string, private apiKey: string) {}
  /** Cleared when a run starts; set only by this handle's owned response.done. */
  get lastSettledResponseId(): string | undefined { return this.settledResponseId }

  async connect(instructions: string, signal?: AbortSignal, onSetupPhase?: (phase: ProviderSetupPhase) => void) {
    if (signal?.aborted) throw new RealtimeError('aborted')
    onSetupPhase?.('sideband_open')
    const opened = this.waiter('sideband-timeout', waiter => { this.openWaiter = waiter }, signal, REALTIME_OPERATION_TIMEOUT_MS)
    // Factory failures are normalized by create(); never include their messages.
    try {
      this.socket = this.deps.socketFactory(`wss://api.openai.com/v1/realtime?call_id=${encodeURIComponent(this.callId)}`, { headers: { Authorization: `Bearer ${this.apiKey}` } })
      this.socket.on('open', this.onOpen)
      this.socket.on('message', this.onMessage)
      this.socket.on('error', this.onSocketError)
      this.socket.on('close', this.onSocketClose)
      if (this.socket.readyState === 1) this.onOpen()
      await opened
    } catch (error) {
      const failure = error instanceof RealtimeError ? error : new RealtimeError('sideband-setup')
      this.openWaiter?.reject(failure); await opened.catch(() => {}); throw failure
    }
    finally { this.openWaiter = undefined }
    onSetupPhase?.('session_configure')
    await this.configure(instructions, signal, REALTIME_OPERATION_TIMEOUT_MS)
  }
  subscribe(listener: (event: RealtimeEvent) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  private emit(event: RealtimeEvent) { for (const listener of this.listeners) { try { listener(event) } catch { /* observers cannot affect ownership */ } } }
  private waiter(code: string, store: (waiter: Waiter) => void, signal?: AbortSignal, budget = 10_000): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false
      const finish = (error?: RealtimeError) => {
        if (settled) return
        settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort)
        error ? reject(error) : resolve()
      }
      const abort = () => finish(new RealtimeError('aborted'))
      const timer = setTimeout(() => finish(new RealtimeError(code)), this.deps.timeoutMs ?? budget)
      store({ resolve: () => finish(), reject: error => finish(error), timer })
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) abort()
    })
  }
  private send(value: Json) {
    if (this.closed || !this.socket) throw new RealtimeError('closed')
    try { this.socket.send(JSON.stringify(value)) } catch { throw new RealtimeError('sideband-send') }
  }
  private async configure(instructions: string, signal?: AbortSignal, budget?: number) {
    nonblank(instructions, 'invalid-instructions', 262_144)
    if (this.update) throw new RealtimeError('configuration-busy')
    const ack = this.waiter('configuration-timeout', waiter => { this.update = { ...waiter, instructions } }, signal, budget)
    try { this.send({ type: 'session.update', session: settings(instructions) }); await ack; this.instructions = instructions }
    catch (error) { this.rejectUpdate(new RealtimeError('configuration-failed')); await ack.catch(() => {}); throw error }
    finally { this.update = undefined }
  }
  private rejectUpdate(error: RealtimeError) { this.update?.reject(error) }

  async *respond(input: { instructions: string; metadata?: Record<string, string>; signal?: AbortSignal }): AsyncIterable<StreamChunk> {
    if (this.closed) throw new RealtimeError('closed')
    if (this.active) throw new RealtimeError('response-busy')
    const metadata = input.metadata ?? {}
    if (Object.entries(metadata).some(([key, value]) => key.startsWith('voice_') || typeof value !== 'string' || key.length > 64 || value.length > 512) || Object.keys(metadata).length > 12) throw new RealtimeError('invalid-metadata')
    const active: Active = { token: randomUUID(), queue: new ChunkQueue(), blocks: new Map(), done: false }
    this.settledResponseId = undefined
    this.active = active
    const abort = () => { void this.cancelActive().catch(() => this.fail('cancel-failed')) }
    input.signal?.addEventListener('abort', abort, { once: true })
    active.disposeAbort = () => input.signal?.removeEventListener('abort', abort)
    try {
      if (input.signal?.aborted) { await this.cancelActive() }
      else {
        await this.configure(input.instructions, input.signal)
        if (this.active === active && !active.done) {
          this.send({ type: 'response.create', response: { conversation: 'none', output_modalities: ['text'], tools: [], tool_choice: 'none', metadata: { ...metadata, voice_call_id: this.callId, voice_request_id: active.token } } })
          active.timer = setTimeout(() => { this.finish(active, { kind: 'error', failure: { code: 'voice/response-timeout', message: 'Realtime response timed out.' } }); void this.close().catch(() => {}) }, this.deps.responseTimeoutMs ?? 120_000)
        }
      }
    } catch (error) {
      const code = error instanceof RealtimeError ? error.code : 'response-setup'
      this.finish(active, { kind: input.signal?.aborted ? 'aborted' : 'error', failure: { code: `voice/${code}`, message: `Realtime response unavailable (${code}).` } })
    }
    try { yield* active.queue }
    finally { if (!active.done) await this.cancelActive() }
  }

  private receive(data: unknown) {
    if (this.closed) return
    let event: Json
    try {
      const raw = typeof data === 'string' ? data : data instanceof ArrayBuffer ? Buffer.from(data).toString('utf8') : Buffer.isBuffer(data) ? data.toString('utf8') : ''
      if (!raw || raw.length > 1_048_576) throw new Error()
      event = JSON.parse(raw)
      if (!event || typeof event !== 'object' || typeof event.type !== 'string') throw new Error()
    } catch { this.fail('invalid-provider-event'); return }
    if (event.type === 'session.updated') {
      const expected = this.update?.instructions ?? this.instructions
      if (!validSettings(event.session, expected)) { this.update?.reject(new RealtimeError('configuration-mismatch')); this.fail('configuration-mismatch'); return }
      this.update?.resolve(); return
    }
    if (event.type === 'error') { this.fail('provider-error'); return }
    if (event.type === 'input_audio_buffer.speech_started') {
      this.emit({ type: 'speech_started', ...(typeof event.item_id === 'string' ? { itemId: event.item_id } : {}), ...(Number.isFinite(event.audio_start_ms) ? { audioStartMs: event.audio_start_ms } : {}) }); return
    }
    if (event.type === 'input_audio_buffer.committed' && typeof event.item_id === 'string') {
      this.emit({ type: 'audio_committed', itemId: event.item_id, ...(typeof event.previous_item_id === 'string' ? { previousItemId: event.previous_item_id } : {}) }); return
    }
    if (event.type === 'conversation.item.added' || event.type === 'conversation.item.done') {
      this.itemWaiters.get(event.item?.id)?.resolve(); return
    }
    const active = this.active
    if (event.type === 'response.created') {
      const response = event.response
      if (typeof response?.id !== 'string') { this.fail('invalid-response'); return }
      const token = response.metadata?.voice_request_id
      if (this.retired.has(token)) { try { this.send({ type: 'response.cancel', response_id: response.id }) } catch { this.fail('cancel-failed') }; return }
      if (!active || token !== active.token || response.metadata?.voice_call_id !== this.callId || active.responseId) { this.fail('unowned-response'); return }
      active.responseId = response.id; return
    }
    if (!active || !active.responseId) return
    const responseId = event.type === 'response.done' ? event.response?.id : event.response_id
    if (responseId !== active.responseId) return
    if (event.type === 'response.function_call_arguments.delta' || event.type === 'response.function_call_arguments.done' || (event.type === 'response.output_item.added' && event.item?.type === 'function_call')) { this.fail('unexpected-tool-call'); return }
    if (event.type === 'response.output_text.delta' || event.type === 'response.output_text.done') {
      const key = `${event.output_index ?? 0}:${event.content_index ?? 0}`
      let block = active.blocks.get(key)
      if (!block) {
        if (active.blocks.size >= 16) { this.fail('response-too-large'); return }
        block = { index: active.blocks.size, text: '', ended: false }; active.blocks.set(key, block); active.queue.push({ type: 'block-start', index: block.index, blockType: 'text' })
      }
      if (block.ended) { this.fail('text-after-completion'); return }
      const text = event.type.endsWith('.delta') ? event.delta : event.text
      if (typeof text !== 'string') { this.fail('invalid-text'); return }
      const delta = event.type.endsWith('.delta') ? text : text.startsWith(block.text) ? text.slice(block.text.length) : undefined
      if (delta === undefined || [...active.blocks.values()].reduce((total, part) => total + part.text.length, 0) + delta.length > 262_144) { this.fail('text-mismatch'); return }
      if (delta) { block.text += delta; active.queue.push({ type: 'text-delta', index: block.index, text: delta }) }
      if (event.type.endsWith('.done')) { block.ended = true; active.queue.push({ type: 'block-end', index: block.index, block: { type: 'text', text: block.text } }) }
      return
    }
    if (event.type === 'response.done') {
      const response = event.response
      this.settledResponseId = responseId
      const usage = usageOf(response.usage)
      if (usage) { active.queue.push({ type: 'usage', usage }); this.emit({ type: 'usage', responseId, usage }) }
      const status = response.status
      if (status === 'completed') this.finish(active, { kind: 'stop' })
      else if (status === 'incomplete' && response.status_details?.reason === 'max_output_tokens') this.finish(active, { kind: 'max-tokens' })
      else this.finish(active, { kind: status === 'cancelled' ? 'aborted' : 'error', failure: { code: `voice/${status === 'cancelled' ? 'cancelled' : 'provider-response-failed'}`, message: status === 'cancelled' ? 'Realtime response cancelled.' : 'Realtime response did not complete.' } })
    }
  }
  private finish(active: Active, reason: Extract<StreamChunk, { type: 'finish' }>['reason']) {
    if (active.done) return
    active.done = true; clearTimeout(active.timer); active.disposeAbort?.()
    for (const block of active.blocks.values()) if (!block.ended) { block.ended = true; active.queue.push({ type: 'block-end', index: block.index, block: { type: 'text', text: block.text } }) }
    if (active.responseId) {
      this.generated.set(active.responseId, { text: [...active.blocks.values()].map(block => block.text).join(''), played: 0, segments: new Map() })
      while (this.generated.size > 16) this.generated.delete(this.generated.keys().next().value!)
    }
    this.retired.add(active.token)
    while (this.retired.size > 128) this.retired.delete(this.retired.values().next().value!)
    active.queue.push({ type: 'finish', reason, replayState: { response: { provider: 'openai-realtime', callId: this.callId, responseId: active.responseId, requestId: active.token } } })
    active.queue.end()
    if (this.active === active) this.active = undefined
  }
  private fail(code: string) {
    if (this.closed) return
    const error = new RealtimeError(code)
    this.openWaiter?.reject(error); this.update?.reject(error)
    for (const waiter of this.itemWaiters.values()) waiter.reject(error)
    if (this.active) this.finish(this.active, { kind: 'error', failure: { code: `voice/${code}`, message: error.message } })
    this.emit({ type: 'error', code, message: error.message })
    void this.close().catch(() => { this.emit({ type: 'error', code: 'hangup-unconfirmed', message: 'Realtime call hangup could not be confirmed.' }) })
  }
  async cancelActive(): Promise<void> {
    const active = this.active
    if (!active) return
    let failed = false
    if (active.responseId) { try { this.send({ type: 'response.cancel', response_id: active.responseId }) } catch { failed = true } }
    this.finish(active, { kind: 'aborted', failure: { code: 'voice/cancelled', message: 'Realtime response cancelled.' } })
    if (failed) throw new RealtimeError('cancel-failed')
  }
  async appendPlayed(input: PlayedSegment): Promise<void> {
    nonblank(input.segmentId, 'invalid-segment', 128)
    nonblank(input.text, 'invalid-played-text', 262_144)
    const generated = this.generated.get(input.responseId)
    if (!generated) throw new RealtimeError('unknown-response')
    const previous = generated.segments.get(input.segmentId)
    if (previous !== undefined) { if (previous !== input.text) throw new RealtimeError('segment-conflict'); return }
    if (generated.text.slice(generated.played, generated.played + input.text.length) !== input.text) throw new RealtimeError('played-text-mismatch')
    if (this.itemWaiters.size) throw new RealtimeError('append-busy')
    const id = `vp_${randomUUID().replaceAll('-', '').slice(0, 24)}`
    const ack = this.waiter('append-timeout', waiter => { this.itemWaiters.set(id, waiter) })
    try {
      this.send({ type: 'conversation.item.create', item: { id, type: 'message', role: 'assistant', content: [{ type: 'output_text', text: input.text }] } })
      await ack
      generated.played += input.text.length; generated.segments.set(input.segmentId, input.text)
    } catch (error) { this.itemWaiters.get(id)?.reject(new RealtimeError('append-failed')); await ack.catch(() => {}); throw error }
    finally { this.itemWaiters.delete(id) }
  }
  close(): Promise<void> {
    if (this.closing) return this.closing
    this.closing = this.doClose()
    return this.closing
  }
  private async doClose() {
    try { await this.cancelActive() } catch { /* hangup supersedes per-response cancellation */ }
    this.closed = true
    const error = new RealtimeError('closed')
    this.openWaiter?.reject(error); this.update?.reject(error)
    for (const waiter of this.itemWaiters.values()) waiter.reject(error)
    try { await hangup(this.deps, this.callId, this.apiKey) }
    catch { throw new RealtimeError('hangup-unconfirmed') }
    finally {
      this.apiKey = ''
      if (this.socket) {
        this.socket.off('open', this.onOpen); this.socket.off('message', this.onMessage); this.socket.off('close', this.onSocketClose)
        // A Node ws closed while CONNECTING emits an asynchronous error. Retain
        // the guarded error listener until the socket itself becomes collectible.
        try { this.socket.close() } catch { /* credential already released */ }
      }
      this.listeners.clear(); this.generated.clear()
    }
  }
}

/** Audio is already in the provider conversation; native input records are not a second prompt. */
export function createDriver(call: RealtimeCall) {
  return {
    run(input: { messages: readonly UserMessage[]; instructions: string; turn: number; step: number; signal: AbortSignal }): AsyncIterable<StreamChunk> {
      return call.respond({ instructions: input.instructions, metadata: { native_turn: String(input.turn), native_step: String(input.step) }, signal: input.signal })
    },
  }
}

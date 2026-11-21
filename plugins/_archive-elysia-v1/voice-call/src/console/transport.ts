/** Authenticated shell carrier; per-call capabilities never leave memory/headers. */
import { createParser } from 'eventsource-parser'
import { SafeVoiceHttpError } from './diagnostics.ts'
import { BROWSER_START_TIMEOUT_MS, LOCAL_OPERATION_TIMEOUT_MS } from '../startup-budget.ts'
import { VOICE_API_PREFIX, VOICE_CAPABILITY_HEADER } from '../protocol.ts'
import type { VoiceControlRequest, VoiceEvent, VoicePlaybackReceipt, VoiceStartRequest, VoiceStartResult, VoiceState } from '../protocol.ts'

export type PageFetch = (input: string, init: RequestInit) => Promise<Response>
export function nativePageFetch(): PageFetch {
  const shell = (globalThis as { __DSH_TRANSPORT__?: { fetch?: PageFetch } }).__DSH_TRANSPORT__?.fetch
  return shell ?? ((path, init) => fetch(path, { ...init, credentials: 'same-origin' }))
}
const route = (name: string) => VOICE_API_PREFIX.slice(1) + '/' + name
/** Bound error-body reads; parse only named public engineering fields, never retain raw bodies. */
async function httpFailure(response: Response, signal: AbortSignal): Promise<SafeVoiceHttpError> {
  const fallback = new SafeVoiceHttpError(response.status)
  const declared = response.headers.get('content-length')
  if (!/^application\/json(?:;|$)/iu.test(response.headers.get('content-type') ?? '') || !response.body
    || (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > 4096))) {
    void response.body?.cancel().catch(() => {})
    return fallback
  }
  const reader = response.body.getReader()
  const abort = () => { void reader.cancel().catch(() => {}) }
  signal.addEventListener('abort',abort,{once:true})
  const decoder = new TextDecoder('utf-8',{fatal:true})
  let size = 0, text = ''
  try {
    signal.throwIfAborted()
    for (;;) {
      const part = await reader.read()
      signal.throwIfAborted()
      if (part.done) break
      size += part.value.byteLength
      if (size > 4096) return fallback
      text += decoder.decode(part.value,{stream:true})
    }
    text += decoder.decode()
    const value: unknown = JSON.parse(text)
    if (!value || typeof value !== 'object' || Array.isArray(value)) return fallback
    const fields = value as {error?:unknown;upstreamStatus?:unknown}
    return new SafeVoiceHttpError(response.status,fields.error,fields.upstreamStatus)
  } catch {
    signal.throwIfAborted()
    return fallback
  } finally {
    signal.removeEventListener('abort',abort)
    void reader.cancel().catch(() => {})
    try { reader.releaseLock() } catch { /* cancellation may still be settling */ }
  }
}
export class VoiceTransport {
  constructor(private readonly carrier: PageFetch = nativePageFetch()) {}
  private async request<T>(path: string, body?: unknown, capability?: string, signal?: AbortSignal): Promise<T> {
    const headers = new Headers()
    if (body !== undefined) headers.set('content-type', 'application/json')
    if (capability) headers.set(VOICE_CAPABILITY_HEADER, capability)
    const deadline = AbortSignal.timeout(path === 'start' ? BROWSER_START_TIMEOUT_MS : LOCAL_OPERATION_TIMEOUT_MS)
    const requestSignal = signal ? AbortSignal.any([signal, deadline]) : deadline
    const response = await this.carrier(route(path), { method: body === undefined ? 'GET' : 'POST',
      cache: 'no-store', headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: requestSignal })
    if (requestSignal.aborted) { void response.body?.cancel().catch(() => {}); requestSignal.throwIfAborted() }
    if (!response.ok) throw await httpFailure(response,requestSignal)
    const value = await response.json() as T
    requestSignal.throwIfAborted()
    return value
  }
  state(signal?: AbortSignal): Promise<VoiceState> { return this.request('state', undefined, undefined, signal) }
  start(value: VoiceStartRequest, signal: AbortSignal): Promise<VoiceStartResult> { return this.request('start', value, undefined, signal) }
  control(value: VoiceControlRequest, capability: string): Promise<VoiceState> { return this.request('control', value, capability) }
  playback(value: VoicePlaybackReceipt, capability: string): Promise<{ ok: true }> { return this.request('playback', value, capability) }
  async follow(callId: string, capability: string, signal: AbortSignal, receive: (event: VoiceEvent) => void): Promise<void> {
    const response = await this.carrier(route('events?callId=' + encodeURIComponent(callId)), {
      method: 'GET', cache: 'no-store', headers: { accept: 'text/event-stream', [VOICE_CAPABILITY_HEADER]: capability }, signal,
    })
    if (signal.aborted) { void response.body?.cancel().catch(() => {}); signal.throwIfAborted() }
    if (!response.ok) throw await httpFailure(response,signal)
    if (!response.body || !response.headers.get('content-type')?.startsWith('text/event-stream')) {
      void response.body?.cancel().catch(() => {})
      throw new Error('voice_event_stream_refused')
    }
    const reader = response.body.getReader()
    const abort = () => { void reader.cancel().catch(() => {}) }
    signal.addEventListener('abort', abort, { once: true })
    const decoder = new TextDecoder()
    const parser = createParser({ maxBufferSize: 256 * 1024, onEvent(event) {
      if (event.event !== 'voice-call' || signal.aborted) return
      const value: unknown = JSON.parse(event.data)
      if (!value || typeof value !== 'object') throw new Error('invalid_voice_event')
      const item = value as Partial<VoiceEvent>
      if (typeof item.callId !== 'string' || !Number.isSafeInteger(item.epoch) || (item.epoch ?? -1) < 0
        || !Number.isSafeInteger(item.seq) || (item.seq ?? -1) < 0 || typeof item.type !== 'string') throw new Error('invalid_voice_event')
      receive(item as VoiceEvent)
    }, onError() { throw new Error('invalid_voice_event_stream') } })
    try {
      for (;;) {
        const next = await reader.read()
        if (signal.aborted) return
        if (next.done) throw new Error('voice_event_stream_closed')
        parser.feed(decoder.decode(next.value, { stream: true }))
      }
    } finally {
      signal.removeEventListener('abort', abort)
      await reader.cancel().catch(() => {})
      reader.releaseLock()
    }
  }
}

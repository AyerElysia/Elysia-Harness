/** Owner-authenticated HTTP routes, one bounded event stream per call. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import type { VoiceState, VoiceStartResult, VoiceEvent } from './protocol.ts'
import { VOICE_API_PREFIX, VOICE_CAPABILITY_HEADER, encodeVoiceEvent } from './protocol.ts'

/** Deliberately small seam so route tests never construct real transports. */
export interface VoiceHttpController {
  getState(): VoiceState
  start(body: unknown, signal?: AbortSignal): Promise<VoiceStartResult>
  subscribeEvents(callId: string, capability: string, listener: (event: VoiceEvent) => boolean | void): { end(reason?: string): Promise<void> }
  control(body: unknown, capability: string): Promise<VoiceState>
  playback(body: unknown, capability: string): Promise<unknown>
}
const MAX_BODY_BYTES = 256 * 1024
const MAX_QUEUE_BYTES = 512 * 1024
const json = (value: unknown, status = 200): Response => new Response(JSON.stringify(value), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
})
class RouteError extends Error { constructor(readonly code: string) { super(code) } }
async function readJson(request: Request): Promise<unknown> {
  if (!/^application\/json(?:;|$)/iu.test(request.headers.get('content-type') ?? '')) throw new RouteError('invalid_content_type')
  const declared = request.headers.get('content-length')
  if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > MAX_BODY_BYTES)) throw new RouteError('invalid_body_size')
  const reader = request.body?.getReader()
  if (!reader) throw new RouteError('invalid_body')
  let bytes = 0
  let text = ''
  const decoder = new TextDecoder('utf-8', { fatal: true })
  try {
    for (;;) {
      request.signal.throwIfAborted()
      const part = await reader.read()
      if (part.done) break
      bytes += part.value.byteLength
      if (bytes > MAX_BODY_BYTES) throw new RouteError('invalid_body_size')
      text += decoder.decode(part.value, { stream: true })
    }
    text += decoder.decode()
    return JSON.parse(text)
  } catch (error) {
    if (error instanceof RouteError) throw error
    throw new RouteError('invalid_body')
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock() }
}
/** Only explicitly classified codes escape; messages and upstream bodies do not. */
function failure(error: unknown): Response {
  const code = typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    && /^[a-z][a-z0-9_-]{0,79}$/u.test(error.code) ? error.code : 'voice_operation_failed'
  const status = /capability|unauthorized|forbidden/u.test(code) ? 403
    : /busy|conflict|already|in_progress/u.test(code) ? 409
    : /^(?:invalid_|unexpected_|privacy_)/u.test(code) ? 400
    : /disabled|not_configured/u.test(code) ? 503 : code === 'start_timeout' ? 504 : 502
  const upstreamStatus = typeof error === 'object' && error !== null && 'upstreamStatus' in error
    && typeof error.upstreamStatus === 'number' && Number.isSafeInteger(error.upstreamStatus)
    && error.upstreamStatus >= 400 && error.upstreamStatus <= 599 ? error.upstreamStatus : undefined
  return json({ error: code, ...(upstreamStatus === undefined ? {} : { upstreamStatus }) }, status)
}
function capability(request: Request): string {
  const value = request.headers.get(VOICE_CAPABILITY_HEADER)
  if (!value || value.length > 256) throw new RouteError('invalid_capability')
  return value
}

/** Request.signal is essential: the host bridge drains a response after disconnect. */
function events(request: Request, owner: VoiceHttpController): Response {
  const url = new URL(request.url)
  if ([...url.searchParams.keys()].some(key => key !== 'callId') || url.searchParams.getAll('callId').length !== 1) throw new RouteError('invalid_event_query')
  const callId = url.searchParams.get('callId') ?? ''
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(callId)) throw new RouteError('invalid_id')
  const secret = capability(request)
  request.signal.throwIfAborted()
  let subscription: ReturnType<VoiceHttpController['subscribeEvents']> | undefined
  let closed = false
  let streamController: ReadableStreamDefaultController<Uint8Array> | undefined
  const detach = () => request.signal.removeEventListener('abort', abort)
  const stop = () => {
    if (closed) return
    closed = true
    detach()
    try { streamController?.close() } catch { /* The browser may already have cancelled its reader. */ }
  }
  const terminate = (reason: string) => {
    stop()
    // Failure remains visible in the owner's state; a disconnected socket cannot receive it.
    void subscription?.end(reason).catch(() => undefined)
  }
  const abort = () => terminate('event_stream_disconnected')
  const stream = new ReadableStream<Uint8Array>({
    start(controller) { streamController = controller },
    cancel() { terminate('event_stream_cancelled') },
  }, { highWaterMark: MAX_QUEUE_BYTES, size: chunk => chunk.byteLength })
  try {
    subscription = owner.subscribeEvents(callId, secret, event => {
      if (closed || request.signal.aborted) return false
      const bytes = encodeVoiceEvent(event)
      if (!streamController || (streamController.desiredSize ?? 0) < bytes.byteLength) { stop(); return false }
      try { streamController.enqueue(bytes) } catch { stop(); return false }
      if (event.type === 'end') stop()
      return true
    })
    if (!closed) {
      request.signal.addEventListener('abort', abort, { once: true })
      if (request.signal.aborted) abort()
    }
  } catch (error) { stop(); throw error }
  return new Response(stream, { headers: {
    'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store, no-transform',
    'x-accel-buffering': 'no', 'connection': 'keep-alive',
  } })
}

/** Mounting routes never opens media, resolves a secret, or creates a Session. */
export function voiceRoutes(owner: VoiceHttpController): ReadonlyArray<{
  path: string; methods: readonly ('GET' | 'POST')[]; requestBody: 'streaming' | 'buffered'; fetch(request: Request): Promise<Response>
}> {
  const route = (name: string, method: 'GET' | 'POST', handle: (request: Request) => Response | Promise<Response>) => ({
    path: VOICE_API_PREFIX + '/' + name, methods: [method], requestBody: method === 'POST' ? 'streaming' as const : 'buffered' as const,
    fetch: async (request: Request) => {
      try {
        if (name !== 'events' && new URL(request.url).search) throw new RouteError('invalid_query')
        return await handle(request)
      } catch (error) { return failure(error) }
    },
  })
  return [
    route('state', 'GET', () => json(owner.getState())),
    route('start', 'POST', async request => json(await owner.start(await readJson(request), request.signal))),
    route('events', 'GET', request => events(request, owner)),
    route('control', 'POST', async request => json(await owner.control(await readJson(request), capability(request)))),
    route('playback', 'POST', async request => {
      await owner.playback(await readJson(request), capability(request))
      return json({ ok: true })
    }),
  ]
}
/** Register only through the existing host authentication/trust carrier. */
export function mountVoiceRoutes(ctx: Context, owner: VoiceHttpController): void {
  for (const route of voiceRoutes(owner)) ctx.effect(() => ctx.connection.fetch.register(route), 'voice-call.http:' + route.path)
}

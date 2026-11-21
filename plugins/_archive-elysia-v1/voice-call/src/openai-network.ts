/** Per-owner OpenAI-only egress. Never sets environment or a global dispatcher. */
import { EventEmitter } from 'node:events'
import { ProxyAgent } from 'undici'
import { HttpsProxyAgent } from 'https-proxy-agent'
import WebSocket from 'ws'
import type { RealtimeDependencies, RealtimeSocket } from './realtime.ts'

import { REALTIME_OPERATION_TIMEOUT_MS as HANDSHAKE_MS } from './startup-budget.ts'
const CLOSE_MS = 2_000
export class OpenAINetworkError extends Error {
  constructor(readonly code: string) { super(`OpenAI network operation failed (${code}).`); this.name = 'OpenAINetworkError' }
}
export interface OpenAINetwork extends Pick<RealtimeDependencies, 'fetchImpl' | 'socketFactory'> { close(): Promise<void> }

function proxyAddress(input?: string): string | undefined {
  if (input === undefined || input === '') return undefined
  let url: URL
  try { url = new URL(input) } catch { throw new OpenAINetworkError('invalid_proxy') }
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new OpenAINetworkError('invalid_proxy')
  return url.href
}
function officialUrl(input: string | URL | Request, websocket = false): URL {
  let url: URL
  try { url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url) }
  catch { throw new OpenAINetworkError('invalid_target') }
  if (url.protocol !== (websocket ? 'wss:' : 'https:') || url.hostname !== 'api.openai.com' || (url.port && url.port !== '443')
    || url.username || url.password || url.hash || !url.pathname.startsWith('/v1/')) throw new OpenAINetworkError('invalid_target')
  if (websocket && (url.pathname !== '/v1/realtime' || [...url.searchParams.keys()].some(key => key !== 'call_id')
    || url.searchParams.getAll('call_id').length !== 1 || !/^[A-Za-z0-9_-]{1,180}$/u.test(url.searchParams.get('call_id') ?? ''))) throw new OpenAINetworkError('invalid_target')
  return url
}
interface FetchOwner { controller: AbortController; reader?: ReadableStreamDefaultReader<Uint8Array>; cleanup(): void }
async function untilAbort<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  let abort = () => {}
  const stopped = new Promise<never>((_resolve, reject) => {
    abort = () => reject(new OpenAINetworkError('aborted'))
    signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort()
  })
  try { return await Promise.race([pending, stopped]) }
  finally { signal.removeEventListener('abort', abort) }
}

export function createOpenAINetwork(proxyUrl?: string): OpenAINetwork {
  const proxy = proxyAddress(proxyUrl)
  const dispatcher = proxy ? new ProxyAgent({ uri: proxy, connect: { timeout: HANDSHAKE_MS }, requestTls: { rejectUnauthorized: true }, headersTimeout: HANDSHAKE_MS }) : undefined
  const fetches = new Set<FetchOwner>()
  const sockets = new Set<{ stop(): void }>()
  let closed = false
  let closing: Promise<void> | undefined

  const fetchImpl: typeof fetch = async (input, init) => {
    officialUrl(input)
    if (closed) throw new OpenAINetworkError('closed')
    const callerSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined)
    if (callerSignal?.aborted) throw new OpenAINetworkError('aborted')
    const controller = new AbortController()
    const owner: FetchOwner = { controller, cleanup: () => {} }
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    let disposed = false
    const abort = () => { controller.abort(); void reader?.cancel().catch(() => {}) }
    const timer = setTimeout(abort, HANDSHAKE_MS); timer.unref?.()
    const cleanup = () => {
      if (disposed) return
      disposed = true; clearTimeout(timer); callerSignal?.removeEventListener('abort', abort); fetches.delete(owner)
    }
    owner.cleanup = cleanup; fetches.add(owner)
    callerSignal?.addEventListener('abort', abort, { once: true })
    controller.signal.addEventListener('abort', () => { void reader?.cancel().catch(() => {}) }, { once: true })
    try {
      // No redirects, including same-origin ones: a credentialed owner chooses
      // the final official endpoint explicitly. Request/body/headers are unchanged.
      const options: RequestInit & { dispatcher?: ProxyAgent | undefined } = { ...init, dispatcher, redirect: 'error', signal: controller.signal }
      const pending = globalThis.fetch(input, options).then(response => {
        if (controller.signal.aborted) { void response.body?.cancel().catch(() => {}); throw new OpenAINetworkError('aborted') }
        return response
      })
      const response = await untilAbort(pending, controller.signal)
      clearTimeout(timer)
      if (controller.signal.aborted) { void response.body?.cancel().catch(() => {}); throw new OpenAINetworkError('aborted') }
      if (!response.body) { cleanup(); return response }
      reader = response.body.getReader(); owner.reader = reader
      const stream = new ReadableStream<Uint8Array>({
        async pull(output) {
          try {
            const chunk = await reader!.read()
            if (controller.signal.aborted) throw new OpenAINetworkError('aborted')
            if (chunk.done) { cleanup(); output.close() }
            else output.enqueue(chunk.value)
          } catch { cleanup(); output.error(new OpenAINetworkError(controller.signal.aborted ? 'aborted' : 'response_stream_failed')) }
        },
        async cancel() { controller.abort(); try { await reader!.cancel() } finally { cleanup() } },
      })
      return new Response(stream, { status: response.status, statusText: response.statusText, headers: response.headers })
    } catch {
      cleanup(); throw new OpenAINetworkError(controller.signal.aborted ? 'aborted' : 'request_failed')
    }
  }

  const socketFactory: RealtimeDependencies['socketFactory'] = (input, options): RealtimeSocket => {
    const url = officialUrl(input, true)
    if (closed) throw new OpenAINetworkError('closed')
    const abort = new AbortController()
    // The signal reaches net.connect inside HttpsProxyAgent, so timeout or owner
    // close also destroys a CONNECT socket which has not yet reached Node ws.
    const agent = proxy ? new HttpsProxyAgent(proxy, { signal: abort.signal, timeout: HANDSHAKE_MS, keepAlive: false }) : undefined
    let raw: WebSocket
    try { raw = new WebSocket(url.href, { headers: options.headers, ...(agent ? { agent } : {}), handshakeTimeout: HANDSHAKE_MS, followRedirects: false, rejectUnauthorized: true }) }
    catch { agent?.destroy(); throw new OpenAINetworkError('websocket_failed') }
    const events = new EventEmitter()
    events.on('error', () => {})
    let closeTimer: ReturnType<typeof setTimeout> | undefined
    let removed = false
    const cleanup = () => { if (removed) return; removed = true; clearTimeout(handshake); clearTimeout(closeTimer); abort.abort(); agent?.destroy(); sockets.delete(owner) }
    const owner = { stop: () => { abort.abort(); try { raw.terminate() } catch { /* normalized owner close below */ }; cleanup() } }
    const handshake = setTimeout(() => { events.emit('error', new OpenAINetworkError('websocket_timeout')); owner.stop() }, HANDSHAKE_MS)
    handshake.unref?.(); sockets.add(owner)
    raw.on('open', () => { clearTimeout(handshake); if (closed) owner.stop(); else events.emit('open') })
    raw.on('message', data => events.emit('message', data))
    raw.on('error', () => events.emit('error', new OpenAINetworkError('websocket_failed')))
    raw.on('close', () => { cleanup(); events.emit('close') })
    return {
      get readyState() { return raw.readyState },
      on(event, listener) { events.on(event, listener); return this },
      off(event, listener) { events.off(event, listener); return this },
      send(data) { try { raw.send(data) } catch { throw new OpenAINetworkError('websocket_send_failed') } },
      close() {
        try {
          if (raw.readyState === WebSocket.CONNECTING) { owner.stop(); return }
          raw.close()
          if (!removed) { closeTimer = setTimeout(owner.stop, CLOSE_MS); closeTimer.unref?.() }
        } catch { owner.stop() }
      },
    }
  }
  return {
    fetchImpl, socketFactory,
    close() {
      if (closing) return closing
      closed = true
      for (const owner of fetches) { owner.controller.abort(); void owner.reader?.cancel().catch(() => {}); owner.cleanup() }
      for (const owner of [...sockets]) owner.stop()
      closing = (async () => {
        if (!dispatcher) return
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
          await Promise.race([dispatcher.close(), new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new OpenAINetworkError('close_timeout')), CLOSE_MS) })])
        } catch {
          clearTimeout(timer)
          try { await Promise.race([dispatcher.destroy(), new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new OpenAINetworkError('close_failed')), CLOSE_MS) })]) }
          catch { throw new OpenAINetworkError('close_failed') }
        } finally { clearTimeout(timer) }
      })()
      return closing
    },
  }
}

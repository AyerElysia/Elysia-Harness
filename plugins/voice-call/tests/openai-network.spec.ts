import { afterEach, describe, expect, it, vi } from 'vitest'
const fake = vi.hoisted(() => ({ dispatchers: [] as any[], agents: [] as any[], sockets: [] as any[], setGlobalDispatcher: vi.fn() }))
vi.mock('undici', () => ({
  setGlobalDispatcher: fake.setGlobalDispatcher,
  ProxyAgent: class {
    close = vi.fn(async () => {}); destroy = vi.fn(async () => {})
    constructor(readonly options: any) { fake.dispatchers.push(this) }
  },
}))
vi.mock('https-proxy-agent', () => ({ HttpsProxyAgent: class {
  destroy = vi.fn()
  constructor(readonly proxy: string, readonly options: any) { fake.agents.push(this) }
} }))
vi.mock('ws', async () => {
  const { EventEmitter } = await import('node:events')
  return { default: class extends EventEmitter {
    static CONNECTING = 0; static OPEN = 1; readyState = 0
    send = vi.fn(); close = vi.fn(() => { this.readyState = 3; this.emit('close') })
    terminate = vi.fn(() => { this.readyState = 3; this.emit('close') })
    constructor(readonly url: string, readonly options: any) { super(); fake.sockets.push(this) }
  } }
})
import { createOpenAINetwork, type OpenAINetwork } from '../src/openai-network.js'
const owners: OpenAINetwork[] = []
function network(proxy?: string) { const owner = createOpenAINetwork(proxy); owners.push(owner); return owner }
const target = 'https://api.openai.com/v1/models/gpt-realtime-2.1-mini'
const socketTarget = 'wss://api.openai.com/v1/realtime?call_id=rtc_owned'
afterEach(async () => {
  for (const owner of owners.splice(0)) await owner.close().catch(() => {})
  vi.unstubAllGlobals(); vi.useRealTimers(); fake.dispatchers.length = 0; fake.agents.length = 0; fake.sockets.length = 0; fake.setGlobalDispatcher.mockClear()
})

describe('OpenAI owner-local network (fake only)', () => {
  it.each(['https://127.0.0.1:17878', 'http://example.com:17878', 'http://user:private@127.0.0.1:17878', 'http://127.0.0.1:17878/path', 'http://127.0.0.1:17878/?token=private', 'http://127.0.0.1:17878/#secret', 'socks5://127.0.0.1:17878', 'not a URL'])('rejects an unsafe proxy without allocating resources (%s)', proxy => {
    expect(() => createOpenAINetwork(proxy)).toThrow('invalid_proxy'); expect(fake.dispatchers).toHaveLength(0)
  })
  it('uses a local dispatcher only for the official origin and preserves model, auth, body, and method', async () => {
    const fetch = vi.fn(async () => new Response('{"id":"gpt-realtime-2.1-mini"}', { headers: { 'Content-Type': 'application/json' } })); vi.stubGlobal('fetch', fetch)
    const owner = network('http://127.0.0.1:17878'); const headers = { Authorization: 'Bearer fake-only' }; const body = new FormData(); body.set('model', 'gpt-realtime-2.1-mini')
    const response = await owner.fetchImpl('https://api.openai.com/v1/realtime/calls', { method: 'POST', headers, body, redirect: 'follow' })
    expect(await response.json()).toEqual({ id: 'gpt-realtime-2.1-mini' })
    expect(fetch).toHaveBeenCalledWith('https://api.openai.com/v1/realtime/calls', expect.objectContaining({ method: 'POST', headers, body, dispatcher: fake.dispatchers[0], redirect: 'error' }))
    expect(fake.dispatchers[0].options).toMatchObject({ uri: 'http://127.0.0.1:17878/', requestTls: { rejectUnauthorized: true }, connect: { timeout: 15000 } })
    expect(globalThis.fetch).toBe(fetch); expect(fake.setGlobalDispatcher).not.toHaveBeenCalled()
  })
  it.each(['http://api.openai.com/v1/models', 'https://api.openai.com.evil.example/v1/models', 'https://evil.example/v1/models', 'https://private@api.openai.com/v1/models', 'https://api.openai.com:8443/v1/models', 'http://127.0.0.1:7862/v1/audio/speech'])('never sends a Bearer credential to an unapproved target (%s)', async url => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch); const owner = network('http://127.0.0.1:17878')
    await expect(owner.fetchImpl(url, { headers: { Authorization: 'Bearer fake-only' } })).rejects.toThrow('invalid_target'); expect(fetch).not.toHaveBeenCalled()
  })
  it('direct mode allocates no proxy agents and still verifies TLS and disables redirects', async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('model')); vi.stubGlobal('fetch', fetch); const owner = network()
    expect(await (await owner.fetchImpl(target)).text()).toBe('model')
    owner.socketFactory(socketTarget, { headers: { Authorization: 'Bearer fake-only' } })
    expect(fake.dispatchers).toHaveLength(0); expect(fake.agents).toHaveLength(0)
    expect(fake.sockets[0].options).toMatchObject({ followRedirects: false, rejectUnauthorized: true, handshakeTimeout: 15000 })
    expect(fake.sockets[0].options.agent).toBeUndefined(); expect(fetch.mock.calls[0]?.[1]).toMatchObject({ dispatcher: undefined, redirect: 'error' })
  })
  it('tunnels only the owned sideband WS with unchanged auth and independent abortable CONNECT ownership', async () => {
    const owner = network('http://127.0.0.1:17878'); const socket = owner.socketFactory(socketTarget, { headers: { Authorization: 'Bearer fake-only' } })
    expect(fake.sockets[0].url).toBe(socketTarget)
    expect(fake.sockets[0].options).toMatchObject({ headers: { Authorization: 'Bearer fake-only' }, agent: fake.agents[0], followRedirects: false, rejectUnauthorized: true, handshakeTimeout: 15000 })
    expect(fake.agents[0].options.signal).toBeInstanceOf(AbortSignal)
    const errors: string[] = []; socket.on('error', error => errors.push(String(error)))
    fake.sockets[0].emit('error', new Error('https://secret@untrusted.example fake-only'))
    expect(errors).toEqual(['OpenAINetworkError: OpenAI network operation failed (websocket_failed).'])
    await owner.close(); expect(fake.agents[0].options.signal.aborted).toBe(true); expect(fake.sockets[0].terminate).toHaveBeenCalledTimes(1)
  })
  it.each(['ws://api.openai.com/v1/realtime?call_id=rtc_owned', 'wss://evil.example/v1/realtime?call_id=rtc_owned', 'wss://api.openai.com/v1/realtime', 'wss://api.openai.com/v1/realtime?call_id=rtc_owned&token=private', 'wss://api.openai.com/v1/realtime?call_id=a&call_id=b'])('refuses unowned WebSocket targets (%s)', url => {
    const owner = network('http://127.0.0.1:17878'); expect(() => owner.socketFactory(url, { headers: { Authorization: 'Bearer fake-only' } })).toThrow('invalid_target'); expect(fake.sockets).toHaveLength(0)
  })
  it('settles request cancellation even if a custom carrier ignores abort, without a direct fallback', async () => {
    const fetch = vi.fn(() => new Promise<Response>(() => {})); vi.stubGlobal('fetch', fetch); const owner = network('http://127.0.0.1:17878'); const controller = new AbortController()
    const response = owner.fetchImpl(target, { signal: controller.signal }); controller.abort()
    await expect(response).rejects.toThrow('aborted'); expect(fetch).toHaveBeenCalledTimes(1)
  })
  it('retains owner cancellation through streaming response reads and cancels the underlying reader', async () => {
    const cancelled = vi.fn(); const fetch = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({ start(stream) { stream.enqueue(Uint8Array.of(1, 2)) }, cancel: cancelled }))); vi.stubGlobal('fetch', fetch)
    const owner = network('http://127.0.0.1:17878'); const reader = (await owner.fetchImpl(target)).body!.getReader(); expect((await reader.read()).value).toEqual(Uint8Array.of(1, 2))
    const pending = reader.read(); await owner.close(); await expect(pending).rejects.toThrow('aborted'); expect(cancelled).toHaveBeenCalledTimes(1)
  })
  it('bounds the proxy/HTTP handshake even if the carrier never settles', async () => {
    vi.useFakeTimers(); const fetch = vi.fn(() => new Promise<Response>(() => {})); vi.stubGlobal('fetch', fetch); const owner = network('http://127.0.0.1:17878')
    const response = owner.fetchImpl(target); const rejection = expect(response).rejects.toThrow('aborted')
    await vi.advanceTimersByTimeAsync(15000); await rejection; expect(fetch).toHaveBeenCalledTimes(1)
  })
  it('bounds a WS CONNECT handshake and releases its own agent/socket without TLS bypass', async () => {
    vi.useFakeTimers(); const owner = network('http://127.0.0.1:17878'); const socket = owner.socketFactory(socketTarget, { headers: { Authorization: 'Bearer fake-only' } }); const errors: string[] = []; socket.on('error', error => errors.push(String(error)))
    await vi.advanceTimersByTimeAsync(15000)
    expect(errors[0]).toContain('websocket_timeout'); expect(fake.agents[0].options.signal.aborted).toBe(true); expect(fake.agents[0].destroy).toHaveBeenCalledTimes(1); expect(fake.sockets[0].terminate).toHaveBeenCalledTimes(1)
  })
  it('closes idempotently and refuses all new work after owner shutdown', async () => {
    const owner = network('http://127.0.0.1:17878'); const first = owner.close(); expect(owner.close()).toBe(first); await first
    expect(fake.dispatchers[0].close).toHaveBeenCalledTimes(1)
    await expect(owner.fetchImpl(target)).rejects.toThrow('closed'); expect(() => owner.socketFactory(socketTarget, { headers: { Authorization: 'Bearer fake' } })).toThrow('closed')
  })
  it('redacts raw fetch failures and confirms destruction if graceful dispatcher close fails', async () => {
    const fetch = vi.fn(async () => { throw new Error('fake-only secret proxy URL') }); vi.stubGlobal('fetch', fetch); const owner = network('http://127.0.0.1:17878')
    await expect(owner.fetchImpl(target)).rejects.toThrow('request_failed')
    fake.dispatchers[0].close.mockRejectedValueOnce(new Error('private network detail')); await owner.close(); expect(fake.dispatchers[0].destroy).toHaveBeenCalledTimes(1)
  })
})

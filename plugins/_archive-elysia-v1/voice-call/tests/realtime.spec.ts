import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { createDriver, REALTIME_MODEL, RealtimeTransport, type RealtimeEvent, type RealtimeSocket } from '../src/realtime.js'

class Socket extends EventEmitter implements RealtimeSocket {
  readyState = 0
  sent: any[] = []
  autoAck = true
  mutate: (session: any) => any = session => session
  send(raw: string) {
    const event = JSON.parse(raw); this.sent.push(event)
    if (event.type === 'session.update' && this.autoAck) queueMicrotask(() => this.server({ type: 'session.updated', session: this.mutate(event.session) }))
    if (event.type === 'conversation.item.create' && this.autoAck) queueMicrotask(() => this.server({ type: 'conversation.item.added', item: event.item }))
  }
  close() { this.readyState = 3; this.emit('close') }
  open() { this.readyState = 1; this.emit('open') }
  server(event: object) { this.emit('message', Buffer.from(JSON.stringify(event))) }
}
function setup(options: { mutate?: (session: any) => any; timeoutMs?: number; hangupStatus?: number } = {}) {
  const socket = new Socket()
  if (options.mutate) socket.mutate = options.mutate
  const requests: { url: string; init: RequestInit }[] = []
  const fetchImpl = vi.fn(async (input: any, init?: RequestInit) => {
    requests.push({ url: String(input), init: init! })
    return String(input).endsWith('/hangup')
      ? new Response(null, { status: options.hangupStatus ?? 200 })
      : new Response('v=0\r\nanswer', { status: 201, headers: { location: '/v1/realtime/calls/rtc_fake_123' } })
  }) as unknown as typeof fetch
  const socketFactory = vi.fn(() => { queueMicrotask(() => socket.open()); return socket })
  const transport = new RealtimeTransport({ fetchImpl, socketFactory, timeoutMs: options.timeoutMs ?? 100, responseTimeoutMs: 1000 })
  const create = () => transport.create({ sdp: 'v=0\r\noffer', instructions: 'SOUL only\nexact.', apiKey: 'fake-test-key' })
  return { socket, requests, fetchImpl, socketFactory, transport, create }
}
async function turn(fixture: ReturnType<typeof setup>, call: Awaited<ReturnType<ReturnType<typeof setup>['create']>>, text = '你好。') {
  const before = fixture.socket.sent.filter(event => event.type === 'response.create').length
  const chunks: any[] = []
  const consume = (async () => { for await (const chunk of call.respond({ instructions: 'SOUL only\nexact.' })) chunks.push(chunk) })()
  await vi.waitFor(() => expect(fixture.socket.sent.filter(event => event.type === 'response.create')).toHaveLength(before + 1))
  const created = fixture.socket.sent.filter(event => event.type === 'response.create').at(-1)
  const response = { id: `resp_${fixture.socket.sent.length}`, metadata: created.response.metadata }
  fixture.socket.server({ type: 'response.created', response })
  fixture.socket.server({ type: 'response.output_text.delta', response_id: response.id, output_index: 0, content_index: 0, delta: text })
  fixture.socket.server({ type: 'response.output_text.done', response_id: response.id, output_index: 0, content_index: 0, text })
  fixture.socket.server({ type: 'response.done', response: { ...response, status: 'completed', usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14, input_token_details: { cached_tokens: 3 } } } })
  await consume
  return { chunks, response }
}

describe('Realtime provider transport (fake only)', () => {
  it('creates unified SDP with strict text-only SOUL settings and attaches sideband', async () => {
    const fixture = setup(); const call = await fixture.create()
    const create = fixture.requests[0]!
    expect(create.url).toBe('https://api.openai.com/v1/realtime/calls')
    expect(create.init.method).toBe('POST')
    const body = create.init.body as FormData
    expect(body.get('sdp')).toBe('v=0\r\noffer')
    expect(JSON.parse(String(body.get('session')))).toMatchObject({ type: 'realtime', model: REALTIME_MODEL, instructions: 'SOUL only\nexact.', output_modalities: ['text'], tools: [], tool_choice: 'none', audio: { input: { turn_detection: { type: 'server_vad', create_response: false, interrupt_response: false } } } })
    expect(fixture.socketFactory).toHaveBeenCalledWith('wss://api.openai.com/v1/realtime?call_id=rtc_fake_123', { headers: { Authorization: 'Bearer fake-test-key' } })
    expect(call.callId).toBe('rtc_fake_123'); expect(call.sdp).toBe('v=0\r\nanswer')
    await call.close()
  })
  it('requires a verified exact configuration before creating every response', async () => {
    const fixture = setup(); const call = await fixture.create()
    fixture.socket.autoAck = false
    const chunks: any[] = []
    const consuming = (async () => { for await (const chunk of call.respond({ instructions: 'SOUL new version' })) chunks.push(chunk) })()
    await vi.waitFor(() => expect(fixture.socket.sent.filter(event => event.type === 'session.update')).toHaveLength(2))
    expect(fixture.socket.sent.filter(event => event.type === 'response.create')).toHaveLength(0)
    const update = fixture.socket.sent.at(-1)
    fixture.socket.server({ type: 'session.updated', session: update.session })
    await vi.waitFor(() => expect(fixture.socket.sent.filter(event => event.type === 'response.create')).toHaveLength(1))
    const request = fixture.socket.sent.at(-1).response
    expect(request).toMatchObject({ conversation: 'none', output_modalities: ['text'], tools: [], tool_choice: 'none' })
    expect(request.instructions).toBeUndefined(); expect(request.input).toBeUndefined()
    await call.cancelActive(); await consuming
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'aborted' } })
    await call.close()
  })
  it.each([
    ['instructions', (session: any) => ({ ...session, instructions: 'not SOUL' })],
    ['tools', (session: any) => ({ ...session, tools: [{ type: 'function', name: 'evil' }] })],
    ['audio', (session: any) => ({ ...session, output_modalities: ['audio'] })],
    ['VAD', (session: any) => ({ ...session, audio: { input: { turn_detection: { type: 'server_vad', create_response: true, interrupt_response: false } } } })],
  ])('rejects accepted-provider %s mismatch and actually ends the call', async (_name, mutate) => {
    const fixture = setup({ mutate })
    await expect(fixture.create()).rejects.toThrow('configuration-mismatch')
    expect(fixture.requests.filter(request => request.url.endsWith('/hangup'))).toHaveLength(1)
    expect(fixture.socket.sent.some(event => event.type === 'response.create')).toBe(false)
  })
  it('emits native chunks and correct uncached input token usage before terminal finish', async () => {
    const fixture = setup(); const call = await fixture.create()
    const { chunks, response } = await turn(fixture, call)
    expect(chunks.map(chunk => chunk.type)).toEqual(['block-start', 'text-delta', 'block-end', 'usage', 'finish'])
    expect(chunks[1]).toMatchObject({ index: 0, text: '你好。' })
    expect(chunks[2].block).toEqual({ type: 'text', text: '你好。' })
    expect(chunks[3].usage).toEqual({ inputTokens: 7, outputTokens: 4, totalTokens: 14, cacheReadTokens: 3 })
    expect(chunks[4]).toMatchObject({ reason: { kind: 'stop' }, replayState: { response: { responseId: response.id } } })
    expect(call.lastSettledResponseId).toBe(response.id)
    await call.close()
  })
  it('reports typed input and usage events without copying raw payload fields', async () => {
    const fixture = setup(); const call = await fixture.create(); const events: RealtimeEvent[] = []
    const dispose = call.subscribe(event => events.push(event))
    fixture.socket.server({ type: 'input_audio_buffer.speech_started', item_id: 'user1', audio_start_ms: 40, secret: 'do not expose' })
    fixture.socket.server({ type: 'input_audio_buffer.committed', item_id: 'user1', previous_item_id: 'prev' })
    await turn(fixture, call)
    expect(events).toEqual([{ type: 'speech_started', itemId: 'user1', audioStartMs: 40 }, { type: 'audio_committed', itemId: 'user1', previousItemId: 'prev' }, expect.objectContaining({ type: 'usage' })])
    dispose(); await call.close()
  })
  it('ignores foreign and cancelled-response deltas rather than leaking them into a later turn', async () => {
    const fixture = setup(); const call = await fixture.create()
    const old: any[] = []; const first = (async () => { for await (const chunk of call.respond({ instructions: 'SOUL only\nexact.' })) old.push(chunk) })()
    await vi.waitFor(() => expect(fixture.socket.sent.some(event => event.type === 'response.create')).toBe(true))
    const oldMetadata = fixture.socket.sent.at(-1).response.metadata
    await call.cancelActive(); await first
    fixture.socket.server({ type: 'response.created', response: { id: 'late_response', metadata: oldMetadata } })
    expect(fixture.socket.sent.at(-1)).toEqual({ type: 'response.cancel', response_id: 'late_response' })
    fixture.socket.server({ type: 'response.output_text.delta', response_id: 'late_response', delta: 'forbidden old words' })
    const second = await turn(fixture, call, '现在。')
    fixture.socket.server({ type: 'response.output_text.delta', response_id: 'foreign', delta: 'foreign words' })
    expect(second.chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join('')).toBe('现在。')
    await call.close()
  })
  it('appends only acknowledged exact generated prefixes and deduplicates segment ids', async () => {
    const fixture = setup(); const call = await fixture.create(); const { response } = await turn(fixture, call, '第一句。第二句。')
    await expect(call.appendPlayed({ responseId: response.id, segmentId: 'wrong', text: '客户端伪造' })).rejects.toThrow('played-text-mismatch')
    await call.appendPlayed({ responseId: response.id, segmentId: 'one', text: '第一句。' })
    await call.appendPlayed({ responseId: response.id, segmentId: 'one', text: '第一句。' })
    await call.appendPlayed({ responseId: response.id, segmentId: 'two', text: '第二句。' })
    expect(fixture.socket.sent.filter(event => event.type === 'conversation.item.create').map(event => event.item.content)).toEqual([[{ type: 'output_text', text: '第一句。' }], [{ type: 'output_text', text: '第二句。' }]])
    await expect(call.appendPlayed({ responseId: response.id, segmentId: 'one', text: '改了' })).rejects.toThrow('segment-conflict')
    await call.close()
  })
  it('redacts provider errors and closes actual provider call exactly once', async () => {
    const fixture = setup(); const call = await fixture.create(); const events: RealtimeEvent[] = []; call.subscribe(event => events.push(event))
    fixture.socket.server({ type: 'error', error: { message: 'fake-test-key SOUL private SDP secret' } })
    await call.close(); await call.close()
    expect(fixture.requests.filter(request => request.url.endsWith('/hangup'))).toHaveLength(1)
    expect(JSON.stringify(events)).not.toContain('fake-test-key'); expect(JSON.stringify(events)).not.toContain('private')
    expect(events[0]).toMatchObject({ type: 'error', code: 'provider-error' })
  })
  it('does not claim hangup succeeded merely because the socket closed', async () => {
    const fixture = setup({ hangupStatus: 503 }); const call = await fixture.create()
    await expect(call.close()).rejects.toThrow('hangup-unconfirmed')
    expect(fixture.socket.readyState).toBe(3)
    await expect(call.close()).rejects.toThrow('hangup-unconfirmed')
    expect(fixture.requests.filter(request => request.url.endsWith('/hangup'))).toHaveLength(1)
  })
  it('times out missing setup acknowledgements and cleans up provider resources', async () => {
    const fixture = setup({ timeoutMs: 20 }); fixture.socket.autoAck = false
    await expect(fixture.create()).rejects.toThrow('configuration-timeout')
    expect(fixture.requests.filter(request => request.url.endsWith('/hangup'))).toHaveLength(1)
  })
  it('native driver forwards SOUL and turn markers, never native input messages as another prompt', async () => {
    const fixture = setup(); const call = await fixture.create()
    const chunks: any[] = []; const driver = createDriver(call)
    const consuming = (async () => { for await (const chunk of driver.run({ messages: [] as any, instructions: 'SOUL only\nexact.', turn: 4, step: 2, signal: new AbortController().signal })) chunks.push(chunk) })()
    await vi.waitFor(() => expect(fixture.socket.sent.some(event => event.type === 'response.create')).toBe(true))
    expect(fixture.socket.sent.at(-1).response.metadata).toMatchObject({ native_turn: '4', native_step: '2' })
    await call.cancelActive(); await consuming; await call.close()
  })
  it('aborts an active owned response and retains only its received prefix', async () => {
    const fixture = setup(); const call = await fixture.create(); const controller = new AbortController(); const chunks: any[] = []
    const consuming = (async () => { for await (const chunk of call.respond({ instructions: 'SOUL only\nexact.', signal: controller.signal })) chunks.push(chunk) })()
    expect(call.lastSettledResponseId).toBeUndefined()
    await vi.waitFor(() => expect(fixture.socket.sent.some(event => event.type === 'response.create')).toBe(true))
    const metadata = fixture.socket.sent.at(-1).response.metadata
    fixture.socket.server({ type: 'response.created', response: { id: 'owned', metadata } })
    fixture.socket.server({ type: 'response.output_text.delta', response_id: 'owned', delta: '已收到' })
    controller.abort(); await consuming
    expect(call.lastSettledResponseId).toBeUndefined()
    expect(fixture.socket.sent.at(-1)).toEqual({ type: 'response.cancel', response_id: 'owned' })
    expect(chunks.at(-2)).toMatchObject({ type: 'block-end', block: { text: '已收到' } })
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'aborted' } })
    fixture.socket.server({ type: 'response.output_text.delta', response_id: 'owned', delta: 'late ignored' })
    await call.appendPlayed({ responseId: 'owned', segmentId: 'prefix', text: '已收到' })
    await call.close()
  })
  it('fails closed if a browser or provider starts an unowned response', async () => {
    const fixture = setup(); const call = await fixture.create(); const events: RealtimeEvent[] = []; call.subscribe(event => events.push(event))
    fixture.socket.server({ type: 'response.created', response: { id: 'unauthorized', metadata: {} } })
    await call.close()
    expect(events[0]).toMatchObject({ type: 'error', code: 'unowned-response' })
    expect(fixture.requests.filter(request => request.url.endsWith('/hangup'))).toHaveLength(1)
  })
  it('fails closed on runtime configuration tampering after setup', async () => {
    const fixture = setup(); const call = await fixture.create(); const events: RealtimeEvent[] = []; call.subscribe(event => events.push(event))
    const original = fixture.socket.sent[0].session
    fixture.socket.server({ type: 'session.updated', session: { ...original, tool_choice: 'auto' } })
    await call.close()
    expect(events[0]).toMatchObject({ type: 'error', code: 'configuration-mismatch' })
  })
  it('sanitizes raw network failures without retrying or creating a socket', async () => {
    const socketFactory = vi.fn(() => new Socket())
    const fetchImpl = vi.fn(async () => { throw new Error('fake-secret-key and private SOUL') }) as unknown as typeof fetch
    const transport = new RealtimeTransport({ fetchImpl, socketFactory })
    await expect(transport.create({ sdp: 'v=0', instructions: 'SOUL', apiKey: 'fake' })).rejects.toThrow('network')
    expect(fetchImpl).toHaveBeenCalledTimes(1); expect(socketFactory).not.toHaveBeenCalled()
  })
  it('cancels non-OK HTTP response streams without consuming private bodies', async () => {
    const cancelled = vi.fn()
    const fetchImpl = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({ cancel: cancelled }), { status: 401 })) as unknown as typeof fetch
    const socketFactory = vi.fn(() => new Socket())
    const transport = new RealtimeTransport({ fetchImpl, socketFactory })
    await expect(transport.create({ sdp: 'v=0', instructions: 'SOUL', apiKey: 'fake' })).rejects.toThrow('HTTP 401')
    expect(cancelled).toHaveBeenCalledTimes(1)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(socketFactory).not.toHaveBeenCalled()
  })
})

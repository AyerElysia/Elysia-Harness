import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAssistantMessage } from '@deepseek-ai/dsh-llm'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import { VoiceActivityDetailsSchema } from '../src/activity.js'
import { VoiceCallController, type ControllerRecordedResponse, type VoiceControllerDependencies, type VoiceActivity } from '../src/controller.js'
import { RealtimeError, RealtimeTransport, type RealtimeSocket } from '../src/realtime.js'
import type { VoiceEvent } from '../src/protocol.js'
import type { VoiceDriver } from '../src/session.js'
import type { BreezeSettings } from '../src/breeze-stream.js'

class Socket extends EventEmitter implements RealtimeSocket {
  readyState = 0; sent: any[] = []; text = '第一句。第二句。'; responses = 0
  send(raw: string) {
    const event = JSON.parse(raw); this.sent.push(event)
    if (event.type === 'session.update') queueMicrotask(() => this.server({ type: 'session.updated', session: event.session }))
    if (event.type === 'conversation.item.create') queueMicrotask(() => this.server({ type: 'conversation.item.added', item: event.item }))
    if (event.type === 'response.create') queueMicrotask(() => {
      const response = { id: `resp_fake_${++this.responses}`, metadata: event.response.metadata }
      this.server({ type: 'response.created', response })
      this.server({ type: 'response.output_text.delta', response_id: response.id, delta: this.text })
      this.server({ type: 'response.output_text.done', response_id: response.id, text: this.text })
      this.server({ type: 'response.done', response: { ...response, status: 'completed', usage: { input_tokens: 8, output_tokens: 4, total_tokens: 12 } } })
    })
  }
  close() { this.readyState = 3; this.emit('close') }
  server(event: object) { this.emit('message', Buffer.from(JSON.stringify(event))) }
}
const controllers: VoiceCallController[] = []
afterEach(async () => { for (const controller of controllers.splice(0)) await controller.close().catch(() => {}); vi.useRealTimers() })
const request = (requestId = 'request_one') => ({ requestId, sdp: 'v=0\r\nfake-offer', privacyMode: 'no-raw-audio' })
function setup(hooks: { record?: (event: VoiceActivity) => Promise<void>; synthesize?: VoiceControllerDependencies['synthesize']; createStatus?: number; hangupStatus?: number; enabled?: boolean; configured?: boolean; slowSetup?: boolean } = {}) {
  const socket = new Socket(); const activities: VoiceActivity[] = []; const events: VoiceEvent[] = []; const accepted: string[] = []; const errors: unknown[] = []
  let driver: VoiceDriver | undefined; let onRecorded: ((event: ControllerRecordedResponse) => Promise<void>) | undefined
  let turn = 0; let generation: AbortController | undefined; const jobs = new Set<Promise<void>>()
  let activeSynthesis = 0; let maxSynthesis = 0; let nativeCheckpointed = false
  const cancel = vi.fn(() => generation?.abort())
  const handle = { cancel, whenIdle: async () => { await Promise.allSettled([...jobs]) } }
  const openedClose = vi.fn(async () => { cancel(); await handle.whenIdle() })
  const fetchImpl = vi.fn(async (url: any) => {
    if (String(url).endsWith('/hangup')) return new Response(null, { status: hooks.hangupStatus ?? 200 })
    if (hooks.slowSetup) await new Promise<void>(resolve => { setTimeout(resolve, 7_000) })
    return new Response('v=0\r\nfake-answer', { status: hooks.createStatus ?? 201, headers: { location: '/v1/realtime/calls/rtc_fake_controller' } })
  }) as unknown as typeof fetch
  const realtime = new RealtimeTransport({ fetchImpl, socketFactory: () => {
    const open = () => { socket.readyState = 1; socket.emit('open') }
    if (hooks.slowSetup) setTimeout(open, 6_000); else queueMicrotask(open)
    return socket
  }, ...(hooks.slowSetup ? {} : { timeoutMs: 100 }) })
  const settings: BreezeSettings = { server: 'http://127.0.0.1:7862', timeoutMs: 1000, maxTextLength: 1000, styleName: 'default', referenceAudioPath: '/fake/not-read.wav', referenceText: 'fake', instruction: 'fixed', cfgScale: 3.8, seed: -1 }
  const synthesize: NonNullable<VoiceControllerDependencies['synthesize']> = hooks.synthesize ?? (async function* (_settings, _text, options) {
    activeSynthesis++; maxSynthesis = Math.max(maxSynthesis, activeSynthesis)
    try { options?.signal?.throwIfAborted(); yield { audio: Uint8Array.of(1, 0, 2, 0), sampleRate: 24000 } }
    finally { activeSynthesis-- }
  })
  const deps: VoiceControllerDependencies = {
    enabled: hooks.enabled ?? true, credentialConfigured: hooks.configured ?? true, breezeConfigPath: '/fake/config-not-read.toml', realtime,
    resolveApiKey: vi.fn(async () => 'fake-offline-key'), loadSettings: vi.fn(async () => settings), synthesize,
    openAgent: vi.fn(async input => { driver = input.driver; onRecorded = input.onRecordedResponse; return { agent: handle, initialInstructions: 'exact SOUL only', close: openedClose } }),
    recordActivity: vi.fn(async event => {
      VoiceActivityDetailsSchema.parse(event.details)
      if (event.type === 'output-generated') expect(nativeCheckpointed).toBe(true)
      activities.push(event); await hooks.record?.(event)
    }),
    acceptAudioCommit: vi.fn(async (_agent, event) => {
      expect(activities.some(activity => activity.type === 'audio-committed' && activity.details?.inputItemId === event.itemId)).toBe(true)
      accepted.push(event.itemId); generation = new AbortController(); const signal = generation.signal; const thisTurn = ++turn
      const job = (async () => {
        let text = ''; let finished = false
        for await (const chunk of driver!.run({ messages: [], instructions: 'exact SOUL only', turn: thisTurn, step: 1, signal })) {
          if (chunk.type === 'text-delta') text += chunk.text
          if (chunk.type === 'finish') finished = chunk.reason.kind === 'stop'
        }
        if (finished && !signal.aborted) {
          nativeCheckpointed = true
          await onRecorded!({ turn: thisTurn, step: 1, seq: SessionSeq(thisTurn * 10), signal,
            message: createAssistantMessage({ content: [{ type: 'text', text }], source: { provider: 'openai-realtime', model: 'gpt-realtime-2.1-mini' } }) })
        }
      })().catch(error => { errors.push(error) })
      jobs.add(job); void job.then(() => jobs.delete(job))
    }),
  }
  const controller = new VoiceCallController(deps); controllers.push(controller)
  const start = async () => { const result = await controller.start(request()); controller.subscribeEvents(result.callId, result.capability, event => { events.push(event) }); return result }
  const wake = (itemId = 'input_one') => socket.server({ type: 'input_audio_buffer.committed', item_id: itemId })
  const waitSpeech = async (segments = 2) => { await vi.waitFor(() => expect(events.filter(event => event.type === 'segment-end')).toHaveLength(segments)); await Promise.allSettled([...jobs]) }
  return { controller, deps, socket, activities, events, accepted, errors, handle, openedClose, fetchImpl, start, wake, waitSpeech, maxSynthesis: () => maxSynthesis }
}

describe('VoiceCallController, offline owners only', () => {
  it('completes serial provider setup after 10s and does not abort a ready call at the startup deadline', async () => {
    vi.useFakeTimers()
    const f = setup({ slowSetup: true })
    const starting = f.start()
    await vi.advanceTimersByTimeAsync(10_001)
    expect(f.controller.getState().connection).toBe('connecting')
    await vi.advanceTimersByTimeAsync(2_999)
    const call = await starting
    expect(f.controller.getState().connection).toBe('ready')
    await vi.advanceTimersByTimeAsync(17_001)
    expect(f.controller.getState().connection).toBe('ready')
    await f.controller.control({ callId: call.callId, epoch: 0, action: 'heartbeat' }, call.capability)
    await f.controller.close()
    expect(f.activities.filter(event => event.type === 'startup-phase').map(event => event.details?.startupPhase))
      .toEqual(['agent_prepare', 'credential_resolve', 'provider_create', 'call_ready'])
    expect(f.activities.at(-1)?.details).toMatchObject({ startupPhase: 'call_ready', providerSetupPhase: 'session_configure', startupTimedOut: false, providerHangupConfirmed: true })
  })
  it.each([true, false])('separates server deadline from client cancellation and records the last provider stage (%s)', async (serverDeadline) => {
    vi.useFakeTimers()
    const f = setup({ record: async event => {
      if (event.type === 'call-start-requested') await new Promise<void>(resolve => { setTimeout(resolve, 8_000) })
    } })
    const create = vi.spyOn(f.deps.realtime, 'create').mockImplementation(({ signal, onSetupPhase }) => {
      onSetupPhase?.('create_http')
      return new Promise((_resolve, reject) => signal!.addEventListener('abort', () => reject(new RealtimeError('aborted')), { once: true }))
    })
    const client = new AbortController()
    const starting = f.controller.start(request(), client.signal)
    const expected = serverDeadline ? 'start_timeout' : 'start_aborted'
    const failure = expect(starting).rejects.toMatchObject({ code: expected })
    await vi.advanceTimersByTimeAsync(serverDeadline ? 30_000 : 12_000)
    if (!serverDeadline) client.abort()
    await failure
    expect(create).toHaveBeenCalledOnce()
    expect(f.openedClose).toHaveBeenCalledOnce()
    expect(f.activities.at(-1)?.details).toMatchObject({
      reason: expected, startupPhase: 'provider_create', providerSetupPhase: 'create_http',
      startupTimedOut: serverDeadline, providerCreated: false, cleanupFailed: false,
    })
  })
  it('keeps ownership blocked when setup cannot confirm hangup of a partially created call', async () => {
    const f = setup()
    vi.spyOn(f.deps.realtime, 'create').mockRejectedValueOnce(new RealtimeError('setup-cleanup-unconfirmed'))
    await expect(f.controller.start(request())).rejects.toMatchObject({ code: 'cleanup_failed' })
    expect(f.activities.at(-1)?.details).toMatchObject({ cleanupFailed: true, startupPhase: 'provider_create', providerCreated: false })
    await expect(f.controller.start(request('another'))).rejects.toMatchObject({ code: 'call_busy' })
  })
  it.each(['breeze_config', 'agent_prepare', 'credential_resolve'] as const)('reports safe local startup phase %s without leaking original errors', async phase => {
    const f = setup()
    const sensitive = new Error('NEVER EXPOSE fake-credential-or-prompt')
    if (phase === 'breeze_config') vi.mocked(f.deps.loadSettings!).mockRejectedValueOnce(sensitive)
    if (phase === 'agent_prepare') vi.mocked(f.deps.openAgent).mockRejectedValueOnce(sensitive)
    if (phase === 'credential_resolve') vi.mocked(f.deps.resolveApiKey).mockRejectedValueOnce(sensitive)
    const failure = await f.controller.start(request()).then(() => undefined, error => error)
    expect(failure).toMatchObject({ code: 'start_failed_' + phase })
    expect(String(failure)).not.toContain('NEVER EXPOSE')
    expect(f.controller.getState()).toMatchObject({ connection: 'failed', errorCode: 'start_failed_' + phase })
    expect(f.activities.at(-1)?.details).toMatchObject({ reason: 'start_failed_' + phase, providerCreated: false, cleanupFailed: false })
    expect(JSON.stringify(f.activities)).not.toContain('NEVER EXPOSE')
    expect(f.fetchImpl).not.toHaveBeenCalled()
  })
  it('preserves only the actual upstream HTTP status of provider creation failure', async () => {
    const f = setup({ createStatus: 401 })
    const failure = await f.controller.start(request()).then(() => undefined, error => error)
    expect(failure).toMatchObject({ code: 'start_failed_provider_create', upstreamStatus: 401 })
    expect(f.controller.getState()).toMatchObject({ connection: 'failed', errorCode: 'start_failed_provider_create' })
    expect(f.activities.at(-1)?.details).toMatchObject({ reason: 'start_failed_provider_create', httpStatus: 401, providerCreated: false, cleanupFailed: false })
    expect(f.openedClose).toHaveBeenCalledOnce()
    expect(f.fetchImpl).toHaveBeenCalledTimes(1)
  })
  it('does not dial on construction and exposes no capability or credential in state', async () => {
    const f = setup(); expect(f.fetchImpl).not.toHaveBeenCalled(); expect(f.deps.openAgent).not.toHaveBeenCalled()
    const start = await f.start(); expect(f.controller.getState()).toMatchObject({ connection: 'ready', capture: 'muted', rawAudioRecorded: false })
    expect(JSON.stringify(f.controller.getState())).not.toContain(start.capability); expect(JSON.stringify(f.activities)).not.toContain('fake-offline-key')
    await f.controller.close(); expect(f.openedClose).toHaveBeenCalledTimes(1)
  })
  it('deduplicates successful requestId without creating another provider call and rejects ended ids', async () => {
    const f = setup(); const first = await f.start(); expect(await f.controller.start(request())).toEqual(first)
    expect(f.fetchImpl).toHaveBeenCalledTimes(1); await f.controller.close()
    await expect(f.controller.start(request())).rejects.toThrow('start_ended'); expect(f.fetchImpl).toHaveBeenCalledTimes(2)
  })
  it('aborting a duplicate waiter never aborts the original call owner', async () => {
    const gate = Promise.withResolvers<void>(); const f = setup({ record: async event => { if (event.type === 'call-start-requested') await gate.promise } })
    const first = f.controller.start(request()); const controller = new AbortController(); const duplicate = f.controller.start(request(), controller.signal)
    controller.abort(); await expect(duplicate).rejects.toThrow('operation_aborted'); gate.resolve()
    const result = await first; expect(result.callId).toBe(f.controller.getState().callId); expect(f.fetchImpl).toHaveBeenCalledTimes(1)
  })
  it('rejects competing calls and capabilities and permits only one event stream owner', async () => {
    const f = setup(); const call = await f.start()
    await expect(f.controller.start(request('different'))).rejects.toThrow('call_busy')
    await expect(f.controller.control({ callId: call.callId, epoch: 0, action: 'heartbeat' }, `${call.capability}x`)).rejects.toThrow('unauthorized_capability')
    expect(() => f.controller.subscribeEvents(call.callId, call.capability, () => {})).toThrow('event_owner_conflict')
  })
  it('uses hot credential metadata for later calls but never changes an active provider', async () => {
    const f = setup({ configured: false }); await expect(f.controller.start(request())).rejects.toThrow('credential_missing')
    f.controller.updateCredentialConfigured(true); const call = await f.start(); f.controller.updateCredentialConfigured(false)
    expect(f.controller.getState().credentialConfigured).toBe(false); expect(call.callId).toBe(f.controller.getState().callId)
    expect(f.deps.resolveApiKey).toHaveBeenCalledTimes(1)
  })
  it('checkpoints input, SOUL hash and native recorded text before sequential Breeze output', async () => {
    const f = setup(); await f.start(); f.wake(); await f.waitSpeech()
    expect(f.maxSynthesis()).toBe(1); expect(f.events.filter(event => event.type === 'text')).toMatchObject([{ text: '第一句。第二句。', stage: 'generated' }])
    expect(f.activities.find(event => event.type === 'prompt-rendered')?.details).toMatchObject({ turn: 1, step: 1, promptHash: createHash('sha256').update('exact SOUL only').digest('hex'), agentRegistered: true })
    expect(f.activities.find(event => event.type === 'output-generated')?.details).toMatchObject({ nativeSeq: 10, turn: 1, step: 1 })
    expect(JSON.stringify(f.activities)).not.toContain('第一句'); expect(JSON.stringify(f.activities)).not.toContain('exact SOUL')
    expect(f.activities.some(event => event.type === 'provider-usage')).toBe(true); expect(f.controller.getState().usage).toMatchObject({ inputTokens: 8, outputTokens: 4, totalTokens: 12 })
  })
  it('projects only contiguous fully reported exact server text, not partial or reordered receipt text', async () => {
    const f = setup(); const call = await f.start(); f.wake(); await f.waitSpeech()
    const ends = f.events.filter((event): event is Extract<VoiceEvent, { type: 'segment-end' }> => event.type === 'segment-end')
    const receipt = (index: number, frames: number, full: boolean) => f.controller.playback({ callId: call.callId, epoch: 0, segmentId: ends[index]!.segmentId, playedFrames: frames, fullyPlayed: full }, call.capability)
    await receipt(1, ends[1]!.frames, true); await receipt(0, 1, false)
    expect(f.socket.sent.filter(event => event.type === 'conversation.item.create')).toHaveLength(0)
    await receipt(0, ends[0]!.frames, true); await receipt(0, ends[0]!.frames, true)
    expect(f.socket.sent.filter(event => event.type === 'conversation.item.create').map(event => event.item.content[0].text)).toEqual(['第一句。', '第二句。'])
    expect(f.activities.find(event => event.type === 'playback-client-reported')?.details).toMatchObject({ clientReported: true, playbackStatus: 'client-reported-full' })
  })
  it('bump-stops output immediately, ignores old receipts and rejects future epochs', async () => {
    const f = setup(); const call = await f.start(); f.wake(); await f.waitSpeech(); const segment = f.events.find(event => event.type === 'segment-end')!
    const stop = f.controller.control({ callId: call.callId, epoch: 0, action: 'stop-playback' }, call.capability)
    expect(f.controller.getState().epoch).toBe(1); expect(f.events.at(-2)?.type).toBe('output-stop'); await stop
    await f.controller.playback({ callId: call.callId, epoch: 0, segmentId: (segment as any).segmentId, playedFrames: 2, fullyPlayed: true }, call.capability)
    expect(f.socket.sent.filter(event => event.type === 'conversation.item.create')).toHaveLength(0)
    await expect(f.controller.control({ callId: call.callId, epoch: 2, action: 'heartbeat' }, call.capability)).rejects.toThrow('invalid_future_epoch')
    expect(f.handle.cancel).toHaveBeenCalledWith({ kind: 'user' }, { keepInbox: true })
  })
  it('preserves an actual queued audio commit even if a speech interruption changes epoch first', async () => {
    const f = setup(); await f.start(); f.wake('input_old'); f.socket.server({ type: 'input_audio_buffer.speech_started', item_id: 'input_new' })
    await vi.waitFor(() => expect(f.activities.some(event => event.type === 'audio-commit-cancelled')).toBe(true))
    expect(f.activities.find(event => event.type === 'audio-committed')).toMatchObject({ epoch: 0, details: { inputItemId: 'input_old' } })
    expect(f.accepted).toEqual([])
  })
  it('hangup drains already admitted source audit before closing the native writer', async () => {
    const gate = Promise.withResolvers<void>(); const f = setup({ record: async event => { if (event.type === 'audio-committed') await gate.promise } }); await f.start(); f.wake()
    await vi.waitFor(() => expect(f.activities.some(event => event.type === 'audio-committed')).toBe(true))
    const closing = f.controller.close(); await Promise.resolve(); expect(f.openedClose).not.toHaveBeenCalled()
    gate.resolve(); await closing; expect(f.openedClose).toHaveBeenCalledTimes(1)
    expect(f.activities.some(event => event.type === 'audio-commit-cancelled')).toBe(true)
    expect(f.activities.at(-1)).toMatchObject({ type: 'call-ended', details: { providerHangupConfirmed: true, agentRegistered: false } })
  })
  it('cuts large PCM into <=32KiB even chunks and keeps chunk indexes continuous', async () => {
    const f = setup({ synthesize: async function* () { yield { audio: new Uint8Array(100_000), sampleRate: 24000 } } }); await f.start(); f.wake(); await f.waitSpeech()
    const pcm = f.events.filter((event): event is Extract<VoiceEvent, { type: 'pcm' }> => event.type === 'pcm')
    expect(pcm.every(event => Buffer.from(event.audio, 'base64').length <= 32_768 && Buffer.from(event.audio, 'base64').length % 2 === 0)).toBe(true)
    expect(pcm.slice(0, 4).map(event => event.chunkIndex)).toEqual([0, 1, 2, 3])
  })
  it('rejects unsupported PCM rate instead of pretending the 24k player can handle it', async () => {
    const f = setup({ synthesize: async function* () { yield { audio: Uint8Array.of(1, 0), sampleRate: 16000 } } }); await f.start(); f.wake()
    await vi.waitFor(() => expect(f.controller.getState().connection).toBe('failed'))
    expect(f.events.some(event => event.type === 'pcm')).toBe(false); expect(f.fetchImpl).toHaveBeenCalledTimes(2)
  })
  it('backpressure or explicit event stream end causes real provider hangup', async () => {
    const f = setup(); const call = await f.controller.start(request()); f.controller.subscribeEvents(call.callId, call.capability, () => false)
    await vi.waitFor(() => expect(f.controller.getState().connection).toBe('failed'))
    expect(f.fetchImpl).toHaveBeenCalledTimes(2)
    const g = setup(); const result = await g.controller.start(request()); const subscription = g.controller.subscribeEvents(result.callId, result.capability, () => {})
    await subscription.end(); expect(g.controller.getState().connection).toBe('ended'); expect(g.fetchImpl).toHaveBeenCalledTimes(2)
  })
  it('emits SSE state heartbeat, renews lease explicitly, and ends after 20 seconds without it', async () => {
    vi.useFakeTimers(); const f = setup(); const call = await f.start(); const initial = f.events.length
    await vi.advanceTimersByTimeAsync(5000); expect(f.events.length).toBeGreaterThan(initial)
    await f.controller.control({ callId: call.callId, epoch: 0, action: 'heartbeat' }, call.capability)
    await vi.advanceTimersByTimeAsync(19_000); expect(f.controller.getState().connection).toBe('ready')
    await vi.advanceTimersByTimeAsync(1000); expect(f.controller.getState().connection).toBe('ended')
  })
  it('never reports successful hangup if the actual provider hangup failed', async () => {
    const f = setup({ hangupStatus: 503 }); await f.start(); await expect(f.controller.close()).rejects.toThrow('cleanup_failed')
    expect(f.controller.getState()).toMatchObject({ connection: 'failed', errorCode: 'cleanup_failed' })
    expect(f.activities.at(-1)?.details).toMatchObject({ providerCreated: true, providerHangupConfirmed: false, cleanupFailed: true })
    await expect(f.controller.start(request('new_after_unknown_cleanup'))).rejects.toThrow('call_busy')
  })
  it('cleans up a failed start and never replays its request id', async () => {
    const f = setup({ createStatus: 503 })
    await expect(f.controller.start(request())).rejects.toThrow('start_failed')
    expect(f.openedClose).toHaveBeenCalledTimes(1)
    await expect(f.controller.start(request())).rejects.toThrow('start_failed')
    expect(f.fetchImpl).toHaveBeenCalledTimes(1)
    expect(f.activities.at(-1)).toMatchObject({ type: 'call-ended', details: { providerCreated: false, providerHangupConfirmed: false, agentRegistered: false } })
  })
  it('aborting the owning start prevents cloud creation and leaves the attempt nonretryable', async () => {
    const gate = Promise.withResolvers<void>(); const f = setup({ record: async event => { if (event.type === 'call-start-requested') await gate.promise } })
    const controller = new AbortController(); const starting = f.controller.start(request(), controller.signal)
    controller.abort(); gate.resolve()
    await expect(starting).rejects.toThrow('start_aborted')
    expect(f.fetchImpl).not.toHaveBeenCalled(); expect(f.deps.openAgent).not.toHaveBeenCalled()
    await expect(f.controller.start(request())).rejects.toThrow('start_failed')
  })
  it('cancels only this call Breeze stream on barge-in, without claiming a complete segment', async () => {
    const f = setup({ synthesize: async function* (_settings, _text, options) {
      yield { audio: Uint8Array.of(1, 0), sampleRate: 24000 }
      await new Promise<never>((_resolve, reject) => { options?.signal?.addEventListener('abort', () => reject(new Error('fake cancelled')), { once: true }); if (options?.signal?.aborted) reject(new Error('fake cancelled')) })
    } }); const call = await f.start(); f.wake()
    await vi.waitFor(() => expect(f.events.some(event => event.type === 'pcm')).toBe(true))
    await f.controller.control({ callId: call.callId, epoch: 0, action: 'stop-playback' }, call.capability)
    await vi.waitFor(() => expect(f.errors.length).toBe(1))
    expect(f.events.some(event => event.type === 'segment-end')).toBe(false)
    expect(f.controller.getState()).toMatchObject({ connection: 'ready', epoch: 1, playback: 'stopped' })
    expect(f.activities.some(event => event.type === 'output-cancelled')).toBe(true)
  })
  it('enforces the ten-minute maximum even while the client renews its heartbeat lease', async () => {
    vi.useFakeTimers(); const f = setup(); const call = await f.start()
    for (let index = 0; index < 119; index++) {
      await vi.advanceTimersByTimeAsync(5000)
      await f.controller.control({ callId: call.callId, epoch: 0, action: 'heartbeat' }, call.capability)
    }
    await vi.advanceTimersByTimeAsync(5000)
    expect(f.controller.getState().connection).toBe('ended')
    expect(f.activities.at(-1)).toMatchObject({ type: 'call-ended', details: { reason: 'max_duration' } })
  })
})

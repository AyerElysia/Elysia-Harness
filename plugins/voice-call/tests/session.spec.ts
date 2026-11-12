import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import { createUserMessage, expandAssistantStream } from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createVoiceAgent, VOICE_SESSION_ID, type VoiceAgentConfig, type VoiceDriver, type VoiceDriverRequest } from '../src/session.ts'

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'voice-call-test-event': { kind: 'voice-call-test-event'; event: 'input_audio_buffer.committed' }
  }
}

const user = (text: string) => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
const control = () => createUserMessage({ content: [{ type: 'text', text: 'provider audio input committed; text unavailable' }], source: { kind: 'voice-call-test-event', event: 'input_audio_buffer.committed' } })

function completed(text = '真实模型原文，不改写。'): VoiceDriver {
  return { async *run() {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: text.slice(0, 3) }
    yield { type: 'text-delta', index: 0, text: text.slice(3) }
    yield { type: 'finish', reason: { kind: 'stop' } }
  } }
}

async function fixture(driver = completed()) {
  const dir = mkdtempSync(join(tmpdir(), 'elysia-voice-agent-gate-'))
  const ctx = new Context()
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  cleanups.push(() => ctx.fiber.dispose())
  writeFileSync(join(dir, 'SOUL.md'), 'fake-test-soul {{literal}}')
  writeFileSync(join(dir, 'USER.md'), 'MUST NOT LOAD USER')
  writeFileSync(join(dir, 'MEMORY.md'), 'MUST NOT LOAD MEMORY')
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SystemPrompt, { includeHarnessIdentity: true, personaPrefix: 'deployment must not enter voice' })
  ctx.systemPrompt.context({ name: 'fixture-required-context', order: 0, text: 'MUST NOT LOAD GLOBAL CONTEXT', required: true })
  ctx.systemPrompt.tools(() => ({ schemas: [{ name: 'must_not_be_usable', description: 'fixture', parameters: {} }] }))
  const records: SessionEvent[] = []
  const errors: unknown[] = []
  ctx.on('agent/error', ({ error }) => { errors.push(error) })
  let checkpoint = 0
  ctx.on('session/event', (_session, event) => { records.push(event) })
  // A deliberately temporary test sink. Production uses existing sessionPersistence.
  ctx.on('session/flush', (session) => {
    checkpoint = session.seq
    writeFileSync(join(dir, 'native-events.json'), JSON.stringify(records))
  })
  const config: VoiceAgentConfig = { cwd: dir, promptsDir: dir, driver }
  const runtime = Promise.withResolvers<Context>()
  await ctx.inject(['sessions', 'agents', 'systemPrompt'], injected => { runtime.resolve(injected) })
  return { ctx: await runtime.promise, dir, config, records, errors, checkpoint: () => checkpoint }
}

function assistantEvents(records: readonly SessionEvent[]) {
  return records.filter((event): event is Extract<SessionEvent, { type: 'assistant/message' }> => event.type === 'assistant/message')
}

describe('native Realtime voice Agent offline gate', () => {
  it('registers a real, uniquely owned independent Agent without replacing the global factory', async () => {
    const f = await fixture()
    const factory = {
      createAgent: vi.fn(async () => { throw new Error('existing-factory-still-selected') }),
      resume: vi.fn(async () => { throw new Error('existing-resume-still-selected') }),
    }
    await f.ctx.agents.setFactory(factory)
    const handle = await createVoiceAgent(f.ctx, f.config)
    cleanups.push(handle.dispose)
    expect(handle.agent.id).toBe(VOICE_SESSION_ID)
    expect(f.ctx.agents.get(VOICE_SESSION_ID)).toBe(handle.agent)
    expect(f.ctx.sessions.get(VOICE_SESSION_ID)).toBe(handle.agent.session)
    expect(handle.agent.session.header.cwd).toBe(f.dir)
    await expect(createVoiceAgent(f.ctx, f.config)).rejects.toThrow(/already has an owner/)
    await expect(f.ctx.agents.create({ sessionId: SessionId('unrelated-test-agent') })).rejects.toThrow('existing-factory-still-selected')
    expect(factory.createAgent).toHaveBeenCalledOnce()
    await handle.dispose()
    expect(f.ctx.agents.get(VOICE_SESSION_ID)).toBeUndefined()
    expect(f.ctx.sessions.get(VOICE_SESSION_ID)).toBeUndefined()
    expect(() => handle.agent.followup(user('after close'))).toThrow(/closed/)
  })

  it('records exact native source, boundaries and compacted raw output before the asynchronous output observer', async () => {
    const f = await fixture()
    const seen: string[] = []
    const handle = await createVoiceAgent(f.ctx, {
      ...f.config,
      onRecordedResponse: async ({ seq, message, stream }) => {
        expect(f.checkpoint()).toBeGreaterThan(seq)
        const disk: SessionEvent[] = JSON.parse(readFileSync(join(f.dir, 'native-events.json'), 'utf8'))
        const persisted = disk.find(event => event.seq === seq)
        expect(persisted?.type).toBe('assistant/message')
        expect([...expandAssistantStream(stream)].filter(item => item.chunk.type === 'text-delta')).toHaveLength(2)
        seen.push(JSON.stringify(message.content))
      },
    })
    cleanups.push(handle.dispose)
    const message = user('这是实际测试输入')
    handle.agent.followup(message)
    await handle.agent.whenIdle()
    expect(f.errors).toEqual([])
    expect(seen).toEqual([JSON.stringify([{ type: 'text', text: '真实模型原文，不改写。' }])])
    const input = f.records.find(event => event.type === 'user/message')
    expect(input?.data).toEqual(message)
    expect(f.records.map(event => event.type)).toEqual(expect.arrayContaining([
      'agent/inbox/spliced', 'turn/start', 'step/start', 'request/header', 'request/context',
      'system/message', 'assistant/message', 'step/end', 'turn/end',
    ]))
    expect(f.records.some(event => event.type.startsWith('plugin:'))).toBe(false)
    // Run the real Session runtime replay validator over the full captured native log.
    const replay = Session.create(handle.agent.id, f.records, handle.agent.session.header)
    expect(replay.firstLiveSeq).toBe(handle.agent.session.seq)
    expect(replay.surface.nodes.length).toBeGreaterThan(0)
  })

  it('loads only literal SOUL through standing-prompt assembly, reloads each response and keeps global/main assembly unchanged', async () => {
    const requests: VoiceDriverRequest[] = []
    const delegate = completed()
    const f = await fixture({ run(request) { requests.push(request); return delegate.run(request) } })
    const globalBefore = renderPrompt(await f.ctx.systemPrompt.assemble())
    const handle = await createVoiceAgent(f.ctx, f.config)
    cleanups.push(handle.dispose)
    handle.agent.followup(control())
    await handle.agent.whenIdle()
    writeFileSync(join(f.dir, 'SOUL.md'), 'fake-test-soul-v2 {{literal}}')
    handle.agent.followup(control())
    await handle.agent.whenIdle()
    expect(requests.map(request => request.instructions)).toEqual(['fake-test-soul {{literal}}', 'fake-test-soul-v2 {{literal}}'])
    expect(renderPrompt(await f.ctx.systemPrompt.assemble())).toBe(globalBefore)
    expect(globalBefore).toContain('deployment must not enter voice')
    expect(requests.every(request => !request.instructions.includes('MUST NOT LOAD'))).toBe(true)
  })

  it('owns durable inbox operations and whenIdle waits for maintenance plus later waking input', async () => {
    const f = await fixture()
    const handle = await createVoiceAgent(f.ctx, f.config)
    cleanups.push(handle.dispose)
    const first = user('first'), replacement = user('replacement'), second = user('second')
    handle.agent.inject(first)
    expect(handle.agent.inbox.replace(first.id, replacement)).toBe(true)
    expect(handle.agent.inbox.remove(first.id)).toBe(false)
    expect(handle.agent.inbox.nextStep).toEqual([replacement])
    handle.agent.inbox.prepend('next-turn', second)
    expect(handle.agent.inbox.remove(second.id)).toBe(true)
    const ready = Promise.withResolvers<void>()
    const maintenance = handle.agent.runMaintenance(async () => { await ready.promise; return 'done' })
    expect(handle.agent.status).toBe('idle')
    expect(() => handle.agent.runMaintenance(async () => undefined)).toThrow(/available/)
    handle.agent.followup(user('wake after maintenance'))
    let idle = false
    const waiting = handle.agent.whenIdle().then(() => { idle = true })
    await Promise.resolve()
    expect(idle).toBe(false)
    ready.resolve()
    expect(await maintenance).toBe('done')
    await waiting
    expect(assistantEvents(f.records)).toHaveLength(1)
    expect(handle.agent.inbox.nextTurn).toEqual([])
    expect(handle.agent.inbox.nextStep).toEqual([])
  })

  it('cancels the active provider, preserves actual delivered partial text as interrupted and discards pending input', async () => {
    const started = Promise.withResolvers<void>()
    const f = await fixture({ async *run({ signal }) {
      yield { type: 'text-delta', index: 0, text: '已流出的真实前缀' }
      started.resolve()
      await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
      signal.throwIfAborted()
    } })
    const handle = await createVoiceAgent(f.ctx, f.config)
    cleanups.push(handle.dispose)
    handle.agent.followup(user('start'))
    await started.promise
    handle.agent.followup(user('queued'))
    handle.agent.cancel({ kind: 'user' })
    await handle.agent.whenIdle()
    const outputs = assistantEvents(f.records)
    expect(outputs).toHaveLength(1)
    expect(outputs[0]?.data.interrupted).toBe(true)
    expect(outputs[0]?.data.message.content).toEqual([{ type: 'text', text: '已流出的真实前缀' }])
    expect(handle.agent.inbox.nextTurn).toEqual([])
    const ending = f.records.find(event => event.type === 'turn/end')
    expect(ending?.data).toEqual({ turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } })
    expect(() => Session.create(handle.agent.id, f.records, handle.agent.session.header)).not.toThrow()
  })

  it('close and owner unload drain and unregister an active response, and close is idempotent', async () => {
    const started = Promise.withResolvers<void>()
    const f = await fixture({ async *run({ signal }) {
      started.resolve()
      await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
      signal.throwIfAborted()
    } })
    const handle = await createVoiceAgent(f.ctx, f.config)
    handle.agent.followup(user('close active'))
    await started.promise
    const closing = handle.dispose()
    expect(handle.agent.close()).toBe(closing)
    await closing
    expect(handle.agent.status).toBe('idle')
    expect(f.ctx.agents.get(VOICE_SESSION_ID)).toBeUndefined()
    const second = await createVoiceAgent(f.ctx, { ...f.config, driver: completed() })
    // Ownership belongs to the plugin context even if the handle is forgotten.
    await f.ctx.fiber.dispose()
    expect(second.agent.status).toBe('idle')
    expect(() => second.agent.followup(user('closed by owner'))).toThrow(/closed/)
  })

  it('fails closed when SOUL disappears and never starts a provider request', async () => {
    const run = vi.fn(completed().run)
    const f = await fixture({ run })
    const handle = await createVoiceAgent(f.ctx, f.config)
    cleanups.push(handle.dispose)
    rmSync(join(f.dir, 'SOUL.md'))
    handle.agent.followup(user('should not dispatch'))
    await handle.agent.whenIdle()
    expect(run).not.toHaveBeenCalled()
    expect(assistantEvents(f.records)).toHaveLength(0)
    expect(f.records.find(event => event.type === 'turn/end')?.data).toMatchObject({ reason: { kind: 'error' } })
  })

  it('keeps output private if persistence rejects it and refuses future provider work', async () => {
    const f = await fixture()
    const observed = vi.fn()
    const handle = await createVoiceAgent(f.ctx, { ...f.config, onRecordedResponse: observed })
    let failed = false
    const remove = f.ctx.on('session/flush', () => {
      if (assistantEvents(f.records).length) { failed = true; throw new Error('fixture disk rejected') }
    })
    handle.agent.followup(user('persist before speech'))
    await handle.agent.whenIdle()
    expect(failed).toBe(true)
    expect(observed).not.toHaveBeenCalled()
    expect(() => handle.agent.followup(user('must not dispatch'))).toThrow(/persistence/)
    remove()
    await handle.dispose()
  })

  it('refuses unqualified restored history and resumes only with explicit projection-derived state', async () => {
    const f = await fixture()
    const original = await createVoiceAgent(f.ctx, f.config)
    original.agent.followup(user('prior'))
    await original.agent.whenIdle()
    const events = [...f.records]
    const header = original.agent.session.header
    await original.dispose()
    const session = Session.create(VOICE_SESSION_ID, events, header)
    await expect(createVoiceAgent(f.ctx, { ...f.config, session })).rejects.toThrow(/projection-derived cursor/)
    const resumed = await createVoiceAgent(f.ctx, { ...f.config, session, restore: { lastTurn: 1 } })
    cleanups.push(resumed.dispose)
    resumed.agent.followup(user('new turn'))
    await resumed.agent.whenIdle()
    expect(f.records.filter(event => event.type === 'turn/start').map(event => event.data)).toEqual([{ turn: 1 }, { turn: 2 }])
  })

  it('does not notify the recorded-output observer about canceled partial output', async () => {
    const started = Promise.withResolvers<void>()
    const observed = vi.fn()
    const f = await fixture({ async *run({ signal }) {
      yield { type: 'text-delta', index: 0, text: 'partial only' }
      started.resolve()
      await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
      signal.throwIfAborted()
    } })
    const handle = await createVoiceAgent(f.ctx, { ...f.config, onRecordedResponse: observed })
    cleanups.push(handle.dispose)
    handle.agent.followup(user('cancel output'))
    await started.promise
    handle.agent.cancel({ kind: 'user' })
    await handle.agent.whenIdle()
    expect(assistantEvents(f.records)[0]?.data.interrupted).toBe(true)
    expect(observed).not.toHaveBeenCalled()
  })
})

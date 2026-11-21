import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import * as Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { afterEach, describe, expect, it } from 'vitest'
import { createVoiceAgent, VOICE_SESSION_ID, type VoiceDriver } from '../src/session.ts'
import { prepareVoiceSession } from '../src/persistence.ts'
import { acceptVoiceAudioCommit } from '../src/input.ts'

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
const driver: VoiceDriver = { async *run() {
  yield { type: 'text-delta', index: 0, text: 'native JSONL voice output' }
  yield { type: 'finish', reason: { kind: 'stop' } }
} }
const user = (text: string) => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'elysia-voice-jsonl-gate-'))
  const root = new Context()
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  cleanups.push(() => root.fiber.dispose())
  writeFileSync(join(dir, 'SOUL.md'), 'fake fixture SOUL only')
  await root.plugin(SessionStore)
  await root.plugin(AgentRegistry)
  await root.plugin(SystemPrompt, { includeHarnessIdentity: false })
  await root.plugin(Jsonl, { root: join(dir, 'native-jsonl'), compression: 'none' })
  const runtime = Promise.withResolvers<Context>()
  await root.inject(['sessions', 'agents', 'systemPrompt', 'sessionPersistence'], ctx => { runtime.resolve(ctx) })
  return { ctx: await runtime.promise, dir }
}

describe('voice existing native JSONL writer integration, temporary directories only', () => {
  it('cold-reads the exact no-transcript, empty-content infrastructure input notice from native JSONL', async () => {
    const f = await fixture()
    const prepared = await prepareVoiceSession(f.ctx, { cwd: f.dir })
    const voice = await createVoiceAgent(f.ctx, { cwd: f.dir, promptsDir: f.dir, driver, ...prepared })
    await acceptVoiceAudioCommit(voice.agent, { type: 'audio_committed', itemId: 'item_fixture' }, 'call_fixture', 0)
    await voice.agent.whenIdle()
    const input = (await prepared.handle.read()).events.find(event => event.type === 'user/message')
    expect(input?.data).toMatchObject({ content: [], source: { kind: 'elysia-voice-input-event',
      actor: 'infrastructure', form: 'notice', rawAudioStored: false, transcript: 'unavailable', replayable: false,
      callId: 'call_fixture', itemId: 'item_fixture', occurrenceId: 'call_fixture:0:item_fixture' } })
    await voice.dispose()
    await prepared.handle.close()
  })

  it('holds a single write owner and persists exact native events without a second append hook', async () => {
    const f = await fixture()
    const prepared = await prepareVoiceSession(f.ctx, { cwd: f.dir })
    expect(prepared.source).toBe('created')
    await expect(prepareVoiceSession(f.ctx, { cwd: f.dir })).rejects.toThrow()
    const agent = await createVoiceAgent(f.ctx, {
      cwd: f.dir, promptsDir: f.dir, driver, session: prepared.session, restore: prepared.restore,
      onRecordedResponse: async ({ seq, message }) => {
        const persisted = await prepared.handle.read()
        const event = persisted.events.find(event => event.seq === seq)
        expect(event?.type).toBe('assistant/message')
        expect(event?.data).toMatchObject({ message })
      },
    })
    agent.agent.followup(user('native persisted input'))
    await agent.agent.whenIdle()
    const read = await prepared.handle.read()
    expect(read.events.map(event => event.seq)).toEqual(read.events.map((_, index) => index))
    expect(read.events.filter(event => event.type === 'assistant/message')).toHaveLength(1)
    expect(read.events.filter(event => event.type === 'user/message')).toHaveLength(1)
    expect(read.events).toHaveLength(agent.agent.session.seq)
    await agent.dispose()
    await prepared.handle.close()
    const reopened = await f.ctx.sessionPersistence.open(VOICE_SESSION_ID, 'read')
    expect((await reopened.read()).events).toEqual(read.events)
    await reopened.close()
  })

  it('restores only the chosen voice Session with exact next turn and a durably stored resume marker', async () => {
    const f = await fixture()
    const first = await prepareVoiceSession(f.ctx, { cwd: f.dir })
    const handle = await createVoiceAgent(f.ctx, { cwd: f.dir, promptsDir: f.dir, driver, ...first })
    handle.agent.followup(user('first lifecycle'))
    await handle.agent.whenIdle()
    await handle.dispose()
    await first.handle.close()
    const restored = await prepareVoiceSession(f.ctx, { cwd: f.dir })
    expect(restored.source).toBe('restored')
    expect(restored.restore.lastTurn).toBe(1)
    expect((await restored.handle.read()).events.length).toBe(restored.session.seq)
    const second = await createVoiceAgent(f.ctx, { cwd: f.dir, promptsDir: f.dir, driver, ...restored })
    second.agent.followup(user('second lifecycle'))
    await second.agent.whenIdle()
    const read = await restored.handle.read()
    expect(read.events.filter(event => event.type === 'turn/start').map(event => event.data)).toEqual([{ turn: 1 }, { turn: 2 }])
    expect(read.events.filter(event => event.type === 'session/end-seed')).toHaveLength(1)
    expect(read.events.map(event => event.seq)).toEqual(read.events.map((_, index) => index))
    await second.dispose()
    await restored.handle.close()
    expect(f.ctx.sessions.get(SessionId('elysia-main'))).toBeUndefined()
  })

  it('repairs an orphaned native turn and restores pending queues from its public cold-read events', async () => {
    const f = await fixture()
    const first = await prepareVoiceSession(f.ctx, { cwd: f.dir })
    const pending = user('parked input without replayable audio')
    await first.handle.append([
      { type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } },
      { type: 'step/start', seq: SessionSeq(1), time: 2, data: { turn: 1, step: 1 } },
      { type: 'agent/inbox/spliced', seq: SessionSeq(2), time: 3, data: { target: 'next-turn', start: 0, inserted: [pending] } },
    ])
    await first.handle.close()
    const restored = await prepareVoiceSession(f.ctx, { cwd: f.dir })
    expect(restored.restore).toMatchObject({ lastTurn: 1, nextTurn: [pending], nextStep: [] })
    const read = await restored.handle.read()
    expect(read.events.filter(event => event.type === 'turn/end').map(event => event.data)).toEqual([{ turn: 1, reason: { kind: 'interrupted' } }])
    expect(restored.session.seq).toBe(read.events.length)
    await restored.handle.close()
  })
})

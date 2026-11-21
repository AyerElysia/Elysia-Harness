import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import * as Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import { SessionId } from '@deepseek-ai/dsh-session'
import { SessionPersistenceNotFoundError } from '@deepseek-ai/dsh-session-persistence'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createVoiceAgent, VoiceAgent, VOICE_SESSION_ID } from '../src/session.ts'
import { prepareVoiceSession } from '../src/persistence.ts'
import { mountVoiceOwnership, VOICE_OWNERSHIP_REJECTED } from '../src/ownership.ts'

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'elysia-voice-ownership-gate-'))
  const root = new Context()
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }))
  cleanups.push(() => root.fiber.dispose())
  writeFileSync(join(directory, 'SOUL.md'), 'isolated ownership test SOUL')
  await mountAgentLoopTestDependencies(root, { systemPrompt: { includeHarnessIdentity: false } })
  await root.plugin(Jsonl, { root: join(directory, 'native-jsonl'), compression: 'none' })
  await mountAgentLoopTestHarness(root)
  const ready = Promise.withResolvers<Context>()
  await root.inject(['agents', 'sessions', 'systemPrompt', 'tools', 'sessionPersistence'], owner => { ready.resolve(owner) })
  const owner = await ready.promise
  const setFactory = vi.spyOn(root.agents, 'setFactory')
  let modelRequests = 0
  root.on('llm/stream', (_options, next) => { modelRequests++; return next() })
  return { root, owner, directory, setFactory, modelRequests: () => modelRequests }
}

async function assertWriterReleased(root: Context, directory: string) {
  const header = root.sessions.prepare(VOICE_SESSION_ID, { meta: { cwd: directory } }).header
  const handle = await root.sessionPersistence.open(VOICE_SESSION_ID, 'write').catch(async error => {
    if (!(error instanceof SessionPersistenceNotFoundError)) throw error
    return root.sessionPersistence.create(header)
  })
  await handle.close()
}

describe('voice-only identity reservation at native Agent publication', () => {
  it('rejects real generic factory create and rolls back registry, Session and write ownership', async () => {
    const f = await fixture()
    mountVoiceOwnership(f.owner)
    await expect(f.root.agents.create({ sessionId: VOICE_SESSION_ID, meta: { cwd: f.directory } })).rejects.toThrow(VOICE_OWNERSHIP_REJECTED)
    expect(f.root.agents.get(VOICE_SESSION_ID)).toBeUndefined()
    expect(f.root.sessions.get(VOICE_SESSION_ID)).toBeUndefined()
    await assertWriterReleased(f.root, f.directory)
    expect(f.setFactory).not.toHaveBeenCalled()
    expect(f.modelRequests()).toBe(0)
  })

  it('rejects real generic persisted resume with native rollback and a released write claim', async () => {
    const f = await fixture()
    const session = f.root.sessions.prepare(VOICE_SESSION_ID, { meta: { cwd: f.directory } })
    const writer = await f.root.sessionPersistence.create(session.header)
    await writer.flush()
    await writer.close()
    mountVoiceOwnership(f.owner)
    await expect(f.root.agents.resume({ resumeSessionId: VOICE_SESSION_ID })).rejects.toThrow(VOICE_OWNERSHIP_REJECTED)
    expect(f.root.agents.get(VOICE_SESSION_ID)).toBeUndefined()
    expect(f.root.sessions.get(VOICE_SESSION_ID)).toBeUndefined()
    await assertWriterReleased(f.root, f.directory)
    expect(f.setFactory).not.toHaveBeenCalled()
    expect(f.modelRequests()).toBe(0)
  })

  it('allows the genuine plugin-owned VoiceAgent and permits unrelated ordinary Agent identities', async () => {
    const f = await fixture()
    mountVoiceOwnership(f.owner)
    const prepared = await prepareVoiceSession(f.owner, { cwd: f.directory })
    const voice = await createVoiceAgent(f.owner, { cwd: f.directory, promptsDir: f.directory,
      session: prepared.session, restore: prepared.restore,
      driver: { async *run() { yield { type: 'finish', reason: { kind: 'stop' } } } } })
    expect(f.root.agents.get(VOICE_SESSION_ID)).toBe(voice.agent)
    expect(voice.agent).toBeInstanceOf(VoiceAgent)
    const ordinaryId = SessionId('ordinary-unrelated-session')
    const ordinary = await f.root.agents.create({ sessionId: ordinaryId, meta: { cwd: f.directory } })
    expect(f.root.agents.get(ordinaryId)).toBe(ordinary.agent)
    expect(ordinary.agent).not.toBeInstanceOf(VoiceAgent)
    await ordinary.dispose()
    await voice.dispose()
    await prepared.handle.close()
    expect(f.setFactory).not.toHaveBeenCalled()
    expect(f.modelRequests()).toBe(0)
  })

  it('removes the hook on disposer and on plugin owner unload without touching the native factory', async () => {
    const f = await fixture()
    const remove = mountVoiceOwnership(f.owner)
    remove()
    const first = await f.root.agents.create({ sessionId: VOICE_SESSION_ID, meta: { cwd: f.directory } })
    await f.root.sessions.flush(first.agent.session)
    await first.dispose()
    mountVoiceOwnership(f.owner)
    await f.owner.fiber.dispose()
    const afterUnload = await f.root.agents.resume({ resumeSessionId: VOICE_SESSION_ID })
    expect(f.root.agents.get(VOICE_SESSION_ID)).toBe(afterUnload.agent)
    await afterUnload.dispose()
    expect(f.setFactory).not.toHaveBeenCalled()
    expect(f.modelRequests()).toBe(0)
  })

  it('does not treat a genuine VoiceAgent from another plugin owner as this plugin capability', async () => {
    const f = await fixture()
    mountVoiceOwnership(f.owner)
    const ready = Promise.withResolvers<Context>()
    await f.root.inject(['agents', 'sessions', 'systemPrompt', 'tools', 'sessionPersistence'], other => { ready.resolve(other) })
    const other = await ready.promise
    const prepared = await prepareVoiceSession(other, { cwd: f.directory })
    await expect(createVoiceAgent(other, { cwd: f.directory, promptsDir: f.directory,
      session: prepared.session, restore: prepared.restore,
      driver: { async *run() { yield { type: 'finish', reason: { kind: 'stop' } } } } })).rejects.toThrow(VOICE_OWNERSHIP_REJECTED)
    expect(f.root.agents.get(VOICE_SESSION_ID)).toBeUndefined()
    expect(f.root.sessions.get(VOICE_SESSION_ID)).toBeUndefined()
    await prepared.handle.close()
    expect(f.modelRequests()).toBe(0)
  })
})

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionStore, { type SessionEvent } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createVoiceAgent, type VoiceDriver } from '../src/session.ts'
import { acceptVoiceAudioCommit } from '../src/input.ts'

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
async function fixture(driver: VoiceDriver) {
  const dir = mkdtempSync(join(tmpdir(), 'elysia-voice-input-gate-'))
  const root = new Context()
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  cleanups.push(() => root.fiber.dispose())
  writeFileSync(join(dir, 'SOUL.md'), 'fake input fixture SOUL')
  await root.plugin(SessionStore)
  await root.plugin(AgentRegistry)
  await root.plugin(SystemPrompt, { includeHarnessIdentity: false })
  const ready = Promise.withResolvers<Context>()
  await root.inject(['sessions', 'agents', 'systemPrompt'], ctx => { ready.resolve(ctx) })
  const ctx = await ready.promise
  const events: SessionEvent[] = []
  root.on('session/event', (_session, event) => { events.push(event) })
  const handle = await createVoiceAgent(ctx, { cwd: dir, promptsDir: dir, driver })
  return { ctx, root, events, handle }
}

describe('truthful no-raw-audio native input admission', () => {
  it('records one empty-content infrastructure notice, checkpoints before wake, and deduplicates provider commits', async () => {
    const run = vi.fn(async function* () { yield { type: 'finish' as const, reason: { kind: 'stop' as const } } })
    const f = await fixture({ run })
    const gate = Promise.withResolvers<void>()
    f.root.on('session/flush', async () => { await gate.promise })
    const commit = { type: 'audio_committed' as const, itemId: 'item_1' }
    const accepting = acceptVoiceAudioCommit(f.handle.agent, commit, 'call_1', 0)
    await Promise.resolve()
    expect(run).not.toHaveBeenCalled()
    expect(f.handle.agent.status).toBe('idle')
    const pending = f.handle.agent.inbox.nextTurn[0]
    expect(pending?.content).toEqual([])
    expect(pending?.source).toMatchObject({ kind: 'elysia-voice-input-event', actor: 'infrastructure',
      form: 'notice', occurrenceId: 'call_1:0:item_1', rawAudioStored: false, transcript: 'unavailable', replayable: false })
    gate.resolve()
    await Promise.all([accepting, acceptVoiceAudioCommit(f.handle.agent, commit, 'call_1', 0)])
    await f.handle.agent.whenIdle()
    expect(run).toHaveBeenCalledOnce()
    expect(f.events.filter(event => event.type === 'user/message')).toHaveLength(1)
    await f.handle.dispose()
  })

  it('never wakes the provider when the admission checkpoint fails and rejects conflicting occurrence metadata', async () => {
    const run = vi.fn(async function* () { yield { type: 'finish' as const, reason: { kind: 'stop' as const } } })
    const f = await fixture({ run })
    const remove = f.root.on('session/flush', () => { throw new Error('fixture persistence failed') })
    await expect(acceptVoiceAudioCommit(f.handle.agent, { type: 'audio_committed', itemId: 'item_1' }, 'call_1', 0)).rejects.toThrow(/persistence failed/)
    expect(run).not.toHaveBeenCalled()
    await expect(acceptVoiceAudioCommit(f.handle.agent, { type: 'audio_committed', itemId: 'item_1', previousItemId: 'item_0' }, 'call_1', 0)).rejects.toThrow(/Conflicting/)
    remove()
    f.root.on('session/flush', () => {})
    await f.handle.dispose()
  })
})

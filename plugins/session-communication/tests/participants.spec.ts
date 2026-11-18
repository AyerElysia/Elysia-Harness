import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { describe, expect, it, vi } from 'vitest'
import { defaultParticipants, ParticipantSessions } from '../src/participants.ts'

function participant(alias: string) {
  const selected = defaultParticipants.find(item => item.alias === alias)
  if (selected === undefined) throw new Error('Unknown participant fixture')
  return selected
}

function fixture() {
  const get = vi.fn()
  const resolveAgent = vi.fn()
  const ensureExisting = vi.fn()
  const ctx = {
    agents: { get },
    sessionController: { resolveAgent },
    reflect: { get: vi.fn(() => ({ session: { ensureExisting } })) },
  } as unknown as Context
  return { manager: new ParticipantSessions(ctx), get, resolveAgent, ensureExisting }
}

describe('participant lifecycle owners', () => {
  it('waits for the conscious owner instead of generically adopting its identity', async () => {
    const test = fixture()
    await expect(test.manager.ensure(participant('main'))).rejects.toMatchObject({ code: 'RESTORE_FAILED', retryable: true })
    expect(test.resolveAgent).not.toHaveBeenCalled()
    const live = { id: 'elysia-conscious-mind' } as Agent
    test.get.mockReturnValue(live)
    await expect(test.manager.ensure(participant('main'))).resolves.toBe(live)
  })

  it('uses the Router owner even when the agent registry already contains that id', async () => {
    const test = fixture()
    const owned = { id: 'elysia-subconscious-router' } as Agent
    test.ensureExisting.mockResolvedValue(owned)
    await expect(test.manager.ensure(participant('router'))).resolves.toBe(owned)
    expect(test.ensureExisting).toHaveBeenCalledOnce()
    expect(test.resolveAgent).not.toHaveBeenCalled()
  })

  it('resumes a cold memory session through its native saved preset and never creates absent sessions', async () => {
    const test = fixture()
    const memory = { id: 'elysia-subconscious-memory' } as Agent
    test.resolveAgent.mockResolvedValue({ agent: memory })
    await expect(test.manager.ensure(participant('memory'))).resolves.toBe(memory)
    expect(test.resolveAgent).toHaveBeenCalledWith('elysia-subconscious-memory')
    test.resolveAgent.mockResolvedValue({ error: { code: 'session/not-found', message: 'missing fixture' } })
    await expect(test.manager.ensure(participant('memory'))).rejects.toMatchObject({ code: 'TARGET_NOT_FOUND', retryable: false })
    await test.manager.dispose()
    await expect(test.manager.ensure(participant('memory'))).rejects.toMatchObject({ code: 'RESTORE_FAILED', retryable: false })
  })
})

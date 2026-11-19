import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { describe, expect, it, vi } from 'vitest'
import { defaultParticipants, ParticipantSessions } from '../src/participants.ts'

// The owner contract (session/memory ensureAgent, store.resting) is guarded by the
// subconscious integration tests; this mock must keep those exact signatures.
function participant(alias: string) {
  const selected = defaultParticipants.find(item => item.alias === alias)
  if (selected === undefined) throw new Error('Unknown participant fixture')
  return selected
}

function fixture(options: { owner?: boolean } = {}) {
  const get = vi.fn()
  const resolveAgent = vi.fn()
  const ensureRouter = vi.fn()
  const ensureMemory = vi.fn()
  const resting = vi.fn(() => false)
  const owner = {
    session: { ensureAgent: ensureRouter },
    memory: { ensureAgent: ensureMemory },
    store: { resting },
  }
  const ctx = {
    agents: { get },
    sessionController: { resolveAgent },
    reflect: { get: vi.fn(() => options.owner === false ? undefined : owner) },
  } as unknown as Context
  return { manager: new ParticipantSessions(ctx), get, resolveAgent, ensureRouter, ensureMemory, resting }
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

  it('delivers the Router target through its owner even when the agent registry already holds that id', async () => {
    const test = fixture()
    const owned = { id: 'elysia-subconscious-router' } as Agent
    test.ensureRouter.mockResolvedValue(owned)
    await expect(test.manager.ensure(participant('router'))).resolves.toBe(owned)
    expect(test.ensureRouter).toHaveBeenCalledOnce()
    expect(test.get).not.toHaveBeenCalled()
    expect(test.resolveAgent).not.toHaveBeenCalled()
  })

  it('keeps a resting Router message retryable instead of delivering it', async () => {
    const test = fixture()
    test.resting.mockReturnValue(true)
    await expect(test.manager.ensure(participant('router'))).rejects.toMatchObject({ code: 'TARGET_RESTING', retryable: true })
    expect(test.ensureRouter).not.toHaveBeenCalled()
  })

  it('restores the memory target through its owner and never through generic api resume', async () => {
    const test = fixture()
    const memory = { id: 'elysia-subconscious-memory' } as Agent
    test.ensureMemory.mockResolvedValue(memory)
    await expect(test.manager.ensure(participant('memory'))).resolves.toBe(memory)
    expect(test.ensureMemory).toHaveBeenCalledOnce()
    expect(test.get).not.toHaveBeenCalled()
    expect(test.resolveAgent).not.toHaveBeenCalled()
  })

  it('reports RESTORE_FAILED while the subconscious owner has not mounted', async () => {
    const test = fixture({ owner: false })
    for (const alias of ['router', 'memory']) {
      await expect(test.manager.ensure(participant(alias))).rejects.toMatchObject({ code: 'RESTORE_FAILED', retryable: true })
    }
    expect(test.ensureRouter).not.toHaveBeenCalled()
    expect(test.ensureMemory).not.toHaveBeenCalled()
    expect(test.resolveAgent).not.toHaveBeenCalled()
  })

  it('reports a non-retryable RESTORE_FAILED once the plugin has been disposed', async () => {
    const test = fixture()
    await test.manager.dispose()
    for (const alias of ['main', 'router', 'memory']) {
      await expect(test.manager.ensure(participant(alias))).rejects.toMatchObject({ code: 'RESTORE_FAILED', retryable: false })
    }
    expect(test.get).not.toHaveBeenCalled()
    expect(test.ensureRouter).not.toHaveBeenCalled()
    expect(test.ensureMemory).not.toHaveBeenCalled()
  })
})

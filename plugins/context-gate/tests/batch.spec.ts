/**
 * Behavior of the wake scheduler: active events are coalesced in a quiet
 * window, capped by `maxWaitMs`, never open a second turn for a busy Agent,
 * and leave no timer behind when the plugin unloads.
 *
 * The direct bus mount owns the real pre-step waterfall and real state writes;
 * only the Agent is structural, so its follow-up sink is observable.
 */
import { describe, expect, it, onTestFinished } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { agentEvents, type Agent } from '@deepseek-ai/dsh-agent'
import { Context } from '@deepseek-ai/cordis'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import { ContextBus } from '../src/context-bus.ts'
import { ContextGateStore } from '../src/state.ts'
import { firePreStep, newSession, sleep, testAgent, textOf } from './helpers.ts'

interface BusEnv {
  readonly ctx: Context
  readonly store: ContextGateStore
  readonly bus: ContextBus
  readonly agent: Agent
  readonly session: Session
  readonly status: { value: 'idle' | 'running' }
  readonly followups: UserMessage[]
}

async function setupBus(options: { batchMs?: number; maxWaitMs?: number } = {}): Promise<BusEnv> {
  const stateDir = await mkdtemp(join(tmpdir(), 'context-gate-batch-'))
  const store = await ContextGateStore.open(stateDir)
  const ctx = new Context()
  const session = newSession()
  const followups: UserMessage[] = []
  const { agent, status } = testAgent(session, (message) => { followups.push(message) })
  const bus = new ContextBus({
    ctx,
    store,
    agentOf: () => agent,
    candidates: () => [session.id],
    defaults: { ttlMs: 15 * 60_000, maxBytes: 65_536, maxQueueDepth: 64 },
    maxEventsPerSnapshot: 16,
    maxSnapshotBytes: 8_192,
    batchMs: options.batchMs ?? 40,
    maxWaitMs: options.maxWaitMs ?? 400,
  })
  await store.setContext(session.id, 'demo.ping', true)
  bus.registerKind({
    kind: 'demo.ping',
    nameZh: '示例事件',
    description: 'A test event.',
    activeByDefault: false,
  })
  bus.attach()
  onTestFinished(async () => {
    await ctx.fiber.dispose()
    await rm(stateDir, { recursive: true, force: true })
  })
  return { ctx, store, bus, agent, session, status, followups }
}

function active(summary: string): {
  kind: string
  source: string
  summary: string
  payload: null
  active: true
} {
  return { kind: 'demo.ping', source: 'test', summary, payload: null, active: true }
}

/** Poll until the wake sink has the expected count, or the budget expires. */
async function waitForWake(followups: readonly UserMessage[], expected: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (followups.length < expected && Date.now() < deadline) await sleep(10)
  return followups.length === expected
}

describe('active wake batching', () => {
  it('coalesces active events into one wake and one merged snapshot', async () => {
    const env = await setupBus()
    await env.bus.publish(active('first'))
    await env.bus.publish(active('second'))
    expect(env.followups).toHaveLength(0)
    await sleep(10)
    expect(env.followups).toHaveLength(0)
    await sleep(90)
    expect(env.followups).toHaveLength(1)

    const { injected } = await firePreStep(env.ctx, env.agent)
    expect(injected).toHaveLength(1)
    const text = textOf(injected[0] as NonNullable<typeof injected[0]>)
    expect(text).toContain('first')
    expect(text).toContain('second')
    expect(env.followups).toHaveLength(1)
  })

  it('extends the quiet window on a later event', async () => {
    const env = await setupBus({ batchMs: 120, maxWaitMs: 1_000 })
    await env.bus.publish(active('first'))
    await sleep(60)
    await env.bus.publish(active('second'))
    await sleep(80)
    expect(env.followups).toHaveLength(0)
    expect(await waitForWake(env.followups, 1, 200)).toBe(true)
  })

  it('caps total postponement at maxWaitMs', async () => {
    const env = await setupBus({ batchMs: 1_000, maxWaitMs: 200 })
    await env.bus.publish(active('first'))
    await sleep(80)
    await env.bus.publish(active('second'))
    expect(await waitForWake(env.followups, 1, 300)).toBe(true)
  })

  it('never opens a second turn for a busy Agent, and drains at the next pre-step', async () => {
    const env = await setupBus()
    env.status.value = 'running'
    await env.bus.publish(active('while busy'))
    await sleep(120)
    expect(env.followups).toHaveLength(0)

    const { injected } = await firePreStep(env.ctx, env.agent)
    expect(injected).toHaveLength(1)
    expect(textOf(injected[0] as NonNullable<typeof injected[0]>)).toContain('while busy')
    expect(env.followups).toHaveLength(0)
  })

  it('re-arms the batch when a busy Agent becomes idle', async () => {
    const env = await setupBus()
    env.status.value = 'running'
    await env.bus.publish(active('deferred'))
    await sleep(100)
    expect(env.followups).toHaveLength(0)

    env.status.value = 'idle'
    agentEvents(env.ctx, env.agent).emit('agent/status', { status: 'idle' })
    await sleep(100)
    expect(env.followups).toHaveLength(1)
  })

  it('never wakes for a passive event but still injects at the next step', async () => {
    const env = await setupBus()
    await env.bus.publish({ kind: 'demo.ping', source: 'test', summary: 'quiet', payload: null })
    await sleep(100)
    expect(env.followups).toHaveLength(0)

    const { injected } = await firePreStep(env.ctx, env.agent)
    expect(injected).toHaveLength(1)
    expect(textOf(injected[0] as NonNullable<typeof injected[0]>)).toContain('quiet')
  })

  it('serializes concurrent publications without losing one', async () => {
    const env = await setupBus()
    await Promise.all([env.bus.publish(active('one')), env.bus.publish(active('two'))])
    expect(env.store.queue(env.session.id).events).toHaveLength(2)
  })

  it('clears the quiet-window timer when the plugin unloads', async () => {
    const env = await setupBus({ batchMs: 60, maxWaitMs: 400 })
    await env.bus.publish(active('never wakes'))
    await env.ctx.fiber.dispose()
    await sleep(120)
    expect(env.followups).toHaveLength(0)
  })
})
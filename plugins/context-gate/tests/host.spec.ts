/**
 * Behavior of the context-gate Host: provider registration, subscriptions,
 * publication, queue/TTL/dedupe/visibility, the merged pre-step snapshot,
 * persistence, and the absence of orchestration or health surfaces.
 *
 * The AgentLoop testkit mounts the real Agent and pre-step waterfall. No
 * VillV-Helix row is mounted, so every assertion is about a standalone gate.
 */
import { describe, expect, it, onTestFinished } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  mountAgentLoopTestDependencies, mountAgentLoopTestHarness,
} from '@deepseek-ai/dsh-agent-loop-testkit'
import * as gate from '../src/index.ts'
import { DOCUMENT_FILE_NAME } from '../src/state.ts'
import { firePreStep, sleep, textOf } from './helpers.ts'

interface Env {
  readonly ctx: Context
  readonly stateDir: string
  readonly agent: Agent
  readonly harness: Awaited<ReturnType<typeof mountAgentLoopTestHarness>>
  readonly fiber: { dispose(): Promise<void> }
}

async function setup(options: { stateDir?: string } = {}): Promise<Env> {
  const stateDir = options.stateDir ?? await mkdtemp(join(tmpdir(), 'context-gate-'))
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx, { systemPrompt: { personaPrefix: '', personaSuffix: '' } })
  const harness = await mountAgentLoopTestHarness(ctx)
  const fiber = await ctx.plugin(gate, { stateDir, batchMs: 30, maxWaitMs: 150 })
  const agent = await harness.create(SessionId('s1'), { provider: 'mock', model: 'mock' })
  onTestFinished(async () => {
    await ctx.fiber.dispose()
    await rm(stateDir, { recursive: true, force: true })
  })
  return { ctx, stateDir, agent, harness, fiber }
}

function registerPing(env: Env, overrides: Partial<gate.ContextKindRegistration> = {}): () => void {
  return env.ctx.contextGate.registerContextKind({
    kind: 'demo.ping',
    nameZh: '示例事件',
    description: 'A test event.',
    activeByDefault: false,
    ...overrides,
  })
}

describe('context snapshot', () => {
  it('lists a registered kind with the session subscription, backlog, and log', async () => {
    const env = await setup()
    const disposeKind = registerPing(env)
    onTestFinished(() => { disposeKind() })
    await env.ctx.contextGate.setContext('s1', 'demo.ping', true)
    const receipt = await env.ctx.contextGate.publish({
      kind: 'demo.ping', source: 'test', summary: 'hello', payload: { n: 1 },
    })
    expect(receipt).toMatchObject({ delivered: 1, failed: 0 })

    const snapshot = await env.ctx.contextGate.list('s1')
    expect(snapshot.contexts.find(entry => entry.kind === 'demo.ping')).toMatchObject({
      kind: 'demo.ping',
      nameZh: '示例事件',
      description: 'A test event.',
      ttlMs: 15 * 60_000,
      backlog: 1,
      enabledBy: { s1: true },
    })
    expect(snapshot.events.map(entry => entry.outcome)).toContain('delivered')
    expect(snapshot).not.toHaveProperty('health')
    expect(snapshot).not.toHaveProperty('tools')
    expect((env.ctx.contextGate as { status?: unknown }).status).toBeUndefined()
  })

  it('refuses an unknown session', async () => {
    const env = await setup()
    await expect(env.ctx.contextGate.list('missing'))
      .rejects.toMatchObject({ code: 'contextGate/SESSION_NOT_FOUND' })
    await expect(env.ctx.contextGate.setContext('missing', 'demo.ping', true))
      .rejects.toMatchObject({ code: 'contextGate/SESSION_NOT_FOUND' })
  })
})

describe('subscriptions and publication', () => {
  it('injects one merged snapshot before the next step and marks it consumed', async () => {
    const env = await setup()
    const disposeKind = registerPing(env)
    onTestFinished(() => { disposeKind() })
    await env.ctx.contextGate.setContext('s1', 'demo.ping', true)
    await env.ctx.contextGate.publish({ kind: 'demo.ping', source: 'test', summary: 'first', payload: { n: 1 } })
    await env.ctx.contextGate.publish({ kind: 'demo.ping', source: 'test', summary: 'second', payload: { n: 2 } })

    const { injected } = await firePreStep(env.ctx, env.agent)
    expect(injected).toHaveLength(1)
    const text = textOf(injected[0] as NonNullable<typeof injected[0]>)
    expect(text).toContain('[context] 2 context event(s) for this step.')
    expect(text).toContain('first')
    expect(text).toContain('second')

    const snapshot = await env.ctx.contextGate.list('s1')
    expect(snapshot.contexts.find(entry => entry.kind === 'demo.ping')?.backlog).toBe(0)
    expect(snapshot.events.filter(entry => entry.outcome === 'consumed')).toHaveLength(2)
  })

  it('replaces the previous relay snapshot instead of accumulating it', async () => {
    const env = await setup()
    const disposeKind = registerPing(env)
    onTestFinished(() => { disposeKind() })
    await env.ctx.contextGate.setContext('s1', 'demo.ping', true)
    await env.ctx.contextGate.publish({ kind: 'demo.ping', source: 'test', summary: 'one', payload: null })
    await firePreStep(env.ctx, env.agent, 1)
    await env.ctx.contextGate.publish({ kind: 'demo.ping', source: 'test', summary: 'two', payload: null })
    await firePreStep(env.ctx, env.agent, 2)

    const visible = [...env.agent.session.surface.nodes].flatMap((seq) => {
      const event = env.agent.session.eventAt(seq)
      if (event?.type !== 'user/message' || event.data.source.kind !== gate.RELAY_SOURCE) return []
      return event.data.content
    })
    expect(visible).toHaveLength(1)
  })

  it('suppresses an unsubscribed publication and an unsubscription', async () => {
    const env = await setup()
    const disposeKind = registerPing(env)
    onTestFinished(() => { disposeKind() })
    const unsent = await env.ctx.contextGate.publish({
      kind: 'demo.ping', source: 'test', summary: 'ignored', payload: null,
    })
    expect(unsent.delivered).toBe(0)
    expect(unsent.suppressed).toBeGreaterThanOrEqual(1)

    await env.ctx.contextGate.setContext('s1', 'demo.ping', true)
    await env.ctx.contextGate.setContext('s1', 'demo.ping', false)
    const stillOff = await env.ctx.contextGate.publish({
      kind: 'demo.ping', source: 'test', summary: 'still ignored', payload: null,
    })
    expect(stillOff.delivered).toBe(0)
    expect((await env.ctx.contextGate.list('s1')).contexts[0]?.backlog).toBe(0)
  })

  it('delivers only to sessions inside the publisher visibility', async () => {
    const env = await setup()
    const second = await env.harness.create(SessionId('s2'), { provider: 'mock', model: 'mock' })
    const disposeKind = registerPing(env)
    onTestFinished(() => { disposeKind() })
    await env.ctx.contextGate.setContext('s1', 'demo.ping', true)
    await env.ctx.contextGate.setContext('s2', 'demo.ping', true)
    const receipt = await env.ctx.contextGate.publish({
      kind: 'demo.ping', source: 'test', summary: 'only s1', payload: null, visibility: { sessionIds: ['s1'] },
    })
    expect(receipt).toMatchObject({ delivered: 1, suppressed: 1 })
    expect((await env.ctx.contextGate.list('s1')).contexts[0]?.backlog).toBe(1)
    expect((await env.ctx.contextGate.list(second.session.id)).contexts[0]?.backlog).toBe(0)
  })

  it('deduplicates a repeated key within the kind TTL', async () => {
    const env = await setup()
    const disposeKind = registerPing(env, { ttlMs: 60_000 })
    onTestFinished(() => { disposeKind() })
    await env.ctx.contextGate.setContext('s1', 'demo.ping', true)
    const first = await env.ctx.contextGate.publish({
      kind: 'demo.ping', source: 'test', summary: 'one', payload: null, dedupeKey: 'same',
    })
    const second = await env.ctx.contextGate.publish({
      kind: 'demo.ping', source: 'test', summary: 'two', payload: null, dedupeKey: 'same',
    })
    expect(first.delivered).toBe(1)
    expect(second).toMatchObject({ delivered: 0, suppressed: 1 })
    expect((await env.ctx.contextGate.list('s1')).contexts[0]?.backlog).toBe(1)
  })

  it('drops an expired event at the next pre-step', async () => {
    const env = await setup()
    const disposeKind = registerPing(env, { ttlMs: 20 })
    onTestFinished(() => { disposeKind() })
    await env.ctx.contextGate.setContext('s1', 'demo.ping', true)
    await env.ctx.contextGate.publish({ kind: 'demo.ping', source: 'test', summary: 'old', payload: null })
    await sleep(60)
    const { injected } = await firePreStep(env.ctx, env.agent)
    expect(injected).toEqual([])
    const snapshot = await env.ctx.contextGate.list('s1')
    expect(snapshot.contexts[0]?.backlog).toBe(0)
    expect(snapshot.events.map(entry => entry.outcome)).toContain('dropped')
  })

  it('keeps the newest events when the queue exceeds its depth', async () => {
    const env = await setup()
    const disposeKind = registerPing(env, { maxQueueDepth: 2 })
    onTestFinished(() => { disposeKind() })
    await env.ctx.contextGate.setContext('s1', 'demo.ping', true)
    for (let index = 0; index < 3; index += 1) {
      await env.ctx.contextGate.publish({
        kind: 'demo.ping', source: 'test', summary: `event ${String(index)}`, payload: null,
      })
    }
    const snapshot = await env.ctx.contextGate.list('s1')
    expect(snapshot.contexts[0]?.backlog).toBe(2)
    expect(snapshot.events.map(entry => entry.outcome)).toContain('dropped')
  })

  it('refuses an unregistered kind and a provider without a Chinese name', async () => {
    const env = await setup()
    await expect(env.ctx.contextGate.publish({
      kind: 'demo.absent', source: 'test', summary: 'x', payload: null,
    })).rejects.toMatchObject({ code: 'contextGate/CONTEXT_UNKNOWN' })
    await expect(env.ctx.contextGate.setContext('s1', 'demo.absent', true))
      .rejects.toMatchObject({ code: 'contextGate/CONTEXT_UNKNOWN' })
    expect(() => env.ctx.contextGate.registerContextKind({
      kind: 'demo.noname', nameZh: '  ', description: 'x',
    })).toThrow(/Chinese display name/)
  })
})

describe('state', () => {
  it('persists subscriptions and queues in its own document and tolerates extra fields', async () => {
    const first = await setup()
    const disposeKind = registerPing(first, { ttlMs: 60_000 })
    await first.ctx.contextGate.setContext('s1', 'demo.ping', true)
    await first.ctx.contextGate.publish({ kind: 'demo.ping', source: 'test', summary: 'persisted', payload: null })
    await first.fiber.dispose()
    disposeKind()

    const file = join(first.stateDir, DOCUMENT_FILE_NAME)
    const raw = await readFile(file, 'utf8')
    expect(raw).toContain('demo.ping')
    const document = JSON.parse(raw) as Record<string, unknown>
    document['futureTopLevel'] = { note: 'ignored by this build' }
    const sessions = document['sessions'] as Record<string, Record<string, unknown>>
    const session = sessions['s1']
    if (session !== undefined) session['futureSessionField'] = true
    const queues = document['queues'] as Record<string, Record<string, unknown>>
    const queue = queues['s1']
    if (queue !== undefined) queue['futureQueueField'] = ['ignored']
    await writeFile(file, `${JSON.stringify(document, null, 2)}\n`, 'utf8')

    const second = await setup({ stateDir: first.stateDir })
    const disposeSecondKind = registerPing(second, { ttlMs: 60_000 })
    onTestFinished(() => { disposeSecondKind() })
    const snapshot = await second.ctx.contextGate.list('s1')
    expect(snapshot.contexts[0]).toMatchObject({ kind: 'demo.ping', backlog: 1, enabledBy: { s1: true } })
    expect(snapshot.events.length).toBeGreaterThan(0)
  })
})
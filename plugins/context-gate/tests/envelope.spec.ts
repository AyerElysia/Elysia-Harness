/**
 * Behavior of the generic context-event envelope: provenance, structured
 * params, admitted content blocks, causality, multi-session delivery, and
 * source-scoped dedupe. The gate owns the queue and injection; the source is
 * metadata and never a delivery filter.
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
import { DOCUMENT_FILE_NAME, ContextGateStore } from '../src/state.ts'
import { firePreStep, sleep, textOf } from './helpers.ts'

interface Env {
  readonly ctx: Context
  readonly stateDir: string
  readonly agent: Agent
  readonly harness: Awaited<ReturnType<typeof mountAgentLoopTestHarness>>
}

async function setup(existingStateDir?: string): Promise<Env> {
  const stateDir = existingStateDir ?? await mkdtemp(join(tmpdir(), 'context-gate-envelope-'))
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx, { systemPrompt: { personaPrefix: '', personaSuffix: '' } })
  const harness = await mountAgentLoopTestHarness(ctx)
  await ctx.plugin(gate, { stateDir, batchMs: 30, maxWaitMs: 150 })
  const agent = await harness.create(SessionId('s1'), { provider: 'mock', model: 'mock' })
  onTestFinished(async () => {
    await ctx.fiber.dispose()
    await rm(stateDir, { recursive: true, force: true })
  })
  return { ctx, stateDir, agent, harness }
}

function register(env: Env, overrides: Partial<gate.ContextKindRegistration> = {}): () => void {
  return env.ctx.contextGate.registerContextKind({
    kind: 'demo.envelope',
    nameZh: '通用事件',
    description: 'A generic context event.',
    ...overrides,
  })
}

describe('generic event envelope', () => {
  it('delivers params, content, origin, and causation to every subscribed session', async () => {
    const env = await setup()
    const second = await env.harness.create(SessionId('s2'), { provider: 'mock', model: 'mock' })
    const disposeKind = register(env)
    onTestFinished(() => { disposeKind() })
    await env.ctx.contextGate.setContext('s1', 'demo.envelope', true)
    await env.ctx.contextGate.setContext(second.session.id, 'demo.envelope', true)

    const receipt = await env.ctx.contextGate.publish({
      id: 'evt-1',
      kind: 'demo.envelope',
      source: 'plugin-a',
      origin: {
        plugin: 'plugin-a',
        instance: 'qq-1',
        sessionId: 'origin-session',
        channel: 'qq',
        conversation: 'group-42',
      },
      summary: 'incoming message',
      params: { messageId: 'm-1', sender: 'alice' },
      content: [{ type: 'text', text: 'admitted body' }],
      causationId: 'evt-parent',
    })
    expect(receipt).toMatchObject({ eventId: 'evt-1', delivered: 2, failed: 0 })

    for (const [agent, sessionId] of [[env.agent, 's1'], [second, 's2']] as const) {
      const { injected } = await firePreStep(env.ctx, agent)
      expect(injected).toHaveLength(1)
      const message = injected[0]
      if (message === undefined) throw new Error('missing injected message')
      expect(textOf(message)).toContain('admitted body')
      expect(textOf(message)).toContain('plugin-a')
      expect(textOf(message)).toContain('group-42')
      expect(textOf(message)).toContain('evt-parent')
      expect(message.content.some(block => block.type === 'text' && block.text === 'admitted body')).toBe(true)
      expect((await env.ctx.contextGate.list(sessionId)).contexts[0]?.backlog).toBe(0)
    }
  })

  it('keeps the legacy payload field working', async () => {
    const env = await setup()
    const disposeKind = register(env)
    onTestFinished(() => { disposeKind() })
    await env.ctx.contextGate.setContext('s1', 'demo.envelope', true)
    await env.ctx.contextGate.publish({
      kind: 'demo.envelope', source: 'legacy', summary: 'legacy payload', payload: { n: 1 },
    })
    const store = await ContextGateStore.open(env.stateDir)
    const event = store.queue('s1').events[0]
    expect(event?.params).toEqual({ n: 1 })
    const { injected } = await firePreStep(env.ctx, env.agent)
    expect(textOf(injected[0] as NonNullable<typeof injected[0]>)).toContain('params: {"n":1}')
  })

  it('never filters delivery by source', async () => {
    const env = await setup()
    const disposeKind = register(env)
    onTestFinished(() => { disposeKind() })
    await env.ctx.contextGate.setContext('s1', 'demo.envelope', true)
    await env.ctx.contextGate.publish({ kind: 'demo.envelope', source: 'source-a', summary: 'a' })
    await env.ctx.contextGate.publish({ kind: 'demo.envelope', source: 'source-b', summary: 'b' })
    const snapshot = await env.ctx.contextGate.list('s1')
    expect(snapshot.contexts[0]?.backlog).toBe(2)
    const { injected } = await firePreStep(env.ctx, env.agent)
    const text = textOf(injected[0] as NonNullable<typeof injected[0]>)
    expect(text).toContain('source-a')
    expect(text).toContain('source-b')
  })

  it('scopes dedupe by kind and source', async () => {
    const env = await setup()
    const disposeKind = register(env, { ttlMs: 60_000 })
    onTestFinished(() => { disposeKind() })
    await env.ctx.contextGate.setContext('s1', 'demo.envelope', true)
    const first = await env.ctx.contextGate.publish({
      kind: 'demo.envelope', source: 'source-a', summary: 'a', dedupeKey: 'same',
    })
    const otherSource = await env.ctx.contextGate.publish({
      kind: 'demo.envelope', source: 'source-b', summary: 'b', dedupeKey: 'same',
    })
    const repeat = await env.ctx.contextGate.publish({
      kind: 'demo.envelope', source: 'source-a', summary: 'a again', dedupeKey: 'same',
    })
    expect(first.delivered).toBe(1)
    expect(otherSource.delivered).toBe(1)
    expect(repeat).toMatchObject({ delivered: 0, suppressed: 1 })
    expect((await env.ctx.contextGate.list('s1')).contexts[0]?.backlog).toBe(2)
  })

  it('expires a dedupe key with the event TTL, not the kind default', async () => {
    const env = await setup()
    const disposeKind = register(env, { ttlMs: 60_000 })
    onTestFinished(() => { disposeKind() })
    await env.ctx.contextGate.setContext('s1', 'demo.envelope', true)
    await env.ctx.contextGate.publish({
      kind: 'demo.envelope', source: 'test', summary: 'first', dedupeKey: 'short', ttlMs: 15,
    })
    await sleep(30)
    const second = await env.ctx.contextGate.publish({
      kind: 'demo.envelope', source: 'test', summary: 'second', dedupeKey: 'short', ttlMs: 15,
    })
    expect(second.delivered).toBe(1)
  })

  it('applies queue depth per kind instead of across the whole queue', async () => {
    const env = await setup()
    const disposeOne = register(env, { kind: 'demo.one', maxQueueDepth: 1 })
    const disposeTwo = register(env, { kind: 'demo.two', maxQueueDepth: 1 })
    onTestFinished(() => { disposeOne(); disposeTwo() })
    await env.ctx.contextGate.setContext('s1', 'demo.one', true)
    await env.ctx.contextGate.setContext('s1', 'demo.two', true)
    await env.ctx.contextGate.publish({ kind: 'demo.one', source: 'test', summary: 'one-1' })
    await env.ctx.contextGate.publish({ kind: 'demo.one', source: 'test', summary: 'one-2' })
    await env.ctx.contextGate.publish({ kind: 'demo.two', source: 'test', summary: 'two-1' })
    await env.ctx.contextGate.publish({ kind: 'demo.two', source: 'test', summary: 'two-2' })
    const store = await ContextGateStore.open(env.stateDir)
    const events = store.queue('s1').events
    expect(events.map(event => event.summary)).toEqual(['one-2', 'two-2'])
  })

  it('rejects a malformed content array and an oversized body', async () => {
    const env = await setup()
    const disposeKind = register(env)
    onTestFinished(() => { disposeKind() })
    const malformed = {
      kind: 'demo.envelope', source: 'test', summary: 'bad', content: [{}],
    } as unknown as gate.ContextEventInput
    await expect(env.ctx.contextGate.publish(malformed)).rejects.toMatchObject({ code: 'contextGate/EVENT_INVALID' })
    await expect(env.ctx.contextGate.publish({
      kind: 'demo.envelope', source: 'test', summary: 'big', params: 'x'.repeat(200), maxBytes: 32,
    })).rejects.toMatchObject({ code: 'contextGate/EVENT_TOO_LARGE' })
  })

  it('persists the full envelope in its own document', async () => {
    const env = await setup()
    const disposeKind = register(env)
    onTestFinished(() => { disposeKind() })
    await env.ctx.contextGate.setContext('s1', 'demo.envelope', true)
    await env.ctx.contextGate.publish({
      id: 'evt-persisted',
      kind: 'demo.envelope',
      source: 'plugin-a',
      origin: { plugin: 'plugin-a', channel: 'qq', conversation: 'c-1' },
      summary: 'persist me',
      params: { a: 1 },
      content: [{ type: 'text', text: 'stored body' }],
      causationId: 'evt-cause',
    })
    const raw = await readFile(join(env.stateDir, DOCUMENT_FILE_NAME), 'utf8')
    const document = JSON.parse(raw) as {
      queues: Record<string, { events: Array<Record<string, unknown>> }>
    }
    const event = document.queues['s1']?.events[0]
    expect(event).toMatchObject({
      id: 'evt-persisted',
      source: 'plugin-a',
      summary: 'persist me',
      params: { a: 1 },
      content: [{ type: 'text', text: 'stored body' }],
      causationId: 'evt-cause',
      origin: { plugin: 'plugin-a', channel: 'qq', conversation: 'c-1' },
    })
  })

  it('reads a legacy v1 event that only has payload', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'context-gate-envelope-legacy-'))
    const legacy = {
      version: 1,
      sessions: { s1: { contexts: { 'demo.envelope': true }, events: [] } },
      queues: {
        s1: {
          events: [{
            id: 'legacy-event',
            kind: 'demo.envelope',
            source: 'legacy',
            summary: 'old payload',
            payload: { n: 2 },
            visibility: {},
            active: false,
            dedupeKey: 'legacy',
            createdAt: 1,
          }],
          consumed: [],
          dedupe: {},
        },
      },
      updatedAt: '2026-01-01T00:00:00.000Z',
    }
    await writeFile(join(stateDir, DOCUMENT_FILE_NAME), JSON.stringify(legacy), 'utf8')
    const env = await setup(stateDir)
    const disposeKind = register(env)
    onTestFinished(() => { disposeKind() })
    const store = await ContextGateStore.open(env.stateDir)
    const event = store.queue('s1').events[0]
    expect(event).toMatchObject({ id: 'legacy-event', params: { n: 2 }, payload: { n: 2 } })
    await firePreStep(env.ctx, env.agent)
    expect((await env.ctx.contextGate.list('s1')).contexts[0]?.backlog).toBe(0)
  })

  it('records source, origin, and causation in the event log', async () => {
    const env = await setup()
    const disposeKind = register(env)
    onTestFinished(() => { disposeKind() })
    await env.ctx.contextGate.setContext('s1', 'demo.envelope', true)
    await env.ctx.contextGate.publish({
      kind: 'demo.envelope',
      source: 'plugin-a',
      origin: { plugin: 'plugin-a', instance: 'i-1' },
      summary: 'logged',
      causationId: 'cause-1',
    })
    const snapshot = await env.ctx.contextGate.list('s1')
    const delivered = snapshot.events.find(entry => entry.outcome === 'delivered')
    expect(delivered).toMatchObject({
      source: 'plugin-a',
      origin: { plugin: 'plugin-a', instance: 'i-1' },
      causationId: 'cause-1',
      summary: 'logged',
    })
  })
})

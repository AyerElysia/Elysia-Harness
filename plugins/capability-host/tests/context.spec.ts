/**
 * Context bus behavior: subscription AND visibility, one merged snapshot per
 * step, active/passive delivery, coalescing, dedupe/TTL, and queue restart
 * recovery.
 *
 * The Router's external-input rule is asserted directly against the injected
 * source: the relay uses `form: 'snapshot'`, which the documented filter never
 * treats as a new external input.
 */

import { describe, expect, it } from 'vitest'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { DOCUMENT_FILE_NAME } from '../src/index.ts'
import {
  createEnv, isRelayEvent, relayMessages, settle, textResponse, toolCallResponse, waitFor,
} from './harness.ts'

/** The documented Router filter, reduced to the fields a relay source carries. */
function isExternalInput(
  source: { readonly kind: string; readonly form?: string },
  content: readonly { readonly type: string; readonly text?: string }[],
): boolean {
  if (source.form === 'instructions' || source.form === 'catalog' || source.form === 'snapshot') return false
  return content.some(block => block.type === 'text' && (block.text ?? '').length > 0)
}

describe('subscription fan-out', () => {
  it('delivers only to subscribed sessions, and publisher visibility can only narrow that set', async () => {
    const env = await createEnv()
    await env.mountHost()
    env.host().registerContextKind({ kind: 'app.message', description: 'Inbound app message', ttlMs: 60_000 })
    await env.createAgent('ctx-a', 'preset-sub')
    await env.createAgent('ctx-b', 'preset-other')
    await env.createAgent('ctx-c')
    await env.host().setContext({ kind: 'preset', id: 'preset-sub' }, 'app.message', true)
    await env.host().setContext({ kind: 'session', id: 'ctx-c' }, 'app.message', true)

    const first = await env.host().publish({
      kind: 'app.message', source: 'spec', summary: 'one', payload: { n: 1 }, active: false, dedupeKey: 'e1',
    })
    expect(first).toMatchObject({ delivered: 2, suppressed: 1 })

    // `preset-other` is named by the publisher but never subscribed: AND, not OR.
    const narrowed = await env.host().publish({
      kind: 'app.message', source: 'spec', summary: 'two', active: false, dedupeKey: 'e2',
      visibility: { presetIds: ['preset-other'] },
    })
    expect(narrowed).toMatchObject({ delivered: 0, suppressed: 3 })

    const targeted = await env.host().publish({
      kind: 'app.message', source: 'spec', summary: 'three', active: false, dedupeKey: 'e3',
      visibility: { sessionIds: ['ctx-a'] },
    })
    expect(targeted).toMatchObject({ delivered: 1, suppressed: 2 })

    const snapshot = await env.host().list()
    expect(snapshot.sessions.find(session => session.id === 'ctx-a')?.queued).toBe(2)
    expect(snapshot.sessions.find(session => session.id === 'ctx-b')?.queued).toBe(0)
    expect(snapshot.sessions.find(session => session.id === 'ctx-c')?.queued).toBe(1)
  })
})

describe('snapshot injection', () => {
  it('merges queued events into one relay snapshot that Router does not treat as external input', async () => {
    const env = await createEnv()
    await env.mountHost()
    env.host().registerContextKind({ kind: 'app.message', description: 'Inbound app message' })
    const agent = await env.createAgent('snap-a')
    await env.host().setContext({ kind: 'session', id: 'snap-a' }, 'app.message', true)
    await env.host().publish({
      kind: 'app.message', source: 'bridge', summary: 'first event', payload: { text: 'hello' }, active: false, dedupeKey: 's1',
    })
    await env.host().publish({
      kind: 'app.message', source: 'bridge', summary: 'second event', active: false, dedupeKey: 's2',
    })

    env.adapter.enqueue(textResponse('ok'))
    await env.send(agent, 'go')

    const relays = relayMessages(agent)
    expect(relays).toHaveLength(1)
    const relay = relays[0]!
    expect(relay.data.source).toMatchObject({ kind: 'elysia-context-relay', form: 'snapshot' })
    expect(JSON.stringify(relay.data.content)).toContain('first event')
    expect(JSON.stringify(relay.data.content)).toContain('second event')
    expect(isExternalInput(relay.data.source, relay.data.content)).toBe(false)
    // A genuine user turn still counts as external input; the relay form is the difference.
    expect(isExternalInput({ kind: 'user' }, [{ type: 'text', text: 'go' }])).toBe(true)

    // A later step with nothing queued injects nothing and leaves the prior snapshot alone.
    env.adapter.enqueue(textResponse('again'))
    await env.send(agent, 'again')
    expect(relayMessages(agent).filter(event => event.data.content.length > 0)).toHaveLength(1)
    expect((await env.host().status()).context.queued).toBe(0)
  })

  it('retires the previous snapshot when a new one is injected', async () => {
    const env = await createEnv()
    await env.mountHost()
    env.host().registerContextKind({ kind: 'app.message', description: 'Inbound app message' })
    const agent = await env.createAgent('snap-b')
    await env.host().setContext({ kind: 'session', id: 'snap-b' }, 'app.message', true)

    await env.host().publish({ kind: 'app.message', source: 'spec', summary: 'round one', active: false, dedupeKey: 'r1' })
    env.adapter.enqueue(textResponse('a'))
    await env.send(agent, 'first')

    await env.host().publish({ kind: 'app.message', source: 'spec', summary: 'round two', active: false, dedupeKey: 'r2' })
    env.adapter.enqueue(textResponse('b'))
    await env.send(agent, 'second')

    const visible = relayMessages(agent)
    // History keeps the retired snapshot as an empty replacement; the surface holds
    // exactly one live relay message.
    expect(visible.filter(event => event.data.content.length === 0)).toHaveLength(1)
    const surfaceRelays = [...agent.session.surface.nodes]
      .map(seq => agent.session.eventAt(seq))
      .filter(event => event !== undefined && isRelayEvent(event))
      .filter(event => event.data.content.length > 0)
    expect(surfaceRelays).toHaveLength(1)
    expect(JSON.stringify(surfaceRelays[0]?.data.content)).toContain('round two')
  })

  it('drops an expired event and records it', async () => {
    const env = await createEnv()
    await env.mountHost()
    env.host().registerContextKind({ kind: 'app.message', description: 'Inbound app message' })
    const agent = await env.createAgent('ttl-a')
    await env.host().setContext({ kind: 'session', id: 'ttl-a' }, 'app.message', true)
    await env.host().publish({
      kind: 'app.message', source: 'spec', summary: 'stale', active: false,
      dedupeKey: 'stale-1', createdAt: Date.now() - 60_000, ttlMs: 1_000,
    })

    env.adapter.enqueue(textResponse('ok'))
    await env.send(agent, 'go')
    expect(relayMessages(agent)).toHaveLength(0)
    const status = await env.host().status()
    expect(status.context.dropped).toBe(1)
    expect(status.diagnostics.some(diagnostic => diagnostic.code === 'CONTEXT_TTL')).toBe(true)
  })

  it('suppresses a repeat publication with the same dedupe key', async () => {
    const env = await createEnv()
    await env.mountHost()
    env.host().registerContextKind({ kind: 'app.message', description: 'Inbound app message', ttlMs: 60_000 })
    await env.createAgent('dedupe-a')
    await env.host().setContext({ kind: 'session', id: 'dedupe-a' }, 'app.message', true)

    const first = await env.host().publish({ kind: 'app.message', source: 'spec', summary: 'once', active: false, dedupeKey: 'same' })
    const second = await env.host().publish({ kind: 'app.message', source: 'spec', summary: 'once', active: false, dedupeKey: 'same' })
    expect(first.delivered).toBe(1)
    expect(second).toMatchObject({ delivered: 0, suppressed: 1 })
  })
})

describe('active and passive delivery', () => {
  it('does not start an extra turn for active events published while one is running', async () => {
    const env = await createEnv()
    await env.mountHost()
    env.host().registerContextKind({ kind: 'app.message', description: 'Inbound app message' })
    const release = Promise.withResolvers<void>()
    env.host().registerTool({
      id: 'elysia_slow',
      scope: 'global',
      description: 'Block the turn until the spec releases it.',
      factory: () => defineTool({
        name: 'elysia_slow',
        description: 'Block the turn until the spec releases it.',
        parameters: {},
        output: {
          schema: { type: 'string' },
          render: (_args, value) => [{ type: 'text', text: value }],
        },
        execute: async () => {
          await release.promise
          return 'released'
        },
      }),
    })
    const agent = await env.createAgent('wake-a')
    await env.host().setContext({ kind: 'session', id: 'wake-a' }, 'app.message', true)
    await env.host().setTool({ kind: 'session', id: 'wake-a' }, 'elysia_slow', true)

    env.adapter.enqueue(toolCallResponse('slow-1', 'elysia_slow', {}), textResponse('done'), textResponse('followup'))
    const sending = env.send(agent, 'block')
    await waitFor(() => env.adapter.requests.length === 1)

    await env.host().publish({ kind: 'app.message', source: 'spec', summary: 'wake one', dedupeKey: 'w1' })
    await env.host().publish({ kind: 'app.message', source: 'spec', summary: 'wake two', dedupeKey: 'w2' })
    await settle()
    // The session is running, so the wake-ups join the turn in flight instead of
    // opening one turn per publication.
    expect(env.adapter.requests).toHaveLength(1)
    expect((await env.host().status()).context.merged).toBeGreaterThanOrEqual(1)

    release.resolve()
    await sending
    // Two publications produced at most one follow-up turn; the first step after
    // the tool result carried the merged snapshot.
    expect(env.adapter.requests.length).toBeGreaterThanOrEqual(2)
    expect(env.adapter.requests.length).toBeLessThanOrEqual(3)
    expect(JSON.stringify(env.adapter.requests[1]?.messages)).toContain('wake one')
    const merged = relayMessages(agent).filter(event => event.data.content.length > 0)
    expect(merged.some(event => JSON.stringify(event.data.content).includes('wake two'))).toBe(true)
  })

  it('leaves a passive event queued until the next input', async () => {
    const env = await createEnv()
    await env.mountHost()
    env.host().registerContextKind({ kind: 'app.message', description: 'Inbound app message' })
    const agent = await env.createAgent('passive-a')
    await env.host().setContext({ kind: 'session', id: 'passive-a' }, 'app.message', true)
    await env.host().publish({ kind: 'app.message', source: 'spec', summary: 'passive note', active: false, dedupeKey: 'p1' })
    await settle()
    expect(env.adapter.requests).toHaveLength(0)

    env.adapter.enqueue(textResponse('next'))
    await env.send(agent, 'next input')
    expect(env.adapter.requests).toHaveLength(1)
    expect(JSON.stringify(relayMessages(agent)[0]?.data.content)).toContain('passive note')
  })
})

describe('restart recovery', () => {
  it('keeps an offline session queue across a remount and injects it when the session resumes', async () => {
    const env = await createEnv()
    // A session that was live in a previous process: its switches, preset, and
    // queue live only in the document.
    await writeFile(join(env.stateDir, DOCUMENT_FILE_NAME), JSON.stringify({
      version: 1,
      presets: { 'preset-idle': { contexts: { 'app.message': true } } },
      sessions: { 'idle-1': { contexts: { 'app.message': true } } },
      sessionPresets: { 'idle-1': 'preset-idle' },
      queues: {},
      updatedAt: '2026-11-22T00:00:00.000Z',
    }), 'utf8')

    const first = await env.mountHost()
    env.host().registerContextKind({ kind: 'app.message', description: 'Inbound app message' })
    const receipt = await env.host().publish({
      kind: 'app.message', source: 'spec', summary: 'published while offline', active: false, dedupeKey: 'off-1',
    })
    expect(receipt.delivered).toBe(1)
    expect((await env.host().list()).sessions.find(session => session.id === 'idle-1')?.live).toBe(false)
    await first.dispose()

    await env.mountHost()
    env.host().registerContextKind({ kind: 'app.message', description: 'Inbound app message' })
    expect((await env.host().status()).context.queued).toBe(1)

    const agent = await env.createAgent('idle-1', 'preset-idle')
    env.adapter.enqueue(textResponse('ok'))
    await env.send(agent, 'resume')
    expect(JSON.stringify(relayMessages(agent)[0]?.data.content)).toContain('published while offline')
    expect((await env.host().status()).context.queued).toBe(0)
  })
})
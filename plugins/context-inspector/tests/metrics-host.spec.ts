import { Context } from '@deepseek-ai/cordis'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { CompactionId } from '@deepseek-ai/dsh-compaction'
import { createAssistantMessage, createSystemMessage, createUserMessage, ProviderRequestId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, TokenUsage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import ProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { describe, expect, it } from 'vitest'
import { createContextMetricsProjection } from '../src/metrics/projection.ts'
import type { ContextMetricsState } from '../src/metrics/projection.ts'
import type { TextCounter } from '../src/metrics/counter-types.ts'

const counter: TextCounter = {
  id: 'mock-v1', label: 'Fixture reference tokenizer',
  supports: (provider, model) => provider === 'fixture' && model === 'supported',
  count: text => ({ tokenizerTokens: Array.from(text).length, heuristicTokens: Math.ceil(text.length / 4), fallback: false }),
}
const tools = [{ name: 'fixture', description: 'fixture tool', parameters: { type: 'object' } }]

function fixture(selected: TextCounter = counter) {
  const session = Session.create(SessionId('context-metrics-fixture'))
  const definition = createContextMetricsProjection(selected, 'fixture-config-v1')
  function replay() {
    return session.snapshotEvents().reduce(definition.apply, definition.init(session.header, SessionLogOffset(0)))
  }
  function view(state: ContextMetricsState = replay()) {
    if (definition.wire === undefined) throw new Error('missing fixture projection view')
    const value = definition.wire.view(state)
    expect(value.estimate.totalTokens).toBe(value.estimate.systemTokens + value.estimate.toolsTokens + value.estimate.messageTokens)
    expect(definition.wire.viewSchema.safeParse(value).success).toBe(true)
    return value
  }
  function header(model = 'supported') {
    session.append('request/header', { reason: 'change', header: { config: { provider: 'fixture', model }, tools } })
  }
  function user(text: string, replace?: SessionSeq) {
    return session.append('user/message', createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }),
      replace === undefined ? { surfaceOp: 'append' } : { surfaceOp: { op: 'replace', startSeq: replace, endSeq: replace }, sourceEventSeqs: [replace] }).seq
  }
  function system(text: string, replace?: SessionSeq) {
    return session.append('system/message', { turn: 1, step: 1, message: createSystemMessage(text) },
      replace === undefined ? { surfaceOp: 'append' } : { surfaceOp: { op: 'replace', startSeq: replace, endSeq: replace }, sourceEventSeqs: [replace] }).seq
  }
  function attempt(usage: TokenUsage) {
    return session.append('assistant/attempt', { turn: 1, step: 1,
      stream: [{ type: 'chunk', time: 1, chunk: { type: 'usage', usage } }],
    })
  }
  return { session, definition, replay, view, header, user, system, attempt }
}

describe('retained context metrics projection', () => {
  it('serves a consistent empty estimate and counts the latest nonempty system and tools', () => {
    const f = fixture()
    expect(f.view().estimate).toMatchObject({ totalTokens: 0, method: 'heuristic', incomplete: false })
    f.header()
    f.system('old')
    const system = f.system('current system')
    f.user('ordinary text')
    const current = f.view()
    expect(current.estimate).toMatchObject({ systemTokens: 'current system'.length + 4, method: 'tokenizer', tokenizerLabel: counter.label })
    expect(current.estimate.toolsTokens).toBe(JSON.stringify(tools).length + 4)
    f.system('', system)
    expect(f.view().estimate.systemTokens).toBe('old'.length + 4)
  })

  it('removes unmetered replacements by actual position without keeping phantom tokens', () => {
    const f = fixture()
    f.header()
    const first = f.user('private fixture '.repeat(100))
    const second = f.user('tail')
    const before = f.view().estimate.totalTokens
    f.user('tiny', first)
    const after = f.view()
    expect(after.estimate.totalTokens).toBeLessThan(before - 1000)
    expect(f.replay().nodes.map(node => node.seq)).not.toContain(first)
    expect(f.replay().nodes.map(node => node.seq)).toContain(second)
    const encoded = JSON.stringify(f.replay())
    expect(encoded).not.toContain('private fixture')
    expect(encoded).not.toContain('ordinary text')
    expect(encoded).not.toContain('parameters')
  })

  it('recomputes the compressed surface without an old provider anchor or shadow-price subtraction', () => {
    const f = fixture()
    f.header()
    f.system('identity')
    const first = f.user('history '.repeat(200))
    const last = f.user('more history')
    f.attempt({ inputTokens: 200, cacheReadTokens: 477952, outputTokens: 19 })
    expect(f.view().latestReported?.inputTokens).toBe(478152)
    f.session.append('compaction/summary', {
      compactionId: CompactionId('fixture-compaction'), summary: [{ type: 'text', text: 'summary' }],
      shadowedRange: { start: first, end: last }, shadowedSeqs: [first, last],
      shadowedTokenCount: 999999, provider: 'fixture', model: 'supported',
    })
    f.session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'summary' }], source: { kind: 'user' } }), {
      surfaceOp: { op: 'replace', startSeq: first, endSeq: last }, sourceEventSeqs: [first, last],
    })
    const current = f.view()
    expect(current.estimate.messageTokens).toBe('summary'.length + 8)
    expect(current.estimate.totalTokens).toBe('identity'.length + 4 + JSON.stringify(tools).length + 4 + 'summary'.length + 8)
    expect(current.latestReported).toMatchObject({ inputTokens: 478152, outputTokens: 19, relationship: 'content-changed' })
  })

  it('includes positive compaction usage as a separate auxiliary API report', () => {
    const f = fixture()
    f.header()
    const first = f.user('history text')
    f.attempt({ inputTokens: 100, outputTokens: 2 })
    const summary = f.session.append('compaction/summary', {
      compactionId: CompactionId('reported-compaction'), summary: [{ type: 'text', text: 'summary' }],
      shadowedRange: { start: first, end: first }, shadowedSeqs: [first], shadowedTokenCount: 20,
      provider: 'fixture', model: 'supported', usage: { inputTokens: 5, cacheReadTokens: 300, outputTokens: 40 },
    })
    const value = f.view()
    expect(value.latestReported).toMatchObject({ purpose: 'compaction', seq: summary.seq,
      inputTokens: 305, outputTokens: 40, relationship: 'unknown' })
    expect(value.latestReported).not.toHaveProperty('turn')
    expect(value.estimate.totalTokens).not.toBe(305)
  })

  it('switches counting routes without retaining text or mixing estimates with API usage', () => {
    const f = fixture()
    f.header()
    f.user('中文中文abcd')
    f.attempt({ inputTokens: 500, outputTokens: 7 })
    const supported = f.view()
    expect(supported.latestReported?.relationship).toBe('same-context')
    expect(supported.latestReported?.provider).toBe('fixture')
    f.header('other-model')
    const other = f.view()
    expect(other.estimate.method).toBe('heuristic')
    expect(other.estimate.totalTokens).toBeLessThan(supported.estimate.totalTokens)
    expect(other.latestReported?.relationship).toBe('route-changed')
    f.header()
    expect(f.view().estimate.totalTokens).toBe(supported.estimate.totalTokens)
  })

  it('keeps the last positive prompt report when a failed SDK attempt reports zero usage', () => {
    const f = fixture()
    f.header()
    f.user('question')
    const sample = f.attempt({ inputTokens: 5, cacheReadTokens: 100, cacheWriteTokens: 3, outputTokens: 9 })
    f.attempt({ inputTokens: 0, cacheReadTokens: 0, outputTokens: 0 })
    expect(f.view().latestReported).toMatchObject({ inputTokens: 108, uncachedInputTokens: 5, cacheReadTokens: 100,
      cacheWriteTokens: 3, outputTokens: 9, seq: sample.seq, relationship: 'same-context' })
  })

  it('captures an assistant report before its new output joins the retained input', () => {
    const f = fixture()
    f.header()
    f.user('question')
    f.session.append('assistant/message', { turn: 1, step: 1, message: createAssistantMessage({
      content: [{ type: 'text', text: 'answer' }], source: { provider: 'fixture', model: 'supported' },
    }), stream: [], usage: { inputTokens: 100, outputTokens: 2 } }, { surfaceOp: 'append' })
    expect(f.view().latestReported).toMatchObject({ inputTokens: 100, outputTokens: 2, relationship: 'content-changed' })
  })

  it('marks image and file structure incomplete instead of claiming their true request cost', () => {
    const f = fixture()
    f.header()
    const image: ContentBlock = { type: 'image', attachment: { attachmentId: AttachmentId('fixture-image'), mediaType: 'image/png', bytes: 2, width: 20, height: 20 } }
    const file: ContentBlock = { type: 'file', attachment: { attachmentId: AttachmentId('fixture-file'), name: 'fixture.txt', bytes: 2 } }
    // The pricing function accepts typed blocks; no attachment store or byte reads are involved.
    const event: SessionEvent<'user/message'> = { type: 'user/message', seq: SessionSeq(99), time: 1,
      data: createUserMessage({ content: [image, file], source: { kind: 'user' } }), surfaceOp: 'append' }
    const result = f.definition.apply(f.replay(), event)
    expect(f.view(result).estimate).toMatchObject({ incomplete: true, incompleteTypes: ['file', 'image'] })
    expect(f.view(result).estimate.totalTokens).toBeGreaterThan(0)
  })

  it('invalidates an unchanged-sequence API report when image representation is offloaded', () => {
    const f = fixture()
    f.header()
    const message = f.session.append('user/message', createUserMessage({ content: [{ type: 'image', attachment: {
      attachmentId: AttachmentId('offload-fixture'), mediaType: 'image/png', bytes: 2, width: 20, height: 20,
    } }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    f.attempt({ inputTokens: 300, outputTokens: 0 })
    const before = f.replay()
    expect(f.view(before).latestReported?.relationship).toBe('same-context')
    const event: SessionEvent<'image/offload'> = {
      type: 'image/offload', seq: SessionSeq(f.session.seq), time: 5,
      data: { targets: [{ seq: message.seq, imageIndexes: [0] }] },
    }
    const changed = f.definition.apply(before, event)
    expect(changed.representationRevision).toBe(event.seq)
    expect(changed.nodes.map(node => node.seq)).toEqual(before.nodes.map(node => node.seq))
    expect(f.view(changed).latestReported?.relationship).toBe('content-changed')
    expect(f.view(changed).estimate).toEqual(f.view(before).estimate)
    expect(f.view(changed).estimate.incompleteTypes).toContain('image')
    expect(f.definition.stateVersion).toBe(2)
    const { representationRevision: _removed, ...old } = before
    expect(f.definition.stateSchema.safeParse(old).success).toBe(false)
  })

  it('reports budget fallback and keeps the entire oversized text in the heuristic count', () => {
    const limited: TextCounter = { ...counter, count: text => text.length > 20
      ? { tokenizerTokens: 0, heuristicTokens: text.length * 2, fallback: true }
      : counter.count(text) }
    const f = fixture(limited)
    f.header()
    f.system('short')
    f.user('x'.repeat(100))
    const estimate = f.view().estimate
    expect(estimate.method).toBe('mixed')
    expect(estimate.messageTokens).toBe(208)
  })

  it('binds checkpoints to the counter fingerprint and leaves prior state unchanged on an invalid range', () => {
    const f = fixture()
    f.header()
    f.user('question')
    const state = f.replay()
    const clone = JSON.stringify(state)
    expect(f.definition.stateSchema.safeParse(state).success).toBe(true)
    expect(createContextMetricsProjection(counter, 'changed-asset').stateSchema.safeParse(state).success).toBe(false)
    const event: SessionEvent<'user/message'> = { type: 'user/message', seq: SessionSeq(999), time: 1,
      data: createUserMessage({ content: [], source: { kind: 'user' } }), surfaceOp: { op: 'replace', startSeq: SessionSeq(777), endSeq: SessionSeq(777) }, sourceEventSeqs: [SessionSeq(777)] }
    expect(() => f.definition.apply(state, event)).toThrow('unavailable surface range')
    expect(JSON.stringify(state)).toBe(clone)
  })

  it('restores a numeric checkpoint and continues at the same result as a full replay', () => {
    const f = fixture()
    f.header()
    const first = f.user('fixture checkpoint text')
    f.attempt({ inputTokens: 12, outputTokens: 3 })
    const checkpoint = JSON.parse(JSON.stringify(f.replay()))
    const restored = f.definition.stateSchema.parse(checkpoint)
    f.user('replacement', first)
    const tail = f.session.snapshotEvents().at(-1)
    if (tail === undefined) throw new Error('missing fixture tail')
    expect(f.definition.apply(restored, tail)).toEqual(f.replay())
    expect(JSON.stringify(restored)).not.toContain('fixture checkpoint text')
  })

  it('keeps missing report identity unknown and retains a provider request id when supplied', () => {
    const f = fixture()
    f.session.append('assistant/attempt', { turn: 2, step: 3, stream: [
      { type: 'chunk', time: 1, chunk: { type: 'usage', usage: { inputTokens: 4, outputTokens: 0 } } },
      { type: 'chunk', time: 2, chunk: { type: 'finish', reason: { kind: 'error', failure: {
        code: 'TIMEOUT', message: 'fixture failure', requestId: ProviderRequestId('fixture-provider-request'),
      } } } },
    ] })
    expect(f.view().latestReported).toMatchObject({ inputTokens: 4, relationship: 'unknown', requestId: 'fixture-provider-request' })
    expect(f.view().latestReported).not.toHaveProperty('provider')
    expect(f.view().latestReported).not.toHaveProperty('model')
    expect(f.view().latestReported).not.toHaveProperty('attemptId')
  })

  it('registers and removes the metrics key through an owned native registry effect', async () => {
    const ctx = new Context()
    await ctx.plugin(ProjectionRegistry)
    try {
      const mount = await ctx.plugin({ inject: ['sessionProjections'], apply(scope: Context) { scope.sessionProjections.register(createContextMetricsProjection(counter, 'fixture-config-v1')) } })
      const session = Session.create(SessionId('lifecycle-fixture'))
      expect(ctx.sessionProjections.snapshot(session).values.elysiaContextMetrics).toBeDefined()
      await mount.dispose()
      expect(ctx.sessionProjections.snapshot(session).values.elysiaContextMetrics).toBeUndefined()
    } finally { await ctx.fiber.dispose() }
  })
})

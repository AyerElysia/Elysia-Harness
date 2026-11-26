/**
 * The context event bus: provider publications, per-session queues and
 * cursors, subscription and visibility filtering, dedupe, TTL, and the one
 * merged snapshot injected per step.
 *
 * Delivery is subscription AND visibility: a session receives an event only
 * when its preset or the session itself subscribed, and only when the
 * publisher's visibility still allows it. A publisher can narrow the target
 * set, never widen it past the panel.
 *
 * The injected snapshot is a `user/message` whose source is
 * `elysia-context-relay` with `form: 'snapshot'`. That form is what keeps the
 * relay out of the Router's external-input test; the visible content is an
 * annotation on the turn, not a new inbound message.
 *
 * @module @elysia/capability-core/context-bus
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContextFormed, UserMessage } from '@deepseek-ai/dsh-llm'
import type {
  ContextEvent, ContextEventInput, ContextKindView, ContextStatus, ContextVisibility, HostState,
  PublishReceipt, ScopeRef,
} from './types.ts'
import type { ContextDefaults, ContextKindRegistration, ResolvedContextKind } from './contracts.ts'
import type { CapabilityStateStore, QueueRecord } from './state.ts'
import { QUEUE_HISTORY_LIMIT } from './state.ts'
import type { DiagnosticLog } from './diagnostics.ts'
import type { SessionSource } from './sessions.ts'
import { CapabilityHostError, describeError } from './errors.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'elysia-context-relay': { kind: 'elysia-context-relay' } & ContextFormed
  }
}

/** Source kind of every relay message: the wake-up and the merged snapshot. */
export const RELAY_SOURCE = 'elysia-context-relay'

/** Section name the merged snapshot contributes. */
export const RELAY_SECTION = 'elysia-context-relay'

/** Options the Host passes to one bus instance. */
export interface ContextBusOptions {
  /** Host context whose `agent/pre-step` listener the bus attaches. */
  readonly ctx: Context
  /** Persisted switches and queues. */
  readonly store: CapabilityStateStore
  /** Live and persisted session lookup. */
  readonly sessions: SessionSource
  /** Traffic defaults for kinds that do not declare their own. */
  readonly defaults: ContextDefaults
  /** Sink for refused or failed deliveries. */
  readonly diagnostics: DiagnosticLog
  /** Maximum events merged into one snapshot. */
  readonly maxEventsPerSnapshot: number
  /** Maximum bytes of one merged snapshot. */
  readonly maxSnapshotBytes: number
  /** Initial delivery state. */
  readonly hostState: HostState
}

/** Delivery accounting kept for `status()`. */
interface BusCounters {
  published: number
  delivered: number
  suppressed: number
  dropped: number
  failed: number
  merged: number
  consumed: number
}

/**
 * Publish, queue, and inject context events.
 *
 * Queue mutations for one session are serialized: a publication and a step
 * injection can interleave on the event loop, and neither may overwrite the
 * other's write.
 */
export class ContextBus {
  private readonly kinds = new Map<string, ResolvedContextKind>()
  private readonly pendingWake = new Set<string>()
  private readonly queueChains = new Map<string, Promise<unknown>>()
  private readonly counters: BusCounters = {
    published: 0, delivered: 0, suppressed: 0, dropped: 0, failed: 0, merged: 0, consumed: 0,
  }
  private state: HostState
  private attached = false

  /** @param options - context, state, sessions, limits, and initial delivery state. */
  private readonly options: ContextBusOptions

  constructor(options: ContextBusOptions) {
    this.options = options
    this.state = options.hostState
  }

  /**
   * Declare one publishable kind.
   * @param registration - kind name, description, and delivery limits.
   * @returns a disposer that removes the declaration.
   * @throws Error when the kind is empty or already declared, which is a provider bug.
   */
  registerKind(registration: ContextKindRegistration): () => void {
    const kind = registration.kind.trim()
    if (kind === '') throw new Error('capability-host: a context kind needs a name')
    if (this.kinds.has(kind)) throw new Error(`capability-host: context kind ${JSON.stringify(kind)} is already declared`)
    const nameZh = registration.nameZh?.trim()
    const resolved: ResolvedContextKind = {
      kind,
      ...(nameZh === undefined || nameZh === '' ? {} : { nameZh }),
      description: registration.description,
      activeByDefault: registration.activeByDefault ?? true,
      ttlMs: registration.ttlMs ?? this.options.defaults.ttlMs,
      maxBytes: registration.maxBytes ?? this.options.defaults.maxBytes,
      maxQueueDepth: registration.maxQueueDepth ?? this.options.defaults.maxQueueDepth,
    }
    this.kinds.set(kind, resolved)
    return () => { this.kinds.delete(kind) }
  }

  /** Registered kinds as the panel lists them. */
  listKinds(): readonly ContextKindView[] {
    return [...this.kinds.values()].map(kind => ({
      kind: kind.kind,
      ...(kind.nameZh === undefined ? {} : { nameZh: kind.nameZh }),
      description: kind.description,
      activeByDefault: kind.activeByDefault,
      ttlMs: kind.ttlMs,
      maxBytes: kind.maxBytes,
    }))
  }

  /** Whether delivery is enabled or paused. */
  hostState(): HostState {
    return this.state
  }

  /**
   * Stop or resume delivery. A paused bus still queues events, subject to TTL,
   * and injects nothing until it is resumed.
   * @param next - desired delivery state.
   */
  setHostState(next: HostState): void {
    this.state = next
  }

  /**
   * Attach the one global `agent/pre-step` listener. Calling it again is a no-op.
   */
  attach(): void {
    if (this.attached) return
    this.attached = true
    this.options.ctx.on('agent/pre-step', async ({ agent, signal }, next): Promise<PreStepDecision> => {
      const decision = await next()
      if (decision.kind === 'reject' || signal.aborted || this.state !== 'enabled') return decision
      let injected: UserMessage | undefined
      try {
        injected = await this.drain(agent)
      } catch (error: unknown) {
        // Nothing was consumed: leaving the queue intact lets the next step retry.
        this.options.diagnostics.report({
          code: 'CONTEXT_DELIVERY_FAILED',
          message: `context injection failed for session ${agent.session.id}: ${describeError(error)}`,
        })
        return decision
      }
      if (injected === undefined) return decision
      return { ...decision, messages: [...decision.messages, injected] }
    }, { prepend: true })
  }

  /**
   * Publish one event to every subscribed, visible session.
   * @param input - the publication.
   * @returns delivery accounting for the publication.
   * @throws CapabilityHostError `CONTEXT_UNKNOWN`, `EVENT_INVALID`, `EVENT_PAYLOAD_INVALID`, or `EVENT_TOO_LARGE`.
   */
  async publish(input: ContextEventInput): Promise<PublishReceipt> {
    const kind = this.kinds.get(input.kind)
    if (kind === undefined) {
      throw new CapabilityHostError('CONTEXT_UNKNOWN', `context kind ${JSON.stringify(input.kind)} is not registered in this Host`, {
        eventKind: input.kind,
      })
    }
    const event = this.normalize(input, kind)
    this.counters.published += 1
    const now = Date.now()
    const receipt = { eventId: event.id, delivered: 0, suppressed: 0, failed: 0 }
    for (const candidate of this.options.sessions.candidates()) {
      const presetId = this.options.sessions.presetOf(candidate.id)
      if (!this.subscribed(candidate.id, presetId, event.kind) || !visibleTo(event.visibility, candidate.id, presetId)) {
        receipt.suppressed += 1
        continue
      }
      const outcome = await this.withQueue(candidate.id, async () => {
        const queue = this.options.store.queue(candidate.id)
        const seenAt = queue.dedupe[event.dedupeKey]
        if (seenAt !== undefined && now - seenAt <= kind.ttlMs) return 'suppressed' as const
        const copy = structuredClone(event)
        let dropped = 0
        const events = [...queue.events, copy]
        while (events.length > kind.maxQueueDepth) {
          events.shift()
          dropped += 1
        }
        const dedupe = this.remember(queue.dedupe, event.dedupeKey, now)
        await this.options.store.mutateQueue(candidate.id, () => ({ events, consumed: queue.consumed, dedupe }))
        if (dropped > 0) {
          this.counters.dropped += dropped
          this.options.diagnostics.report({
            code: 'CONTEXT_BACKPRESSURE',
            message: `session ${candidate.id} dropped ${String(dropped)} oldest event(s) from kind ${JSON.stringify(kind.kind)}`,
            eventKind: kind.kind,
          })
        }
        return 'delivered' as const
      })
      if (outcome === 'suppressed') {
        receipt.suppressed += 1
        continue
      }
      receipt.delivered += 1
      this.counters.delivered += 1
      if (event.active) this.wake(candidate.id)
    }
    return receipt
  }

  /** Delivery health for `status()`. */
  status(): ContextStatus {
    let oldest: number | undefined
    for (const sessionId of this.options.sessions.candidates()) {
      for (const event of this.options.store.queue(sessionId.id).events) {
        if (oldest === undefined || event.createdAt < oldest) oldest = event.createdAt
      }
    }
    return {
      kinds: this.kinds.size,
      queued: this.options.store.queuedCount(),
      ...(oldest === undefined ? {} : { oldestEventAt: oldest }),
      ...this.counters,
    }
  }

  /**
   * Build and consume the merged snapshot for one Agent's step.
   * @param agent - Agent whose undelivered events are injected.
   * @returns the snapshot message, or undefined when the queue holds nothing deliverable.
   */
  private async drain(agent: Agent): Promise<UserMessage | undefined> {
    const sessionId = agent.session.id
    const message = await this.withQueue(sessionId, async () => {
      const queue = this.options.store.queue(sessionId)
      const now = Date.now()
      const kept: ContextEvent[] = []
      let expired = 0
      for (const event of queue.events) {
        const ttl = event.ttlMs ?? this.kinds.get(event.kind)?.ttlMs ?? this.options.defaults.ttlMs
        if (now - event.createdAt > ttl) {
          expired += 1
          continue
        }
        kept.push(event)
      }
      if (expired > 0) this.counters.dropped += expired
      if (expired > 0) this.options.diagnostics.report({
        code: 'CONTEXT_TTL',
        message: `session ${sessionId} dropped ${String(expired)} expired event(s)`,
      })
      if (kept.length === 0) {
        if (expired > 0) {
          await this.options.store.mutateQueue(sessionId, () => ({ events: [], consumed: queue.consumed, dedupe: queue.dedupe }))
        }
        return undefined
      }

      const selected: ContextEvent[] = []
      const sections: { name: string; text: string }[] = []
      let bytes = 0
      for (const event of kept.slice(0, this.options.maxEventsPerSnapshot)) {
        const rendered = clampBytes(renderEvent(event), Math.max(1, this.options.maxSnapshotBytes - bytes))
        if (selected.length > 0 && bytes + Buffer.byteLength(rendered, 'utf8') > this.options.maxSnapshotBytes) break
        selected.push(event)
        sections.push({ name: `${RELAY_SECTION}:${event.kind}`, text: rendered })
        bytes += Buffer.byteLength(rendered, 'utf8')
      }
      if (selected.length === 0) return undefined

      const consumedIds = selected.map(event => event.id)
      const consumed = new Set(consumedIds)
      const remaining = kept.filter(event => !consumed.has(event.id))
      this.retireSnapshots(agent)
      // Commit the cursor before the loop appends the message: a step that fails
      // later still shows the snapshot in history, so it must not be re-delivered.
      await this.options.store.mutateQueue(sessionId, () => ({
        events: remaining,
        consumed: [...queue.consumed, ...consumedIds].slice(-QUEUE_HISTORY_LIMIT),
        dedupe: queue.dedupe,
      }))
      this.counters.consumed += selected.length
      this.pendingWake.delete(sessionId)

      const text = `[context] ${String(selected.length)} context event(s) for this step.\n`
        + sections.map(section => section.text).join('\n')
      return createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: RELAY_SOURCE, form: 'snapshot', sections },
      })
    })
    return message
  }

  /**
   * Wake one session for an active event, coalescing repeats.
   * @param sessionId - session that accepted an active event.
   */
  private wake(sessionId: string): void {
    if (this.state !== 'enabled') {
      this.counters.merged += 1
      return
    }
    const agent = this.options.sessions.agentOf(sessionId)
    if (agent === undefined) {
      // Offline: the queue is the wake-up; the next step injects it.
      this.counters.merged += 1
      return
    }
    if (this.pendingWake.has(sessionId)) {
      this.counters.merged += 1
      return
    }
    this.pendingWake.add(sessionId)
    try {
      agent.followup(createUserMessage({
        content: [{ type: 'text', text: '[context] Context events are queued for this session; they are injected when this turn starts.' }],
        source: {
          kind: RELAY_SOURCE,
          form: 'snapshot',
          sections: [{ name: RELAY_SECTION, text: '[context] active context event' }],
        },
      }))
    } catch (error: unknown) {
      this.pendingWake.delete(sessionId)
      this.counters.failed += 1
      this.options.diagnostics.report({
        code: 'CONTEXT_WAKE_FAILED',
        message: `cannot wake session ${sessionId}: ${describeError(error)}`,
      })
    }
  }

  /**
   * Remove every earlier relay snapshot from one Agent's visible surface, so
   * the new snapshot replaces the previous turn's annotation instead of
   * accumulating beside it.
   * @param agent - Agent whose surface is rewritten.
   */
  private retireSnapshots(agent: Agent): void {
    for (const seq of [...agent.session.surface.nodes]) {
      // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; the surface API is the read path here.
      const event = agent.session.eventAt(seq)
      if (event?.type !== 'user/message' || event.data.source.kind !== RELAY_SOURCE) continue
      agent.session.append('user/message', createUserMessage({
        content: [],
        source: { kind: RELAY_SOURCE, form: 'snapshot', sections: [] },
      }), {
        surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq },
        sourceEventSeqs: [seq],
      })
    }
  }

  private subscribed(sessionId: string, presetId: string | undefined, kind: string): boolean {
    const ref: ScopeRef = { kind: 'session', id: sessionId }
    const own = this.options.store.switchValue(ref, 'contexts', kind)
    if (own !== undefined) return own
    if (presetId === undefined) return false
    return this.options.store.switchValue({ kind: 'preset', id: presetId }, 'contexts', kind) ?? false
  }

  private normalize(input: ContextEventInput, kind: ResolvedContextKind): ContextEvent {
    if (typeof input.summary !== 'string') {
      throw new CapabilityHostError('EVENT_INVALID', 'a context event needs a summary string', { eventKind: kind.kind })
    }
    if (typeof input.source !== 'string' || input.source === '') {
      throw new CapabilityHostError('EVENT_INVALID', 'a context event needs a source', { eventKind: kind.kind })
    }
    const id = input.id ?? crypto.randomUUID()
    const maxBytes = input.maxBytes ?? kind.maxBytes
    const ttlMs = input.ttlMs ?? kind.ttlMs
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new CapabilityHostError('EVENT_INVALID', `ttlMs must be a positive finite number, got ${String(ttlMs)}`, { eventKind: kind.kind })
    }
    if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
      throw new CapabilityHostError('EVENT_INVALID', `maxBytes must be a positive finite number, got ${String(maxBytes)}`, { eventKind: kind.kind })
    }
    let serialized: string
    try {
      const json = JSON.stringify(input.payload ?? null)
      if (json === undefined) throw new Error('the payload has no JSON form')
      serialized = json
    } catch (error: unknown) {
      throw new CapabilityHostError('EVENT_PAYLOAD_INVALID', `payload is not JSON-serializable: ${describeError(error)}`, {
        eventKind: kind.kind, eventId: id,
      })
    }
    const bytes = Buffer.byteLength(serialized, 'utf8')
    if (bytes > maxBytes) {
      throw new CapabilityHostError('EVENT_TOO_LARGE', `payload is ${String(bytes)} bytes; the limit is ${String(maxBytes)}`, {
        eventKind: kind.kind, eventId: id, bytes, maxBytes,
      })
    }
    return {
      id,
      kind: kind.kind,
      source: input.source,
      summary: input.summary,
      // A JSON round trip is the canonical copy: no shared mutable object and no
      // value JSON cannot carry reaches a subscriber.
      payload: JSON.parse(serialized) as unknown,
      visibility: normalizeVisibility(input.visibility, kind.kind),
      active: input.active ?? kind.activeByDefault,
      dedupeKey: input.dedupeKey ?? id,
      createdAt: input.createdAt ?? Date.now(),
      ttlMs,
      maxBytes,
    }
  }

  private remember(dedupe: Readonly<Record<string, number>>, key: string, at: number): Record<string, number> {
    const next: Record<string, number> = { ...dedupe, [key]: at }
    const keys = Object.keys(next)
    if (keys.length <= QUEUE_HISTORY_LIMIT) return next
    const ordered = keys.sort((left, right) => (next[left] ?? 0) - (next[right] ?? 0))
    for (const stale of ordered.slice(0, keys.length - QUEUE_HISTORY_LIMIT)) delete next[stale]
    return next
  }

  private async withQueue<T>(sessionId: string, run: () => Promise<T>): Promise<T> {
    const previous = this.queueChains.get(sessionId) ?? Promise.resolve()
    const next = previous.then(run, run)
    this.queueChains.set(sessionId, next.then(() => undefined, () => undefined))
    return next
  }
}

/**
 * Validate a publisher's visibility restriction.
 * @param visibility - candidate restriction.
 * @param kind - kind name, used in the diagnostic.
 * @returns the normalized restriction, empty when absent.
 */
function normalizeVisibility(visibility: ContextVisibility | undefined, kind: string): ContextVisibility {
  if (visibility === undefined) return {}
  const ids = (value: readonly string[] | undefined, label: string): string[] | undefined => {
    if (value === undefined) return undefined
    if (!Array.isArray(value) || value.some(entry => typeof entry !== 'string' || entry === '')) {
      throw new CapabilityHostError('EVENT_INVALID', `visibility.${label} must be a non-empty string array`, { eventKind: kind })
    }
    return [...value]
  }
  const presetIds = ids(visibility.presetIds, 'presetIds')
  const sessionIds = ids(visibility.sessionIds, 'sessionIds')
  return {
    ...(presetIds === undefined ? {} : { presetIds }),
    ...(sessionIds === undefined ? {} : { sessionIds }),
  }
}

/**
 * Whether one session is inside a publisher's visibility restriction.
 * @param visibility - the event's restriction.
 * @param sessionId - candidate session.
 * @param presetId - preset the session runs.
 * @returns true when the restriction allows the session.
 */
function visibleTo(visibility: ContextVisibility, sessionId: string, presetId: string | undefined): boolean {
  if (visibility.sessionIds !== undefined && !visibility.sessionIds.includes(sessionId)) return false
  if (visibility.presetIds === undefined) return true
  return presetId !== undefined && visibility.presetIds.includes(presetId)
}

/**
 * Render one event for the merged snapshot.
 * @param event - the event to render.
 * @returns model-facing text.
 */
function renderEvent(event: ContextEvent): string {
  const at = new Date(event.createdAt).toISOString()
  return `- ${event.kind} from ${event.source} (${event.active ? 'active' : 'passive'}) at ${at}\n`
    + `  summary: ${event.summary}\n`
    + `  payload: ${safeJson(event.payload)}`
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? 'null'
  } catch {
    return '[unserializable payload]'
  }
}

/**
 * Clamp text to a byte ceiling without splitting a multi-byte character.
 * @param text - text to clamp.
 * @param maxBytes - ceiling in UTF-8 bytes.
 * @returns the original text, or a truncated form ending in an ellipsis.
 */
function clampBytes(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text
  const budget = Math.max(0, maxBytes - 3)
  let out = ''
  let used = 0
  for (const char of text) {
    const size = Buffer.byteLength(char, 'utf8')
    if (used + size > budget) break
    out += char
    used += size
  }
  return `${out}…`
}

/** A queue record type re-exported for tests that inspect persisted state. */
export type { QueueRecord }

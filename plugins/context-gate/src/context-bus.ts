/**
 * The context gate's delivery bus: provider publications, per-session queues
 * and cursors, subscription and visibility filtering, dedupe, TTL, and the one
 * merged snapshot injected before a step.
 *
 * Delivery is subscription AND visibility: a session receives an event only
 * when it subscribed the kind, and only when the publisher's visibility still
 * allows it. A publisher can narrow the target set, never widen it.
 *
 * Active events are coalesced while the Agent is idle. The first active event
 * starts a quiet-window timer; further active events inside that window extend
 * it, and `maxWaitMs` caps the total postponement. The wake-up is one follow-up
 * message, and the merged snapshot drains at the next pre-step. A busy Agent is
 * never given a second turn: its events stay queued for a pre-step or for the
 * idle transition.
 *
 * @module @elysia/context-gate/context-bus
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import type { ContextFormed, UserMessage } from '@deepseek-ai/dsh-llm'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type {
  ContextEvent, ContextEventInput, ContextKindRegistration, ContextVisibility, EventOutcome,
  PublishReceipt, ResolvedContextKind,
} from './types.ts'
import type { ContextGateStore } from './state.ts'
import { QUEUE_HISTORY_LIMIT } from './state.ts'
import { ContextGateError, describeError } from './errors.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'context-gate-context-relay': { kind: 'context-gate-context-relay' } & ContextFormed
  }
}

/** Source kind of every relay message: the wake-up and the merged snapshot. */
export const RELAY_SOURCE = 'context-gate-context-relay'

/** Section name the merged snapshot contributes. */
export const RELAY_SECTION = 'context-gate-context-relay'

/** Traffic defaults for kinds that do not declare their own. */
export interface ContextDefaults {
  /** Default age ceiling for an undelivered event. */
  readonly ttlMs: number
  /** Default per-event size ceiling. */
  readonly maxBytes: number
  /** Default undelivered events retained per session. */
  readonly maxQueueDepth: number
}

/** The Agent surface the bus reads: identity, lifecycle state, and one wake path. */
export interface ContextAgent {
  /** Live session whose queue this Agent drains. */
  readonly session: Session
  /** `idle` may receive one wake-up; `running` never does while busy. */
  readonly status: 'idle' | 'running'
  /** Queue one follow-up turn; the batch window calls this at most once. */
  followup(message: UserMessage): void
}

/** Options one bus instance reads. */
export interface ContextBusOptions {
  /** Host context whose listeners and timer owners the bus registers. */
  readonly ctx: Context
  /** Persisted queues, subscriptions, and the event log. */
  readonly store: ContextGateStore
  /** Live-agent lookup; a persisted session has no Agent. */
  readonly agentOf: (sessionId: string) => ContextAgent | undefined
  /** Every session a publication may target. */
  readonly candidates: () => readonly string[]
  /** Traffic defaults. */
  readonly defaults: ContextDefaults
  /** Maximum events merged into one snapshot. */
  readonly maxEventsPerSnapshot: number
  /** Maximum bytes of one merged snapshot. */
  readonly maxSnapshotBytes: number
  /** Quiet window after the first active event, in milliseconds. */
  readonly batchMs: number
  /** Total postponement ceiling from the first active event, in milliseconds. */
  readonly maxWaitMs: number
}

/** One session's snapshot request while it is being prepared. */
interface DrainResult {
  readonly message: UserMessage | undefined
  readonly consumed: number
}

/** One session's pending quiet-window timer. */
interface PendingWake {
  /** When the current batching window started. */
  readonly firstAt: number
  /** Timer that fires when the window closes. */
  readonly timer: ReturnType<typeof setTimeout>
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
  private readonly wakeTimers = new Map<string, PendingWake>()
  private readonly queueChains = new Map<string, Promise<unknown>>()
  private attached = false

  /** @param options - context, store, session lookup, limits, and batching. */
  constructor(private readonly options: ContextBusOptions) {}

  /**
   * Declare one publishable kind.
   * @param registration - kind name, description, and delivery limits.
   * @returns a disposer that removes the declaration.
   * @throws Error when the kind is empty or already declared, which is a provider bug.
   */
  registerKind(registration: ContextKindRegistration): () => void {
    const kind = registration.kind.trim()
    const nameZh = registration.nameZh.trim()
    const description = registration.description.trim()
    if (kind === '') throw new Error('context-gate: a context kind needs a name')
    if (nameZh === '') throw new Error(`context-gate: context kind ${JSON.stringify(kind)} needs a Chinese display name`)
    if (description === '') throw new Error(`context-gate: context kind ${JSON.stringify(kind)} needs a description`)
    if (this.kinds.has(kind)) throw new Error(`context-gate: context kind ${JSON.stringify(kind)} is already declared`)
    this.kinds.set(kind, {
      kind,
      nameZh,
      description,
      activeByDefault: registration.activeByDefault ?? false,
      ttlMs: registration.ttlMs ?? this.options.defaults.ttlMs,
      maxBytes: registration.maxBytes ?? this.options.defaults.maxBytes,
      maxQueueDepth: registration.maxQueueDepth ?? this.options.defaults.maxQueueDepth,
    })
    return () => { this.kinds.delete(kind) }
  }

  /** Registered kinds as the panel lists them. */
  listKinds(): readonly ResolvedContextKind[] {
    return [...this.kinds.values()]
  }

  /** Whether one kind is registered. */
  hasKind(kind: string): boolean {
    return this.kinds.has(kind)
  }

  /**
   * Attach the global pre-step, status, and timer owners. Calling it again is a no-op.
   */
  attach(): void {
    if (this.attached) return
    this.attached = true
    this.options.ctx.effect(
      () => this.options.ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
        const decision = await next()
        if (decision.kind === 'reject' || signal.aborted) return decision
        let injected: UserMessage | undefined
        try {
          injected = (await this.drain(agent)).message
        } catch (error: unknown) {
          // Nothing was consumed: leaving the queue intact lets the next step retry.
          this.fail(agent.session.id, `context injection failed: ${describeError(error)}`)
          return decision
        }
        if (injected === undefined) return decision
        return { ...decision, messages: [...decision.messages, injected] }
      }, { prepend: true }),
      'context-gate.pre-step',
    )
    this.options.ctx.effect(
      () => this.options.ctx.on('agent/status', ({ agent, status }) => {
        if (status === 'idle') this.resume(agent)
      }),
      'context-gate.agent-status',
    )
    this.options.ctx.effect(() => () => { this.dispose() }, 'context-gate.wake-timers')
  }

  /** Cancel every quiet-window timer owned by this bus. */
  dispose(): void {
    for (const pending of this.wakeTimers.values()) clearTimeout(pending.timer)
    this.wakeTimers.clear()
    this.pendingWake.clear()
  }

  /**
   * Publish one event to every subscribed, visible session.
   * @param input - the publication.
   * @returns delivery accounting for the publication.
   * @throws ContextGateError `CONTEXT_UNKNOWN`, `EVENT_INVALID`, `EVENT_PAYLOAD_INVALID`, or `EVENT_TOO_LARGE`.
   */
  async publish(input: ContextEventInput): Promise<PublishReceipt> {
    const kind = this.kinds.get(input.kind)
    if (kind === undefined) {
      throw new ContextGateError('CONTEXT_UNKNOWN', `context kind ${JSON.stringify(input.kind)} is not registered in this Host`, {
        eventKind: input.kind,
      })
    }
    const event = this.normalize(input, kind)
    const now = Date.now()
    const receipt = { eventId: event.id, delivered: 0, suppressed: 0, failed: 0 }
    const candidates = this.options.candidates()
    for (const candidate of candidates) {
      if (!this.subscribed(candidate, event.kind) || !visibleTo(event.visibility, candidate)) {
        receipt.suppressed += 1
        continue
      }
      try {
        const outcome = await this.withQueue(candidate, async () => {
          const queue = this.options.store.queue(candidate)
          const seenAt = queue.dedupe[event.dedupeKey]
          if (seenAt !== undefined && now - seenAt <= kind.ttlMs) return 'suppressed' as const
          const copy = structuredClone(event)
          let dropped = 0
          const events = [...queue.events, copy]
          while (events.length > kind.maxQueueDepth) {
            events.shift()
            dropped += 1
          }
          const dedupe = remember(queue.dedupe, event.dedupeKey, now)
          await this.options.store.mutateQueue(candidate, () => ({ events, consumed: queue.consumed, dedupe }))
          if (dropped > 0) {
            await this.log(candidate, event.kind, 'dropped', `${String(dropped)} oldest event(s) removed from the queue`)
          }
          return 'delivered' as const
        })
        if (outcome === 'suppressed') {
          receipt.suppressed += 1
          continue
        }
        receipt.delivered += 1
        await this.log(candidate, event.kind, 'delivered', `queue accepted event ${event.id}`)
        if (event.active) this.schedule(candidate)
      } catch (error: unknown) {
        receipt.failed += 1
        this.fail(candidate, `publish failed: ${describeError(error)}`, event.kind)
      }
    }
    for (const candidate of candidates) {
      if (!this.subscribed(candidate, event.kind)) continue
      await this.log(candidate, event.kind, 'published', `from ${event.source}: ${event.summary}`)
    }
    return receipt
  }

  /**
   * Build and consume one session's merged snapshot.
   * @param agent - Agent whose undelivered events are injected.
   * @returns the snapshot message and the number of consumed events.
   */
  private async drain(agent: ContextAgent): Promise<DrainResult> {
    const sessionId = agent.session.id
    return await this.withQueue(sessionId, async () => {
      this.clearWake(sessionId)
      const queue = this.options.store.queue(sessionId)
      const now = Date.now()
      const kept: ContextEvent[] = []
      let expired = 0
      for (const event of queue.events) {
        if (now - event.createdAt > this.ttlOf(event)) {
          expired += 1
          continue
        }
        kept.push(event)
      }
      if (expired > 0) await this.log(sessionId, 'context', 'dropped', `${String(expired)} expired event(s)`)
      if (kept.length === 0) {
        if (expired > 0) {
          await this.options.store.mutateQueue(sessionId, () => ({ events: [], consumed: queue.consumed, dedupe: queue.dedupe }))
        }
        return { message: undefined, consumed: 0 }
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
      if (selected.length === 0) return { message: undefined, consumed: 0 }

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
      for (const event of selected) {
        await this.log(sessionId, event.kind, 'consumed', `injected ${event.id}`)
      }

      const text = `[context] ${String(selected.length)} context event(s) for this step.\n`
        + sections.map(section => section.text).join('\n')
      return {
        message: createUserMessage({
          content: [{ type: 'text', text }],
          source: { kind: RELAY_SOURCE, form: 'snapshot', sections },
        }),
        consumed: selected.length,
      }
    })
  }

  /**
   * Arm or extend one session's quiet-window timer after an active event.
   * @param sessionId - session that accepted an active event.
   */
  private schedule(sessionId: string): void {
    const existing = this.wakeTimers.get(sessionId)
    if (existing !== undefined) {
      this.arm(sessionId, existing.firstAt)
      return
    }
    if (this.pendingWake.has(sessionId)) return
    const agent = this.options.agentOf(sessionId)
    if (agent === undefined || agent.status !== 'idle') {
      // Busy or offline: the queue is the wake-up. A pre-step drains it while a
      // turn is open; the idle transition retries the batch while it is not.
      return
    }
    if (!this.hasLiveActiveEvent(sessionId)) return
    this.arm(sessionId, Date.now())
  }

  /**
   * Replace the timer for one batching window, preserving its start time.
   * @param sessionId - target session.
   * @param firstAt - when the current window started.
   */
  private arm(sessionId: string, firstAt: number): void {
    const current = this.wakeTimers.get(sessionId)
    if (current !== undefined) clearTimeout(current.timer)
    const elapsed = Math.max(0, Date.now() - firstAt)
    const remaining = Math.max(0, this.options.maxWaitMs - elapsed)
    const delay = Math.min(Math.max(0, this.options.batchMs), remaining)
    const timer = setTimeout(() => { this.flush(sessionId) }, delay)
    this.wakeTimers.set(sessionId, { firstAt, timer })
  }

  /**
   * Close one batching window and open at most one follow-up turn.
   * @param sessionId - session whose quiet window closed.
   */
  private flush(sessionId: string): void {
    this.wakeTimers.delete(sessionId)
    if (this.pendingWake.has(sessionId)) return
    const agent = this.options.agentOf(sessionId)
    // A running Agent is mid-turn: do not open another turn. The queue drains at
    // its next pre-step, or the idle transition re-arms this batch.
    if (agent === undefined || agent.status !== 'idle') return
    if (!this.hasLiveActiveEvent(sessionId)) return
    this.pendingWake.add(sessionId)
    try {
      agent.followup(createUserMessage({
        content: [{ type: 'text', text: '[context] Context events are queued for this session; they are injected when this turn starts.' }],
        source: { kind: RELAY_SOURCE, form: 'snapshot', sections: [{ name: RELAY_SECTION, text: '[context] active context event' }] },
      }))
    } catch (error: unknown) {
      this.pendingWake.delete(sessionId)
      this.fail(sessionId, `cannot wake session: ${describeError(error)}`)
    }
  }

  /**
   * Re-arm the batch for one Agent that just became idle with active events queued.
   * @param agent - Agent whose status flipped to idle.
   */
  private resume(agent: ContextAgent): void {
    const sessionId = agent.session.id
    if (this.wakeTimers.has(sessionId) || this.pendingWake.has(sessionId)) return
    if (!this.hasLiveActiveEvent(sessionId)) return
    if (agent.status !== 'idle') return
    this.arm(sessionId, Date.now())
  }

  /** Cancel the timer and pending-wake marker for one session. */
  private clearWake(sessionId: string): void {
    const pending = this.wakeTimers.get(sessionId)
    if (pending !== undefined) {
      clearTimeout(pending.timer)
      this.wakeTimers.delete(sessionId)
    }
    this.pendingWake.delete(sessionId)
  }

  /** Whether one session has an active, unexpired queued event. */
  private hasLiveActiveEvent(sessionId: string): boolean {
    const now = Date.now()
    return this.options.store.queue(sessionId).events.some(event => event.active && now - event.createdAt <= this.ttlOf(event))
  }

  /** The TTL one queued event observes. */
  private ttlOf(event: ContextEvent): number {
    return event.ttlMs ?? this.kinds.get(event.kind)?.ttlMs ?? this.options.defaults.ttlMs
  }

  /**
   * Remove every earlier relay snapshot from one Agent's visible surface, so
   * the new snapshot replaces the previous turn's annotation instead of
   * accumulating beside it.
   * @param agent - Agent whose surface is rewritten.
   */
  private retireSnapshots(agent: ContextAgent): void {
    for (const seq of [...agent.session.surface.nodes]) {
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

  private subscribed(sessionId: string, kind: string): boolean {
    return this.options.store.contexts(sessionId)[kind] ?? false
  }

  private normalize(input: ContextEventInput, kind: ResolvedContextKind): ContextEvent {
    if (typeof input.summary !== 'string') {
      throw new ContextGateError('EVENT_INVALID', 'a context event needs a summary string', { eventKind: kind.kind })
    }
    if (typeof input.source !== 'string' || input.source === '') {
      throw new ContextGateError('EVENT_INVALID', 'a context event needs a source', { eventKind: kind.kind })
    }
    const id = input.id ?? crypto.randomUUID()
    const maxBytes = input.maxBytes ?? kind.maxBytes
    const ttlMs = input.ttlMs ?? kind.ttlMs
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new ContextGateError('EVENT_INVALID', `ttlMs must be a positive finite number, got ${String(ttlMs)}`, { eventKind: kind.kind })
    }
    if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
      throw new ContextGateError('EVENT_INVALID', `maxBytes must be a positive finite number, got ${String(maxBytes)}`, { eventKind: kind.kind })
    }
    let serialized: string
    try {
      const json = JSON.stringify(input.payload ?? null)
      if (json === undefined) throw new Error('the payload has no JSON form')
      serialized = json
    } catch (error: unknown) {
      throw new ContextGateError('EVENT_PAYLOAD_INVALID', `payload is not JSON-serializable: ${describeError(error)}`, {
        eventKind: kind.kind, eventId: id,
      })
    }
    const bytes = Buffer.byteLength(serialized, 'utf8')
    if (bytes > maxBytes) {
      throw new ContextGateError('EVENT_TOO_LARGE', `payload is ${String(bytes)} bytes; the limit is ${String(maxBytes)}`, {
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

  private fail(sessionId: string, message: string, kind?: string): void {
    void this.log(sessionId, kind ?? 'context', 'failed', message)
  }

  private async log(sessionId: string, kind: string, outcome: EventOutcome, detail: string): Promise<void> {
    await this.options.store.logEvent(sessionId, { id: crypto.randomUUID(), kind, outcome, at: Date.now(), detail })
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
  const sessionIds = visibility.sessionIds
  if (sessionIds === undefined) return {}
  if (!Array.isArray(sessionIds) || sessionIds.some(entry => typeof entry !== 'string' || entry === '')) {
    throw new ContextGateError('EVENT_INVALID', 'visibility.sessionIds must be a non-empty string array', { eventKind: kind })
  }
  return { sessionIds: [...sessionIds] }
}

/**
 * Whether one session is inside a publisher's visibility restriction.
 * @param visibility - the event's restriction.
 * @param sessionId - candidate session.
 * @returns true when the restriction allows the session.
 */
function visibleTo(visibility: ContextVisibility, sessionId: string): boolean {
  return visibility.sessionIds === undefined || visibility.sessionIds.includes(sessionId)
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

function remember(dedupe: Readonly<Record<string, number>>, key: string, at: number): Record<string, number> {
  const next: Record<string, number> = { ...dedupe, [key]: at }
  const keys = Object.keys(next)
  if (keys.length <= QUEUE_HISTORY_LIMIT) return next
  const ordered = keys.sort((left, right) => (next[left] ?? 0) - (next[right] ?? 0))
  for (const stale of ordered.slice(0, keys.length - QUEUE_HISTORY_LIMIT)) delete next[stale]
  return next
}
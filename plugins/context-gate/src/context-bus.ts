/**
 * The context gate's delivery bus: generic event-envelope normalization,
 * provider publications, per-session queues and cursors, subscription and
 * visibility filtering, dedupe, TTL, and the one merged snapshot injected
 * before a step.
 *
 * Delivery is subscription AND visibility: a session receives an event only
 * when it subscribed the kind, and only when the publisher's visibility still
 * allows it. A publisher can narrow the target set, never widen it. The
 * event's source and origin are metadata for attribution, logging, dedupe, and
 * causality; they never filter delivery.
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
import type { ContentBlock, ContextFormed, UserMessage } from '@deepseek-ai/dsh-llm'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type {
  ContextEvent, ContextEventInput, ContextKindRegistration, ContextOrigin, ContextVisibility,
  EventOutcome, EventParameterOption, EventParameterRegistration, EventParameterType, PublishReceipt, ResolvedContextKind,
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

/** One owner-only injection that is not routed through subscriptions. */
export interface DirectEventInput {
  /** Log/persistence kind, such as `agent.timer`. It need not be registered. */
  readonly kind: string
  /** Producer identity for the log. */
  readonly source: string
  /** One-line summary shown to the model. */
  readonly summary: string
  /** Structured body. */
  readonly params?: unknown
  /** Admitted content blocks injected with the snapshot. */
  readonly content?: ContentBlock[]
  /** True opens a turn after the batch window. */
  readonly active: boolean
  /** Dedupe identity within kind and source. */
  readonly dedupeKey?: string
  /** Age ceiling for the queued injection. */
  readonly ttlMs?: number
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
    if (typeof registration !== 'object' || registration === null) {
      throw new Error('context-gate: a context kind registration must be an object')
    }
    if (typeof registration.kind !== 'string' || registration.kind.trim() === '') {
      throw new Error('context-gate: a context kind needs a name')
    }
    const kind = registration.kind.trim()
    if (typeof registration.nameZh !== 'string' || registration.nameZh.trim() === '') {
      throw new Error(`context-gate: context kind ${JSON.stringify(kind)} needs a Chinese display name`)
    }
    const nameZh = registration.nameZh.trim()
    if (typeof registration.description !== 'string' || registration.description.trim() === '') {
      throw new Error(`context-gate: context kind ${JSON.stringify(kind)} needs a description`)
    }
    const description = registration.description.trim()
    if (this.kinds.has(kind)) throw new Error(`context-gate: context kind ${JSON.stringify(kind)} is already declared`)
    const ttlMs = registration.ttlMs ?? this.options.defaults.ttlMs
    const maxBytes = registration.maxBytes ?? this.options.defaults.maxBytes
    const maxQueueDepth = registration.maxQueueDepth ?? this.options.defaults.maxQueueDepth
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new Error(`context-gate: context kind ${JSON.stringify(kind)} needs a positive ttlMs`)
    }
    if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
      throw new Error(`context-gate: context kind ${JSON.stringify(kind)} needs a positive maxBytes`)
    }
    if (!Number.isInteger(maxQueueDepth) || maxQueueDepth <= 0) {
      throw new Error(`context-gate: context kind ${JSON.stringify(kind)} needs a positive integer maxQueueDepth`)
    }
    this.kinds.set(kind, {
      kind,
      nameZh,
      description,
      activeByDefault: registration.activeByDefault ?? false,
      ttlMs,
      maxBytes,
      maxQueueDepth,
      parameters: normalizeParameters(registration.parameters, kind),
    })
    return () => { this.kinds.delete(kind) }
  }

  /** Registered kinds as the panel lists them. */
  listKinds(): readonly ResolvedContextKind[] {
    return [...this.kinds.values()]
  }

  /** One registered kind, when this Host knows it. */
  kind(kind: string): ResolvedContextKind | undefined {
    return this.kinds.get(kind)
  }

  /**
   * Wake one idle session that has an active queued event.
   * @param sessionId - target session.
   */
  wakeSession(sessionId: string): void {
    this.schedule(sessionId)
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
    if (typeof input !== 'object' || input === null) {
      throw new ContextGateError('EVENT_INVALID', 'a context event publication must be an object')
    }
    const kind = this.kinds.get(input.kind)
    if (kind === undefined) {
      throw new ContextGateError('CONTEXT_UNKNOWN', `context kind ${JSON.stringify(input.kind)} is not registered in this Host`, {
        eventKind: input.kind,
      })
    }
    const event = this.normalize(input, kind)
    const now = Date.now()
    const token = dedupeToken(event)
    const receipt = { eventId: event.id, delivered: 0, suppressed: 0, failed: 0 }
    // Absence observes every kind published into the gate, subscribed or not.
    await this.options.store.noteKindsSeen([event.kind], now)
    const candidates = this.options.candidates()
    for (const candidate of candidates) {
      if (!this.subscribed(candidate, event.kind) || !visibleTo(event.visibility, candidate)) {
        receipt.suppressed += 1
        continue
      }
      try {
        const outcome = await this.withQueue(candidate, async () => {
          const queue = this.options.store.queue(candidate)
          // A document written before the source-scoped token used the bare
          // dedupe key; keep that key working during the additive migration.
          const seenAt = queue.dedupe[token] ?? queue.dedupe[event.dedupeKey]
          if (seenAt !== undefined && now - seenAt <= this.ttlOf(event)) return 'suppressed' as const
          const copy = structuredClone(event)
          const events = [...queue.events, copy]
          const dropped: ContextEvent[] = []
          let queued = events.filter(entry => entry.kind === event.kind).length
          while (queued > kind.maxQueueDepth) {
            const index = events.findIndex(entry => entry.kind === event.kind)
            if (index < 0) break
            const [removed] = events.splice(index, 1)
            queued -= 1
            if (removed !== undefined) dropped.push(removed)
          }
          const dedupe = remember(queue.dedupe, token, now)
          await this.options.store.mutateQueue(candidate, () => ({ events, consumed: queue.consumed, dedupe }))
          for (const removed of dropped) {
            await this.log(candidate, 'dropped', 'oldest event removed from the queue', removed)
          }
          return 'delivered' as const
        })
        if (outcome === 'suppressed') {
          receipt.suppressed += 1
          continue
        }
        receipt.delivered += 1
        await this.log(candidate, 'delivered', `queue accepted event ${event.id}`, event)
        if (event.active) this.schedule(candidate)
      } catch (error: unknown) {
        receipt.failed += 1
        await this.log(candidate, 'failed', `publish failed: ${describeError(error)}`, event)
      }
    }
    for (const candidate of candidates) {
      if (!this.subscribed(candidate, event.kind) || !visibleTo(event.visibility, candidate)) continue
      await this.log(candidate, 'published', `from ${event.source}: ${event.summary}`, event)
    }
    return receipt
  }

  /**
   * Queue one owner-only injection without routing it through subscriptions.
   * Timer and absence events use this path: they belong to their owner and are
   * not subscribable kinds.
   * @param sessionId - owner session.
   * @param input - the injection.
   * @returns after the queue write is durable.
   */
  async deliverDirect(sessionId: string, input: DirectEventInput): Promise<void> {
    const now = Date.now()
    const ttlMs = input.ttlMs ?? this.options.defaults.ttlMs
    const maxDepth = this.kinds.get(input.kind)?.maxQueueDepth ?? this.options.defaults.maxQueueDepth
    const id = crypto.randomUUID()
    const dedupeKey = input.dedupeKey ?? id
    const token = `${input.kind}\u0000${input.source}\u0000${dedupeKey}`
    const event: ContextEvent = {
      id,
      kind: input.kind,
      source: input.source,
      summary: input.summary,
      ...(input.params === undefined ? {} : { params: cloneJson(input.params, input.kind) }),
      ...(input.content === undefined ? {} : { content: input.content }),
      visibility: {},
      active: input.active,
      dedupeKey,
      ttlMs,
      createdAt: now,
    }
    const delivered = await this.withQueue(sessionId, async () => {
      const queue = this.options.store.queue(sessionId)
      const seenAt = queue.dedupe[token]
      if (seenAt !== undefined && now - seenAt <= ttlMs) return false
      const events = [...queue.events, event]
      const dropped: ContextEvent[] = []
      let queued = events.filter(entry => entry.kind === event.kind).length
      while (queued > maxDepth) {
        const index = events.findIndex(entry => entry.kind === event.kind)
        if (index < 0) break
        const [removed] = events.splice(index, 1)
        queued -= 1
        if (removed !== undefined) dropped.push(removed)
      }
      const dedupe = remember(queue.dedupe, token, now)
      await this.options.store.mutateQueue(sessionId, () => ({ events, consumed: queue.consumed, dedupe }))
      for (const removed of dropped) {
        await this.log(sessionId, 'dropped', 'oldest event removed from the queue', removed)
      }
      return true
    })
    if (!delivered) return
    await this.log(sessionId, 'delivered', `queue accepted ${event.kind} ${event.id}`, event)
    if (event.active) this.schedule(sessionId)
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
      const expired: ContextEvent[] = []
      for (const event of queue.events) {
        if (now - event.createdAt > this.ttlOf(event)) {
          expired.push(event)
          continue
        }
        kept.push(event)
      }
      if (kept.length === 0) {
        if (expired.length > 0) {
          await this.options.store.mutateQueue(sessionId, () => ({ events: [], consumed: queue.consumed, dedupe: queue.dedupe }))
          for (const event of expired) {
            await this.log(sessionId, 'dropped', 'expired before injection', event)
          }
        }
        return { message: undefined, consumed: 0 }
      }

      const selected: ContextEvent[] = []
      const sections: { name: string; text: string }[] = []
      let bytes = 0
      for (const event of kept.slice(0, this.options.maxEventsPerSnapshot)) {
        const rendered = clampBytes(renderEvent(event), Math.max(1, this.options.maxSnapshotBytes - bytes))
        const renderedBytes = Buffer.byteLength(rendered, 'utf8')
        const contentBytes = event.content === undefined ? 0 : Buffer.byteLength(safeJson(event.content), 'utf8')
        if (selected.length > 0 && bytes + renderedBytes + contentBytes > this.options.maxSnapshotBytes) break
        selected.push(event)
        sections.push({ name: `${RELAY_SECTION}:${event.kind}`, text: rendered })
        bytes += renderedBytes + contentBytes
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
      for (const event of expired) {
        await this.log(sessionId, 'dropped', 'expired before injection', event)
      }
      for (const event of selected) {
        await this.log(sessionId, 'consumed', `injected ${event.id}`, event)
      }

      const content: ContentBlock[] = [{
        type: 'text',
        text: `[context] ${String(selected.length)} context event(s) for this step.\n`
          + sections.map(section => section.text).join('\n'),
      }]
      for (const event of selected) {
        if (event.content === undefined || event.content.length === 0) continue
        content.push({ type: 'text', text: `[context] content for ${event.kind} (${event.id}):` })
        content.push(...event.content)
      }
      return {
        message: createUserMessage({
          content,
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
    return this.options.store.subscription(sessionId, kind).enabled
  }

  private normalize(input: ContextEventInput, kind: ResolvedContextKind): ContextEvent {
    if (typeof input.summary !== 'string') {
      throw new ContextGateError('EVENT_INVALID', 'a context event needs a summary string', { eventKind: kind.kind })
    }
    if (typeof input.source !== 'string' || input.source.trim() === '') {
      throw new ContextGateError('EVENT_INVALID', 'a context event needs a source', { eventKind: kind.kind })
    }
    const id = input.id ?? crypto.randomUUID()
    if (typeof id !== 'string' || id === '') {
      throw new ContextGateError('EVENT_INVALID', 'a context event id must be a non-empty string', { eventKind: kind.kind })
    }
    const dedupeKey = input.dedupeKey ?? id
    if (typeof dedupeKey !== 'string' || dedupeKey === '') {
      throw new ContextGateError('EVENT_INVALID', 'dedupeKey must be a non-empty string', { eventKind: kind.kind, eventId: id })
    }
    const maxBytes = input.maxBytes ?? kind.maxBytes
    const ttlMs = input.ttlMs ?? kind.ttlMs
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new ContextGateError('EVENT_INVALID', `ttlMs must be a positive finite number, got ${String(ttlMs)}`, { eventKind: kind.kind })
    }
    if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
      throw new ContextGateError('EVENT_INVALID', `maxBytes must be a positive finite number, got ${String(maxBytes)}`, { eventKind: kind.kind })
    }
    if (input.active !== undefined && typeof input.active !== 'boolean') {
      throw new ContextGateError('EVENT_INVALID', 'active must be a boolean', { eventKind: kind.kind })
    }
    const origin = normalizeOrigin(input.origin, kind.kind)
    const content = normalizeContent(input.content, kind.kind)
    const params = input.params !== undefined ? input.params : input.payload
    const causationId = normalizeOptionalId(input.causationId, 'causationId', kind.kind)
    const createdAt = input.createdAt ?? Date.now()
    if (!Number.isFinite(createdAt)) {
      throw new ContextGateError('EVENT_INVALID', `createdAt must be a finite number, got ${String(createdAt)}`, { eventKind: kind.kind })
    }
    let serialized: string
    try {
      const body: Record<string, unknown> = {}
      if (params !== undefined) body['params'] = params
      if (content !== undefined) body['content'] = content
      const json = JSON.stringify(body)
      if (json === undefined) throw new Error('the event body has no JSON form')
      serialized = json
    } catch (error: unknown) {
      throw new ContextGateError('EVENT_PAYLOAD_INVALID', `params/content are not JSON-serializable: ${describeError(error)}`, {
        eventKind: kind.kind, eventId: id,
      })
    }
    const bytes = Buffer.byteLength(serialized, 'utf8')
    if (bytes > maxBytes) {
      throw new ContextGateError('EVENT_TOO_LARGE', `event body is ${String(bytes)} bytes; the limit is ${String(maxBytes)}`, {
        eventKind: kind.kind, eventId: id, bytes, maxBytes,
      })
    }
    const body = JSON.parse(serialized) as { params?: unknown; content?: readonly ContentBlock[] }
    if (params !== undefined && body.params === undefined) {
      throw new ContextGateError('EVENT_PAYLOAD_INVALID', 'params has no JSON form', { eventKind: kind.kind, eventId: id })
    }
    return {
      id,
      kind: kind.kind,
      source: input.source,
      ...(origin === undefined ? {} : { origin }),
      summary: input.summary,
      // A JSON round trip is the canonical copy: no shared mutable object and no
      // value JSON cannot carry reaches a subscriber.
      ...(body.params === undefined ? {} : { params: body.params }),
      ...(input.payload === undefined ? {} : { payload: body.params }),
      ...(body.content === undefined ? {} : { content: body.content }),
      visibility: normalizeVisibility(input.visibility, kind.kind),
      active: input.active ?? kind.activeByDefault,
      dedupeKey,
      ...(causationId === undefined ? {} : { causationId }),
      createdAt,
      ttlMs,
      maxBytes,
    }
  }

  private fail(sessionId: string, message: string, kind?: string): void {
    void this.log(sessionId, 'failed', message, undefined, kind)
  }

  private async log(
    sessionId: string,
    outcome: EventOutcome,
    detail: string,
    event?: ContextEvent,
    kind = event?.kind ?? 'context',
  ): Promise<void> {
    await this.options.store.logEvent(sessionId, {
      id: crypto.randomUUID(),
      kind,
      outcome,
      at: Date.now(),
      detail,
      ...(event === undefined ? {} : {
        eventId: event.id,
        source: event.source,
        ...(event.origin === undefined ? {} : { origin: event.origin }),
        summary: event.summary,
        ...(event.causationId === undefined ? {} : { causationId: event.causationId }),
      }),
    })
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
  if (typeof visibility !== 'object' || visibility === null || Array.isArray(visibility)) {
    throw new ContextGateError('EVENT_INVALID', 'visibility must be an object', { eventKind: kind })
  }
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
 * Normalize the optional provenance of one publication.
 * @param origin - publisher-supplied origin.
 * @param kind - kind name, used in the diagnostic.
 * @returns a detached copy with only non-empty fields.
 * @throws ContextGateError `EVENT_INVALID` when a field is malformed.
 */
function normalizeOrigin(origin: ContextOrigin | undefined, kind: string): ContextOrigin | undefined {
  if (origin === undefined) return undefined
  if (typeof origin !== 'object' || origin === null) {
    throw new ContextGateError('EVENT_INVALID', 'origin must be an object', { eventKind: kind })
  }
  if (typeof origin.plugin !== 'string' || origin.plugin.trim() === '') {
    throw new ContextGateError('EVENT_INVALID', 'origin.plugin must be a non-empty string', { eventKind: kind })
  }
  const normalized: {
    plugin: string
    instance?: string
    sessionId?: string
    channel?: string
    conversation?: string
  } = { plugin: origin.plugin.trim() }
  for (const field of ['instance', 'sessionId', 'channel', 'conversation'] as const) {
    const value = origin[field]
    if (value === undefined) continue
    if (typeof value !== 'string' || value === '') {
      throw new ContextGateError('EVENT_INVALID', `origin.${field} must be a non-empty string`, { eventKind: kind })
    }
    normalized[field] = value
  }
  return normalized
}

/**
 * Validate the content blocks a source plugin has already admitted.
 * @param content - publisher-supplied blocks.
 * @param kind - kind name, used in the diagnostic.
 * @returns the blocks, or undefined when there are none.
 * @throws ContextGateError `EVENT_INVALID` when the value is not a block array.
 */
function normalizeContent(
  content: readonly ContentBlock[] | undefined,
  kind: string,
): readonly ContentBlock[] | undefined {
  if (content === undefined) return undefined
  if (!Array.isArray(content)) {
    throw new ContextGateError('EVENT_INVALID', 'content must be an array of content blocks', { eventKind: kind })
  }
  if (content.length === 0) return undefined
  for (const [index, block] of content.entries()) {
    if (typeof block !== 'object' || block === null || typeof block.type !== 'string' || block.type === '') {
      throw new ContextGateError('EVENT_INVALID', `content[${String(index)}] is not a content block`, { eventKind: kind })
    }
    if (block.type === 'text' && typeof block.text !== 'string') {
      throw new ContextGateError('EVENT_INVALID', `content[${String(index)}] is not a text block`, { eventKind: kind })
    }
  }
  return content
}

/**
 * Validate one optional opaque id.
 * @param value - candidate value.
 * @param label - field name used in the diagnostic.
 * @param kind - kind name used in the diagnostic.
 * @returns the value, or undefined when absent.
 */
function normalizeOptionalId(value: string | undefined, label: string, kind: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value === '') {
    throw new ContextGateError('EVENT_INVALID', `${label} must be a non-empty string`, { eventKind: kind })
  }
  return value
}

/**
 * Render one event for the merged snapshot.
 * @param event - the event to render.
 * @returns model-facing text.
 */
function renderEvent(event: ContextEvent): string {
  const at = new Date(event.createdAt).toISOString()
  const origin = event.origin === undefined ? '' : ` origin ${formatOrigin(event.origin)}`
  const cause = event.causationId === undefined ? '' : ` causation ${event.causationId}`
  const params = event.params !== undefined ? event.params : event.payload
  const lines = [
    `- ${event.kind} from ${event.source}${origin} (${event.active ? 'active' : 'passive'}) at ${at}${cause}`,
    `  summary: ${event.summary}`,
  ]
  if (params !== undefined) lines.push(`  params: ${safeJson(params)}`)
  return lines.join('\n')
}

/**
 * Render the optional provenance fields as one compact label.
 * @param origin - normalized origin.
 * @returns a parenthesized label such as `(plugin, instance=qq-1)`.
 */
function formatOrigin(origin: ContextOrigin): string {
  const parts = [origin.plugin]
  if (origin.instance !== undefined) parts.push(`instance=${origin.instance}`)
  if (origin.sessionId !== undefined) parts.push(`session=${origin.sessionId}`)
  if (origin.channel !== undefined) parts.push(`channel=${origin.channel}`)
  if (origin.conversation !== undefined) parts.push(`conversation=${origin.conversation}`)
  return `(${parts.join(', ')})`
}

/**
 * Dedupe identity of one event: a key is scoped to its kind and source so two
 * providers that happen to choose the same key cannot suppress each other.
 * @param event - normalized event.
 * @returns the stable dedupe token.
 */
function dedupeToken(event: ContextEvent): string {
  return `${event.kind}\u0000${event.source}\u0000${event.dedupeKey}`
}

/**
 * Validate and detach one provider's subscription parameter declarations.
 * @param parameters - provider declarations, if any.
 * @param kind - kind name used in the diagnostic.
 * @returns the normalized declarations.
 */
function normalizeParameters(
  parameters: readonly EventParameterRegistration[] | undefined,
  kind: string,
): readonly EventParameterRegistration[] {
  if (parameters === undefined) return []
  if (!Array.isArray(parameters)) {
    throw new Error(`context-gate: context kind ${JSON.stringify(kind)} parameters must be an array`)
  }
  const types: readonly EventParameterType[] = ['session', 'source', 'enum', 'boolean', 'number', 'string']
  const keys = new Set<string>()
  return parameters.map((parameter, index) => {
    if (typeof parameter !== 'object' || parameter === null) {
      throw new Error(`context-gate: context kind ${JSON.stringify(kind)} parameter ${String(index)} must be an object`)
    }
    if (typeof parameter.key !== 'string' || parameter.key.trim() === '') {
      throw new Error(`context-gate: context kind ${JSON.stringify(kind)} parameter ${String(index)} needs a key`)
    }
    const key = parameter.key.trim()
    if (keys.has(key)) throw new Error(`context-gate: context kind ${JSON.stringify(kind)} repeats parameter ${JSON.stringify(key)}`)
    keys.add(key)
    if (typeof parameter.labelZh !== 'string' || parameter.labelZh.trim() === '') {
      throw new Error(`context-gate: context kind ${JSON.stringify(kind)} parameter ${JSON.stringify(key)} needs a Chinese label`)
    }
    if (!types.includes(parameter.type)) {
      throw new Error(`context-gate: context kind ${JSON.stringify(kind)} parameter ${JSON.stringify(key)} has an unknown type`)
    }
    if (parameter.type === 'enum') {
      const options = parameter.options
      if (options === undefined) {
        if (parameter.optionsProvider === undefined) {
          throw new Error(`context-gate: context kind ${JSON.stringify(kind)} parameter ${JSON.stringify(key)} needs enum options or an options provider`)
        }
      } else if (options.length === 0) {
        throw new Error(`context-gate: context kind ${JSON.stringify(kind)} parameter ${JSON.stringify(key)} needs enum options`)
      }
      for (const option of options ?? []) {
        if (typeof option.value !== 'string' || option.value === ''
          || typeof option.labelZh !== 'string' || option.labelZh.trim() === '') {
          throw new Error(`context-gate: context kind ${JSON.stringify(kind)} parameter ${JSON.stringify(key)} has a malformed option`)
        }
      }
    }
    return {
      key,
      labelZh: parameter.labelZh.trim(),
      ...(parameter.labelEn === undefined ? {} : { labelEn: parameter.labelEn }),
      type: parameter.type,
      ...(parameter.multiple === undefined ? {} : { multiple: parameter.multiple }),
      ...(parameter.allowAll === undefined ? {} : { allowAll: parameter.allowAll }),
      ...(parameter.allowFuture === undefined ? {} : { allowFuture: parameter.allowFuture }),
      ...(parameter.options === undefined ? {} : { options: parameter.options.map((option: EventParameterOption) => ({ ...option })) }),
      ...(parameter.description === undefined ? {} : { description: parameter.description }),
      ...(parameter.optionsProvider === undefined ? {} : { optionsProvider: parameter.optionsProvider }),
    }
  })
}

/**
 * Copy one direct-injection body through JSON so no mutable object reaches the queue.
 * @param value - structured body.
 * @param kind - kind used in the diagnostic.
 * @returns the detached JSON value.
 */
function cloneJson(value: unknown, kind: string): unknown {
  try {
    return JSON.parse(JSON.stringify(value))
  } catch (error: unknown) {
    throw new ContextGateError('EVENT_PAYLOAD_INVALID', `direct ${kind} params are not JSON-serializable: ${describeError(error)}`, {
      eventKind: kind,
    })
  }
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
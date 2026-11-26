/**
 * Wire and persistence types of the context gate.
 *
 * Types only: no runtime code, so the browser half can import this module
 * without pulling Host dependencies, and every value here is JSON-serializable
 * because it crosses the Remote channel or is written to the state document.
 *
 * @module @elysia/context-gate/types
 */

/** Map key of the session scope in the Host's per-session records. */
export type ScopeKey = string

/**
 * What one session sees of a registered context kind.
 *
 * `enabledBy` is keyed by session id so the snapshot stays useful to a Host
 * that renders more than one session later; the current Remote API asks for
 * exactly one.
 */
export interface ContextEntry {
  /** Event kind, such as `app.message`. */
  readonly kind: string
  /** Chinese display name supplied by the provider. */
  readonly nameZh: string
  /** One line describing what the kind carries. */
  readonly description: string
  /** Age ceiling for an undelivered event of this kind. */
  readonly ttlMs: number
  /** Events of this kind already queued for the session. */
  readonly backlog: number
  /** Subscription state for the session; a missing key means off. */
  readonly enabledBy: Readonly<Record<ScopeKey, boolean>>
}

/** How one context event ended up. */
export type EventOutcome = 'published' | 'delivered' | 'consumed' | 'failed' | 'dropped'

/** One row of the session's recent context-event log. */
export interface EventLogEntry {
  /** Event id minted by the publisher. */
  readonly id: string
  /** Event kind the entry was published as. */
  readonly kind: string
  /** What happened to it. */
  readonly outcome: EventOutcome
  /** Epoch milliseconds of the outcome. */
  readonly at: number
  /** Host explanation: a failure reason, a dedupe or TTL drop, or the target count. */
  readonly detail?: string
}

/** What `contextGate/list` answers for one session. */
export interface ContextSnapshot {
  /** Registered kinds, with this session's subscription and backlog. */
  readonly contexts: readonly ContextEntry[]
  /** Recent context-event log, newest first. */
  readonly events: readonly EventLogEntry[]
}

/** Publisher-side restriction on the sessions one event may reach. */
export interface ContextVisibility {
  /** Allowed session ids; omission allows every subscribed session. */
  readonly sessionIds?: readonly string[]
}

/** One stored context event. */
export interface ContextEvent {
  /** Stable event identity. */
  readonly id: string
  /** Registered kind. */
  readonly kind: string
  /** Producer identity, for the event log. */
  readonly source: string
  /** One line shown to the model and in the panel. */
  readonly summary: string
  /** Structured body. JSON-serializable and bounded by `maxBytes`. */
  readonly payload: unknown
  /** Hard upper bound the publisher places on the target set. */
  readonly visibility: ContextVisibility
  /** True opens a turn after the batch window; false waits for the next step. */
  readonly active: boolean
  /** Suppresses a repeat of the same key within the event's TTL. */
  readonly dedupeKey: string
  /** Age after which an undelivered event is dropped. */
  readonly ttlMs?: number
  /** Per-event size ceiling; an oversized event is refused, not truncated. */
  readonly maxBytes?: number
  /** Publication time in milliseconds since the epoch. */
  readonly createdAt: number
}

/** What a provider submits to `publish()`. */
export interface ContextEventInput {
  /** Caller-chosen identity, for idempotent republishing. */
  readonly id?: string
  /** Registered kind; an unregistered kind is refused. */
  readonly kind: string
  /** Producer identity. */
  readonly source: string
  /** One line shown to the model and in the panel. */
  readonly summary: string
  /** Structured, JSON-serializable body. */
  readonly payload?: unknown
  /** Publisher-side restriction; defaults to no restriction. */
  readonly visibility?: ContextVisibility
  /** Defaults to the kind's `activeByDefault`. */
  readonly active?: boolean
  /** Dedupe key; defaults to the event id. */
  readonly dedupeKey?: string
  /** Age after which an undelivered event is dropped. */
  readonly ttlMs?: number
  /** Per-event size ceiling. */
  readonly maxBytes?: number
  /** Publication time; defaults to now. */
  readonly createdAt?: number
}

/** Delivery accounting for one publication. */
export interface PublishReceipt {
  /** Identity of the published event. */
  readonly eventId: string
  /** Sessions whose queue accepted the event. */
  readonly delivered: number
  /** Sessions excluded by subscription, visibility, or dedupe. */
  readonly suppressed: number
  /** Sessions whose enqueue failed. */
  readonly failed: number
}

/** One provider's declaration of a publishable kind. */
export interface ContextKindRegistration {
  /** Kind name, `<plugin>.<event>`. */
  readonly kind: string
  /** Required Chinese display name. */
  readonly nameZh: string
  /** One line describing what the event carries. */
  readonly description: string
  /** Whether publications default to opening a turn; false is the safe default. */
  readonly activeByDefault?: boolean
  /** Default age ceiling for undelivered events. */
  readonly ttlMs?: number
  /** Default per-event size ceiling. */
  readonly maxBytes?: number
  /** Default undelivered events retained per session. */
  readonly maxQueueDepth?: number
}

/** One kind resolved against the Host's traffic defaults. */
export interface ResolvedContextKind {
  readonly kind: string
  readonly nameZh: string
  readonly description: string
  readonly activeByDefault: boolean
  readonly ttlMs: number
  readonly maxBytes: number
  readonly maxQueueDepth: number
}

/** Undelivered events and delivery cursors of one session. */
export interface QueueRecord {
  /** Undelivered events, oldest first. */
  readonly events: readonly ContextEvent[]
  /** Recently consumed event ids, bounded. */
  readonly consumed: readonly string[]
  /** Dedupe key to the publication time that set it. */
  readonly dedupe: Readonly<Record<string, number>>
}

/** One session's gate state. */
export interface SessionRecord {
  /** Context kind to explicit subscription on/off. */
  readonly contexts: Readonly<Record<string, boolean>>
  /** Recent context-event log, newest first. */
  readonly events: readonly EventLogEntry[]
}

/** The whole state document. */
export interface GateDocument {
  /** Document generation this build writes and reads. */
  readonly version: 1
  /** Per-session subscriptions and event log. */
  readonly sessions: Readonly<Record<string, SessionRecord>>
  /** Per-session context queues. */
  readonly queues: Readonly<Record<string, QueueRecord>>
  /** ISO timestamp of the last committed write. */
  readonly updatedAt: string
}
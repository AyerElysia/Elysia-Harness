/**
 * Wire and persistence types of the context gate.
 *
 * Types only: no runtime code, so the browser half can import this module
 * without pulling Host dependencies, and every value here is JSON-serializable
 * because it crosses the Remote channel or is written to the state document.
 * Registration-only fields may carry callbacks; those never reach the wire.
 *
 * @module @elysia/context-gate/types
 */

import type { ContentBlock } from '@deepseek-ai/dsh-llm'

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
  /** Source-defined subscription parameters, when the provider declared any. */
  readonly parameters?: readonly EventParameterSchema[]
  /** Stored parameter values for this session. */
  readonly params?: EventParameterValues
  /** True when the subscription comes from a future-session rule rather than an explicit switch. */
  readonly subscribed?: boolean
}

/** How one context event ended up. */
export type EventOutcome = 'published' | 'delivered' | 'consumed' | 'failed' | 'dropped'

/** One row of the session's recent context-event log. */
export interface EventLogEntry {
  /** Stable row identity; one publication or delivery step can produce several rows. */
  readonly id: string
  /** Event id the row belongs to, when the row names one publication. */
  readonly eventId?: string
  /** Event kind the entry was published as. */
  readonly kind: string
  /** Producer id of the event, for attribution. */
  readonly source?: string
  /** Structured provenance of the event, when the publisher supplied one. */
  readonly origin?: ContextOrigin
  /** One-line publication summary, when the row belongs to one event. */
  readonly summary?: string
  /** Causation chain link, when the publisher supplied one. */
  readonly causationId?: string
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
  /** Custom event rules owned where the session is the owner. */
  readonly rules?: readonly EventRule[]
}

/** Publisher-side restriction on the sessions one event may reach. */
export interface ContextVisibility {
  /** Allowed session ids; omission allows every subscribed session. */
  readonly sessionIds?: readonly string[]
}

/**
 * Structured provenance of one publication.
 *
 * `source` stays the compatibility producer id; `origin` carries the
 * optional channel/instance context a source plugin already knows. Neither
 * field filters delivery: a subscriber receives every event of a subscribed
 * kind that visibility allows, regardless of which source published it.
 */
export interface ContextOrigin {
  /** Plugin that produced the event. */
  readonly plugin: string
  /** Plugin instance, account, or connection identity. */
  readonly instance?: string
  /** Session the event originated from, when it describes a session event. */
  readonly sessionId?: string
  /** Channel identity, such as `qq`, `kook`, `feishu`, or `ayla`. */
  readonly channel?: string
  /** Conversation identity inside the channel. */
  readonly conversation?: string
}

/** One stored context event. */
export interface ContextEvent {
  /** Stable event identity. */
  readonly id: string
  /** Registered kind. */
  readonly kind: string
  /** Producer identity, for the event log. */
  readonly source: string
  /** Structured provenance, when the publisher supplied one. */
  readonly origin?: ContextOrigin
  /** One line shown to the model and in the panel. */
  readonly summary: string
  /** Structured body. JSON-serializable and bounded by `maxBytes`. */
  readonly params?: unknown
  /**
   * Compatibility alias for {@link ContextEvent.params}.
   * @deprecated Use `params`; kept so existing providers keep working.
   */
  readonly payload?: unknown
  /** Source-admitted content blocks injected into the snapshot message. */
  readonly content?: readonly ContentBlock[]
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
  /** Event that caused this one, for causal chains. */
  readonly causationId?: string
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
  /** Structured provenance; metadata only, never a delivery filter. */
  readonly origin?: ContextOrigin
  /** One line shown to the model and in the panel. */
  readonly summary: string
  /** Structured, JSON-serializable body. */
  readonly params?: unknown
  /**
   * Compatibility alias for {@link ContextEventInput.params}.
   * @deprecated Use `params`; kept so existing providers keep working.
   */
  readonly payload?: unknown
  /** Source-admitted content blocks injected into the snapshot message. */
  readonly content?: readonly ContentBlock[]
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
  /** Event that caused this one, for causal chains. */
  readonly causationId?: string
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

/** One value option a source plugin offers for an enum-style subscription parameter. */
export interface EventParameterOption {
  /** Stored value. */
  readonly value: string
  /** Chinese label. */
  readonly labelZh: string
  /** Optional English label. */
  readonly labelEn?: string
}

/** Kinds of values a source plugin's subscription parameter accepts. */
export type EventParameterType = 'session' | 'source' | 'enum' | 'boolean' | 'number' | 'string'

/**
 * One source-defined subscription parameter schema.
 *
 * ContextGate renders and stores the values; the source plugin interprets
 * them. It never turns these parameters into a generic delivery filter.
 */
export interface EventParameterSchema {
  /** Stable key inside the kind's parameter object. */
  readonly key: string
  /** Chinese label rendered by the panel. */
  readonly labelZh: string
  /** Optional English label. */
  readonly labelEn?: string
  /** Value kind. */
  readonly type: EventParameterType
  /** Whether a non-empty array is expected. */
  readonly multiple?: boolean
  /** Whether the value may select every current session. */
  readonly allowAll?: boolean
  /** Whether the value may cover sessions created later. */
  readonly allowFuture?: boolean
  /** Allowed values for `enum`. */
  readonly options?: readonly EventParameterOption[]
  /** One line explaining how the source plugin interprets the parameter. */
  readonly description?: string
}

/**
 * A parameter declaration at registration time. `optionsProvider` is a Host
 * callback that fills `options` per session; it never crosses the Remote
 * channel.
 */
export interface EventParameterRegistration extends EventParameterSchema {
  /**
   * Supply the current options for one session.
   * @param sessionId - session whose panel is rendered.
   * @returns the options the panel offers.
   */
  readonly optionsProvider?: (sessionId: string) => readonly EventParameterOption[]
}

/** Stored parameter values keyed by schema key. */
export type EventParameterValues = Readonly<Record<string, unknown>>

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
  /** Source-defined subscription parameter schema. */
  readonly parameters?: readonly EventParameterRegistration[]
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
  readonly parameters: readonly EventParameterRegistration[]
}

/** Undelivered events and delivery cursors of one session. */
export interface QueueRecord {
  /** Undelivered events, oldest first. */
  readonly events: readonly ContextEvent[]
  /** Recently consumed event ids, bounded. */
  readonly consumed: readonly string[]
  /** Dedupe token to the publication time that set it. */
  readonly dedupe: Readonly<Record<string, number>>
}

/** One session's gate state. */
export interface SessionRecord {
  /** Context kind to explicit subscription on/off. */
  readonly contexts: Readonly<Record<string, boolean>>
  /** Recent context-event log, newest first. */
  readonly events: readonly EventLogEntry[]
  /** Source-defined subscription parameter values keyed by kind. */
  readonly params?: Readonly<Record<string, EventParameterValues>>
  /** First time this session was observed by the gate; future rules compare against it. */
  readonly firstSeenAt?: number
}

/** A rule that subscribes every session observed after its creation. */
export interface FutureSubscription {
  /** Stable rule identity. */
  readonly id: string
  /** Kind the future sessions subscribe. */
  readonly kind: string
  /** Source-defined parameter values applied to the future subscription. */
  readonly params: EventParameterValues
  /** Creation time; only sessions first seen later are matched. */
  readonly createdAt: number
}

/** Absolute, relative, recurring, or second-interval firing rule. */
export type TimerSchedule =
  | { readonly kind: 'once'; readonly at: number }
  | { readonly kind: 'after'; readonly afterMs: number }
  | { readonly kind: 'rrule'; readonly rrule: string; readonly timeZone?: string }
  | { readonly kind: 'seconds'; readonly everySeconds: number }

/** One per-session timer. */
export interface TimerInstance {
  /** Stable identity. */
  readonly id: string
  /** Session that owns the timer and receives its injections. */
  readonly ownerSessionId: string
  /** Preset the timer was adopted from, when any. */
  readonly presetId?: string
  /** Operator-facing name. */
  readonly name: string
  /** Firing schedule. */
  readonly schedule: TimerSchedule
  /** Text injected into the owner on fire. */
  readonly content: string
  /** True opens a turn after the batch window. */
  readonly wake: boolean
  /** Schedule anchor fixed when the schedule was created or last replaced. */
  readonly anchorAt: number
  /** False pauses firing without losing the schedule. */
  readonly enabled: boolean
  /** Next absolute due time, or null when the schedule is exhausted. */
  readonly nextDueAt: number | null
  /** Last firing time. */
  readonly lastFiredAt?: number
  /** Number of completed firings. */
  readonly firedCount: number
  /** Number of missed rounds collapsed into one firing at restart. */
  readonly missedCount?: number
  /** Last scheduling failure, if any. */
  readonly lastError?: string
  /** Creation time. */
  readonly createdAt: number
  /** Last definition change. */
  readonly updatedAt: number
  /** Optional expiry; no firing happens after it. */
  readonly expiresAt?: number
}

/** A reusable timer template; adoption creates an independent instance. */
export interface TimerPreset {
  /** Stable identity. */
  readonly id: string
  /** Session that created the template. */
  readonly ownerSessionId: string
  /** Operator-facing name. */
  readonly name: string
  /** Template schedule. */
  readonly schedule: TimerSchedule
  /** Template content. */
  readonly content: string
  /** Default wake flag of an adopted instance. */
  readonly wake: boolean
  /** Creation time. */
  readonly createdAt: number
  /** Last template change; adopted instances are unaffected. */
  readonly updatedAt?: number
}

/** A global quiet-period watcher owned by one session. */
export interface AbsenceTimer {
  /** Stable identity. */
  readonly id: string
  /** Session that receives the injection. */
  readonly ownerSessionId: string
  /** Optional operator-facing name. */
  readonly name?: string
  /** Watched kinds; a single `*` watches every kind. */
  readonly kinds: readonly string[]
  /** Quiet period in milliseconds. */
  readonly quietMs: number
  /** Latest time one watched kind was published, or the creation time baseline. */
  readonly lastSeenAt: number
  /** True after firing; a later watched publication re-arms it. */
  readonly fired: boolean
  /** False pauses the watcher. */
  readonly enabled: boolean
  /** Creation time. */
  readonly createdAt: number
  /** Last update time. */
  readonly updatedAt: number
  /** Last firing time. */
  readonly lastFiredAt?: number
}

/** Input for one timer creation. */
export interface TimerDraft {
  /** Operator-facing name. */
  readonly name: string
  /** Text injected into the owner on fire. */
  readonly content: string
  /** True wakes the owner; false waits for the next step. */
  readonly wake?: boolean
  /** Absolute ISO-8601 instant for a `once` timer. */
  readonly at?: string
  /** Relative seconds for a `after` timer. */
  readonly afterSeconds?: number
  /** Two-line DTSTART/RRULE expression, or a bare RRULE line. */
  readonly rrule?: string
  /** IANA zone used when `rrule` omits DTSTART. */
  readonly timeZone?: string
  /** Interval seconds for a `seconds` timer. */
  readonly everySeconds?: number
  /** Optional expire instant. */
  readonly expiresAt?: string
}

/** Partial timer change; a schedule field replaces the whole schedule. */
export interface TimerPatch {
  readonly name?: string
  readonly content?: string
  readonly wake?: boolean
  readonly enabled?: boolean
  readonly at?: string
  readonly afterSeconds?: number
  readonly rrule?: string
  readonly timeZone?: string
  readonly everySeconds?: number
  readonly expiresAt?: string | null
}

/** Input for one absence watcher. */
export interface AbsenceDraft {
  /** Optional operator-facing name. */
  readonly name?: string
  /** Watched kinds; a single `*` watches every kind. */
  readonly kinds: readonly string[]
  /** Quiet period in milliseconds. */
  readonly quietMs: number
}

/** Partial absence change. */
export interface AbsencePatch {
  readonly name?: string
  readonly kinds?: readonly string[]
  readonly quietMs?: number
  readonly enabled?: boolean
}

/** Internal DSH events a rule may observe. Raw payloads are never exposed to subscribers. */
export type InternalEventName =
  | 'session/event'
  | 'tool/call'
  | 'tool/result'
  | 'turn/start'
  | 'turn/end'
  | 'job/registered'
  | 'job/settled'
  | 'subagent/start'
  | 'subagent/end'

/** One declarative condition evaluated against the trigger context. */
export interface RuleCondition {
  /** Dot path into the trigger context, such as `params.messageId` or `toolName`. */
  readonly field: string
  /** Comparison to perform. */
  readonly op: 'eq' | 'neq' | 'contains' | 'matches' | 'gt' | 'lt' | 'exists'
  /** Right-hand side; absent for `exists`. */
  readonly value?: unknown
}

/** An isolated script used as an extra rule condition. */
export interface RuleScript {
  /** Async function body; its return value is the condition, and a throw means no fire. */
  readonly source: string
  /** Hard wall-clock budget; defaults to 1500 ms. */
  readonly timeoutMs?: number
  /** Worker heap ceiling; defaults to 16 MB. */
  readonly memoryMb?: number
}

/** One custom-event rule trigger. */
export type RuleTrigger =
  | { readonly kind: 'time'; readonly schedule: TimerSchedule }
  | { readonly kind: 'absence'; readonly kinds: readonly string[]; readonly quietMs: number }
  | { readonly kind: 'internal'; readonly event: InternalEventName }
  | {
    readonly kind: 'http-poll'
    readonly url: string
    readonly intervalMs: number
    /** Dot path selecting the JSON value that becomes `params`. */
    readonly jsonPath?: string
  }
  | { readonly kind: 'webhook' }
  | {
    readonly kind: 'composite'
    readonly op: 'all' | 'any' | 'not' | 'sequence'
    readonly triggers: readonly RuleTrigger[]
    /** Satisfaction window for `all` and `sequence`; defaults to 60000 ms. */
    readonly windowMs?: number
  }

/** One stored custom-event rule. */
export interface EventRule {
  /** Stable identity. */
  readonly id: string
  /** Session that owns the rule and its generated events. */
  readonly ownerSessionId: string
  /** Operator-facing name. */
  readonly name: string
  /** Firing trigger. */
  readonly trigger: RuleTrigger
  /** Conditions ANDed before firing. */
  readonly where: readonly RuleCondition[]
  /** Content template; `{{path}}` is replaced from the trigger context. */
  readonly contentTemplate: string
  /** Optional isolated script condition. */
  readonly script?: RuleScript
  /** True wakes the owner; false waits for the next step. */
  readonly wake: boolean
  /** Publisher-side restriction of the generated event. */
  readonly visibility: ContextVisibility
  /** Minimum time between two firings. */
  readonly cooldownMs: number
  /** Maximum number of firings; 0 means unlimited. */
  readonly maxFires: number
  /** Optional expiry instant. */
  readonly expiresAt?: number
  /** False pauses the rule without losing it. */
  readonly enabled: boolean
  /** SHA-256 of the webhook secret; the secret itself is never stored. */
  readonly webhookTokenHash?: string
  /** Number of completed firings. */
  readonly fireCount: number
  /** Last firing time. */
  readonly lastFiredAt?: number
  /** Last evaluation/registration failure. */
  readonly lastError?: string
  /** Next due time for a time trigger. */
  readonly nextDueAt?: number
  /** Schedule anchor fixed when the trigger was created or last replaced. */
  readonly anchorAt?: number
  /** Time a one-shot time trigger completed, including a failed publication attempt. */
  readonly completedAt?: number
  /** Creation time. */
  readonly createdAt: number
  /** Last definition change. */
  readonly updatedAt: number
}

/** Input for one rule creation. */
export interface EventRuleDraft {
  readonly name: string
  readonly trigger: RuleTrigger
  readonly where?: readonly RuleCondition[]
  readonly contentTemplate: string
  readonly script?: RuleScript
  readonly wake?: boolean
  readonly visibility?: ContextVisibility
  readonly cooldownMs?: number
  readonly maxFires?: number
  readonly expiresAt?: string
  /** Plain secret for a webhook rule; only its hash is stored. */
  readonly webhookSecret?: string
}

/** Partial rule change. */
export interface EventRulePatch {
  readonly name?: string
  readonly trigger?: RuleTrigger
  readonly where?: readonly RuleCondition[]
  readonly contentTemplate?: string
  readonly script?: RuleScript | null
  readonly wake?: boolean
  readonly visibility?: ContextVisibility
  readonly cooldownMs?: number
  readonly maxFires?: number
  readonly expiresAt?: string | null
  readonly webhookSecret?: string
}

/** What `contextGate/timers` answers for one session. */
export interface TimerSnapshot {
  /** Timers owned by the session. */
  readonly timers: readonly TimerInstance[]
  /** Every timer preset visible to the session. */
  readonly presets: readonly TimerPreset[]
  /** Absence watchers owned by the session. */
  readonly absences: readonly AbsenceTimer[]
  /** Server time the snapshot was built. */
  readonly now: number
}

/** What a rule test run reports. */
export interface RuleTestResult {
  /** Whether the trigger matched and conditions passed. */
  readonly matched: boolean
  /** Whether the rule would publish (cooldown, limits, and expiry included). */
  readonly fired: boolean
  /** Human-readable explanation. */
  readonly detail: string
  /** Rendered content the rule would publish. */
  readonly content?: string
}

/** One rule's evaluation context. Internal payloads stay Host-side; a rule only sees its declared fields. */
export interface RuleTriggerContext {
  /** Internal event name or `time`/`absence`/`http-poll`/`webhook`. */
  readonly event: string
  /** Session the trigger belongs to, when any. */
  readonly sessionId?: string
  /** Tool name for a tool event. */
  readonly toolName?: string
  /** Short publication summary of the internal event. */
  readonly summary?: string
  /** Structured body; bounded and JSON-serializable. */
  readonly params?: unknown
  /** Event kind for a session/event trigger. */
  readonly kind?: string
  /** Turn number for turn events. */
  readonly turn?: number
}

/** The whole state document. */
export interface GateDocument {
  /** Document generation this build writes. Version 1 documents are migrated on read. */
  readonly version: 2
  /** Per-session subscriptions, parameter values, and event log. */
  readonly sessions: Readonly<Record<string, SessionRecord>>
  /** Per-session context queues. */
  readonly queues: Readonly<Record<string, QueueRecord>>
  /** Future-session subscription rules. */
  readonly futureSubscriptions: readonly FutureSubscription[]
  /** Timer instances, presets, absence watchers, and global last-seen times. */
  readonly timers: TimerDocument
  /** Custom-event rule definitions. */
  readonly rules: RuleDocument
  /** ISO timestamp of the last committed write. */
  readonly updatedAt: string
}

/** Persisted timer section. */
export interface TimerDocument {
  /** Per-session timer instances. */
  readonly instances: readonly TimerInstance[]
  /** Reusable timer templates. */
  readonly presets: readonly TimerPreset[]
  /** Absence watchers. */
  readonly absence: readonly AbsenceTimer[]
  /** Latest publication time of each kind, including kinds without a subscriber. */
  readonly lastSeenByKind: Readonly<Record<string, number>>
}

/** Persisted rule section. */
export interface RuleDocument {
  /** Rule definitions and their runtime counters. */
  readonly definitions: readonly EventRule[]
}
/**
 * Wire and persistence types of the session-scoped capability panel.
 *
 * Types only: no runtime code, so the browser half can import this module
 * without pulling Host dependencies, and every value here is JSON-serializable
 * because it crosses the Remote channel or is written to the state document.
 *
 * There is one scope: the current session. A preset's static tools are locked
 * rows; every globally registered tool is a dynamic row that the session may
 * disable. Preset-level scope rows do not exist.
 *
 * @module @elysia/villv-helix/types
 */

/** The panel's only addressable scope: the session whose view renders it. */
export interface ScopeRef {
  /** Scope kind; always `session`. */
  readonly kind: 'session'
  /** Session identity. */
  readonly id: string
}

/** Map key of the session scope in the Host's per-session records. */
export type ScopeKey = string

/** Where a tool registers: globally on the Host, or inside the Agent scope. */
export type ToolScope = 'global' | 'agent'

/**
 * Who owns a tool. `static` tools are mounted inside the Agent scope by the
 * preset composition and the panel cannot switch them; `dynamic` tools are
 * global registrations the panel disables per session.
 */
export type ToolOrigin = 'static' | 'dynamic'

/**
 * Gate verdict of one tool for the viewed session. `active` means the next step
 * admits it, `hidden` means the session disabled it, and `frozen` is reserved
 * for a restriction installed mid-step (this Host installs restrictions between
 * steps, so it does not report one).
 */
export type StepGate = 'active' | 'frozen' | 'hidden'

/** One tool the Host reports, with its origin, lock, and session state. */
export interface ToolEntry {
  /** Tool id the model sees, such as `web_search`. */
  readonly id: string
  /** Chinese display name supplied by the provider. */
  readonly nameZh?: string
  /** Functional group id the panel uses for display. */
  readonly group: string
  /** Registration scope: a global row or an Agent-scoped row. */
  readonly scope: ToolScope
  /** Whether the preset composition owns the tool or the Host registered it globally. */
  readonly origin: ToolOrigin
  /** Whether the panel may never switch this tool; static tools are locked. */
  readonly locked: boolean
  /** Preset that mounts a static tool, when the Host attributes one. */
  readonly sourcePresetId?: string
  /** Provider name when the tool delegates to one. */
  readonly provider?: string
  /** Why this tool cannot be gated, when it cannot. */
  readonly failure?: string
  /** Effective enablement for the session scope; dynamic tools only. */
  readonly enabledBy?: Readonly<Record<ScopeKey, boolean>>
  /** Next-step gate verdict for the session scope. */
  readonly stepBy?: Readonly<Record<ScopeKey, StepGate>>
}

/** One display group of dynamic tools as the Host reports it. */
export interface ToolGroupEntry {
  /** Group id derived from the tool's functional category. */
  readonly id: string
  /** Registration scope of every member. */
  readonly scope: ToolScope
  /** Whether the group belongs to the preset composition or the Host. */
  readonly origin: ToolOrigin
  /** Whether the members are one atomic unit. */
  readonly atomic: boolean
  /** Whether the group carries no switch. */
  readonly locked: boolean
  /** Member tool ids in display order. */
  readonly tools: readonly string[]
}

/** One saved dynamic-tool selection the panel can apply in one click. */
export interface ToolPresetEntry {
  /** Stable id minted by the Host. */
  readonly id: string
  /** Operator-provided display name. */
  readonly name: string
  /** Dynamic tool ids the preset switches on. */
  readonly tools: readonly string[]
  /** Creation time in milliseconds since the epoch. */
  readonly createdAt: number
}

/** One context event kind the Host can subscribe the session to. */
export interface ContextEntry {
  /** Event kind, such as `app.message`. */
  readonly kind: string
  /** Chinese display name supplied by the provider. */
  readonly nameZh?: string
  /** Whether publishing wakes a turn (`true`) or waits for the next step. */
  readonly active: boolean
  /** Time to live of a queued event; absent keeps it until consumed. */
  readonly ttlMs?: number
  /** Events already queued for this session. */
  readonly backlog?: number
  /** Why this kind cannot be subscribed, when it cannot. */
  readonly failure?: string
  /** Effective subscription for the session scope; a missing key means off. */
  readonly enabledBy: Readonly<Record<ScopeKey, boolean>>
}

/** The current session as the panel's left column renders it. */
export interface SessionRowEntry {
  /** Session identity. */
  readonly id: string
  /** Display title; the panel falls back to the id. */
  readonly title?: string
  /** Working directory the session belongs to. */
  readonly workspace?: string
  /** Preset the Host detected for the session, when it detected one. */
  readonly presetId?: string
  /** Human-facing preset name when the roster reports one. */
  readonly presetName?: string
  /** Whether the Host has a live Agent for this session. */
  readonly live: boolean
  /** Whether 会话编排模式 is active for this session. */
  readonly orchestrated?: boolean
  /** Epoch milliseconds of the last activity, when the Host reports one. */
  readonly lastActiveAt?: number
}

/** Read-only prompt bundle of the active preset. */
export interface PresetPrompt {
  readonly id: string
  readonly name?: string
  readonly root: string
  readonly files: readonly string[]
  readonly text: string
  readonly missing: readonly string[]
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

/** Tool counters the health surface reports. */
export interface ToolHealth {
  /** Static tools the preset composition currently mounts in this session. */
  readonly static: number
  /** Globally registered tools the Host can switch for this session. */
  readonly registered: number
  /** Global tools currently enabled for this session. */
  readonly enabled: number
  /** Tools whose registration failed. */
  readonly failed: number
  /** Global-scope tool count. */
  readonly global: number
  /** Agent-scoped static tool count. */
  readonly agent: number
}

/** Context-bus counters the health surface reports. */
export interface ContextHealth {
  /** Events waiting for this session. */
  readonly queueDepth: number
  /** Age of the oldest queued event in milliseconds. */
  readonly oldestAgeMs: number
  /** Events consumed since the Host started. */
  readonly consumed: number
  /** Events that failed to deliver or inject. */
  readonly failed: number
  /** Active events merged into one wake-up batch. */
  readonly merged: number
}

/** Restriction counters the health surface reports. */
export interface GateHealth {
  /** Restrictions that could not be installed. */
  readonly failClosed: number
  /** Restriction installations that failed loud. */
  readonly failLoud: number
  /** The most recent restriction error, when one was recorded. */
  readonly lastError?: string
}

/** Health counters served by the Host's `status()` endpoint. */
export interface HealthStatus {
  /** Tool registration and enablement counters. */
  readonly tools: ToolHealth
  /** Context-bus queue and consumption counters. */
  readonly contexts: ContextHealth
  /** Restriction failure counters. */
  readonly gate: GateHealth
  /** Epoch milliseconds of the sample. */
  readonly capturedAt: number
}

/** What `villvHelix/list` answers for one session. */
export interface CapabilitySnapshot {
  /** Every tool the Host reports, static and dynamic. */
  readonly tools: readonly ToolEntry[]
  /** Display groups of dynamic tools. */
  readonly groups: readonly ToolGroupEntry[]
  /** Context event kinds the Host can subscribe. */
  readonly contexts: readonly ContextEntry[]
  /** The current session, as the panel's left column renders it. */
  readonly sessions: readonly SessionRowEntry[]
  /** Saved tool selections, in creation order. */
  readonly toolPresets: readonly ToolPresetEntry[]
  /** Recent context-event log, newest first. */
  readonly events: readonly EventLogEntry[]
}

/** What `villvHelix/status` answers. */
export interface HostStatus {
  /** Whether the calling connection may write; false renders the panel read-only. */
  readonly writable: boolean
  /** Host lifecycle the panel explains when it is not `live`. */
  readonly mode: 'live' | 'starting' | 'degraded'
  /** Health counters for this session. */
  readonly health: HealthStatus
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
  /** True wakes a turn; false waits for the session's next step. */
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
  /** Whether publications default to waking a turn; false is the safe default. */
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

/** One session's panel state. */
export interface SessionStateRecord {
  /** Whether 会话编排模式 is active for this session. */
  readonly orchestrated: boolean
  /** Explicitly allowed global tool ids; every other global tool stays off in orchestrated sessions. */
  readonly enabledTools: readonly string[]
  /** Global tool ids this session disabled (legacy migration field). */
  readonly disabledTools: readonly string[]
  /** Context kind to explicit subscription on/off. */
  readonly contexts: Readonly<Record<string, boolean>>
  /** Recent context-event log, newest first. */
  readonly events: readonly EventLogEntry[]
}

/** The whole state document. */
export interface HelixDocument {
  /** Document generation this build writes and reads. */
  readonly version: 1
  /** Per-session panel state. */
  readonly sessions: Readonly<Record<string, SessionStateRecord>>
  /** Per-session context queues. */
  readonly queues: Readonly<Record<string, QueueRecord>>
  /** Saved tool selections, shared across sessions. */
  readonly toolPresets: readonly ToolPresetEntry[]
  /** ISO timestamp of the last committed write. */
  readonly updatedAt: string
}

/** What a provider may publish through the orchestrator service. */
export interface OrchestratorPublish {
  /**
   * Publish one context event to every subscribed session.
   * @param input - the publication.
   * @returns delivery accounting.
   */
  publish(input: ContextEventInput): Promise<PublishReceipt>
}
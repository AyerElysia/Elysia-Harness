/**
 * Wire contracts of the ElyH capability panel. Types only: no runtime code, so
 * a browser half can import this module without pulling Host dependencies, and
 * every value here is JSON-serializable because it crosses the Remote channel.
 *
 * v1.2 split: `origin: 'static'` rows come from a preset's composition and are
 * locked; `origin: 'dynamic'` rows are the panel's catalog and are switchable.
 *
 * @module @elysia/capability-core/types
 */

/** Where a dynamic tool is registered, and therefore who can switch it. */
export type ToolScope = 'global' | 'agent'

/**
 * One addressable switch surface. There is no `base` scope: a preset's static
 * tools are locked, and dynamic switches live on a preset or a session.
 */
export type ScopeRef =
  | { readonly kind: 'global' }
  | { readonly kind: 'preset'; readonly id: string }
  | { readonly kind: 'session'; readonly id: string }

/** Whether the Host delivers context events or only accumulates them. */
export type HostState = 'enabled' | 'paused'

/**
 * One context event published to subscribed sessions.
 *
 * `payload` must be JSON-serializable; the bus copies it per subscriber, so a
 * publisher never shares a mutable object across sessions.
 */
export interface ContextEvent {
  /** Stable event identity; the publisher may supply one, otherwise the bus mints it. */
  readonly id: string
  /** Registered kind such as `app.message` or `prompt.change`. */
  readonly kind: string
  /** Producer identity, for the event log. */
  readonly source: string
  /** One line shown to the model and in the panel. */
  readonly summary: string
  /** Structured body. JSON-serializable and bounded by `maxBytes`. */
  readonly payload: unknown
  /**
   * Hard upper bound the publisher places on the target set. Target selection
   * is an AND: a session must both be subscribed and inside this visibility.
   */
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

/** Publisher-side restriction on the sessions one event may reach. */
export interface ContextVisibility {
  /** Allowed preset ids; omission allows every subscribed preset. */
  readonly presetIds?: readonly string[]
  /** Allowed session ids; omission allows every subscribed session. */
  readonly sessionIds?: readonly string[]
}

/** What a publisher submits; identity and timestamp are optional. */
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

/** Which layer owns one tool. */
export type ToolOrigin = 'static' | 'dynamic'

/** The switch layer that decided one dynamic value. */
export type SwitchOrigin = 'global' | 'preset' | 'session' | 'default'

/** One global catalog tool's persisted switch. */
export interface GlobalToolState {
  /** Effective global switch; absent means off. */
  readonly enabled: boolean
  /** Whether the operator has written an explicit value. */
  readonly stored: boolean
}

/**
 * One tool as the panel renders it.
 *
 * A static row is locked and read-only. Whether a dynamic row is shadowed is
 * per scope: a preset whose composition contributes the same id shadows it for
 * that preset's sessions, while every other preset can still switch it on. The
 * client derives that from the static rows (`sourcePresetId`) and the scope it
 * is rendering; the snapshot carries no global shadow flag.
 */
export interface ToolView {
  /** Tool id, or the module name for an unmapped static module. */
  readonly id: string
  /** Chinese display name supplied by the provider. */
  readonly nameZh?: string
  /** Static (preset composition) or dynamic (panel catalog). */
  readonly origin: ToolOrigin
  /** True for a static tool: it cannot be switched. */
  readonly locked: boolean
  /** Registration scope; present for dynamic entries. */
  readonly scope?: ToolScope
  /** Extension group the tool belongs to, such as `reply`. */
  readonly group?: string
  /** Module that owns the definition, when another plugin mounts it. */
  readonly provider?: string
  /** Model-facing description. */
  readonly description?: string
  /** Host services a dynamic definition needs. */
  readonly required: readonly string[]
  /** Whether the definition is mounted in this Host process. */
  readonly registered: boolean
  /** Why a dynamic entry is not registered, when it is not. */
  readonly reason?: string
  /** Preset whose composition contributes a static tool. */
  readonly sourcePresetId?: string
}

/** A switchable context kind. */
/** One saved dynamic-tool selection the panel can apply in one click. */
export interface ToolPresetView {
  /** Stable id minted by the Host. */
  readonly id: string
  /** Operator-provided display name. */
  readonly name: string
  /** Dynamic tool ids the preset switches on. */
  readonly tools: readonly string[]
  /** Creation time in milliseconds since the epoch. */
  readonly createdAt: number
}

/** A switchable context kind. */
export interface ContextKindView {
  /** Registered kind name. */
  readonly kind: string
  /** Chinese display name supplied by the provider. */
  readonly nameZh?: string
  /** One line describing what the kind carries. */
  readonly description: string
  /** Whether publications default to waking a turn. */
  readonly activeByDefault: boolean
  /** Effective age ceiling for undelivered events. */
  readonly ttlMs: number
  /** Effective per-event size ceiling. */
  readonly maxBytes: number
}

/** Explicit overrides stored in one scope; absence inherits the parent layer. */
export interface ScopeOverrides {
  /** Tool id to explicit on/off. */
  readonly tools: Readonly<Record<string, boolean>>
  /** Context kind to explicit subscription on/off. */
  readonly contexts: Readonly<Record<string, boolean>>
}

/** One scope's merged switches. */
export interface ScopeView {
  /** The scope these switches belong to. */
  readonly ref: ScopeRef
  /** Explicit overrides stored at this scope. */
  readonly overrides: ScopeOverrides
  /** Effective switch per tool id: static ids are always true. */
  readonly tools: Readonly<Record<string, boolean>>
  /** Effective context subscription after preset and session merging. */
  readonly contexts: Readonly<Record<string, boolean>>
}

/** One known session, live or restored from persisted state. */
export interface SessionView {
  /** Session identity. */
  readonly id: string
  /** Latest session title, when the log has one. */
  readonly title?: string
  /** Working directory the session belongs to. */
  readonly workspace?: string
  /** Preset the session runs, when known. */
  readonly presetId?: string
  /** Whether an Agent currently owns the session. */
  readonly live: boolean
  /** Undelivered context events waiting for this session. */
  readonly queued: number
  /** Oldest undelivered event's publication time. */
  readonly oldestEventAt?: number
}

/** One non-fatal problem the panel reports instead of hiding. */
export interface Diagnostic {
  /** Stable code such as `TOOL_UNKNOWN`. */
  readonly code: string
  /** Human-readable explanation. */
  readonly message: string
  /** ISO timestamp of the observation. */
  readonly at: string
  /** Scope the problem belongs to, when it belongs to one. */
  readonly scope?: ScopeRef
  /** Tool the problem belongs to. */
  readonly toolId?: string
  /** Context kind the problem belongs to. */
  readonly eventKind?: string
}

/** Everything the panel needs to render the tool and context switches. */
export interface CapabilitySnapshot {
  /** Snapshot format generation. v1.2 added static rows and removed `base`. */
  readonly version: 2
  /** Whether delivery is enabled or paused. */
  readonly hostState: HostState
  /** Static and dynamic tools with their registration state. */
  readonly tools: readonly ToolView[]
  /** Registered context kinds. */
  readonly contexts: readonly ContextKindView[]
  /** Preset and session switch surfaces. */
  readonly scopes: readonly ScopeView[]
  /** Live and persisted sessions. */
  readonly sessions: readonly SessionView[]
  /** Saved tool selections, in creation order. */
  readonly toolPresets: readonly ToolPresetView[]
  /** ISO timestamp of the last committed state write. */
  readonly stateUpdatedAt?: string
  /** Non-fatal problems observed since mount. */
  readonly diagnostics: readonly Diagnostic[]
}

/** Tool registration and gate health. */
export interface ToolStatus {
  /** Static tools read from preset compositions. */
  readonly static: number
  /** Dynamic entries registered at global scope. */
  readonly global: number
  /** Dynamic entries handed to a Capability Set for agent scopes. */
  readonly agent: number
  /** Dynamic entries currently enabled for at least one known session. */
  readonly enabledNow: number
  /** Dynamic entries that could not be registered or whose required services are missing. */
  readonly unavailable: number
}

/** Context delivery health. */
export interface ContextStatus {
  /** Registered kinds. */
  readonly kinds: number
  /** Undelivered events across every session queue. */
  readonly queued: number
  /** Oldest undelivered event's publication time. */
  readonly oldestEventAt?: number
  /** Accepted publications. */
  readonly published: number
  /** Session deliveries that enqueued the event. */
  readonly delivered: number
  /** Session deliveries excluded by subscription, visibility, or dedupe. */
  readonly suppressed: number
  /** Events discarded by TTL or backpressure. */
  readonly dropped: number
  /** Session deliveries that failed. */
  readonly failed: number
  /** Turn wake-ups coalesced into an already pending wake-up. */
  readonly merged: number
  /** Events marked consumed by a snapshot injection. */
  readonly consumed: number
}

/** Step-gate health. */
export interface GateStatus {
  /** Gate evaluations since mount. */
  readonly evaluated: number
  /** Evaluations that threw. */
  readonly errorCount: number
  /** Most recent gate error message. */
  readonly lastError?: string
  /** Whether the most recent error came from a fail-loud group. */
  readonly lastErrorLoud: boolean
}

/** Host health and accounting. */
export interface HostStatus {
  /** Whether delivery is enabled or paused. */
  readonly hostState: HostState
  /** ISO timestamp of when this Host instance mounted. */
  readonly mountedAt: string
  /** Absolute state directory. */
  readonly stateDir: string
  /** Persisted document generation. */
  readonly stateVersion: number
  /** ISO timestamp of the last committed state write. */
  readonly stateUpdatedAt?: string
  /** Tool registration and gate accounting. */
  readonly tools: ToolStatus
  /** Context delivery accounting. */
  readonly context: ContextStatus
  /** Step-gate accounting. */
  readonly gate: GateStatus
  /** Live and persisted session counts. */
  readonly sessions: { readonly live: number; readonly known: number }
  /** Non-fatal problems observed since mount. */
  readonly diagnostics: readonly Diagnostic[]
}

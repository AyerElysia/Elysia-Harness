/**
 * Client-safe payloads of the capability panel. Types only: no runtime code, so
 * the browser half can import this module without pulling Host dependencies.
 *
 * These client-safe declarations mirror the Remote API served by
 * `@elysia/capability-core`; the core owns the authoritative Host declarations.
 * This package imports no Host code, so the browser half stays independent of
 * React-free Host internals. Keep the response guards in `api.ts` aligned with
 * the core's wire fields.
 *
 * v1.2 keeps two tool origins: `static` tools come from the preset definition
 * (preset-manager owns them, the panel only reads them) and `dynamic` tools come
 * from the Host catalog (the panel switches them per scope).
 *
 * @module @elysia/capability-panel/types
 */

/**
 * Scope address of the panel's write target. Both kinds are write targets for
 * dynamic tools and context subscriptions; a static tool has no writable scope.
 */
export type ScopeRef =
  | { readonly kind: 'global' }
  | { readonly kind: 'preset'; readonly id: string }
  | { readonly kind: 'session'; readonly id: string }

/**
 * Map key of one scope in the Host's per-scope records: `preset:<id>` or
 * `session:<id>`. The Host writes these keys; the panel only reads and matches
 * them.
 */
export type ScopeKey = string

/** Where a tool registers: globally on the Host, or inside an agent scope. */
export type ToolScope = 'global' | 'agent'

/** One global catalog tool's persisted switch. */
export interface GlobalToolState {
  /** Effective global switch; absent means off. */
  readonly enabled: boolean
  /** Whether the operator has written an explicit value. */
  readonly stored: boolean
}

/**
 * Who owns a tool. `static` tools are mounted by the preset definition and the
 * panel cannot switch them; `dynamic` tools come from the Host catalog and the
 * panel switches them per scope.
 */
export type ToolOrigin = 'static' | 'dynamic'

/**
 * Gate verdict of one tool for the scope being viewed. `active` means the
 * current step admitted it, `frozen` means it was disabled mid-step and stays
 * usable until that step ends, and `hidden` means it is absent until the next
 * step's evaluation.
 */
export type StepGate = 'active' | 'frozen' | 'hidden'

/** One tool the Host reports, with its origin, lock, and per-scope state. */
export interface ToolEntry {
  /** Tool id the model sees, such as `web_search` or `send_text`. */
  readonly id: string
  /** Chinese display name supplied by the provider. */
  readonly nameZh?: string
  /** Group id that owns this tool, such as `static`, `reply`, or `files-read`. */
  readonly group: string
  /** Registration scope: a global row or an agent-scoped row. */
  readonly scope: ToolScope
  /** Whether the preset definition owns the tool or the Host catalog does. */
  readonly origin: ToolOrigin
  /** Whether the panel may never switch this tool; static tools are locked. */
  readonly locked: boolean
  /** Preset that mounts a static tool, when the Host attributes one. */
  readonly sourcePresetId?: string
  /**
   * Advisory only: a dynamic catalog row whose id a static tool of the effective
   * preset already covers. The panel derives this from the scope's static tool
   * set (`shadowedToolIds()`), so a Host that omits the field behaves the same and
   * a stale flag cannot block a tool the preset does not actually mount.
   */
  readonly shadowed?: boolean
  /** Provider name when the tool delegates to one, such as `modsearch`. */
  readonly provider?: string
  /** Why this tool cannot be gated or registered, when it cannot. */
  readonly failure?: string
  /**
   * Effective enablement per {@link ScopeKey}; dynamic tools only. A static tool
   * is always enabled and carries no switch, so a missing record is the normal
   * case for it.
   */
  readonly enabledBy?: Readonly<Record<ScopeKey, boolean>>
  /** Current-step gate verdict per {@link ScopeKey}. */
  readonly stepBy?: Readonly<Record<ScopeKey, StepGate>>
}

/** One switchable group of dynamic tools as the Host offers it. */
export interface ToolGroupEntry {
  /** Group id: `reply`, `files-read`, `files-write`, `skill`, `schedule`, `comm`, `router`, or `dev`. */
  readonly id: string
  /** Registration scope of every member. */
  readonly scope: ToolScope
  /** Whether the group belongs to the preset definition or the Host catalog. */
  readonly origin: ToolOrigin
  /** Whether the members are one atomic unit the panel cannot split. */
  readonly atomic: boolean
  /** Whether the group carries no switch; a static group does. */
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

/** One context event kind the Host can subscribe a scope to. */
export interface ContextEntry {
  /** Event kind, such as `app.message` or `prompt.change`. */
  readonly kind: string
  /** Chinese display name supplied by the provider. */
  readonly nameZh?: string
  /** Whether publishing wakes a turn (`true`) or waits for the next step. */
  readonly active: boolean
  /** Time to live of a queued event; absent keeps it until consumed. */
  readonly ttlMs?: number
  /** Events already queued for the scopes that subscribe this kind. */
  readonly backlog?: number
  /** Why this kind cannot be subscribed, when it cannot. */
  readonly failure?: string
  /** Effective subscription per {@link ScopeKey}; a missing key means off. */
  readonly enabledBy: Readonly<Record<ScopeKey, boolean>>
}

/** One session or preset row of the scope list. */
export interface ScopeRowEntry {
  /** Which list the row belongs to. */
  readonly kind: 'preset' | 'session'
  /** Session id or preset id. */
  readonly id: string
  /** Display title; the panel falls back to the id. */
  readonly title?: string
  /** Working directory the session belongs to. */
  readonly workspace?: string
  /** Preset the Host detected for a session, when it detected one. */
  readonly presetId?: string
  /** Whether the Host has a live session for this row; persisted rows are offline. */
  readonly live: boolean
  /** Epoch milliseconds of the last activity, when the Host reports one. */
  readonly lastActiveAt?: number
  /** Number of sessions a preset row covers. */
  readonly sessionCount?: number
}

/** How one context event ended up. */
export type EventOutcome = 'published' | 'delivered' | 'consumed' | 'failed' | 'dropped'

/** One row of the Host's recent context-event log. */
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
  /** Static tools the preset definitions currently mount. */
  readonly static: number
  /** Dynamic catalog entries the Host holds. */
  readonly registered: number
  /** Dynamic tools currently enabled for at least one scope. */
  readonly enabled: number
  /** Tools whose registration or gate failed. */
  readonly failed: number
  /** Global-scope dynamic tool count. */
  readonly global: number
  /** Agent-scoped dynamic tool count. */
  readonly agent: number
}

/** Context-bus counters the health surface reports. */
export interface ContextHealth {
  /** Events waiting for a consumer. */
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

/** Gate counters the health surface reports. */
export interface GateHealth {
  /** Optional extension gates that failed closed and hid their tool. */
  readonly failClosed: number
  /** Reply-group gates that failed loud and failed the step. */
  readonly failLoud: number
  /** The most recent gate error, when one was recorded. */
  readonly lastError?: string
}

/** Health counters served by the Host's `status()` endpoint. */
export interface HealthStatus {
  /** Tool registration and enablement counters. */
  readonly tools: ToolHealth
  /** Context-bus queue and consumption counters. */
  readonly contexts: ContextHealth
  /** Gate failure counters. */
  readonly gate: GateHealth
  /** Epoch milliseconds of the sample. */
  readonly capturedAt: number
}

/** What `capabilityHost/list` answers: every switchable surface plus the scope lists. */
export interface CapabilitySnapshot {
  /** Dynamic tool groups the panel switches. Static groups carry `locked` and no switch. */
  readonly groups: readonly ToolGroupEntry[]
  /**
   * Every tool the Host reports, static and dynamic. The same id may appear
   * twice: once as the preset's static tool and once as a `shadowed` dynamic
   * catalog row.
   */
  readonly tools: readonly ToolEntry[]
  /** Context event kinds the Host can subscribe. */
  readonly contexts: readonly ContextEntry[]
  /** Preset rows, managed and built-in alike. */
  readonly presets: readonly ScopeRowEntry[]
  /** Session rows, live and persisted (offline). */
  readonly sessions: readonly ScopeRowEntry[]
  /** Saved tool selections, when the Host reports them. */
  readonly toolPresets?: readonly ToolPresetEntry[]
  /** Recent context-event log, newest first as the Host orders it. */
  readonly events: readonly EventLogEntry[]
}

/** What `capabilityHost/status` answers: write authority and the health sample. */
export interface HostStatus {
  /** Whether the calling connection may write; false renders the panel read-only. */
  readonly writable: boolean
  /** Host lifecycle the panel explains when it is not `live`. */
  readonly mode: 'live' | 'starting' | 'degraded'
  /** Health counters for this sample. */
  readonly health: HealthStatus
}

/**
 * One context event as `capabilityHost/publish` accepts it, mirroring the
 * architecture note's §4.1 payload. The panel itself publishes nothing; the
 * adapter carries the endpoint for providers and for future debug surfaces.
 */
export interface ContextEvent {
  /** Publisher-minted event id. */
  readonly id: string
  /** Event kind the subscribing scopes name. */
  readonly kind: string
  /** Publishing provider, such as a channel bridge. */
  readonly source: string
  /** One-line summary shown in the log. */
  readonly summary: string
  /** JSON-serializable payload; the Host copies it per subscription. */
  readonly payload: unknown
  /** Scope narrowing; the Host intersects it with the panel's subscriptions. */
  readonly visibility: { readonly presetIds?: readonly string[]; readonly sessionIds?: readonly string[] }
  /** Whether publishing may wake a turn. */
  readonly active: boolean
  /** Deduplication key within one scope queue. */
  readonly dedupeKey: string
  /** Per-event time to live in milliseconds. */
  readonly ttlMs?: number
  /** Per-event byte cap; the Host refuses a larger payload. */
  readonly maxBytes?: number
  /** Epoch milliseconds the publisher created the event. */
  readonly createdAt: number
}

/** What `capabilityHost/publish` answers. */
export interface PublishReceipt {
  /** The published event id. */
  readonly eventId: string
  /** Sessions the event reached. */
  readonly delivered: number
  /** Sessions whose visibility or dedupe suppressed the event. */
  readonly suppressed: number
  /** Sessions that failed to receive it. */
  readonly failed: number
}

/** One `setTool` write the page asks the Host to apply. */
export interface ToolWrite {
  /** Scope the write targets. */
  readonly scope: ScopeRef
  /** Tool id to switch. */
  readonly toolId: string
  /** Whether the tool becomes enabled. */
  readonly enabled: boolean
}

/** One `setContext` write the page asks the Host to apply. */
export interface ContextWrite {
  /** Scope the write targets. */
  readonly scope: ScopeRef
  /** Event kind to subscribe or unsubscribe. */
  readonly eventKind: string
  /** Whether the scope subscribes the kind. */
  readonly enabled: boolean
}
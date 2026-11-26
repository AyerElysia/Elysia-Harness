/**
 * Wire and persistence types of the session-scoped tool panel.
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

/** What `villvHelix/list` answers for one session. */
export interface CapabilitySnapshot {
  /** Every tool the Host reports, static and dynamic. */
  readonly tools: readonly ToolEntry[]
  /** Display groups of dynamic tools. */
  readonly groups: readonly ToolGroupEntry[]
  /** The current session, as the panel's left column renders it. */
  readonly sessions: readonly SessionRowEntry[]
  /** Saved tool selections, in creation order. */
  readonly toolPresets: readonly ToolPresetEntry[]
}

/** One session's panel state. */
export interface SessionStateRecord {
  /** Whether 会话编排模式 is active for this session. */
  readonly orchestrated: boolean
  /** Explicitly allowed global tool ids; every other global tool stays off in orchestrated sessions. */
  readonly enabledTools: readonly string[]
  /** Global tool ids this session disabled (legacy migration field). */
  readonly disabledTools: readonly string[]
}

/** The whole state document. */
export interface HelixDocument {
  /** Document generation this build writes and reads. */
  readonly version: 1
  /** Per-session panel state. */
  readonly sessions: Readonly<Record<string, SessionStateRecord>>
  /** Saved tool selections, shared across sessions. */
  readonly toolPresets: readonly ToolPresetEntry[]
  /** ISO timestamp of the last committed write. */
  readonly updatedAt: string
}

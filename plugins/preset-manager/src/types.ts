/**
 * Client-safe payloads of the preset manager. Types only: no runtime code, so
 * the browser half can import this module without pulling Host dependencies.
 *
 * @module @elysia/preset-manager/types
 */

/** One prompt file the manager can offer for a preset, relative to its root. */
export interface PromptCandidate {
  /** Root-relative path with `/` separators. */
  readonly path: string
  /** Size on disk in bytes. */
  readonly bytes: number
}

/** Where a tool face comes from. */
export type ToolFaceKind = 'default' | 'common' | 'existing' | 'custom'

/** The face a preset was created from, kept as provenance beside its tool ids. */
export interface ToolFaceRef {
  /** Which family the face belongs to. */
  readonly kind: ToolFaceKind
  /** Face id: `default`, a common id, a preset id, or a custom-face id. */
  readonly id: string
}

/** One selectable tool face with the tool ids it switches on. */
export interface ToolFace {
  /** Which family the face belongs to. */
  readonly kind: ToolFaceKind
  /** Face id. */
  readonly id: string
  /**
   * Display name. Built-in and common faces carry an empty name because the
   * browser localizes them by id; an existing preset carries its own name and a
   * custom face carries the operator's.
   */
  readonly name: string
  /** Tool ids this face switches on, in switch order. */
  readonly tools: readonly string[]
  /** Composition modules this deployment cannot offer; present only when filtered. */
  readonly missing?: readonly string[]
  /**
   * True when {@link missing} dropped at least one row, so applying the face
   * yields fewer tools than the preset it came from.
   */
  readonly partial?: boolean
}

/** One switchable tool as the create page renders it. */
export interface ToolOption {
  /** Tool id: the row id inside the preset's tool group. */
  readonly id: string
  /** Module specifier the row mounts. */
  readonly module: string
  /** False when a probe showed the row cannot activate in this deployment. */
  readonly available: boolean
  /** Host diagnostic for an unavailable tool, shown verbatim. */
  readonly reason?: string
  /** Platform a shell-specific row can run on. */
  readonly platform?: 'win32' | 'posix'
}

/** Everything the create page needs to render switches and faces. */
export interface ToolFaceCatalog {
  /** Every tool this deployment can compose into a preset, in display order. */
  readonly tools: readonly ToolOption[]
  /** Default, common, existing-preset, and custom faces. */
  readonly faces: readonly ToolFace[]
}

/** What the create page submits; the manager turns it into a preset definition. */
export interface PresetDraft {
  /** Identity and roster key: lowercase letters, digits and hyphens. */
  readonly id: string
  /** Display name. */
  readonly name: string
  /** One sentence on what the preset is for. */
  readonly description?: string
  /** One sentence telling the model what this preset is; rendered before the files. */
  readonly identity: string
  /** Whether to mount `agent-instructions` and inject workspace AGENTS.md files. */
  readonly agentInstructions?: boolean
  /** Absolute directory holding the prompt files. */
  readonly promptRoot: string
  /** Ordered, root-relative file list; at least one file must be non-empty. */
  readonly promptFiles: readonly string[]
  /** Roster position; the registry default is unset. */
  readonly order?: number
  /** Tool ids to switch on; an absent list means network search only. */
  readonly tools?: readonly string[]
  /** Face the tool ids came from, for provenance. */
  readonly toolFace?: ToolFaceRef
}

/** One roster row as the page renders it. */
export interface PresetSummary {
  /** Preset identity saved by sessions. */
  readonly id: string
  /** Display name, when the registry or the manager document publishes one. */
  readonly name?: string
  /** One sentence on what the preset is for. */
  readonly description?: string
  /** Whether this manager owns the definition (and may delete it). */
  readonly managed: boolean
  /** Live session ids whose agent runs this preset. */
  readonly inUse: readonly string[]
  /** Why the definition cannot compose a session, when it cannot. */
  readonly diagnostic?: string
  /** Absolute prompt root; manager-owned rows only. */
  readonly promptRoot?: string
  /** Number of configured prompt files; manager-owned rows only. */
  readonly promptFileCount?: number
  /** ISO timestamp of creation; manager-owned rows only. */
  readonly createdAt?: string
  /** Tool ids the record switches on; manager-owned rows only. */
  readonly tools?: readonly string[]
  /** Stored tool ids this build's catalog no longer offers; manager-owned rows only. */
  readonly unknownTools?: readonly string[]
}

/** What the create page submits to add one custom face. */
export interface CustomToolFaceInput {
  /** Operator-provided display name. */
  readonly name: string
  /** Tool ids the face switches on; at least one. */
  readonly tools: readonly string[]
}

/** Delete-time flags. */
export interface DeletePresetOptions {
  /**
   * Also drop a manager-owned entry whose registration is gone. It never
   * overrides {@link PresetSummary.inUse}: a preset a live session runs is
   * always refused, because the roster entry is what that session resumes on.
   */
  readonly force?: boolean
}

/** One file's content identity at one read. */
export interface PromptFileSnapshot {
  /** Root-relative path with `/` separators. */
  readonly path: string
  /** Current size in bytes. */
  readonly bytes: number
  /** SHA-256 of the raw bytes, lowercase hex. */
  readonly hash: string
}

/** One read of every configured prompt file. */
export interface PromptBundle {
  /** Assembled system-prompt text: identity, then file bodies, then diagnostics. */
  readonly text: string
  /** Content identity of each file that was read. */
  readonly snapshot: readonly PromptFileSnapshot[]
  /** Configured files that could not be read. */
  readonly missing: readonly string[]
}

/** How a file changed since the previous read. */
export type PromptChangeAction = 'load' | 'add' | 'modify' | 'remove'

/** One reported change. */
export interface PromptChange {
  /** Which way the file moved. */
  readonly action: PromptChangeAction
  /** Root-relative path with `/` separators. */
  readonly path: string
}

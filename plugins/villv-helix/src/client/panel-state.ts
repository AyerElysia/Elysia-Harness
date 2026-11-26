/**
 * Pure projections over one session snapshot: which scope the panel addresses,
 * which static tools the preset mounts, whether a dynamic row is shadowed, and
 * the exact keys the rendered switches read.
 *
 * The panel manages exactly one session. Static tools belong to the preset
 * composition, so they are always on and the panel never writes them; every
 * global row is a dynamic tool the session may disable.
 *
 * @module @elysia/villv-helix/client/panel-state
 */

import type {
  CapabilitySnapshot, ScopeKey, ScopeRef, StepGate, ToolEntry,
} from '../types.ts'

/**
 * Address key of the session scope, matching the Host's per-session records.
 * @param scope - the session scope.
 * @returns `session:<id>`.
 */
export function scopeKeyOf(scope: ScopeRef): ScopeKey {
  return `${scope.kind}:${scope.id}`
}

/**
 * Identity of one tool row. The Host may report the same id twice — once as a
 * preset's static tool and once as a global row — so `origin` is part of the
 * identity.
 * @param tool - the tool row.
 * @returns `static:<id>` or `dynamic:<id>`.
 */
export function toolKey(tool: ToolEntry): string {
  return `${tool.origin}:${tool.id}`
}

/**
 * The ids the preset's static tools already cover.
 * @param staticTools - static tools of the current session.
 * @returns their ids, used to derive whether a dynamic row is shadowed.
 */
export function shadowedToolIds(staticTools: readonly ToolEntry[]): ReadonlySet<string> {
  return new Set(staticTools.map(tool => tool.id))
}

/**
 * Whether a dynamic row is covered by a static tool of the current session.
 * @param tool - the tool row.
 * @param shadowedIds - ids the preset's static tools cover.
 * @returns true for a dynamic row whose id a static tool already provides.
 */
export function isShadowed(tool: ToolEntry, shadowedIds: ReadonlySet<string>): boolean {
  return tool.origin === 'dynamic' && shadowedIds.has(tool.id)
}

/**
 * The preset whose static tools the current session runs.
 * @param snapshot - the loaded Host snapshot.
 * @returns the preset id, or undefined when the Host did not detect one.
 */
export function effectivePresetId(snapshot: CapabilitySnapshot): string | undefined {
  return snapshot.sessions[0]?.presetId
}

/**
 * The static tools the current session's preset mounts.
 * @param tools - every tool the snapshot carries.
 * @param presetId - preset whose composition to read; absent still lists the
 *   static rows, because those rows are the composition the Agent really has.
 * @returns static tools attributed to that preset, or to no preset at all.
 */
export function staticToolsFor(tools: readonly ToolEntry[], presetId: string | undefined): readonly ToolEntry[] {
  return tools.filter(tool => tool.origin === 'static'
    && (presetId === undefined || tool.sourcePresetId === undefined || tool.sourcePresetId === presetId))
}

/**
 * The session scope the panel addresses, as the snapshot reports it.
 * @param snapshot - the loaded Host snapshot.
 * @returns the session scope, or undefined when the snapshot carries no row.
 */
export function currentScope(snapshot: CapabilitySnapshot): ScopeRef | undefined {
  const row = snapshot.sessions[0]
  return row === undefined ? undefined : { kind: 'session', id: row.id }
}

/** The verdict a rendered dynamic switch reads for the session. */
export function toolStep(tool: ToolEntry, key: ScopeKey): StepGate {
  return tool.stepBy?.[key] ?? (tool.enabledBy?.[key] === true ? 'active' : 'hidden')
}
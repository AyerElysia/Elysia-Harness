/**
 * Pure projections over one Host snapshot: which scope a row addresses, which
 * static tools the effective preset mounts, whether a group is on, which
 * members an atomic group refuses to split, and the exact writes a switch
 * gesture produces.
 *
 * Two rules drive this module. Static tools belong to the preset definition, so
 * they are always on and the panel never writes them. The reply group is the
 * reason the write helpers exist: `pass` and the send tools are one unit, so the
 * panel must never send a write that would remove a session's ability to stay
 * silent.
 *
 * @module @elysia/capability-host/client/panel-state
 */

import type {
  CapabilitySnapshot, ContextEntry, ScopeKey, ScopeRef, ScopeRowEntry, StepGate, ToolEntry,
  ToolGroupEntry, ToolWrite,
} from './types.ts'

/**
 * Members an atomic group never lets the panel switch on their own: the reply
 * group keeps `pass` enabled so a session can always stay silent.
 */
export const LOCKED_MEMBERS: readonly string[] = ['pass']

/**
 * Address key of one scope, matching the Host's per-scope records.
 * @param scope - the scope to address.
 * @returns `preset:<id>` or `session:<id>`.
 */
export function scopeKeyOf(scope: ScopeRef): ScopeKey {
  return `${scope.kind}:${scope.id}`
}

/**
 * Address of one scope-list row.
 * @param row - session or preset row.
 * @returns the scope it addresses.
 */
export function scopeOfRow(row: ScopeRowEntry): ScopeRef {
  return { kind: row.kind, id: row.id }
}

/**
 * Identity of one tool row. The Host may report the same tool id twice — once as
 * a preset's static tool and once as a shadowed dynamic row — so `origin` is part
 * of the identity.
 * @param tool - the tool row.
 * @returns `static:<id>` or `dynamic:<id>`.
 */
export function toolKey(tool: ToolEntry): string {
  return `${tool.origin}:${tool.id}`
}

/**
 * The ids the effective preset's static tools already cover.
 * @param staticTools - static tools of the effective preset.
 * @returns their ids, used to derive whether a dynamic row is shadowed.
 */
export function shadowedToolIds(staticTools: readonly ToolEntry[]): ReadonlySet<string> {
  return new Set(staticTools.map(tool => tool.id))
}

/**
 * Whether a dynamic row is covered by a static tool of the current scope.
 * Shadowing is derived here from the scope's static set, never from the Host's
 * advisory flag: multiple presets mount different faces, so only the effective
 * preset can decide.
 * @param tool - the tool row.
 * @param shadowedIds - ids the effective preset's static tools cover.
 * @returns true for a dynamic row whose id a static tool already provides.
 */
export function isShadowed(tool: ToolEntry, shadowedIds: ReadonlySet<string>): boolean {
  return tool.origin === 'dynamic' && shadowedIds.has(tool.id)
}

/**
 * Whether one tool is on for one scope key. A static tool is always on; a
 * shadowed dynamic row is never on; every other dynamic tool reads its stored
 * switch and defaults to off.
 * @param tool - the tool row.
 * @param key - scope key being viewed.
 * @param shadowedIds - ids the effective preset's static tools cover.
 * @returns the effective switch.
 */
export function toolEnabled(tool: ToolEntry, key: ScopeKey, shadowedIds: ReadonlySet<string>): boolean {
  if (tool.origin === 'static') return true
  if (isShadowed(tool, shadowedIds)) return false
  return tool.enabledBy?.[key] ?? false
}

/**
 * Whether the panel may write this tool at all.
 * @param tool - the tool row.
 * @param shadowedIds - ids the effective preset's static tools cover.
 * @returns true only for an unlocked dynamic tool the preset does not shadow.
 */
export function canToggleTool(tool: ToolEntry, shadowedIds: ReadonlySet<string>): boolean {
  return tool.origin === 'dynamic' && !tool.locked && !isShadowed(tool, shadowedIds)
}

/**
 * The preset whose static tools the selected scope runs.
 * @param selected - scope being viewed; absent when no session or preset exists.
 * @param snapshot - the loaded Host snapshot.
 * @returns the preset id, or undefined when the scope has no preset.
 */
export function effectivePresetId(
  selected: ScopeRef | undefined,
  snapshot: CapabilitySnapshot,
): string | undefined {
  if (selected === undefined) return undefined
  if (selected.kind === 'preset') return selected.id
  return snapshot.sessions.find(row => row.id === selected.id)?.presetId
}

/**
 * The static tools the effective preset mounts.
 * @param tools - every tool the snapshot carries.
 * @param presetId - preset whose composition to read; absent yields none.
 * @returns static tools attributed to that preset, or to no preset at all.
 */
export function staticToolsFor(tools: readonly ToolEntry[], presetId: string | undefined): readonly ToolEntry[] {
  if (presetId === undefined) return []
  return tools.filter(tool => tool.origin === 'static'
    && (tool.sourcePresetId === undefined || tool.sourcePresetId === presetId))
}

/**
 * Resolve a group's member tools in the group's order.
 * @param group - the group row.
 * @param tools - every tool the snapshot carries.
 * @returns the member tools; ids the snapshot does not carry are skipped.
 */
export function groupMembers(group: ToolGroupEntry, tools: readonly ToolEntry[]): readonly ToolEntry[] {
  const byId = new Map(tools.map(tool => [tool.id, tool]))
  return group.tools.flatMap((id) => {
    const tool = byId.get(id)
    return tool === undefined ? [] : [tool]
  })
}

/**
 * The members of a group the panel may write.
 * @param group - the group row.
 * @param tools - every tool the snapshot carries.
 * @param shadowedIds - ids the effective preset's static tools cover.
 * @returns unlocked dynamic members the preset does not shadow, in group order.
 */
export function writableMembers(
  group: ToolGroupEntry,
  tools: readonly ToolEntry[],
  shadowedIds: ReadonlySet<string>,
): readonly ToolEntry[] {
  return groupMembers(group, tools).filter(tool => canToggleTool(tool, shadowedIds))
}

/**
 * Whether every writable member of a group is on for one scope.
 * @param group - the group row.
 * @param tools - every tool the snapshot carries.
 * @param key - scope key being viewed.
 * @param shadowedIds - ids the effective preset's static tools cover.
 * @returns true only when the group has writable members and all of them are on.
 */
export function groupEnabled(
  group: ToolGroupEntry,
  tools: readonly ToolEntry[],
  key: ScopeKey,
  shadowedIds: ReadonlySet<string>,
): boolean {
  const members = writableMembers(group, tools, shadowedIds)
  return members.length > 0 && members.every(tool => toolEnabled(tool, key, shadowedIds))
}

/**
 * The group's worst current-step verdict: a hidden member hides the group, a
 * frozen one freezes it, and only all-active members read as active.
 * @param group - the group row.
 * @param tools - every tool the snapshot carries.
 * @param key - scope key being viewed.
 * @returns the group's current-step verdict.
 */
export function groupStep(group: ToolGroupEntry, tools: readonly ToolEntry[], key: ScopeKey): StepGate {
  const members = groupMembers(group, tools)
  if (members.some(tool => tool.stepBy?.[key] === 'hidden')) return 'hidden'
  if (members.some(tool => tool.stepBy?.[key] === 'frozen')) return 'frozen'
  return 'active'
}

/**
 * Whether the panel must hide this member's own switch.
 * @param group - the group the member belongs to.
 * @param tool - the member tool.
 * @returns true for an atomic group's locked member (`pass`).
 */
export function memberLocked(group: ToolGroupEntry, tool: ToolEntry): boolean {
  return group.atomic && LOCKED_MEMBERS.includes(tool.id)
}

/**
 * The writes one group switch gesture produces. Static and shadowed members are
 * excluded: a static member has no writable scope and a shadowed dynamic row is
 * not registered by the Host.
 * @param scope - scope being edited.
 * @param group - group being switched.
 * @param tools - every tool the snapshot carries.
 * @param enabled - target switch of the whole group.
 * @param shadowedIds - ids the effective preset's static tools cover.
 * @returns one write per writable member, all with the same target.
 */
export function groupWrites(
  scope: ScopeRef,
  group: ToolGroupEntry,
  tools: readonly ToolEntry[],
  enabled: boolean,
  shadowedIds: ReadonlySet<string>,
): readonly ToolWrite[] {
  return writableMembers(group, tools, shadowedIds).map(tool => ({ scope, toolId: tool.id, enabled }))
}

/**
 * The write one member switch gesture produces.
 * @param scope - scope being edited.
 * @param tool - member being switched.
 * @param enabled - target switch.
 * @returns the single write.
 */
export function memberWrite(scope: ScopeRef, tool: ToolEntry, enabled: boolean): ToolWrite {
  return { scope, toolId: tool.id, enabled }
}

/**
 * Whether one context kind is subscribed for one scope.
 * @param entry - the context kind row.
 * @param key - scope key being viewed.
 * @returns the effective subscription.
 */
export function contextEnabled(entry: ContextEntry, key: ScopeKey): boolean {
  return entry.enabledBy[key] ?? false
}

/**
 * Sessions ordered for the list: live first, then most recently active.
 * @param sessions - session rows in Host order.
 * @returns a new ordered array.
 */
export function orderSessions(sessions: readonly ScopeRowEntry[]): readonly ScopeRowEntry[] {
  return sessions.toSorted((left, right) => {
    if (left.live !== right.live) return left.live ? -1 : 1
    return (right.lastActiveAt ?? 0) - (left.lastActiveAt ?? 0)
  })
}

/**
 * Groups ordered for display: static groups first, then Host order. The panel
 * derives the static card from the tool rows, so a static group row only decides
 * where that card sits when the Host sends one.
 * @param groups - group rows in Host order.
 * @returns a new ordered array.
 */
export function orderGroups(groups: readonly ToolGroupEntry[]): readonly ToolGroupEntry[] {
  return groups.filter(group => group.origin === 'static').concat(groups.filter(group => group.origin === 'dynamic'))
}

/**
 * The scope the panel opens on: the first live session, else the first session,
 * else the first preset, else none.
 * @param presets - preset rows.
 * @param sessions - session rows.
 * @returns the initial scope, or undefined when nothing exists yet.
 */
export function selectInitialScope(
  presets: readonly ScopeRowEntry[],
  sessions: readonly ScopeRowEntry[],
): ScopeRef | undefined {
  const ordered = orderSessions(sessions)
  const session = ordered.find(row => row.live) ?? ordered[0]
  if (session !== undefined) return scopeOfRow(session)
  const preset = presets[0]
  return preset === undefined ? undefined : scopeOfRow(preset)
}

/**
 * Resolve the scope the panel keeps selected across a refresh.
 * @param key - the scope key selected before the refresh, when one was.
 * @param presets - preset rows of the new snapshot.
 * @param sessions - session rows of the new snapshot.
 * @returns the row's scope when it still exists, otherwise the initial scope.
 */
export function resolveScope(
  key: ScopeKey | undefined,
  presets: readonly ScopeRowEntry[],
  sessions: readonly ScopeRowEntry[],
): ScopeRef | undefined {
  if (key !== undefined) {
    const match = [...presets, ...sessions].find(row => scopeKeyOf(scopeOfRow(row)) === key)
    if (match !== undefined) return scopeOfRow(match)
  }
  return selectInitialScope(presets, sessions)
}

/** Age buckets the health surface renders. */
export type AgeUnit = 'justNow' | 'seconds' | 'minutes' | 'hours'

/** One age measurement split into a bucket and a count. */
export interface Age {
  /** Which localized template renders it. */
  readonly unit: AgeUnit
  /** Bucket count; zero for {@link AgeUnit} `justNow`. */
  readonly count: number
}

/**
 * Split a millisecond age into the bucket the health surface renders.
 * @param ms - age in milliseconds; negative and non-finite values read as just now.
 * @returns the bucket and its count.
 */
export function formatAge(ms: number): Age {
  if (!Number.isFinite(ms) || ms < 1000) return { unit: 'justNow', count: 0 }
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return { unit: 'seconds', count: seconds }
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return { unit: 'minutes', count: minutes }
  return { unit: 'hours', count: Math.floor(minutes / 60) }
}

/**
 * Render an epoch timestamp as a fixed UTC clock time, so the log reads the same
 * in every time zone the Host and browser could disagree on.
 * @param at - epoch milliseconds.
 * @returns `HH:MM:SS`.
 */
export function formatClock(at: number): string {
  return new Date(at).toISOString().slice(11, 19)
}
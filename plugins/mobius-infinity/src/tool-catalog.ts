/**
 * The tools a managed preset can compose, and the tool faces offered beside
 * them.
 *
 * The catalog is closed on purpose: every entry names a module this deployment
 * can actually mount inside a preset realm, so enabling it cannot leave the
 * preset waiting on a service no Host row provides. Tools whose host provider
 * is absent here — or that only work inside an isolated group the manager does
 * not build — stay out of the list, and the README states the exclusions.
 *
 * @module @elysia/mobius-infinity/tool-catalog
 */

import type { PresetDefinition } from '@deepseek-ai/dsh-agent-preset-registry'

/** One child plugin row of a preset definition. */
export type PresetRow = PresetDefinition['plugins'][number]

/** A Loader `disabled` expression, in the dialect `entryListProblem` accepts. */
export interface ToolDisabledExpression {
  /** JavaScript expression evaluated against the Loader context. */
  readonly __jsExpr: string
}

/** One tool the create page can switch on. */
export interface ToolCatalogEntry {
  /** Loader row id inside the preset's tool group. */
  readonly id: string
  /** Module specifier the row mounts. */
  readonly module: string
  /** Configuration the row always receives. */
  readonly config?: Readonly<Record<string, unknown>>
  /** Platform gate the row carries, so a preset never waits on a missing shell. */
  readonly disabled?: ToolDisabledExpression
  /** Platform the row can run on, when the row is shell-specific. */
  readonly platform?: 'win32' | 'posix'
}

/** The default face: network search only, which is the shipped minimal preset. */
export const DEFAULT_TOOL_IDS: readonly string[] = ['tool-web']

/** Id of the built-in default face. */
export const DEFAULT_FACE_ID = 'default'

/** Tool ids that make up the default face, resolved through the catalog. */
export const TOOL_CATALOG: readonly ToolCatalogEntry[] = [
  {
    id: 'tool-web',
    module: '@deepseek-ai/dsh-tool-web',
    config: { fetch: true, searchTimeoutMs: 60000 },
  },
  { id: 'tool-fs', module: '@deepseek-ai/dsh-tool-fs', config: { applyPatch: false } },
  {
    id: 'tool-fs-search',
    module: '@deepseek-ai/dsh-tool-fs-search',
    config: { sampleOverCapGlobResults: false },
  },
  {
    id: 'tool-bash',
    module: '@deepseek-ai/dsh-tool-bash',
    platform: 'posix',
    disabled: { __jsExpr: "process.platform === 'win32'" },
  },
  {
    id: 'tool-pwsh',
    module: '@deepseek-ai/dsh-tool-pwsh',
    platform: 'win32',
    disabled: { __jsExpr: "process.platform !== 'win32'" },
  },
  { id: 'tool-todo', module: '@deepseek-ai/dsh-tool-todo', config: { allowParallelInProgress: true } },
  { id: 'tool-ask-user', module: '@deepseek-ai/dsh-tool-ask-user' },
  { id: 'tool-skill', module: '@deepseek-ai/dsh-tool-skill' },
  { id: 'tool-jobs', module: '@deepseek-ai/dsh-tool-jobs' },
  { id: 'tool-goal', module: '@deepseek-ai/dsh-tool-goal' },
  {
    id: 'tool-subagent',
    module: '@deepseek-ai/dsh-tool-subagent',
    config: { provider: 'spawn', toolName: 'subagent' },
  },
  { id: 'tool-agent-team', module: '@deepseek-ai/dsh-tool-agent-team' },
  { id: 'tool-present', module: '@deepseek-ai/dsh-tool-present' },
  { id: 'tool-office', module: '@deepseek-ai/dsh-tool-office' },
]

/** One built-in face beside the default one. */
export interface CommonToolFace {
  /** Stable id the client localizes. */
  readonly id: string
  /** Tool ids in switch order. */
  readonly tools: readonly string[]
}

/** Chat-only, search-only, search with files, and every available tool. */
export const COMMON_FACES: readonly CommonToolFace[] = [
  { id: 'none', tools: [] },
  { id: 'search', tools: ['tool-web'] },
  { id: 'search-files', tools: ['tool-web', 'tool-fs', 'tool-fs-search'] },
  { id: 'full', tools: TOOL_CATALOG.map(entry => entry.id) },
]

/**
 * Read one catalog entry.
 * @param id - tool id.
 * @returns the entry, or undefined when the catalog does not know the id.
 */
export function findTool(id: string): ToolCatalogEntry | undefined {
  return TOOL_CATALOG.find(entry => entry.id === id)
}

/**
 * Keep only ids the catalog resolves, in the submitted order.
 * @param ids - submitted tool ids.
 * @returns the resolved ids and the ones the catalog does not know.
 */
export function partitionToolIds(ids: readonly string[]): { known: string[]; unknown: string[] } {
  const known: string[] = []
  const unknown: string[] = []
  for (const id of ids) {
    if (findTool(id) === undefined) unknown.push(id)
    else if (!known.includes(id)) known.push(id)
  }
  return { known, unknown }
}

/** Whether one composition row contributes a model-facing tool. */
export function isToolModule(moduleName: string): boolean {
  return moduleName.startsWith('@deepseek-ai/dsh-tool-') || moduleName.endsWith('/tools')
}

/**
 * Map one preset's composition modules onto catalog ids.
 * @param modules - tool module specifiers in composition order.
 * @returns resolved ids in first-seen order, and modules this catalog cannot offer.
 */
export function toolIdsForModules(modules: readonly string[]): { ids: string[]; missing: string[] } {
  const ids: string[] = []
  const missing: string[] = []
  for (const moduleName of modules) {
    const entry = TOOL_CATALOG.find(candidate => candidate.module === moduleName)
    if (entry === undefined) {
      if (!missing.includes(moduleName)) missing.push(moduleName)
    } else if (!ids.includes(entry.id)) ids.push(entry.id)
  }
  return { ids, missing }
}

/**
 * Build the rows of one preset's tool group.
 * @param ids - resolved catalog ids.
 * @returns rows in the submitted order; unknown ids are skipped by the caller.
 */
export function toolRowsFor(ids: readonly string[]): PresetRow[] {
  const rows: PresetRow[] = []
  for (const id of ids) {
    const entry = findTool(id)
    if (entry === undefined) continue
    rows.push({
      id: entry.id,
      name: entry.module,
      ...(entry.config === undefined ? {} : { config: { ...entry.config } }),
      ...(entry.disabled === undefined ? {} : { disabled: { ...entry.disabled } }),
    })
  }
  return rows
}

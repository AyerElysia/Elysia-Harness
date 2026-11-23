/**
 * Static tool probe: the read-only half of the tool surface.
 *
 * A preset's tool rows are owned by preset-manager. The panel may display them
 * and must never switch, register, or unregister them. This module reads each
 * preset's composition through `agentPresets.compositionInventory()` and maps
 * known modules to the tool ids they contribute.
 *
 * An unmapped module is reported once as a diagnostic and still displayed under
 * its module name, so an unknown static row is visible rather than silently
 * dropped.
 *
 * @module @elysia/capability-host/static-tools
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ScopeKey } from '@deepseek-ai/dsh-scope'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import { STATIC_TOOL_MODULES } from './contracts.ts'
import type { DiagnosticLog } from './diagnostics.ts'
import { describeError } from './errors.ts'

/** One static tool, as one preset contributes it. */
export interface StaticToolEntry {
  /** Tool id the module contributes, or the module name when it is unmapped. */
  readonly id: string
  /** Composition module that contributes it. */
  readonly moduleName: string
  /** Preset whose composition carries the row. */
  readonly sourcePresetId: string
  /** False when this build has no tool-id mapping for the module. */
  readonly mapped: boolean
}

/** One read of the static tool surface. */
export interface StaticToolSnapshot {
  /** One entry per preset and contributed tool id. */
  readonly entries: readonly StaticToolEntry[]
  /** Every static id, including unmapped module names. */
  readonly ids: ReadonlySet<string>
  /** Static ids per preset. */
  readonly byPreset: ReadonlyMap<string, ReadonlySet<string>>
}

/** The empty read, used before the first probe. */
const EMPTY: StaticToolSnapshot = { entries: [], ids: new Set(), byPreset: new Map() }

/** The preset registry read surface this probe needs. */
interface PresetRegistryLike {
  compositionInventory(): Promise<readonly {
    readonly id: string
    readonly broken?: string
    readonly rows: readonly {
      readonly moduleName: string
      readonly enabled: boolean | 'conditional'
    }[]
  }[]>
  acquireScope(id?: string): Promise<{ key: ScopeKey } & AsyncDisposable>
}

/**
 * Whether one composition row is a tool module rather than prompt, clock,
 * compaction, or another non-tool contribution.
 *
 * This is the same rule preset-manager uses to build a static tool face, so the
 * two views never disagree about which rows are tools.
 * @param moduleName - module specifier a composition row names.
 * @returns true for `@deepseek-ai/dsh-tool-*` and `…/tools` modules.
 */
export function isStaticToolModule(moduleName: string): boolean {
  return moduleName.startsWith('@deepseek-ai/dsh-tool-') || moduleName.endsWith('/tools')
}

/**
 * Read each preset's static tool face.
 *
 * Rows whose enablement cannot be decided without a mount (`'conditional'`) are
 * not claimed as static: this Host only locks what the composition states.
 */
export class StaticToolProbe {
  private readonly reportedModules = new Set<string>()

  /**
   * @param ctx - Host context carrying `agentPresets`.
   * @param diagnostics - sink for unmapped modules and unreadable compositions.
   */
  private readonly ctx: Context
  private readonly diagnostics: DiagnosticLog

  constructor(
    ctx: Context,
    diagnostics: DiagnosticLog,
  ) {
    this.ctx = ctx
    this.diagnostics = diagnostics
  }

  /**
   * Read every preset composition and map its tool rows.
   * @returns the static surface; empty when no preset registry is mounted.
   */
  async read(): Promise<StaticToolSnapshot> {
    const registry = this.ctx.get('agentPresets')
    if (registry === undefined) return EMPTY
    let compositions
    try {
      compositions = await registry.compositionInventory()
    } catch (error: unknown) {
      this.diagnostics.report({
        code: 'STATIC_PROBE_FAILED',
        message: `cannot read the preset composition inventory: ${describeError(error)}`,
      })
      return EMPTY
    }
    const entries: StaticToolEntry[] = []
    const byPreset = new Map<string, Set<string>>()
    const presetRegistry = registry as unknown as PresetRegistryLike
    for (const composition of compositions) {
      if (composition.broken !== undefined) continue
      // The live scope is the authoritative tool list: it includes the real
      // definitions a preset contributes, not just the module that mounts them.
      let actual: readonly ToolDefinition[] | undefined
      try {
        const lease = await presetRegistry.acquireScope(composition.id)
        try {
          actual = this.ctx.tools.definitions(lease.key)
        } finally {
          await lease[Symbol.asyncDispose]()
        }
      } catch (error: unknown) {
        this.diagnostics.report({
          code: 'STATIC_PROBE_FAILED',
          message: `cannot read the live tool face of preset ${JSON.stringify(composition.id)}: ${describeError(error)}`,
        })
      }
      if (actual !== undefined) {
        const actualNames = new Set(actual.map(definition => definition.name))
        const ids = new Set<string>()
        for (const row of composition.rows) {
          if (row.enabled !== true) continue
          if (!isStaticToolModule(row.moduleName)) continue
          const mapped = STATIC_TOOL_MODULES[row.moduleName]
          if (mapped === undefined) {
            const key = `${composition.id}\0${row.moduleName}`
            if (!this.reportedModules.has(key)) {
              this.reportedModules.add(key)
              this.diagnostics.report({
                code: 'STATIC_TOOL_UNMAPPED',
                message: `preset ${JSON.stringify(composition.id)} mounts ${JSON.stringify(row.moduleName)}, `
                  + 'which this build cannot map to tool ids; the module is shown without a switch',
              })
            }
            entries.push({ id: row.moduleName, moduleName: row.moduleName, sourcePresetId: composition.id, mapped: false })
            ids.add(row.moduleName)
            continue
          }
          for (const id of mapped) {
            if (!actualNames.has(id)) continue
            entries.push({ id, moduleName: row.moduleName, sourcePresetId: composition.id, mapped: true })
            ids.add(id)
          }
        }
        byPreset.set(composition.id, ids)
        continue
      }
      // Fallback for a preset whose scope cannot be read: retain the composition
      // module names so an unknown static row is visible instead of silently lost.
      for (const row of composition.rows) {
        // Only a row the composition states as enabled is a static tool here.
        if (row.enabled !== true) continue
        // Prompt files, clocks, compaction, and other contributions are not tools.
        if (!isStaticToolModule(row.moduleName)) continue
        const mapped = STATIC_TOOL_MODULES[row.moduleName]
        if (mapped === undefined) {
          const key = `${composition.id}\0${row.moduleName}`
          if (!this.reportedModules.has(key)) {
            this.reportedModules.add(key)
            this.diagnostics.report({
              code: 'STATIC_TOOL_UNMAPPED',
              message: `preset ${JSON.stringify(composition.id)} mounts ${JSON.stringify(row.moduleName)}, `
                + 'which this build cannot map to tool ids; the module is shown without a switch',
            })
          }
          entries.push({ id: row.moduleName, moduleName: row.moduleName, sourcePresetId: composition.id, mapped: false })
          const ids = byPreset.get(composition.id) ?? new Set<string>()
          ids.add(row.moduleName)
          byPreset.set(composition.id, ids)
          continue
        }
        const ids = byPreset.get(composition.id) ?? new Set<string>()
        for (const id of mapped) {
          entries.push({ id, moduleName: row.moduleName, sourcePresetId: composition.id, mapped: true })
          ids.add(id)
        }
        byPreset.set(composition.id, ids)
      }
    }
    return {
      entries,
      ids: new Set(entries.map(entry => entry.id)),
      byPreset,
    }
  }
}

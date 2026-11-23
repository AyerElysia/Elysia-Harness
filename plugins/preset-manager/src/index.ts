/**
 * Host half of the preset manager: it owns a small document of presets that
 * reference prompt files on disk, registers each one as a runtime preset
 * definition, and lists/deletes them. It never creates a session and never
 * selects a preset for an existing session.
 *
 * The document also owns the preset's tool face: the tool rows its definition
 * composes, the face the operator picked, and the custom faces they defined.
 * Every offered tool is probed once per process against the live registry, so
 * the create page never shows a switch that would leave a preset unusable.
 *
 * @module @elysia/preset-manager
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { AgentPreset } from '@deepseek-ai/dsh-agent-preset-registry'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {
  CustomToolFaceInput, ToolFace, ToolFaceCatalog, ToolOption,
  DeletePresetOptions, PresetDraft, PresetSummary, PromptCandidate,
} from './types.ts'
import { PresetDocumentStore, type PresetRecord, type ToolFaceRecord } from './document.ts'
import { buildPresetDefinition } from './definition.ts'
import { PresetManagerError, describeError, type PresetErrorCode } from './errors.ts'
import { normalizeDraft, readPromptCandidates, assertToolFaceName } from './validation.ts'
import {
  COMMON_FACES, DEFAULT_FACE_ID, DEFAULT_TOOL_IDS, TOOL_CATALOG, findTool,
  isToolModule, partitionToolIds, toolIdsForModules, toolRowsFor,
} from './tool-catalog.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    presetManager: PresetManager
  }
}

/** The composition rows this manager reads from the public preset inventory. */
interface CompositionRow {
  /** Module specifier the row names. */
  readonly moduleName: string
}

/** One preset's composition as {@link AgentPresetRegistry.compositionInventory} reports it. */
interface Composition {
  /** Preset identity. */
  readonly id: string
  /** Display name the preset published. */
  readonly name?: string
  /** Why the preset cannot compose a session, when it cannot. */
  readonly broken?: string
  /** Plugin rows in composition order. */
  readonly rows: readonly CompositionRow[]
}

/**
 * Turn a refusal into the wire failure a Remote caller discriminates on, and
 * rethrow anything else unchanged.
 * @param error - the caught failure.
 */
function fail(error: unknown): never {
  if (error instanceof PresetManagerError) {
    throw new RemoteError(`presetManager/${error.code}`, error.message, error.details)
  }
  throw error
}

/**
 * Summary row for one manager-owned record, before the registry diagnostic is
 * added.
 * @param record - persisted manager-owned preset.
 * @param inUse - live session ids running it.
 * @returns the display row.
 */
function managedRow(record: PresetRecord, inUse: readonly string[]): PresetSummary {
  const known = partitionToolIds(record.tools)
  return {
    id: record.id,
    name: record.name,
    managed: true,
    inUse,
    promptRoot: record.promptRoot,
    promptFileCount: record.promptFiles.length,
    createdAt: record.createdAt,
    tools: [...record.tools],
    ...(known.unknown.length === 0 ? {} : { unknownTools: known.unknown }),
    ...(record.description === undefined ? {} : { description: record.description }),
  }
}

/** Host service owning the manager document and every registration it made. */
export class PresetManager extends TypertRemoteService {
  /** Prerequisite services: the preset roster and the live Agent registry. */
  static inject = ['agentPresets', 'agents']

  /** Resolves once the document is open and every owned preset is registered. */
  readonly ready: Promise<void>

  private store: PresetDocumentStore | undefined
  private readonly disposers = new Map<string, () => Promise<void>>()
  private readonly pending = new Map<string, Promise<() => Promise<void>>>()
  private readonly registrationErrors = new Map<string, string>()
  private toolProbe: Promise<ReadonlyMap<string, string> | undefined> | undefined
  private toolProbeResult: ReadonlyMap<string, string> | undefined
  private disposed = false

  /**
   * @param ctx - host context carrying `agentPresets` and `agents`.
   * @param config - the state directory the manager document lives in.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'presetManager', { namespace: 'presetManager' })
    this.ready = this.start(config.stateDir)
    ctx.effect(() => () => this.disposeAll(), 'elysia-preset-manager.registrations')
  }

  /**
   * Read the roster: every registered preset plus every manager-owned record,
   * marked with ownership, live use, and the activation diagnostic.
   * @returns one row per preset, manager-owned rows first in creation order.
   */
  @Remote('list')
  async list(): Promise<PresetSummary[]> {
    try {
      await this.ready
      const store = this.requireStore()
      const registry = await this.ctx.agentPresets.list()
      const index = this.inUseIndex()
      const byId = new Map(registry.map(preset => [preset.id, preset]))
      const rows: PresetSummary[] = []
      for (const record of store.list()) {
        const registered = byId.get(record.id)
        const diagnostic = registered?.broken
          ?? this.registrationErrors.get(record.id)
          ?? (this.disposers.has(record.id) ? undefined : 'preset registration is not installed')
        rows.push({
          ...managedRow(record, index.get(record.id) ?? []),
          ...(diagnostic === undefined ? {} : { diagnostic }),
        })
      }
      const managedIds = new Set(store.list().map(record => record.id))
      for (const preset of registry.toSorted((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0)) {
        if (managedIds.has(preset.id)) continue
        rows.push({
          ...unmanagedRow(preset, index.get(preset.id) ?? []),
        })
      }
      return rows
    } catch (error: unknown) {
      fail(error)
    }
  }

  /**
   * Read every tool this deployment can compose into a preset, together with
   * the default, common, existing-preset, and custom faces.
   *
   * Each tool is probed against the live registry before it is offered, and the
   * result is kept for this Host process: a tool that cannot activate is still
   * listed, marked unavailable with its diagnostic, so nothing is dropped
   * silently.
   * @returns the tool switches and the faces built from them.
   */
  @Remote('listToolFaces')
  async listToolFaces(): Promise<ToolFaceCatalog> {
    try {
      await this.ready
      const store = this.requireStore()
      const failures = await this.probeToolAvailability()
      const options: ToolOption[] = TOOL_CATALOG.map((entry) => {
        const reason = failures?.get(entry.id)
        return {
          id: entry.id,
          module: entry.module,
          available: reason === undefined,
          ...(entry.platform === undefined ? {} : { platform: entry.platform }),
          ...(reason === undefined ? {} : { reason }),
        }
      })
      const available = new Set(options.filter(option => option.available).map(option => option.id))
      const faces: ToolFace[] = [
        {
          kind: 'default',
          id: DEFAULT_FACE_ID,
          name: '',
          tools: DEFAULT_TOOL_IDS.filter(id => available.has(id)),
        },
        ...COMMON_FACES.map(face => ({
          kind: 'common' as const,
          id: face.id,
          name: '',
          tools: face.tools.filter(id => available.has(id)),
        })),
        ...await this.existingPresetFaces(available),
        ...store.listFaces().map(record => customFace(record, available)),
      ]
      return { tools: options, faces }
    } catch (error: unknown) {
      fail(error)
    }
  }

  /**
   * Store one custom face built from the submitted tool ids.
   * @param input - display name and tool ids from the create page's switches.
   * @returns the stored face as the page renders it.
   */
  @Remote('createToolFace')
  async createToolFace(input: CustomToolFaceInput): Promise<ToolFace> {
    try {
      await this.ready
      const store = this.requireStore()
      const name = assertToolFaceName(input.name)
      const tools = partitionToolIds(Array.isArray(input.tools) ? input.tools : [])
      const unknownTool = tools.unknown[0]
      if (unknownTool !== undefined) {
        throw new PresetManagerError('TOOL_UNKNOWN', `tool ${JSON.stringify(unknownTool)} is not in this build's catalog`, {
          toolId: unknownTool, reason: 'unknown-tool',
        })
      }
      if (tools.known.length === 0) {
        throw new PresetManagerError('TOOL_FACE_INVALID', 'a custom tool face needs at least one tool', {
          reason: 'no-tools',
        })
      }
      const taken = store.listFaces().some(face => face.name.toLowerCase() === name.toLowerCase())
      if (taken) {
        throw new PresetManagerError('TOOL_FACE_EXISTS', `a custom tool face named ${JSON.stringify(name)} already exists`, {
          reason: 'name-taken',
        })
      }
      const record: ToolFaceRecord = { id: `custom-${randomUUID().slice(0, 8)}`, name, tools: tools.known }
      await store.addFace(record)
      return customFace(record, new Set(TOOL_CATALOG.map(entry => entry.id)))
    } catch (error: unknown) {
      fail(error)
    }
  }

  /**
   * Remove one custom face. Built-in, common, and existing-preset faces are
   * read-only. Presets that recorded the face keep the tool ids they saved.
   * @param id - custom face id.
   * @returns after the document write.
   */
  @Remote('deleteToolFace')
  async deleteToolFace(id: string): Promise<void> {
    try {
      await this.ready
      const store = this.requireStore()
      if (store.findFace(id) === undefined) {
        if (await this.isImmutableFace(id)) {
          throw new PresetManagerError('TOOL_FACE_READONLY', `tool face "${id}" belongs to a built-in family and cannot be deleted`, {
            toolFaceId: id, reason: 'read-only',
          })
        }
        throw new PresetManagerError('TOOL_FACE_NOT_FOUND', `no custom tool face "${id}" exists`, {
          toolFaceId: id, reason: 'missing',
        })
      }
      await store.removeFace(id)
    } catch (error: unknown) {
      fail(error)
    }
  }

  /**
   * Register one new preset from a validated draft. Registration comes first and
   * the document second, so a refused definition never leaves a half-owned row.
   * @param draft - id, metadata, prompt root, ordered files, and tool ids.
   * @returns the created row.
   */
  @Remote('create')
  async create(draft: PresetDraft): Promise<PresetSummary> {
    try {
      await this.ready
      const store = this.requireStore()
      const record = await normalizeDraft(draft, store.listFaces().map(face => face.id))
      const registry = await this.ctx.agentPresets.list()
      if (store.find(record.id) !== undefined || registry.some(preset => preset.id === record.id)) {
        throw new PresetManagerError('PRESET_ID_EXISTS', `preset id "${record.id}" is already taken`, {
          presetId: record.id,
        })
      }
      const dispose = await this.registerOwned(record)
      try {
        await store.add(record)
      } catch (error: unknown) {
        await this.release(record.id, dispose)
        throw error
      }
      this.disposers.set(record.id, dispose)
      return managedRow(record, this.inUseIndex().get(record.id) ?? [])
    } catch (error: unknown) {
      fail(error)
    }
  }

  /**
   * Remove one manager-owned preset. A preset a live session runs is always
   * refused: its roster entry is what that session resumes on. Custom tool
   * faces are independent and survive.
   * @param id - preset identity.
   * @param options - `force` also drops an entry whose registration is already gone.
   * @returns after disposal and the document write.
   */
  @Remote('delete')
  async delete(id: string, options?: DeletePresetOptions): Promise<void> {
    try {
      await this.ready
      const store = this.requireStore()
      const record = store.find(id)
      if (record === undefined) {
        const registry = await this.ctx.agentPresets.list()
        if (registry.some(preset => preset.id === id)) {
          throw new PresetManagerError(
            'PRESET_NOT_MANAGED',
            `preset "${id}" is declared by a bundle or profile; the manager cannot delete it`,
            { presetId: id },
          )
        }
        throw new PresetManagerError('PRESET_NOT_FOUND', `no preset "${id}" is registered`, { presetId: id })
      }
      const inUse = this.inUseIndex().get(id) ?? []
      if (inUse.length > 0) {
        throw new PresetManagerError(
          'PRESET_IN_USE',
          `preset "${id}" is used by ${String(inUse.length)} live session(s): ${inUse.join(', ')}`,
          { presetId: id, sessionIds: inUse },
        )
      }
      const dispose = this.disposers.get(id)
      if (dispose === undefined && options?.force !== true) {
        throw new PresetManagerError(
          'PRESET_UNREGISTERED',
          `preset "${id}" has no live registration; pass force to drop the owned entry anyway`,
          { presetId: id, reason: this.registrationErrors.get(id) ?? 'not-installed' },
        )
      }
      if (dispose !== undefined) await this.release(id, dispose)
      await store.remove(id)
      this.registrationErrors.delete(id)
    } catch (error: unknown) {
      fail(error)
    }
  }

  /**
   * List the Markdown files a prompt root offers.
   * @param root - absolute directory chosen through the directory picker.
   * @returns `*.md` candidates sorted by name.
   */
  @Remote('listPromptCandidates')
  async listPromptCandidates(root: string): Promise<PromptCandidate[]> {
    try {
      await this.ready
      return await readPromptCandidates(root)
    } catch (error: unknown) {
      fail(error)
    }
  }

  /**
   * Build the faces that come from registered presets.
   * @param available - tool ids this deployment can compose.
   * @returns one face per preset with a tool row, filtered to available tools.
   */
  private async existingPresetFaces(available: ReadonlySet<string>): Promise<ToolFace[]> {
    const inventory: readonly Composition[] = await this.ctx.agentPresets.compositionInventory()
    const faces: ToolFace[] = []
    for (const preset of inventory) {
      if (preset.broken !== undefined) continue
      const modules = preset.rows.map(row => row.moduleName).filter(isToolModule)
      if (modules.length === 0) continue
      const mapped = toolIdsForModules(modules)
      const missing = [...mapped.missing]
      for (const id of mapped.ids) {
        if (available.has(id)) continue
        const entry = findTool(id)
        if (entry !== undefined && !missing.includes(entry.module)) missing.push(entry.module)
      }
      faces.push({
        kind: 'existing',
        id: preset.id,
        name: preset.name ?? preset.id,
        tools: mapped.ids.filter(id => available.has(id)),
        ...(missing.length === 0 ? {} : { missing, partial: true }),
      })
    }
    return faces
  }

  /**
   * Whether a face id belongs to a family the manager never deletes.
   * @param id - face id that no custom face carries.
   * @returns true for the default face, a common face, or a registered preset.
   */
  private async isImmutableFace(id: string): Promise<boolean> {
    if (id === DEFAULT_FACE_ID || COMMON_FACES.some(face => face.id === id)) return true
    const registry = await this.ctx.agentPresets.list()
    return registry.some(preset => preset.id === id)
  }

  /**
   * Probe every catalog tool against the live registry, once per process.
   *
   * A tool is usable when registering a one-row preset leaves no diagnostic:
   * the registry has already mounted the row and audited every service it
   * waits on. Results are cached because the set of Host services that can
   * satisfy a preset row is fixed for the life of the process.
   * @returns tool id to diagnostic for unusable tools, or undefined when the
   * registry refused every probe, which means the probe itself is not evidence.
   */
  private async probeToolAvailability(): Promise<ReadonlyMap<string, string> | undefined> {
    if (this.toolProbeResult !== undefined) return this.toolProbeResult
    const inFlight = this.toolProbe
    if (inFlight !== undefined) return inFlight
    const run = this.runToolProbes()
    this.toolProbe = run
    try {
      return await run
    } finally {
      this.toolProbe = undefined
    }
  }

  /** Run one registration per catalog tool and collect the refusals. */
  private async runToolProbes(): Promise<ReadonlyMap<string, string> | undefined> {
    const failures = new Map<string, string>()
    let refusedRegistrations = 0
    for (const entry of TOOL_CATALOG) {
      const probeId = `elysia-tool-probe-${randomUUID()}`
      let dispose: () => Promise<void>
      try {
        dispose = await this.ctx.agentPresets.register({
          id: probeId,
          plugins: [{
            id: 'tools',
            name: 'cordis:group',
            group: true,
            config: toolRowsFor([entry.id]),
          }],
        })
      } catch (error: unknown) {
        refusedRegistrations += 1
        failures.set(entry.id, describeError(error))
        continue
      }
      try {
        const probe = await this.ctx.agentPresets.resolve(probeId)
        if (probe.broken !== undefined) failures.set(entry.id, probe.broken)
      } catch (error: unknown) {
        failures.set(entry.id, describeError(error))
      } finally {
        try {
          await dispose()
        } catch {
          // A probe whose registration already settled owns no retained scope;
          // a rejection here leaves nothing to clean up.
        }
      }
    }
    // Every probe failing before a scope existed means the registry refused the
    // registrations themselves, not that each tool is unavailable.
    if (refusedRegistrations === TOOL_CATALOG.length) {
      this.ctx.logger.warn('preset-manager: tool probe could not register any preset row; offering the static catalog')
      return undefined
    }
    this.toolProbeResult = failures
    return failures
  }

  /**
   * Open the document and start registering every preset it owns. Registration
   * adds each definition to the roster synchronously, so session resume can
   * resolve it; activation continues after this plugin's Loader row returns.
   * @param stateDir - the manager document directory.
   * @returns after the document opens and every registration is scheduled.
   */
  private async start(stateDir: string): Promise<void> {
    const store = await PresetDocumentStore.open(stateDir)
    this.store = store
    for (const record of store.list()) {
      const pending = this.registerOwned(record)
      this.pending.set(record.id, pending)
      void pending.then((dispose) => {
        this.pending.delete(record.id)
        if (this.disposed) return
        this.disposers.set(record.id, dispose)
        this.registrationErrors.delete(record.id)
      }, (error: unknown) => {
        this.pending.delete(record.id)
        if (!this.disposed) this.registrationErrors.set(record.id, describeError(error))
      })
    }
  }

  /**
   * Register one record and confirm the registry considers it usable.
   * @param record - validated manager-owned preset.
   * @returns the registration disposer, owned by the caller.
   */
  private async registerOwned(record: PresetRecord): Promise<() => Promise<void>> {
    let dispose: () => Promise<void>
    try {
      dispose = await this.ctx.agentPresets.register(buildPresetDefinition(record))
    } catch (error: unknown) {
      throw new PresetManagerError(
        'PRESET_REGISTER_FAILED',
        `preset "${record.id}" could not be registered: ${describeError(error)}`,
        { presetId: record.id, reason: describeError(error) },
      )
    }
    const registered = await this.ctx.agentPresets.list()
    const broken = registered.find(preset => preset.id === record.id)?.broken
    if (broken !== undefined) {
      await this.release(record.id, dispose)
      throw new PresetManagerError(
        'PRESET_REGISTER_FAILED',
        `preset "${record.id}" cannot compose a session: ${broken}`,
        { presetId: record.id, reason: broken },
      )
    }
    return dispose
  }

  /**
   * Dispose one registration, keeping the document entry when disposal fails.
   * @param id - preset identity.
   * @param dispose - the registration's disposer.
   */
  private async release(id: string, dispose: () => Promise<void>): Promise<void> {
    try {
      await dispose()
    } catch (error: unknown) {
      throw new PresetManagerError(
        'PRESET_DISPOSE_FAILED',
        `preset "${id}" registration could not be disposed: ${describeError(error)}`,
        { presetId: id, reason: describeError(error) },
      )
    }
    this.disposers.delete(id)
  }

  /** Map every preset id to the live sessions currently running it. */
  private inUseIndex(): Map<string, string[]> {
    const index = new Map<string, string[]>()
    for (const agent of this.ctx.agents.list()) {
      const preset = this.ctx.agentPresets.presetForSession(agent.session)
      if (preset === null) continue
      const sessions = index.get(preset) ?? []
      if (!sessions.includes(agent.session.id)) sessions.push(agent.session.id)
      index.set(preset, sessions)
    }
    return index
  }

  /** The opened document; unreachable after `ready` resolves. */
  private requireStore(): PresetDocumentStore {
    if (this.store === undefined) {
      throw new PresetManagerError('STATE_INVALID', 'preset-manager document is not open', { reason: 'not-open' })
    }
    return this.store
  }

  /** Dispose every registration this plugin made, including pending startup work. */
  private async disposeAll(): Promise<void> {
    this.disposed = true
    const pending = [...this.pending.values()]
    this.pending.clear()
    for (const registration of pending) {
      try {
        const dispose = await registration
        await dispose()
      } catch {
        // A registration that never resolved owns no live tree to dispose.
      }
    }
    const entries = [...this.disposers]
    this.disposers.clear()
    for (const [, dispose] of entries) await dispose()
  }
}

/**
 * One stored custom face as the page renders it, filtered to what this
 * deployment can compose.
 * @param record - stored custom face.
 * @param available - tool ids this deployment can compose.
 * @returns the face, marked partial when a stored tool is unavailable.
 */
function customFace(record: ToolFaceRecord, available: ReadonlySet<string>): ToolFace {
  const missing = record.tools.filter(id => !available.has(id))
  return {
    kind: 'custom',
    id: record.id,
    name: record.name,
    tools: record.tools.filter(id => available.has(id)),
    ...(missing.length === 0 ? {} : { missing, partial: true }),
  }
}

/** Row for a preset the manager does not own. */
function unmanagedRow(preset: AgentPreset, inUse: readonly string[]): PresetSummary {
  return {
    id: preset.id,
    managed: false,
    inUse,
    ...(preset.name === undefined ? {} : { name: preset.name }),
    ...(preset.description === undefined ? {} : { description: preset.description }),
    ...(preset.broken === undefined ? {} : { diagnostic: preset.broken }),
  }
}

/** Where the manager document lives. */
export interface Config {
  /** Absolute directory holding the manager document. */
  stateDir: string
}

/** Validation for {@link Config}: a missing or relative directory fails at load. */
export const Config: z<Config> = z.object({
  stateDir: z.string().required(),
})

/** Cordis plugin name used by loader diagnostics. */
export const name = 'elysia-preset-manager'

/** Prerequisite services of the Host row. */
export const inject = ['agentPresets', 'agents']

/**
 * Mount the manager and wait for its document and registrations.
 * @param ctx - host context owning the service.
 * @param config - the state directory the manager document lives in.
 * @throws when the state directory is unusable or a registration is refused at start.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const manager = new PresetManager(ctx, config)
  await manager.ready
}

/** Re-exported for callers that branch on the refusal code. */
export type { PresetErrorCode }

/**
 * The Host service: it owns the dynamic catalog, the step gate, the context
 * bus, the session registry, the static tool probe, and the persisted
 * document, and it exposes the panel's Remote API (`list`, `setTool`,
 * `setContext`, `publish`, `status`).
 *
 * v1.2 boundary: a preset's static tool face is read from
 * `agentPresets.compositionInventory()` and shown locked. Only dynamic tools are
 * switchable, and only dynamic registrations are owned here.
 *
 * @module @elysia/capability-host/service
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ScopeKey } from '@deepseek-ai/dsh-scope'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import type { ToolDefinition, ToolExecution } from '@deepseek-ai/dsh-tools'
import { Remote, RemoteError, TypertRemoteService, principalOf } from '@deepseek-ai/dsh-typert-protocol'
import type { Principal } from '@deepseek-ai/dsh-typert-protocol'
import type {
  CapabilitySnapshot, ContextEventInput, ContextStatus, HostState, HostStatus,
  PublishReceipt, ScopeRef, ScopeView, SessionView, ToolPresetView, ToolView,
} from './types.ts'
import type { ContextDefaults, ContextKindRegistration, ToolCatalogEntry } from './contracts.ts'
import { CapabilityStateStore } from './state.ts'
import { DiagnosticLog } from './diagnostics.ts'
import { ToolGate, type GateAgent } from './gate.ts'
import { ToolCatalog } from './catalog.ts'
import { ContextBus } from './context-bus.ts'
import { SessionRegistry } from './sessions.ts'
import { StaticToolProbe, type StaticToolSnapshot } from './static-tools.ts'
import { CapabilityHostError, describeError } from './errors.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    capabilityHost: CapabilityHost
  }

  interface Events {
    /**
     * A switch, delivery state, or catalog changed. A Capability Set row
     * re-syncs its registrations; nothing else consumes it.
     * @param change - what changed and, when it applies to one scope, which one.
     * @mode emit
     */
    'capability-host/change'(change: CapabilityChange): undefined
  }
}

/** One observable change to the capability surface. */
export interface CapabilityChange {
  /** Which kind of change happened. */
  readonly action: 'setTool' | 'setContext' | 'state' | 'catalog'
  /** Scope the change applies to, when it applies to one. */
  readonly scope?: ScopeRef
  /** Tool id or context kind the change addresses. */
  readonly id?: string
  /** The value after the change. */
  readonly enabled?: boolean
}

/** One recorded mutation, kept in process for the owner audit trail. */
export interface AuditEntry {
  /** ISO timestamp. */
  readonly at: string
  /** Action that was performed. */
  readonly action: CapabilityChange['action']
  /** Scope it applied to. */
  readonly scope?: ScopeRef
  /** Tool id or context kind. */
  readonly id?: string
  /** Value after the change. */
  readonly enabled?: boolean
}

/** The resolved configuration one Host instance runs with. */
export interface HostConfig {
  /** Absolute directory holding the panel document. */
  readonly stateDir: string
  /** Initial delivery state. */
  readonly hostState: HostState
  /** Traffic defaults for context kinds that do not declare their own. */
  readonly context: ContextDefaults
  /** Ceiling on events merged into one snapshot. */
  readonly maxEventsPerSnapshot: number
  /** Ceiling on bytes of one merged snapshot. */
  readonly maxSnapshotBytes: number
  /** Principal allowed to mutate switches; absent means any in-process caller. */
  readonly ownerId?: string
}

/** Everything a mounted Host instance owns, available after `ready` resolves. */
interface HostRuntime {
  readonly store: CapabilityStateStore
  readonly diagnostics: DiagnosticLog
  readonly gate: ToolGate
  readonly catalog: ToolCatalog
  readonly bus: ContextBus
  readonly sessions: SessionRegistry
  readonly probe: StaticToolProbe
  /** Most recent static tool read. */
  staticTools: StaticToolSnapshot
}

/** The empty static read, before the first probe. */
const EMPTY_STATIC: StaticToolSnapshot = { entries: [], ids: new Set(), byPreset: new Map() }

/**
 * Turn a refusal into the wire failure a Remote caller discriminates on, and
 * rethrow anything else unchanged.
 * @param error - the caught failure.
 */
function fail(error: unknown): never {
  if (error instanceof CapabilityHostError) {
    throw new RemoteError(`capabilityHost/${error.code}`, error.message, error.details)
  }
  throw error
}

/** The document timestamp a fresh, never-written document carries. */
const EPOCH = new Date(0).toISOString()

/**
 * Host-side owner of the capability panel.
 *
 * Construction registers the service and starts the state document; Remote
 * callers await {@link ready} first, so a snapshot never observes a half-built
 * runtime.
 */
export class CapabilityHost extends TypertRemoteService {
  /** Prerequisite services of the Host row. */
  static inject = ['agents', 'tools', 'agentPresets']

  /** Resolves once the document is open, static tools are read, and the bus is attached. */
  readonly ready: Promise<void>

  /** ISO timestamp of this Host instance's mount. */
  readonly mountedAt = new Date().toISOString()

  private runtime: HostRuntime | undefined
  private readonly diagnostics = new DiagnosticLog()
  private readonly audit: AuditEntry[] = []

  /**
   * @param ctx - Host context carrying `agents`, `tools`, and `agentPresets`.
   * @param config - resolved Host configuration.
   */
  private readonly config: HostConfig
  private dynamicIds = new Set<string>()

  constructor(ctx: Context, config: HostConfig) {
    super(ctx, 'capabilityHost', { namespace: 'capabilityHost' })
    this.config = config
    this.ready = this.start()
  }

  /**
   * Declare one dynamic tool.
   * @param entry - the provider's declaration.
   * @returns a disposer that removes what the declaration registered.
   */
  registerTool(entry: ToolCatalogEntry): () => void {
    const runtime = this.requireRuntime()
    const dispose = runtime.catalog.register(entry)
    this.emit({ action: 'catalog', id: entry.id })
    return dispose
  }

  /**
   * Declare one publishable context kind.
   * @param registration - kind name, description, and delivery limits.
   * @returns a disposer that removes the declaration.
   */
  registerContextKind(registration: ContextKindRegistration): () => void {
    const runtime = this.requireRuntime()
    const dispose = runtime.bus.registerKind(registration)
    this.emit({ action: 'catalog', id: registration.kind })
    return dispose
  }

  /**
   * Agent-scoped dynamic entries switched on at one scope, for the Capability Set row.
   * @param ref - preset or session scope being mounted.
   * @returns entries enabled at that scope.
   */
  agentToolEntries(ref: ScopeRef): readonly ToolCatalogEntry[] {
    return this.requireRuntime().catalog.agentEntriesFor(ref)
  }

  /**
   * Whether one dynamic tool is on for one Agent right now, without catching failures.
   * @param agent - Agent whose step is being prepared.
   * @param toolId - dynamic catalog id.
   * @returns whether the tool participates in this Agent's step.
   */
  isEnabled(agent: GateAgent | undefined, toolId: string): boolean {
    return this.requireRuntime().gate.enabled(agent, toolId)
  }

  /**
   * Report a Capability Set mount failure the panel must show.
   * @param toolId - catalog id that could not mount.
   * @param message - what failed.
   */
  reportMountFailure(toolId: string, message: string): void {
    this.diagnostics.report({ code: 'TOOL_MOUNT_FAILED', message, toolId })
  }

  /**
   * Pause or resume delivery. Paused keeps queueing events and injects nothing;
   * the state is process-local and is not persisted.
   * @param state - desired delivery state.
   */
  setHostState(state: HostState): void {
    this.requireRuntime().bus.setHostState(state)
    this.record({ action: 'state', enabled: state === 'enabled' })
    this.emit({ action: 'state', enabled: state === 'enabled' })
  }

  /** The process-local audit trail, newest last. */
  auditLog(): readonly AuditEntry[] {
    return this.audit
  }

  /**
   * Read the switch surface and catalog for the panel.
   * @returns the snapshot the panel renders.
   */
  @Remote('list')
  async list(): Promise<CapabilitySnapshot> {
    try {
      await this.ready
      return await this.buildSnapshot()
    } catch (error: unknown) {
      fail(error)
    }
  }

  /**
   * Switch one dynamic tool on or off for a preset or session.
   * @param scope - target scope.
   * @param toolId - dynamic catalog id.
   * @param enabled - explicit on or explicit off.
   * @returns after the document write is durable.
   * @throws CapabilityHostError `TOOL_STATIC_LOCKED` for a preset's static tool.
   */
  @Remote('setTool')
  async setTool(scope: ScopeRef, toolId: string, enabled: boolean): Promise<void> {
    try {
      await this.ready
      const runtime = this.requireRuntime()
      this.assertAuthorized()
      const target = parseScopeRef(scope)
      await this.refreshStatic()
      if (this.staticIdsFor(target).has(toolId)) {
        throw new CapabilityHostError('TOOL_STATIC_LOCKED', '预设默认工具，不能关闭', { toolId, scope: target })
      }
      const record = runtime.catalog.find(toolId)
      if (record === undefined && !this.dynamicIds.has(toolId)) {
        throw new CapabilityHostError('TOOL_UNKNOWN', `tool ${JSON.stringify(toolId)} is not registered by any provider`, { toolId })
      }
      await this.assertScopeExists(target)
      await runtime.store.setSwitch(target, 'tools', toolId, enabled)
      this.record({ action: 'setTool', scope: target, id: toolId, enabled })
      this.emit({ action: 'setTool', scope: target, id: toolId, enabled })
    } catch (error: unknown) {
      fail(error)
    }
  }

  /**
   * Save the current dynamic-tool selection as a reusable named group.
   * @param name - operator-provided display name.
   * @param tools - dynamic tool ids to store.
   * @returns the committed preset.
   */
  @Remote('createToolPreset')
  async createToolPreset(name: string, tools: readonly string[]): Promise<ToolPresetView> {
    try {
      await this.ready
      const runtime = this.requireRuntime()
      this.assertAuthorized()
      const trimmed = typeof name === 'string' ? name.trim() : ''
      if (trimmed === '') throw new CapabilityHostError('TOOL_UNKNOWN', '工具组名称不能为空', {
        reason: 'empty-name',
      })
      if (!Array.isArray(tools) || tools.length === 0) {
        throw new CapabilityHostError('TOOL_UNKNOWN', '工具组至少需要一个工具', { reason: 'empty-tools' })
      }
      const normalized = [...new Set(tools)]
      const unknown = normalized.find(id => !this.dynamicIds.has(id))
      if (unknown !== undefined) {
        throw new CapabilityHostError('TOOL_UNKNOWN', `tool ${JSON.stringify(unknown)} is not dynamic in this build`, {
          toolId: unknown,
        })
      }
      const record = await runtime.store.addToolPreset(trimmed, normalized)
      this.emit({ action: 'state' })
      return record
    } catch (error: unknown) {
      fail(error)
    }
  }

  /**
   * Delete one saved tool group.
   * @param id - saved preset id.
   * @returns after the document write is durable.
   */
  @Remote('deleteToolPreset')
  async deleteToolPreset(id: string): Promise<void> {
    try {
      await this.ready
      const runtime = this.requireRuntime()
      this.assertAuthorized()
      if (!await runtime.store.removeToolPreset(id)) {
        throw new CapabilityHostError('TOOL_UNKNOWN', `tool preset ${JSON.stringify(id)} does not exist`, {
          toolId: id,
        })
      }
      this.emit({ action: 'state' })
    } catch (error: unknown) {
      fail(error)
    }
  }

  /**
   * Subscribe or unsubscribe one context kind for a preset or session.
   * @param scope - target scope.
   * @param eventKind - registered kind name.
   * @param enabled - explicit subscribe or explicit unsubscribe.
   * @returns after the document write is durable.
   */
  @Remote('setContext')
  async setContext(scope: ScopeRef, eventKind: string, enabled: boolean): Promise<void> {
    try {
      await this.ready
      const runtime = this.requireRuntime()
      this.assertAuthorized()
      const target = parseScopeRef(scope)
      if (!runtime.bus.listKinds().some(kind => kind.kind === eventKind)) {
        throw new CapabilityHostError('CONTEXT_UNKNOWN', `context kind ${JSON.stringify(eventKind)} is not registered`, {
          eventKind,
        })
      }
      await this.assertScopeExists(target)
      await runtime.store.setSwitch(target, 'contexts', eventKind, enabled)
      this.record({ action: 'setContext', scope: target, id: eventKind, enabled })
      this.emit({ action: 'setContext', scope: target, id: eventKind, enabled })
    } catch (error: unknown) {
      fail(error)
    }
  }

  /**
   * Publish one context event to every subscribed, visible session.
   * @param event - the publication.
   * @returns delivery accounting.
   */
  @Remote('publish')
  async publish(event: ContextEventInput): Promise<PublishReceipt> {
    try {
      await this.ready
      this.assertAuthorized()
      if (typeof event !== 'object' || event === null) {
        throw new CapabilityHostError('EVENT_INVALID', 'a publication must be an object')
      }
      return await this.requireRuntime().bus.publish(event)
    } catch (error: unknown) {
      fail(error)
    }
  }

  /**
   * Read the Host's health and accounting.
   * @returns tool, context, gate, and session status.
   */
  @Remote('status')
  async status(): Promise<HostStatus> {
    try {
      await this.ready
      const runtime = this.requireRuntime()
      await runtime.sessions.observe()
      const staticTools = await this.refreshStatic()
      const records = runtime.catalog.list()
      if (this.dynamicIds.size === 0) await this.buildSnapshot()
      const dynamicCount = this.dynamicIds.size
      const candidates = runtime.sessions.candidates()
      let enabledNow = 0
      for (const record of records) {
        if (record.entry.scope !== 'global') continue
        if (candidates.some(candidate => runtime.gate.enabled(runtime.sessions.agentOf(candidate.id), record.entry.id))) {
          enabledNow += 1
        }
      }
      const document = runtime.store.snapshot()
      const context: ContextStatus = runtime.bus.status()
      return {
        hostState: runtime.bus.hostState(),
        mountedAt: this.mountedAt,
        stateDir: this.config.stateDir,
        stateVersion: document.version,
        ...(document.updatedAt === EPOCH ? {} : { stateUpdatedAt: document.updatedAt }),
        tools: {
          static: staticTools.entries.length,
          global: dynamicCount,
          agent: 0,
          enabledNow,
          unavailable: records.filter(record => record.reason !== undefined).length,
        },
        context,
        gate: runtime.gate.status(),
        sessions: runtime.sessions.counts(),
        diagnostics: this.diagnostics.list(),
      }
    } catch (error: unknown) {
      fail(error)
    }
  }

  /** Open the document, compose the runtime, and attach the step listener. */
  private async start(): Promise<void> {
    const store = await CapabilityStateStore.open(this.config.stateDir)
    const sessions = new SessionRegistry(this.ctx, store)
    const gate = new ToolGate(store, sessionId => sessions.presetOf(sessionId), this.diagnostics)
    const catalog = new ToolCatalog(this.ctx, gate, this.diagnostics)
    const bus = new ContextBus({
      ctx: this.ctx,
      store,
      sessions,
      defaults: this.config.context,
      diagnostics: this.diagnostics,
      maxEventsPerSnapshot: this.config.maxEventsPerSnapshot,
      maxSnapshotBytes: this.config.maxSnapshotBytes,
      hostState: this.config.hostState,
    })
    const probe = new StaticToolProbe(this.ctx, this.diagnostics)
    bus.attach()
    this.runtime = {
      store, diagnostics: this.diagnostics, gate, catalog, bus, sessions, probe, staticTools: EMPTY_STATIC,
    }
    // A restart must still enforce stored off switches before the first panel
    // list call refreshes the full inventory.
    this.dynamicIds = new Set(this.ctx.tools.definitions().map(definition => definition.name))
    // Read the static face once so the first snapshot and switch validation are
    // complete; it does not alter the dynamic registrations.
    await this.refreshStatic()
    this.ctx.effect(() => () => catalog.dispose(), 'elysia-capability-host.catalog')
    // Call-level gate: a switch flipped mid-step must not let an already-admitted
    // call run. `when` is the step gate; this guard is the monotonic backstop.
    this.ctx.effect(() => this.ctx.tools.guard(exec => this.guardCall(exec)), 'elysia-capability-host.guard')
    this.reconcile()
  }

  /**
   * Re-read the static tool surface.
   *
   * Static tools are per preset and do not change what this Host registers: a
   * global dynamic tool of the same id stays registered, and DSH's scoped layers
   * shadow it only for the preset that contributes the static one.
   * @returns the latest static read.
   */
  private async refreshStatic(): Promise<StaticToolSnapshot> {
    const runtime = this.requireRuntime()
    const snapshot = await runtime.probe.read()
    runtime.staticTools = snapshot
    return snapshot
  }

  /**
   * Static ids that apply to one scope: the preset's own set, or the set of the
   * preset a session inherits.
   * @param ref - preset or session scope.
   * @returns the static ids locked in that scope.
   */
  private staticIdsFor(ref: ScopeRef): ReadonlySet<string> {
    const runtime = this.requireRuntime()
    const presetId = ref.kind === 'preset' ? ref.id : runtime.sessions.presetOf(ref.id)
    if (presetId === undefined) return new Set()
    return runtime.staticTools.byPreset.get(presetId) ?? new Set()
  }

  /**
   * Deny an admitted dynamic call whose tool was switched off after the step started.
   * @param exec - the pending call.
   * @returns a denial reason, or undefined to leave the call allowed.
   */
  private guardCall(exec: Readonly<ToolExecution>): string | undefined {
    if (exec.agent === undefined) return undefined
    const runtime = this.runtime
    if (runtime === undefined) return undefined
    const record = runtime.catalog.find(exec.name)
    const managed = record !== undefined && record.entry.scope === 'global'
    // Stored switches are authoritative even when a plugin registered its
    // global tool after this Host started: the restart path must still refuse
    // a tool the panel explicitly switched off.
    const inventory = !managed && (this.dynamicIds.has(exec.name) || this.hasToolSwitch(exec.agent, exec.name))
    if (!managed && !inventory) return undefined
    // A preset's own tool row shadows a global tool with the same name; that call
    // is static and has no switch.
    const presetId = runtime.sessions.presetOf(exec.agent.session.id)
    if (presetId !== undefined && (runtime.staticTools.byPreset.get(presetId) ?? new Set()).has(exec.name)) return undefined
    // Only an admitted call is this guard's business. A tool already filtered out
    // of the step set must fall through so the registry answers UNKNOWN_TOOL.
    if (exec.toolSet === undefined || !exec.toolSet.view(exec.agent).has(exec.name)) return undefined
    try {
      const enabled = managed
        ? this.isEnabled(exec.agent, record.entry.id)
        : this.inventoryEnabled(exec.agent, exec.name)
      return enabled ? undefined : `tool ${JSON.stringify(exec.name)} is switched off for this session`
    } catch (error: unknown) {
      // Fail closed: an unresolvable call-level gate denies the call.
      this.diagnostics.report({
        code: 'GATE_FAILED',
        message: `call-level gate failed for tool ${JSON.stringify(exec.name)}: ${describeError(error)}`,
        toolId: exec.name,
      })
      return `tool ${JSON.stringify(exec.name)} cannot be resolved`
    }
  }

  /** Whether a stored session or preset switch exists for one unmanaged tool. */
  private hasToolSwitch(agent: GateAgent, toolId: string): boolean {
    const runtime = this.requireRuntime()
    if (runtime.store.switchValue({ kind: 'session', id: agent.session.id }, 'tools', toolId) !== undefined) return true
    const presetId = runtime.sessions.presetOf(agent.session.id)
    return presetId !== undefined
      && runtime.store.switchValue({ kind: 'preset', id: presetId }, 'tools', toolId) !== undefined
  }

  /** Whether an unmanaged registered tool is on for one Agent. Defaults to its actual availability. */
  private inventoryEnabled(agent: GateAgent, toolId: string, available = true): boolean {
    const runtime = this.requireRuntime()
    const own = runtime.store.switchValue({ kind: 'session', id: agent.session.id }, 'tools', toolId)
    if (own !== undefined) return own
    const presetId = runtime.sessions.presetOf(agent.session.id)
    if (presetId !== undefined) {
      const inherited = runtime.store.switchValue({ kind: 'preset', id: presetId }, 'tools', toolId)
      if (inherited !== undefined) return inherited
    }
    return available
  }

  /** Whether an unmanaged registered tool is on for one panel scope. */
  private inventoryScopeEnabled(ref: ScopeRef, toolId: string, available = true): boolean {
    const runtime = this.requireRuntime()
    const own = runtime.store.switchValue(ref, 'tools', toolId)
    if (own !== undefined) return own
    if (ref.kind === 'session') {
      const presetId = runtime.sessions.presetOf(ref.id)
      if (presetId !== undefined) {
        const inherited = runtime.store.switchValue({ kind: 'preset', id: presetId }, 'tools', toolId)
        if (inherited !== undefined) return inherited
      }
    }
    return available
  }

  /** Every tool visible in one preset or session scope. */
  private async scopeDefinitions(ref: ScopeRef): Promise<readonly ToolDefinition[]> {
    const runtime = this.requireRuntime()
    const agent: Agent | undefined = ref.kind === 'session' ? runtime.sessions.agentOf(ref.id) : undefined
    if (agent !== undefined) {
      const key = scopeOf(agent.ctx)
      if (key !== undefined) return this.ctx.tools.definitions(key)
    }
    const presetId = ref.kind === 'preset' ? ref.id : runtime.sessions.presetOf(ref.id)
    if (presetId !== undefined) {
      const registry = this.ctx.get('agentPresets') as {
        acquireScope?(id?: string): Promise<{ key: ScopeKey } & AsyncDisposable>
      } | undefined
      if (registry?.acquireScope !== undefined) {
        const lease = await registry.acquireScope(presetId)
        try {
          return this.ctx.tools.definitions(lease.key)
        } finally {
          await lease[Symbol.asyncDispose]()
        }
      }
    }
    return this.ctx.tools.definitions()
  }

  /**
   * Report stored ids this build no longer offers. Unknown entries never block
   * the panel: the rest of the document still applies.
   */
  private reconcile(): void {
    const runtime = this.runtime
    if (runtime === undefined) return
    const toolIds = new Set(runtime.catalog.list().map(record => record.entry.id))
    const kindIds = new Set(runtime.bus.listKinds().map(kind => kind.kind))
    const document = runtime.store.snapshot()
    const scopes: ScopeRef[] = [
      ...Object.keys(document.presets).map(id => ({ kind: 'preset', id }) as const),
      ...Object.keys(document.sessions).map(id => ({ kind: 'session', id }) as const),
    ]
    for (const ref of scopes) {
      const overrides = runtime.store.overrides(ref)
      for (const toolId of Object.keys(overrides.tools)) {
        if (toolIds.has(toolId)) continue
        this.diagnostics.report({
          code: 'TOOL_UNKNOWN',
          message: `stored dynamic tool ${JSON.stringify(toolId)} is not offered by this build; the entry is kept but has no effect`,
          scope: ref, toolId,
        })
      }
      for (const kind of Object.keys(overrides.contexts)) {
        if (kindIds.has(kind)) continue
        this.diagnostics.report({
          code: 'CONTEXT_UNKNOWN',
          message: `stored context kind ${JSON.stringify(kind)} is not registered in this build; the entry is kept but has no effect`,
          scope: ref, eventKind: kind,
        })
      }
    }
  }

  /** Compose the panel snapshot. */
  private async buildSnapshot(): Promise<CapabilitySnapshot> {
    const runtime = this.requireRuntime()
    await runtime.sessions.observe()
    const staticTools = await this.refreshStatic()
    const records = runtime.catalog.list()
    const managedIds = records.map(record => record.entry.id)
    const globalDefinitions = new Map(this.ctx.tools.definitions().map(definition => [definition.name, definition]))
    const kinds = runtime.bus.listKinds()
    const kindIds = kinds.map(kind => kind.kind)
    const presetIds = await this.knownPresetIds()
    const sessionIds = [...new Set([
      ...runtime.sessions.candidates().map(candidate => candidate.id),
      ...runtime.store.sessionIds(),
    ])].sort()
    const scopes: ScopeView[] = []
    const universe = new Map<string, ToolDefinition>()
    const scopeInputs: {
      ref: ScopeRef
      staticIds: ReadonlySet<string>
      definitions?: readonly ToolDefinition[]
    }[] = []
    for (const id of presetIds) {
      scopeInputs.push({ ref: { kind: 'preset', id }, staticIds: staticTools.byPreset.get(id) ?? new Set() })
    }
    for (const id of sessionIds) {
      const presetId = runtime.sessions.presetOf(id)
      scopeInputs.push({
        ref: { kind: 'session', id },
        staticIds: presetId === undefined ? new Set() : staticTools.byPreset.get(presetId) ?? new Set(),
      })
    }
    // One deployment-wide universe: a tool mounted by any preset is available
    // to the panel, even when the selected preset does not compose it.
    for (const definition of this.ctx.tools.definitions()) universe.set(definition.name, definition)
    for (const input of scopeInputs) {
      const definitions = await this.scopeDefinitions(input.ref)
      input.definitions = definitions
      for (const definition of definitions) universe.set(definition.name, definition)
    }
    const dynamicViews = new Map<string, ToolView>()
    this.dynamicIds = new Set([...universe.keys()].filter(name =>
      scopeInputs.length === 0 || !scopeInputs.every(input => input.staticIds.has(name))))
    for (const [name, definition] of universe) {
      if (!this.dynamicIds.has(name)) continue
      dynamicViews.set(name, {
        id: name,
        origin: 'dynamic',
        locked: false,
        scope: globalDefinitions.has(name) ? 'global' : 'agent',
        group: 'registered',
        required: [],
        registered: true,
        provider: 'registered',
        description: definition.description,
      })
    }
    for (const input of scopeInputs) {
      const tools = runtime.gate.merged(input.ref, managedIds)
      const localNames = new Set((input.definitions ?? []).map(definition => definition.name))
      for (const name of universe.keys()) {
        if (input.staticIds.has(name)) continue
        tools[name] = this.inventoryScopeEnabled(input.ref, name, localNames.has(name))
      }
      // Static tools are always on for the preset that composes them.
      for (const staticId of input.staticIds) tools[staticId] = true
      scopes.push({
        ref: input.ref,
        overrides: runtime.store.overrides(input.ref),
        tools,
        contexts: this.mergedContexts(input.ref, kindIds),
      })
    }

    const tools: ToolView[] = [
      ...staticTools.entries.map((entry): ToolView => ({
        id: entry.id,
        origin: 'static',
        locked: true,
        registered: true,
        required: [],
        provider: entry.moduleName,
        sourcePresetId: entry.sourcePresetId,
        ...(entry.mapped
          ? {}
          : {
            description: `static module ${entry.moduleName}: no tool-id mapping in this build`,
            reason: 'unmapped static module',
          }),
      })),
      ...records.map((record): ToolView => {
        const entry = record.entry
        return {
          id: entry.id,
          origin: 'dynamic',
          // A dynamic entry is never locked; a preset that composes the same
          // static id shadows it for that preset only, which the client derives.
          locked: false,
          scope: entry.scope,
          description: entry.description,
          required: entry.required ?? [],
          registered: record.registered,
          ...(entry.group === undefined ? {} : { group: entry.group }),
          ...(entry.provider === undefined ? {} : { provider: entry.provider }),
          ...(record.reason === undefined ? {} : { reason: record.reason }),
        }
      }),
      ...dynamicViews.values(),
    ]
    const sessions: SessionView[] = [...runtime.sessions.list()]
    const document = runtime.store.snapshot()
    return {
      version: 2,
      hostState: runtime.bus.hostState(),
      tools,
      contexts: kinds,
      scopes,
      sessions,
      toolPresets: runtime.store.toolPresets(),
      ...(document.updatedAt === EPOCH ? {} : { stateUpdatedAt: document.updatedAt }),
      diagnostics: this.diagnostics.list(),
    }
  }

  /**
   * Merge one scope's context subscriptions over the registered kinds.
   * @param ref - preset or session scope.
   * @param kindIds - registered kind names.
   * @returns explicit subscription per kind after preset and session merging.
   */
  private mergedContexts(ref: ScopeRef, kindIds: readonly string[]): Record<string, boolean> {
    const runtime = this.requireRuntime()
    const merged: Record<string, boolean> = {}
    for (const kind of kindIds) {
      const own = runtime.store.switchValue(ref, 'contexts', kind)
      if (own !== undefined) {
        merged[kind] = own
        continue
      }
      if (ref.kind === 'preset') {
        merged[kind] = false
        continue
      }
      const presetId = runtime.sessions.presetOf(ref.id)
      merged[kind] = presetId === undefined
        ? false
        : runtime.store.switchValue({ kind: 'preset', id: presetId }, 'contexts', kind) ?? false
    }
    return merged
  }

  /** Preset ids the panel may address: registered, stored, or live. */
  private async knownPresetIds(): Promise<string[]> {
    const runtime = this.requireRuntime()
    const ids = new Set<string>(runtime.store.presetIds())
    for (const candidate of runtime.sessions.candidates()) {
      const presetId = runtime.sessions.presetOf(candidate.id)
      if (presetId !== undefined) ids.add(presetId)
    }
    const registry = this.ctx.get('agentPresets')
    if (registry !== undefined) {
      for (const preset of await registry.list()) ids.add(preset.id)
    }
    return [...ids].sort()
  }

  /**
   * Refuse a switch for a scope nothing knows about, so a typo cannot create an
   * invisible preset entry.
   * @param ref - preset or session scope.
   * @throws CapabilityHostError `SCOPE_NOT_FOUND`.
   */
  private async assertScopeExists(ref: ScopeRef): Promise<void> {
    if (ref.kind === 'preset') {
      const known = await this.knownPresetIds()
      if (!known.includes(ref.id)) {
        throw new CapabilityHostError('SCOPE_NOT_FOUND', `no preset ${JSON.stringify(ref.id)} is registered`, { scope: ref })
      }
      return
    }
    const known = this.requireRuntime().sessions.candidates().some(candidate => candidate.id === ref.id)
    if (!known) {
      throw new CapabilityHostError('SCOPE_NOT_FOUND', `no session ${JSON.stringify(ref.id)} is known`, { scope: ref })
    }
  }

  /**
   * Minimal owner check. A Remote caller that is not the owner is refused while
   * {@link HostConfig.ownerId} is set; an in-process caller (no invocation) and
   * the owner principal are allowed.
   *
   * TODO(product-auth): replace `ownerId` with the deployment's authorization
   * service once one exists; this hook deliberately has no credential logic.
   * @throws CapabilityHostError `NOT_AUTHORIZED`.
   */
  private assertAuthorized(): void {
    const ownerId = this.config.ownerId
    if (ownerId === undefined) return
    const principal = principalOf(this.ctx.invocation)
    if (principal === undefined) return
    const identity = principalIdentity(principal)
    if (identity !== undefined && identity === ownerId) return
    throw new CapabilityHostError('NOT_AUTHORIZED', 'only the owner may change capability switches', {
      principal: identity ?? principal.kind,
    })
  }

  private record(entry: Omit<AuditEntry, 'at'>): void {
    this.audit.push({ at: new Date().toISOString(), ...entry })
    while (this.audit.length > 200) this.audit.shift()
  }

  private emit(change: CapabilityChange): void {
    this.ctx.emit('capability-host/change', change)
  }

  private requireRuntime(): HostRuntime {
    if (this.runtime === undefined) {
      throw new CapabilityHostError('NOT_READY', 'the capability Host has not finished opening its state document')
    }
    return this.runtime
  }
}

/**
 * Read a caller identity a merged principal may carry. The core map declares
 * only the owner, so a non-owner identity is read structurally; a principal
 * with no identity cannot match a configured owner and is refused.
 * @param principal - the non-owner principal of the current Remote call.
 * @returns its id when it publishes one.
 */
function principalIdentity(principal: Principal): string | undefined {
  if (!('id' in principal)) return undefined
  const value = principal.id
  return typeof value === 'string' ? value : undefined
}

/**
 * Validate a scope reference at the wire boundary. v1.2 has no `base` scope;
 * a stale caller that sends one is told the surface is read-only.
 * @param value - candidate reference from a Remote caller.
 * @returns the validated reference.
 * @throws CapabilityHostError `SCOPE_INVALID` for an unknown kind or missing id, or `SCOPE_READ_ONLY` for the removed Base scope.
 */
function parseScopeRef(value: unknown): ScopeRef {
  if (typeof value !== 'object' || value === null) {
    throw new CapabilityHostError('SCOPE_INVALID', 'a scope reference must be an object')
  }
  const record = value as Record<string, unknown>
  const kind = record['kind']
  if (kind === 'base') {
    throw new CapabilityHostError('SCOPE_READ_ONLY', 'static tools have no writable scope', { scope: 'base' })
  }
  if (kind === 'preset' || kind === 'session') {
    const id = record['id']
    if (typeof id !== 'string' || id === '') {
      throw new CapabilityHostError('SCOPE_INVALID', `a ${kind} scope needs a non-empty id`, { kind })
    }
    return { kind, id }
  }
  throw new CapabilityHostError('SCOPE_INVALID', `unknown scope kind ${String(kind)}`, { kind: typeof kind === 'string' ? kind : '' })
}

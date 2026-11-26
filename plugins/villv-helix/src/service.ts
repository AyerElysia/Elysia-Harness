/**
 * The Host service: session-scoped tool restrictions, static-tool locks, the
 * managed tool mounts, the model-facing special-tool face, and the tool-panel
 * snapshot.
 *
 * It registers no tools of its own. It pulls the real global tool definitions
 * from `ctx.tools`, and for every live Agent installs the stored `deny` mask
 * with the real `tools.restrict()` API. Preset-owned static tools stay visible
 * and locked; the panel never writes them.
 *
 * @module @elysia/villv-helix/service
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { foldSessionTitle } from '@deepseek-ai/dsh-session-title'
import { scopeChainOf, scopeOf } from '@deepseek-ai/dsh-scope'
import type { ScopeKey } from '@deepseek-ai/dsh-scope'
import type { PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {
  CapabilitySnapshot, SessionRowEntry, ToolEntry, ToolGroupEntry, ToolPresetEntry,
} from './types.ts'
import { isOfficialPreset } from './presets.ts'
import { HelixStore } from './state.ts'
import { VillvHelixError } from './errors.ts'
import { MANAGED_SUITES, MANAGED_TOOL_IDS, SessionToolMounts } from './tool-mounts.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    villvHelix: VillVHelix
  }

  interface Events {
    /**
     * A session's tool surface changed.
     * @param change - what changed and which session it applies to.
     * @mode emit
     */
    'villv-helix/change'(change: HelixChange): undefined
  }
}

/** One observable change to a session's tool surface. */
export interface HelixChange {
  /** Which kind of change happened. */
  readonly action: 'setTool' | 'setMode' | 'catalog' | 'toolPresets' | 'restriction'
  /** Session the change applies to; absent for the shared tool-preset library. */
  readonly sessionId?: string
  /** Tool id the change names. */
  readonly id?: string
  /** Enablement the change set, when it set one. */
  readonly enabled?: boolean
}

/** Resolved Host configuration. */
export interface HostConfig {
  /** Absolute directory holding the state document. */
  readonly stateDir: string
}

/** One installed restriction and the exact deny list it carries. */
interface AppliedRestriction {
  readonly deny: readonly string[]
  readonly release: () => void
}

/**
 * Turn a refusal into the wire failure a Remote caller discriminates on, and
 * rethrow anything else unchanged.
 * @param error - the caught failure.
 */
function fail(error: unknown): never {
  if (error instanceof VillvHelixError) {
    throw new RemoteError(`villvHelix/${error.code}`, error.message, error.details)
  }
  throw error
}

/**
 * Host-side owner of the session tool panel.
 *
 * Construction registers the service and starts the state document; Remote
 * callers await {@link ready} first, so a snapshot never observes a half-built
 * runtime.
 */
export class VillVHelix extends TypertRemoteService {
  /** Prerequisite services of the Host row. */
  static inject = ['agents', 'tools']

  /** Resolves once the document is open and the stored masks are installed. */
  readonly ready: Promise<void>

  private store: HelixStore | undefined
  private readonly restrictions = new Map<string, AppliedRestriction>()
  private readonly presetStaticIds = new Map<string, ReadonlySet<string>>()
  private readonly toolMounts = new SessionToolMounts()
  private readonly faceContexts = new Map<string, () => void>()
  private readonly toolNames = new Map<string, string>()
  private reconciling = false

  /** @param ctx - Host context carrying `agents` and `tools`. */
  private readonly config: HostConfig

  /**
   * @param ctx - Host context carrying `agents` and `tools`.
   * @param config - state directory.
   */
  constructor(ctx: Context, config: HostConfig) {
    super(ctx, 'villvHelix', { namespace: 'villvHelix' })
    this.config = config
    this.ready = this.start()
  }

  /**
   * Supply the panel-only Chinese name for any tool.
   * @param toolId - model-facing tool id.
   * @param nameZh - short Chinese display name.
   * @returns a disposer that restores the previous hint.
   */
  registerToolName(toolId: string, nameZh: string): () => void {
    const id = toolId.trim()
    const name = nameZh.trim()
    if (id === '' || name === '') {
      throw new Error('villv-helix: a tool name hint needs a tool id and a Chinese name')
    }
    const previous = this.toolNames.get(id)
    this.toolNames.set(id, name)
    this.emit({ action: 'catalog', id })
    return () => {
      if (this.toolNames.get(id) !== name) return
      if (previous === undefined) this.toolNames.delete(id)
      else this.toolNames.set(id, previous)
      this.emit({ action: 'catalog', id })
    }
  }

  /**
   * Read the session's tool surface.
   * @param sessionId - the session whose view renders the panel.
   * @returns the snapshot the panel renders.
   * @throws VillvHelixError `SESSION_NOT_FOUND` when no live Agent owns the id.
   */
  @Remote('list')
  async list(sessionId: string): Promise<CapabilitySnapshot> {
    try {
      await this.ready
      const agent = this.requireAgent(sessionId)
      return await this.buildSnapshot(agent)
    } catch (error: unknown) {
      fail(error)
    }
  }

  /**
   * Render the system prompt the active session actually assembles.
   * @param sessionId - target session.
   * @returns the rendered prompt, or an empty string when no prompt service is mounted.
   */
  @Remote('readSystemPrompt')
  async readSystemPrompt(sessionId: string): Promise<string> {
    try {
      await this.ready
      const agent = this.requireAgent(sessionId)
      const prompt = this.ctx.get('systemPrompt') as
        | { assemble(context?: { scope?: ScopeKey }): Promise<PromptAssembly> }
        | undefined
      if (prompt === undefined) return ''
      const scope = scopeOf(agent.ctx)
      const assembly = await prompt.assemble(scope === undefined ? {} : { scope })
      return [
        ...assembly.sections.map(section => section.text),
        ...assembly.contexts.map(context => context.text),
      ].filter(text => text.trim() !== '').join('\n\n')
    } catch (error: unknown) {
      fail(error)
    }
  }

  /**
   * Turn 工具编辑模式 on or off for one session.
   * @param sessionId - target session.
   * @param enabled - true installs the session tool mask, false releases it.
   * @returns after the document write is durable and the mask is reconciled.
   */
  @Remote('getMode')
  async getMode(sessionId: string): Promise<boolean> {
    try {
      await this.ready
      return this.requireStore().orchestrated(sessionId)
    } catch (error: unknown) {
      fail(error)
    }
  }

  @Remote('setMode')
  async setMode(sessionId: string, enabled: boolean): Promise<void> {
    try {
      await this.ready
      await this.requireStore().setOrchestrated(sessionId, enabled)
      const agent = this.ctx.agents.get(SessionId(sessionId))
      if (agent !== undefined) {
        this.capturePresetStatics(agent)
        this.applyRestriction(agent)
        const store = this.requireStore()
        await this.toolMounts.reconcile(
          agent, store.orchestrated(sessionId), new Set(store.enabledTools(sessionId)),
          isOfficialPreset(agent.session.header.agentPreset),
        )
      }
      this.emit({ action: 'setMode', sessionId, enabled })
    } catch (error: unknown) {
      fail(error)
    }
  }

  /**
   * Enable or disable one global tool for one session.
   * @param sessionId - target session.
   * @param toolId - global tool id.
   * @param enabled - false removes it from this session's next step.
   * @returns after the document write is durable and the mask is reinstalled.
   * @throws VillvHelixError `TOOL_UNKNOWN` or `TOOL_STATIC_LOCKED`.
   */
  @Remote('setTool')
  async setTool(sessionId: string, toolId: string, enabled: boolean): Promise<void> {
    try {
      await this.ready
      const agent = this.requireAgent(sessionId)
      // Capture the preset-owned surface before any managed suite can mount.
      // A preset static tool that shares a managed id (read/edit/glob, ...) must
      // stay locked rather than being mistaken for a switchable special tool.
      this.capturePresetStatics(agent)
      const global = this.globalDefinitions()
      const staticIds = this.presetStaticIds.get(sessionId) ?? new Set()
      const official = isOfficialPreset(agent.session.header.agentPreset)
      if (official && !global.has(toolId) && staticIds.has(toolId)) {
        throw new VillvHelixError('TOOL_STATIC_LOCKED', '预设默认工具，不能关闭', { toolId, sessionId })
      }
      if (!global.has(toolId) && !MANAGED_TOOL_IDS.has(toolId)) {
        if (this.agentDefinitions(agent).has(toolId)) {
          throw new VillvHelixError('TOOL_STATIC_LOCKED', '预设默认工具，不能关闭', { toolId, sessionId })
        }
        throw new VillvHelixError('TOOL_UNKNOWN', `tool ${JSON.stringify(toolId)} is not a global tool`, { toolId, sessionId })
      }
      await this.requireStore().setTool(sessionId, toolId, enabled)
      this.capturePresetStatics(agent)
      this.applyRestriction(agent)
      const store = this.requireStore()
      await this.toolMounts.reconcile(
        agent, store.orchestrated(sessionId), new Set(store.enabledTools(sessionId)),
        isOfficialPreset(agent.session.header.agentPreset),
      )
      this.emit({ action: 'setTool', sessionId, id: toolId, enabled })
    } catch (error: unknown) {
      fail(error)
    }
  }

  /**
   * Save one named tool selection.
   * @param name - operator-provided display name.
   * @param tools - dynamic tool ids the preset switches on.
   * @returns the committed preset.
   */
  @Remote('createToolPreset')
  async createToolPreset(name: string, tools: readonly string[]): Promise<ToolPresetEntry> {
    try {
      await this.ready
      const global = this.globalDefinitions()
      const enabled = tools.filter(id => global.has(id) || MANAGED_TOOL_IDS.has(id))
      if (enabled.length === 0) {
        throw new VillvHelixError('TOOL_UNKNOWN', '当前没有开启任何工具，无法创建工具组')
      }
      const created = await this.requireStore().createToolPreset(name, enabled)
      this.emit({ action: 'toolPresets', id: created.id })
      return created
    } catch (error: unknown) {
      fail(error)
    }
  }

  /**
   * Delete one named tool selection.
   * @param id - preset identity.
   * @returns after the document write is durable.
   */
  @Remote('deleteToolPreset')
  async deleteToolPreset(id: string): Promise<void> {
    try {
      await this.ready
      await this.requireStore().deleteToolPreset(id)
      this.emit({ action: 'toolPresets', id })
    } catch (error: unknown) {
      fail(error)
    }
  }

  /** Open the document, install stored masks, and attach the Agent listeners. */
  private async start(): Promise<void> {
    const store = await HelixStore.open(this.config.stateDir)
    this.store = store
    this.ctx.on('agent/created', ({ agent }) => {
      this.installFaceContext(agent)
      this.reconcile()
    })
    this.ctx.on('agent/disposed', ({ agent }) => {
      this.restrictions.get(agent.session.id)?.release()
      this.restrictions.delete(agent.session.id)
      this.presetStaticIds.delete(agent.session.id)
      this.faceContexts.get(agent.session.id)?.()
      this.faceContexts.delete(agent.session.id)
      this.toolMounts.dispose(agent.session.id)
    })
    this.ctx.on('tools/change', () => {
      // Static preset rows may register after the Agent is created. Keep the
      // panel's static/id split current without rerunning a restrict install
      // whose own tools/change notification could race the previous mask.
      for (const agent of this.ctx.agents.list()) this.capturePresetStatics(agent)
    })
    this.ctx.effect(() => () => {
      this.disposeRestrictions()
      this.toolMounts.disposeAll()
    }, 'villv-helix.restrictions')
    this.reconcile()
  }

  /**
 * Register the durable model-facing special-tool face. Developer messages are
 * a UI/history channel; this context is the copy the provider actually sends
 * on every request, so the model cannot mistake the advertised schema for the
 * enabled set.
 */
  private installFaceContext(agent: Agent): void {
    const sessionId = agent.session.id
    if (this.faceContexts.has(sessionId)) return
    const dispose = agent.ctx.systemPrompt.context({
      name: 'villv-helix:special-tools',
      order: 900,
      text: () => this.faceContextText(sessionId),
    })
    this.faceContexts.set(sessionId, dispose)
  }

  private faceContextText(sessionId: string): string {
    const store = this.store
    if (store === undefined || !store.orchestrated(sessionId)) return ''
    const labels = new Map(MANAGED_SUITES.flatMap(suite => suite.tools.map(tool => [tool.id, `${tool.nameZh}（${tool.id}）`] as const)))
    const label = (id: string): string => labels.get(id) ?? id
    const enabled = new Set(store.enabledTools(sessionId).filter(id => MANAGED_TOOL_IDS.has(id)))
    const all = [...MANAGED_TOOL_IDS]
    const official = isOfficialPreset(this.requireAgent(sessionId).session.header.agentPreset)
    const staticIds = this.presetStaticIds.get(sessionId) ?? new Set<string>()
    const locked = official
      ? all.filter(id => staticIds.has(id) && !this.toolMounts.owns(sessionId, id))
      : []
    const dynamic = all.filter(id => !locked.includes(id))
    return [
      '[VillV-Helix 特殊工具面]',
      `预设锁定（不可关闭）：${locked.map(label).join('、') || '无'}`,
      `已启用：${dynamic.filter(id => enabled.has(id)).map(label).join('、') || '无'}`,
      `未启用/不可用：${dynamic.filter(id => !enabled.has(id)).map(label).join('、') || '无'}`,
      '调用规则：只有“已启用”中的特殊工具可以执行。',
    ].join('\n')
  }

  /** Reinstall every live Agent's stored deny mask and managed mounts when they differ. */
  private reconcile(): void {
    if (this.reconciling) return
    this.reconciling = true
    try {
      const store = this.requireStore()
      const agents = this.ctx.agents.list()
      for (const agent of agents) {
        this.capturePresetStatics(agent)
        this.installFaceContext(agent)
      }
      for (const agent of agents) this.applyRestriction(agent)
      for (const agent of agents) {
        const sessionId = agent.session.id
        void this.toolMounts.reconcile(
          agent, store.orchestrated(sessionId), new Set(store.enabledTools(sessionId)),
          isOfficialPreset(agent.session.header.agentPreset),
        ).then(() => {
          // Mounting a suite emits tools/change; the next snapshot sees it.
          this.emit({ action: 'catalog', sessionId })
        }, () => {
          // The snapshot reports the failed suite on its tool rows; the change
          // event only asks the panel to re-read it.
          this.emit({ action: 'restriction', sessionId })
        })
      }
    } finally {
      this.reconciling = false
    }
  }

  /**
   * Capture the preset-owned static tool ids before any managed suite is
   * mounted into the Agent scope. A later mount must not be mistaken for a
   * preset row.
   * @param agent - live Agent whose scope is read.
   */
  private capturePresetStatics(agent: Agent): void {
    const sessionId = agent.session.id
    const global = this.globalDefinitions()
    const ids = new Set(this.presetStaticIds.get(sessionId) ?? [])
    for (const name of this.agentDefinitions(agent).keys()) {
      if (global.has(name)) continue
      // A managed suite mounted into the Agent scope is not a preset row. A
      // same-id registration that is not owned by our mount is static and must
      // stay locked; ownership, not the id alone, decides this.
      if (MANAGED_TOOL_IDS.has(name) && !ids.has(name) && this.toolMounts.owns(sessionId, name)) continue
      ids.add(name)
    }
    this.presetStaticIds.set(sessionId, ids)
  }

  /**
   * Install one Agent's stored deny mask.
   * @param agent - live Agent whose scope receives the restriction.
   */
  private applyRestriction(agent: Agent): void {
    const sessionId = agent.session.id
    const store = this.requireStore()
    const known = this.globalDefinitions()
    const allowed = new Set(store.enabledTools(sessionId))
    const desired = store.orchestrated(sessionId)
      ? [...known.keys()].filter(id => !allowed.has(id)).sort()
      : []
    const applied = this.restrictions.get(sessionId)
    if (applied !== undefined && sameNames(applied.deny, desired)) return
    applied?.release()
    this.restrictions.delete(sessionId)
    if (desired.length === 0) return
    try {
      const release = agent.ctx.tools.restrict({ deny: desired })
      this.restrictions.set(sessionId, { deny: desired, release })
    } catch {
      // The mask could not be installed. The panel still reads the stored
      // state; the restriction event asks it to refresh.
      this.emit({ action: 'restriction', sessionId })
    }
  }

  /** Lift every installed restriction owned by this plugin. */
  private disposeRestrictions(): void {
    for (const applied of this.restrictions.values()) applied.release()
    this.restrictions.clear()
  }

  /**
   * Compose one session's tool-panel snapshot.
   * @param agent - the live Agent behind the session.
   * @returns the snapshot the panel renders.
   */
  private async buildSnapshot(agent: Agent): Promise<CapabilitySnapshot> {
    const store = this.requireStore()
    const sessionId = agent.session.id
    const key = `${'session'}:${sessionId}`
    const official = isOfficialPreset(agent.session.header.agentPreset)
    const global = this.globalDefinitions()
    const agentScope = this.agentDefinitions(agent)
    const staticIds = this.presetStaticIds.get(sessionId)
      ?? new Set([...agentScope.keys()].filter(name => !global.has(name)))
    const orchestrated = store.orchestrated(sessionId)
    const allowed = new Set(store.enabledTools(sessionId))
    const presetId = agent.session.header.agentPreset
    let presetName: string | undefined
    if (presetId !== undefined) {
      const registry = this.ctx.get('agentPresets') as
        | {
            list(): Promise<readonly { id: string; name?: string }[]>
            readDocument?(id: string): Promise<{ name?: string }>
          }
        | undefined
      presetName = (await registry?.list())?.find(preset => preset.id === presetId)?.name
      if (presetName === undefined && registry?.readDocument !== undefined) {
        try {
          presetName = (await registry.readDocument(presetId)).name
        } catch {
          presetName = undefined
        }
      }
    }
    const title = foldSessionTitle(agent.session.snapshotEvents())?.title
    presetName ??= presetId
    const live = this.ctx.agents.get(SessionId(sessionId)) !== undefined

    const staticTools: ToolEntry[] = []
    for (const name of staticIds) {
      if (!agentScope.has(name)) continue
      staticTools.push({
        id: name,
        ...(this.toolNames.get(name) === undefined ? {} : { nameZh: this.toolNames.get(name) as string }),
        group: 'static',
        scope: 'agent',
        origin: 'static',
        locked: true,
        ...(presetId === undefined ? {} : { sourcePresetId: presetId }),
        enabledBy: { [key]: true },
        stepBy: { [key]: 'active' },
      })
    }

    const dynamicTools: ToolEntry[] = [...global.keys()].sort().map((name): ToolEntry => {
      const enabled = !orchestrated || allowed.has(name)
      return {
        id: name,
        ...(this.toolNames.get(name) === undefined ? {} : { nameZh: this.toolNames.get(name) as string }),
        group: 'registered',
        scope: 'global',
        origin: 'dynamic',
        locked: false,
        enabledBy: { [key]: enabled },
        stepBy: { [key]: enabled ? 'active' : 'hidden' },
      }
    })
    // Managed suite rows are visible only while orchestrated. They are not
    // registered until the user turns one on; the default is off. Preset-owned
    // rows and real global rows keep their own origin.
    if (orchestrated) {
      for (const suite of MANAGED_SUITES) {
        for (const tool of suite.tools) {
          if ((official && staticIds.has(tool.id)) || global.has(tool.id)) continue
          if (dynamicTools.some(entry => entry.id === tool.id)) continue
          const enabled = allowed.has(tool.id)
          const failure = this.toolMounts.failure(sessionId, tool.id)
          dynamicTools.push({
            id: tool.id,
            nameZh: tool.nameZh,
            group: 'managed',
            scope: 'agent',
            origin: 'dynamic',
            locked: false,
            ...(failure === undefined ? {} : { failure }),
            enabledBy: { [key]: enabled },
            stepBy: { [key]: enabled ? 'active' : 'hidden' },
          })
        }
      }
    }
    // A global row shadowed by an Agent-scoped definition is displayed as the
    // static row only; the client derives that from the static id set.
    const groups: ToolGroupEntry[] = dynamicTools.length === 0
      ? []
      : [{
          id: 'registered',
          scope: 'global',
          origin: 'dynamic',
          atomic: false,
          locked: false,
          tools: dynamicTools.map(tool => tool.id),
        }]

    const sessions: SessionRowEntry[] = [{
      id: sessionId,
      ...(title === undefined ? {} : { title }),
      ...(agent.session.header.cwd === undefined ? {} : { workspace: agent.session.header.cwd }),
      ...(presetId === undefined ? {} : { presetId }),
      ...(presetName === undefined ? {} : { presetName }),
      live,
      orchestrated,
    }]

    return {
      tools: [...staticTools, ...dynamicTools],
      groups,
      sessions,
      toolPresets: store.toolPresets().map(preset => ({ ...preset, tools: [...preset.tools] })),
    }
  }

  /** Every globally registered tool definition, keyed by name. */
  private globalDefinitions(): ReadonlyMap<string, { readonly name: string; readonly description: string }> {
    return new Map(this.ctx.tools.definitions().map(definition => [definition.name, definition]))
  }

  /**
   * Every definition one Agent resolves: globals plus its preset's scoped rows.
   * @param agent - live Agent whose scope is read.
   */
  private agentDefinitions(agent: Agent): ReadonlyMap<string, { readonly name: string; readonly description: string }> {
    const key: ScopeKey | undefined = scopeOf(agent.ctx)
    if (key === undefined) return this.globalDefinitions()
    const all = new Map<string, { readonly name: string; readonly description: string }>()
    for (const scopeKey of scopeChainOf(key)) {
      for (const definition of this.ctx.tools.definitions(scopeKey)) all.set(definition.name, definition)
    }
    return all
  }

  /**
   * Resolve the live Agent behind one session.
   * @param sessionId - session identity.
   * @returns the live Agent.
   * @throws VillvHelixError `SESSION_NOT_FOUND` when no Agent owns the id.
   */
  private requireAgent(sessionId: string): Agent {
    const agent = this.agentOf(sessionId)
    if (agent === undefined) {
      throw new VillvHelixError('SESSION_NOT_FOUND', `session ${JSON.stringify(sessionId)} is not live`, { sessionId })
    }
    return agent
  }

  private agentOf(sessionId: string): Agent | undefined {
    return this.ctx.agents.get(SessionId(sessionId))
  }

  private requireStore(): HelixStore {
    if (this.store === undefined) throw new Error('villv-helix is not ready')
    return this.store
  }

  private emit(change: HelixChange): void {
    this.ctx.emit('villv-helix/change', change)
  }
}

function sameNames(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((name, index) => name === right[index])
}

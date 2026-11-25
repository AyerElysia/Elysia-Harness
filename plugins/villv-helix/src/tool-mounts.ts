/**
 * Per-session mounts for tools that are not part of the preset's static face.
 *
 * The tool packages stay ordinary plugins: they never know about Helix or a
 * session. Helix chooses their mount point. A suite mounted through
 * `agent.ctx` registers its tools in that Agent's scope, so every other session
 * keeps the same package absent. Disposing the mount removes the registrations.
 *
 * @module @elysia/villv-helix/tool-mounts
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Fiber, Plugin } from '@deepseek-ai/cordis'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import type {} from '@deepseek-ai/dsh-tools'

/** One tool id offered by a managed suite. */
export interface ManagedTool {
  /** Model-facing tool name. */
  readonly id: string
  /** Chinese display label. */
  readonly nameZh: string
}

/** One optional tool package and the tools it contributes. */
export interface ManagedSuite {
  /** Stable suite id. */
  readonly id: string
  /** Package specifier resolved from the Helix package. */
  readonly module: string
  /** Tools the suite may register. */
  readonly tools: readonly ManagedTool[]
  /** Config passed when the suite is mounted. */
  readonly config: (wanted: readonly string[], present: ReadonlySet<string>) => Record<string, unknown> | undefined
}

/** Optional suites Helix can mount inside one session. */
export const MANAGED_SUITES: readonly ManagedSuite[] = [
  {
    id: 'tool-fs',
    module: '@deepseek-ai/dsh-tool-fs',
    tools: [
      { id: 'read', nameZh: '读取文件' },
      { id: 'write', nameZh: '写入文件' },
      { id: 'edit', nameZh: '编辑文件' },
      { id: 'read_image', nameZh: '读取图片' },
    ],
    config: (wanted, present) => {
      const read = wanted.includes('read') && !present.has('read')
      const write = wanted.includes('write') && !present.has('write')
      const edit = wanted.includes('edit') && !present.has('edit')
      const readImage = wanted.includes('read_image') && !present.has('read_image')
      if (!read && !write && !edit && !readImage) return undefined
      return { read, write, edit, readImage, applyPatch: false }
    },
  },
  {
    id: 'tool-fs-search',
    module: '@deepseek-ai/dsh-tool-fs-search',
    tools: [
      { id: 'glob', nameZh: '匹配文件' },
      { id: 'grep', nameZh: '搜索内容' },
    ],
    config: () => ({ sampleOverCapGlobResults: false }),
  },
  {
    id: 'tool-pwsh',
    module: '@deepseek-ai/dsh-tool-pwsh',
    tools: [{ id: 'pwsh', nameZh: 'PowerShell' }],
    config: () => ({}),
  },
  {
    id: 'plugin-market',
    module: '@deepseek-ai/dsh-plugin-market/tools',
    tools: [{ id: 'plugin_market', nameZh: '插件市场' }],
    config: () => ({}),
  },
  {
    id: 'plugin-manager',
    module: '@deepseek-ai/dsh-plugin-manager/tools',
    tools: [{ id: 'plugin_manager', nameZh: '插件管理器' }],
    config: () => ({}),
  },
  {
    id: 'tool-jobs',
    module: '@deepseek-ai/dsh-tool-jobs',
    tools: [
      { id: 'job_list', nameZh: '后台任务' },
      { id: 'job_output', nameZh: '读取后台任务输出' },
      { id: 'job_kill', nameZh: '终止后台任务' },
    ],
    config: () => ({}),
  },
]

/** Every tool id a managed suite can provide. */
export const MANAGED_TOOL_IDS: ReadonlySet<string> = new Set(
  MANAGED_SUITES.flatMap(suite => suite.tools.map(tool => tool.id)),
)

/** One live suite mount. */
interface MountedSuite {
  /** Tool ids this mount contributes, for diagnostics and re-use checks. */
  readonly wanted: readonly string[]
  /** Exact Cordis fiber owning the registrations. */
  readonly fiber: Fiber
}

/** Load one plugin package without making it a hard runtime dependency. */
function loadPlugin(specifier: string): Promise<Plugin | undefined> {
  return import(specifier).then(
    (module) => {
      const candidate = (module as { default?: Plugin }).default ?? module
      if (typeof candidate === 'function') return candidate
      if (typeof candidate === 'object' && candidate !== null && typeof (candidate as { apply?: unknown }).apply === 'function') {
        return candidate as Plugin
      }
      return undefined
    },
    () => undefined,
  )
}

/**
 * Own the per-session mounts. One instance belongs to the Helix Host service and
 * all of its work is disposed with the service.
 */
export class SessionToolMounts {
  private readonly mounts = new Map<string, Map<string, MountedSuite>>()
  private readonly loading = new Map<string, Promise<Plugin | undefined>>()
  private readonly chains = new Map<string, Promise<void>>()
  private readonly failures = new Map<string, string>()

  /**
   * Reconcile one Agent's managed tools. Mounts are installed under the Agent
   * context, never the root, so the package remains ordinary and independently
   * mountable elsewhere.
   * @param agent - live Agent whose scope receives the tools.
   * @param orchestrated - whether 会话编排模式 is active for the session.
   * @param enabled - explicitly enabled managed tool ids.
   */
  async reconcile(agent: Agent, orchestrated: boolean, enabled: ReadonlySet<string>): Promise<void> {
    const sessionId = agent.session.id
    const previous = this.chains.get(sessionId) ?? Promise.resolve()
    const next = previous.then(
      () => this.apply(agent, orchestrated, enabled),
      () => this.apply(agent, orchestrated, enabled),
    )
    this.chains.set(sessionId, next)
    try {
      await next
    } finally {
      if (this.chains.get(sessionId) === next) this.chains.delete(sessionId)
    }
  }

  /** Dispose every mount owned by one session. */
  dispose(sessionId: string): void {
    const owned = this.mounts.get(sessionId)
    if (owned === undefined) return
    for (const mount of owned.values()) void mount.fiber.dispose()
    this.mounts.delete(sessionId)
    this.clearFailures(sessionId)
  }

  /** Dispose every mount; called when the Host service unloads. */
  disposeAll(): void {
    for (const sessionId of [...this.mounts.keys()]) this.dispose(sessionId)
    this.failures.clear()
  }

  /** Tools currently registered by a suite mount for one session. */
  mounted(sessionId: string, suiteId: string): readonly string[] {
    return this.mounts.get(sessionId)?.get(suiteId)?.wanted ?? []
  }

  /** Mount failure for one session/tool, when the optional package could not mount. */
  failure(sessionId: string, toolId: string): string | undefined {
    return this.failures.get(`${sessionId}/${toolId}`)
  }

  /** Resolve one suite's plugin, loading it at most once per process. */
  private plugin(suite: ManagedSuite): Promise<Plugin | undefined> {
    let pending = this.loading.get(suite.module)
    if (pending === undefined) {
      pending = loadPlugin(suite.module)
      this.loading.set(suite.module, pending)
    }
    return pending
  }

  /**
   * Apply the desired mount set for one Agent.
   * @param agent - live Agent.
   * @param orchestrated - mode gate.
   * @param enabled - explicit allow set.
   */
  private async apply(agent: Agent, orchestrated: boolean, enabled: ReadonlySet<string>): Promise<void> {
    const sessionId = agent.session.id
    if (!orchestrated) {
      this.dispose(sessionId)
      this.clearFailures(sessionId)
      return
    }

    const current = this.mounts.get(sessionId) ?? new Map<string, MountedSuite>()
    const own = new Set([...current.values()].flatMap(mount => mount.wanted))
    const scope = scopeOf(agent.ctx)
    const present = new Set(
      scope === undefined
        ? []
        : agent.ctx.tools.definitions(scope).map(definition => definition.name),
    )
    // A suite's own mounted tools must not look like preset rows; otherwise
    // every tools/change would unmount and remount the same suite forever.
    const foreign = new Set([...present].filter(id => !own.has(id)))
    const desired = new Map<string, readonly string[]>()
    for (const suite of MANAGED_SUITES) {
      const wanted = suite.tools
        .map(tool => tool.id)
        .filter(id => enabled.has(id) && !foreign.has(id))
      if (wanted.length > 0) desired.set(suite.id, wanted)
    }
    for (const [suiteId, mount] of [...current]) {
      const next = desired.get(suiteId) ?? []
      if (next.length === mount.wanted.length && next.every((id, index) => id === mount.wanted[index])) continue
      void mount.fiber.dispose()
      current.delete(suiteId)
      this.clearFailures(sessionId, suiteId)
    }

    if (current.size === 0) this.mounts.delete(sessionId)
    for (const suite of MANAGED_SUITES) {
      const wanted = desired.get(suite.id)
      if (wanted === undefined || current.has(suite.id)) continue
      const plugin = await this.plugin(suite)
      if (plugin === undefined) {
        this.setFailure(sessionId, suite, '工具包不可用')
        continue
      }
      const config = suite.config(wanted, foreign)
      if (config === undefined) continue
      try {
        const fiber = agent.ctx.plugin(plugin, config)
        // Publish the ownership before awaiting readiness: mounting emits
        // tools/change synchronously, and the next reconcile must recognize
        // these ids as ours rather than as preset rows.
        current.set(suite.id, { wanted, fiber })
        this.mounts.set(sessionId, current)
        this.clearFailures(sessionId, suite.id)
        await fiber
      } catch (error: unknown) {
        // Already mounted in this exact scope, or an optional service is
        // absent. The suite stays unavailable for this session.
        current.delete(suite.id)
        if (current.size === 0) this.mounts.delete(sessionId)
        this.setFailure(sessionId, suite, error instanceof Error ? error.message : String(error))
      }
    }
  }

  /** Store one suite failure against every tool it would contribute. */
  private setFailure(sessionId: string, suite: ManagedSuite, message: string): void {
    for (const tool of suite.tools) this.failures.set(`${sessionId}/${tool.id}`, message)
  }

  /** Clear failure records for one session, or one suite of it. */
  private clearFailures(sessionId: string, suiteId?: string): void {
    const suite = suiteId === undefined ? undefined : MANAGED_SUITES.find(entry => entry.id === suiteId)
    if (suite === undefined) {
      for (const key of [...this.failures.keys()]) {
        if (key.startsWith(`${sessionId}/`)) this.failures.delete(key)
      }
      return
    }
    for (const tool of suite.tools) this.failures.delete(`${sessionId}/${tool.id}`)
  }
}
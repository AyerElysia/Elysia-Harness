/**
 * Per-session mounts for tools that are not part of the preset's static face.
 *
 * The tool packages stay ordinary plugins: they never know about Helix or a
 * session. Helix chooses their mount point. A suite mounted through an extended
 * agent context registers stable tool definitions there; every special suite
 * is mounted while the session is orchestrated, so a never-enabled name is
 * still callable and fails through the live pre-execute guard as
 * `UNKNOWN_TOOL` instead of being silently routed to another tool.
 *
 * @module @elysia/villv-helix/tool-mounts
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context, Fiber, Plugin } from '@deepseek-ai/cordis'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import type { ToolDefinition, ToolRegistrationOptions } from '@deepseek-ai/dsh-tools'

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
  /** Services the suite needs before it can be mounted. */
  readonly requires: readonly string[]
  /** Config passed when the suite is mounted. */
  readonly config: (wanted: readonly string[], present: ReadonlySet<string>) => Record<string, unknown> | undefined
}

/** Optional suites Helix can mount inside one session. */
export const MANAGED_SUITES: readonly ManagedSuite[] = [
  {
    id: 'tool-fs',
    module: '@deepseek-ai/dsh-tool-fs',
    requires: ['tools', 'fs', 'systemPrompt', 'workingDirectory'],
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
    requires: ['tools', 'systemPrompt', 'subprocess', 'workingDirectory'],
    tools: [
      { id: 'glob', nameZh: '匹配文件' },
      { id: 'grep', nameZh: '搜索内容' },
    ],
    config: () => ({ sampleOverCapGlobResults: false }),
  },
  {
    id: 'tool-bash',
    module: '@deepseek-ai/dsh-tool-bash',
    requires: ['tools', 'shell', 'systemPrompt', 'shellEnv', 'workingDirectory'],
    tools: [{ id: 'bash', nameZh: 'Bash' }],
    config: () => ({}),
  },
  {
    id: 'tool-pwsh',
    module: '@deepseek-ai/dsh-tool-pwsh',
    requires: ['tools', 'shell', 'systemPrompt', 'shellEnv', 'workingDirectory'],
    tools: [{ id: 'pwsh', nameZh: 'PowerShell' }],
    config: () => ({}),
  },
  {
    id: 'plugin-market',
    module: '@deepseek-ai/dsh-plugin-market/tools',
    requires: ['tools', 'pluginMarket'],
    tools: [{ id: 'plugin_market', nameZh: '插件市场' }],
    config: () => ({}),
  },
  {
    id: 'plugin-manager',
    module: '@deepseek-ai/dsh-plugin-manager/tools',
    requires: ['tools', 'pluginManager'],
    tools: [{ id: 'plugin_manager', nameZh: '插件管理器' }],
    config: () => ({}),
  },
  {
    id: 'tool-jobs',
    module: '@deepseek-ai/dsh-tool-jobs',
    requires: ['tools', 'jobs', 'systemPrompt'],
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
  /** All tool ids this mount registers; the gate decides their visibility. */
  readonly wanted: readonly string[]
  /** Exact Cordis fiber owning the registrations. */
  readonly fiber: Fiber
}

/** One orchestrated session's stable registry and its current gate. */
interface MountedSession {
  /** Tool ids allowed to execute. Mutated in place while mounted. */
  readonly enabled: Set<string>
  /** Managed names actually registered by this session's suite mounts. */
  readonly owned: Set<string>
  /** Agent-scoped context whose `tools.register` adds the gate. */
  readonly ctx: Context
  /** Suite mounts owned by the session. */
  readonly suites: Map<string, MountedSuite>
  /** Disposer for the live stale-call guard. */
  readonly disposeGuard: () => void
}

/**
 * Build an Agent-scoped context that leaves tool definitions registered and
 * gates their execution. Keeping the registration stable is what makes a
 * disabled-name call a real `UNKNOWN_TOOL`: disposing a fiber would instead
 * make the call disappear entirely and invite a fallback tool.
 * @param ctx - exact Agent context.
 * @param enabled - tool ids currently allowed for this session.
 * @returns a child context whose `tools.register` composes the gate.
 */
function gateContext(ctx: Context, owned: Set<string>): Context {
  const tools = ctx.tools
  const proxy = new Proxy(tools, {
    get(target, property) {
      if (property === 'register') {
        return (definition: ToolDefinition, options: ToolRegistrationOptions = {}) => {
          const name = definition.name
          if (!MANAGED_TOOL_IDS.has(name)) return target.register(definition, options)
          // The declaration stays visible for the mounted lifetime, even while the
          // tool is disabled; execution is the only availability boundary. This
          // keeps a stale model choice as a real UNKNOWN_TOOL instead of making
          // the name disappear and inviting a substitute tool.
          // Mark ownership before register: registration emits tools/change
          // synchronously, and the static snapshot must not mistake this
          // managed definition for a preset row.
          owned.add(name)
          let dispose: () => void
          try {
            dispose = target.register(definition, options)
          } catch (error: unknown) {
            owned.delete(name)
            throw error
          }
          return () => {
            owned.delete(name)
            dispose()
          }
        }
      }
      const value = Reflect.get(target, property)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  return ctx.extend({ tools: proxy })
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
  private readonly sessions = new Map<string, MountedSession>()
  private readonly loading = new Map<string, Promise<Plugin | undefined>>()
  private readonly chains = new Map<string, Promise<void>>()
  private readonly failures = new Map<string, string>()

  /**
   * Reconcile one Agent's managed tools. Every service-available suite mounts
   * for the session; toggling only changes the pre-execute gate.
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
    const session = this.sessions.get(sessionId)
    if (session === undefined) return
    session.disposeGuard()
    for (const mount of session.suites.values()) void mount.fiber.dispose()
    this.sessions.delete(sessionId)
    this.clearFailures(sessionId)
  }

  /** Dispose every mount; called when the Host service unloads. */
  disposeAll(): void {
    for (const sessionId of [...this.sessions.keys()]) this.dispose(sessionId)
    this.failures.clear()
  }

  /** Tools currently registered by a suite mount for one session. */
  mounted(sessionId: string, suiteId: string): readonly string[] {
    return this.sessions.get(sessionId)?.suites.get(suiteId)?.wanted ?? []
  }

  /** Whether this session's suite mounts, not a preset/static row, own a name. */
  owns(sessionId: string, toolId: string): boolean {
    return this.sessions.get(sessionId)?.owned.has(toolId) === true
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
      return
    }

    let session = this.sessions.get(sessionId)
    if (session === undefined) {
      const gate = new Set(enabled)
      const owned = new Set<string>()
      const disposeGuard = agent.ctx.on('tools/pre-execute', async (exec, next) => {
        if (!MANAGED_TOOL_IDS.has(exec.name) || !owned.has(exec.name)) return next()
        if (gate.has(exec.name)) return next()
        return {
          kind: 'deny',
          reason: `unknown tool "${exec.name}"`,
          info: { name: 'ToolNotFoundError', code: 'UNKNOWN_TOOL' },
        }
      })
      session = {
        enabled: gate,
        owned,
        ctx: gateContext(agent.ctx, owned),
        suites: new Map(),
        disposeGuard,
      }
      this.sessions.set(sessionId, session)
    } else {
      session.enabled.clear()
      for (const id of enabled) session.enabled.add(id)
    }

    const scope = scopeOf(agent.ctx)
    const mountedIds = new Set([...session.suites.values()].flatMap(mount => mount.wanted))
    const present = new Set(
      scope === undefined ? [] : agent.ctx.tools.definitions(scope).map(definition => definition.name),
    )
    // Preset/static tools keep their own registration; do not mount a suite
    // definition under a duplicate name. Global names cannot be registered in
    // this Agent scope either, so they count as present too.
    const foreign = new Set([...present].filter(id => !mountedIds.has(id)))

    for (const suite of MANAGED_SUITES) {
      if (session.suites.has(suite.id)) continue
      // Mount every suite whose services exist, even when all its tools are
      // initially off. The stable declaration is what gives a disabled name
      // something to call and fail as UNKNOWN_TOOL; it cannot be created at
      // the moment the user switches a tool off.
      if (suite.requires.some(name => agent.ctx.get(name) === undefined)) continue
      const plugin = await this.plugin(suite)
      if (plugin === undefined) {
        this.setFailure(sessionId, suite, '工具包不可用')
        continue
      }
      const wanted = suite.tools.map(tool => tool.id)
      const config = suite.config(wanted, foreign)
      if (config === undefined) continue
      try {
        const fiber = session.ctx.plugin(plugin, config)
        session.suites.set(suite.id, { wanted, fiber })
        this.clearFailures(sessionId, suite.id)
        await fiber
      } catch (error: unknown) {
        session.suites.delete(suite.id)
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
/**
 * The session registry: live Agents from `ctx.agents` plus sessions the state
 * document still knows about. It never creates a session; it answers which
 * preset a session runs and which sessions a publication must reach.
 *
 * Offline sessions matter twice: the panel lists them, and their queues keep
 * accumulating so a restart does not lose events for a session that is idle.
 *
 * @module @elysia/capability-host/sessions
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type { SessionView } from './types.ts'
import type { CapabilityStateStore } from './state.ts'

/** One session a publication may target. */
export interface SessionCandidate {
  /** Session identity. */
  readonly id: string
}

/** Minimal shape of the mounted `sessionQuery` service this registry reads. */
interface SessionQueryRecord {
  readonly header: {
    readonly id: string
    readonly cwd?: string
    readonly agentPreset?: string
  }
  readonly live?: boolean
}

interface WorkspaceRegistryLike {
  readonly archivedSessionIds: readonly string[]
}

interface SessionObservationLike {
  readonly projections?: {
    readonly values?: Readonly<Record<string, unknown>>
  }
  [Symbol.dispose](): void
}

interface SessionTitleResult {
  readonly sessionId: string
  readonly status: 'fulfilled' | 'rejected'
  readonly value?: {
    readonly title?: {
      readonly title?: string
    }
  }
}

interface SessionQueryLike {
  listSessions(signal?: AbortSignal): Promise<readonly SessionQueryRecord[]>
  observeSession(
    sessionId: ReturnType<typeof SessionId>,
    options?: { readonly projectionMode?: 'all' | 'none' },
  ): Promise<SessionObservationLike>
  readTitleSnapshots(
    sessionIds: readonly ReturnType<typeof SessionId>[],
    signal?: AbortSignal,
  ): Promise<readonly SessionTitleResult[]>
}

/** The service surface the context bus reads. */
export interface SessionSource {
  /** Every live or persisted session, each id once. */
  candidates(): readonly SessionCandidate[]
  /** Agent owning one session, when it is live. */
  agentOf(sessionId: string): Agent | undefined
  /** Preset one session runs, live or recorded. */
  presetOf(sessionId: string): string | undefined
}

/** Live and persisted session lookup over one Host context. */
export class SessionRegistry implements SessionSource {
  /**
   * @param ctx - Host context providing `agents` and, when mounted, `agentPresets`.
   * @param store - document holding the persisted session-to-preset mapping.
   */
  private readonly ctx: Context
  private readonly store: CapabilityStateStore
  private readonly titles = new Map<string, string>()
  private readonly workspaces = new Map<string, string>()
  private archived = new Set<string>()

  constructor(
    ctx: Context,
    store: CapabilityStateStore,
  ) {
    this.ctx = ctx
    this.store = store
  }

  /** Live Agents, in registry order. */
  live(): readonly Agent[] {
    return this.ctx.agents.list()
  }

  /** @inheritdoc */
  candidates(): readonly SessionCandidate[] {
    const ids = new Set<string>()
    for (const agent of this.live()) ids.add(agent.session.id)
    for (const id of this.store.sessionIds()) ids.add(id)
    return [...ids].filter(id => !this.archived.has(id)).map(id => ({ id }))
  }

  /** @inheritdoc */
  agentOf(sessionId: string): Agent | undefined {
    return this.ctx.agents.get(SessionId(sessionId))
  }

  /**
   * The preset a session runs. A live Agent's own selection wins; otherwise the
   * mapping recorded while it was live is used.
   * @param sessionId - session identity.
   * @returns the preset id, or undefined when neither source knows it.
   */
  presetOf(sessionId: string): string | undefined {
    const agent = this.agentOf(sessionId)
    if (agent !== undefined) {
      const preset = this.ctx.get('agentPresets')?.presetForSession(agent.session)
      if (preset !== null && preset !== undefined) return preset
    }
    return this.store.sessionPreset(sessionId)
  }

  /**
   * Persist the preset of every live session that resolves one, so an offline
   * session keeps its preset across a restart.
   * @returns after any newly observed mapping is durable.
   */
  async observe(): Promise<void> {
    const workspaces = this.ctx.get('workspaceRegistry') as WorkspaceRegistryLike | undefined
    this.archived = new Set(workspaces?.archivedSessionIds ?? [])
    for (const agent of this.live()) {
      const cwd = agent.session.header.cwd
      if (cwd !== undefined) this.workspaces.set(agent.session.id, cwd)
      const preset = this.ctx.get('agentPresets')?.presetForSession(agent.session)
      if (preset === null || preset === undefined) continue
      await this.store.setSessionPreset(agent.session.id, preset)
    }
    // Offline sessions are not Agents, so `agents.list()` cannot see them. Read
    // the durable corpus so the panel's session rows and per-preset counts match
    // the sidebar, and record each header's preset for later gate evaluation.
    const query = this.ctx.get('sessionQuery') as SessionQueryLike | undefined
    if (query === undefined) return
    const records = await query.listSessions()
    for (const record of records) {
      const id = record.header.id
      if (record.header.cwd !== undefined) this.workspaces.set(id, record.header.cwd)
      // A live Agent's own selection is authoritative and was recorded above.
      if (record.live === true) continue
      // Older sessions keep the real preset in the projection log; the header
      // may still carry the creation default. Prefer the projection.
      let preset = record.header.agentPreset
      let blank = false
      let observation: SessionObservationLike | undefined
      try {
        observation = await query.observeSession(SessionId(id), { projectionMode: 'all' })
        const values = observation.projections?.values
        const projected = values?.['agentPreset']
        if (typeof projected === 'string' && projected.length > 0) preset = projected
        const metadata = values?.['sessionListMetadata']
        blank = typeof metadata === 'object' && metadata !== null
          && (metadata as Record<string, unknown>)['blank'] === true
      } catch {
        // A corrupt or unreadable session must not hide the rest of the list.
      } finally {
        observation?.[Symbol.dispose]()
      }
      if (blank) {
        await this.store.forgetSession(id)
        continue
      }
      if (typeof preset === 'string' && preset.length > 0) await this.store.setSessionPreset(id, preset)
    }
    const missingTitles = records.map(record => record.header.id).filter(id => !this.titles.has(id))
    if (missingTitles.length === 0) return
    const titleResults = await query.readTitleSnapshots(missingTitles.map(id => SessionId(id)))
    for (const result of titleResults) {
      if (result.status !== 'fulfilled') continue
      const title = result.value?.title?.title
      if (typeof title === 'string' && title.length > 0) this.titles.set(result.sessionId, title)
    }
  }

  /**
   * Every session as the panel lists it.
   * @returns live sessions first in registry order, then persisted-only ids.
   */
  list(): readonly SessionView[] {
    const live = new Set<string>(this.live().map(agent => agent.session.id))
    const rows: SessionView[] = []
    for (const candidate of this.candidates()) {
      const presetId = this.presetOf(candidate.id)
      const queue = this.store.queue(candidate.id)
      const oldest = queue.events.reduce<number | undefined>(
        (earliest, event) => earliest === undefined || event.createdAt < earliest ? event.createdAt : earliest,
        undefined,
      )
      const title = this.titles.get(candidate.id)
      const workspace = this.workspaces.get(candidate.id)
      rows.push({
        id: candidate.id,
        live: live.has(candidate.id),
        queued: queue.events.length,
        ...(title === undefined ? {} : { title }),
        ...(workspace === undefined ? {} : { workspace }),
        ...(presetId === undefined ? {} : { presetId }),
        ...(oldest === undefined ? {} : { oldestEventAt: oldest }),
      })
    }
    return rows
  }

  /** Live and known session counts. */
  counts(): { live: number; known: number } {
    return { live: this.live().length, known: this.candidates().length }
  }
}

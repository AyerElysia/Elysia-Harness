/**
 * The Host service of the context gate: provider registration, publication,
 * session subscriptions, and the panel snapshot.
 *
 * It is independent of VillV-Helix and of the session orchestration mode. The
 * bus attaches to every live Agent through a global pre-step listener; there
 * is no enable flag and no per-session mode check.
 *
 * @module @elysia/context-gate/service
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {
  ContextEntry, ContextEventInput, ContextKindRegistration, ContextSnapshot, PublishReceipt,
} from './types.ts'
import { ContextBus, type ContextDefaults } from './context-bus.ts'
import { ContextGateStore } from './state.ts'
import { ContextGateError } from './errors.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    contextGate: ContextGate
  }
}

/** Resolved Host configuration. */
export interface HostConfig {
  /** Absolute directory holding the state document. */
  readonly stateDir: string
  /** Traffic defaults for context kinds that do not declare their own. */
  readonly context: ContextDefaults
  /** Ceiling on events merged into one snapshot. */
  readonly maxEventsPerSnapshot: number
  /** Ceiling on bytes of one merged snapshot. */
  readonly maxSnapshotBytes: number
  /** Quiet window after the first active event, in milliseconds. */
  readonly batchMs: number
  /** Total postponement ceiling from the first active event, in milliseconds. */
  readonly maxWaitMs: number
}

/**
 * Turn a refusal into the wire failure a Remote caller discriminates on, and
 * rethrow anything else unchanged.
 * @param error - the caught failure.
 */
function fail(error: unknown): never {
  if (error instanceof ContextGateError) {
    throw new RemoteError(`contextGate/${error.code}`, error.message, error.details)
  }
  throw error
}

/**
 * Host-side owner of context subscriptions, queues, and the injection log.
 *
 * Construction registers the service and starts the state document; Remote
 * callers await {@link ready} first, so a snapshot never observes a half-built
 * runtime.
 */
export class ContextGate extends TypertRemoteService {
  /** Prerequisite services of the Host row. */
  static inject = ['agents']

  /** Resolves once the document is open and the bus is attached. */
  readonly ready: Promise<void>

  private store: ContextGateStore | undefined
  private bus: ContextBus | undefined

  /** @param config - state directory, delivery limits, and batching. */
  private readonly config: HostConfig

  /**
   * @param ctx - Host context carrying `agents`.
   * @param config - state directory, delivery limits, and batching.
   */
  constructor(ctx: Context, config: HostConfig) {
    super(ctx, 'contextGate', { namespace: 'contextGate' })
    this.config = config
    this.ready = this.start()
  }

  /**
   * Declare one publishable context kind.
   * @param registration - kind name, Chinese name, description, and delivery limits.
   * @returns a disposer that removes the declaration.
   */
  registerContextKind(registration: ContextKindRegistration): () => void {
    const dispose = this.requireBus().registerKind(registration)
    return () => { dispose() }
  }

  /**
   * Publish one context event to every subscribed session.
   * @param input - the publication.
   * @returns delivery accounting.
   */
  async publish(input: ContextEventInput): Promise<PublishReceipt> {
    try {
      await this.ready
      return await this.requireBus().publish(input)
    } catch (error: unknown) {
      fail(error)
    }
  }

  /**
   * Read one session's context surface and recent injection log.
   * @param sessionId - the session the view renders.
   * @returns registered kinds with this session's subscription and backlog, plus the log.
   * @throws ContextGateError `SESSION_NOT_FOUND` when no live Agent owns the id.
   */
  @Remote('list')
  async list(sessionId: string): Promise<ContextSnapshot> {
    try {
      await this.ready
      const agent = this.requireAgent(sessionId)
      return this.buildSnapshot(agent.session.id)
    } catch (error: unknown) {
      fail(error)
    }
  }

  /**
   * Subscribe or unsubscribe one context kind for one session.
   * @param sessionId - target session.
   * @param kind - registered kind.
   * @param enabled - false unsubscribes it.
   * @returns after the document write is durable.
   * @throws ContextGateError `CONTEXT_UNKNOWN` or `SESSION_NOT_FOUND`.
   */
  @Remote('setContext')
  async setContext(sessionId: string, kind: string, enabled: boolean): Promise<void> {
    try {
      await this.ready
      this.requireAgent(sessionId)
      if (!this.requireBus().hasKind(kind)) {
        throw new ContextGateError('CONTEXT_UNKNOWN', `context kind ${JSON.stringify(kind)} is not registered`, {
          eventKind: kind, sessionId,
        })
      }
      await this.requireStore().setContext(sessionId, kind, enabled)
    } catch (error: unknown) {
      fail(error)
    }
  }

  /** Open the document, compose the bus, attach it, and own its teardown. */
  private async start(): Promise<void> {
    const store = await ContextGateStore.open(this.config.stateDir)
    const bus = new ContextBus({
      ctx: this.ctx,
      store,
      agentOf: (sessionId) => this.agentOf(sessionId),
      candidates: () => this.candidates(),
      defaults: this.config.context,
      maxEventsPerSnapshot: this.config.maxEventsPerSnapshot,
      maxSnapshotBytes: this.config.maxSnapshotBytes,
      batchMs: this.config.batchMs,
      maxWaitMs: this.config.maxWaitMs,
    })
    this.store = store
    this.bus = bus
    bus.attach()
    this.ctx.effect(() => () => {
      bus.dispose()
      this.bus = undefined
      this.store = undefined
    }, 'context-gate.lifecycle')
  }

  /**
   * Compose one session's context snapshot.
   * @param sessionId - target session.
   * @returns registered kinds and the log, newest first.
   */
  private buildSnapshot(sessionId: string): ContextSnapshot {
    const store = this.requireStore()
    const bus = this.requireBus()
    const queue = store.queue(sessionId)
    const subscriptions = store.contexts(sessionId)
    const contexts: ContextEntry[] = bus.listKinds().map(kind => ({
      kind: kind.kind,
      nameZh: kind.nameZh,
      description: kind.description,
      ttlMs: kind.ttlMs,
      backlog: queue.events.filter(event => event.kind === kind.kind).length,
      enabledBy: { [sessionId]: subscriptions[kind.kind] ?? false },
    }))
    return { contexts, events: store.events(sessionId) }
  }

  /**
   * Resolve the live Agent behind one session.
   * @param sessionId - session identity.
   * @returns the live Agent.
   * @throws ContextGateError `SESSION_NOT_FOUND` when no Agent owns the id.
   */
  private requireAgent(sessionId: string): Agent {
    const agent = this.agentOf(sessionId)
    if (agent === undefined) {
      throw new ContextGateError('SESSION_NOT_FOUND', `session ${JSON.stringify(sessionId)} is not live`, { sessionId })
    }
    return agent
  }

  private agentOf(sessionId: string): Agent | undefined {
    return this.ctx.agents.get(SessionId(sessionId))
  }

  /** Every session a publication may target: live Agents plus persisted state. */
  private candidates(): readonly string[] {
    const ids = new Set<string>()
    for (const agent of this.ctx.agents.list()) ids.add(agent.session.id)
    for (const id of this.requireStore().sessionIds()) ids.add(id)
    return [...ids]
  }

  private requireStore(): ContextGateStore {
    if (this.store === undefined) throw new Error('context-gate is not ready')
    return this.store
  }

  private requireBus(): ContextBus {
    if (this.bus === undefined) throw new Error('context-gate is not ready')
    return this.bus
  }
}
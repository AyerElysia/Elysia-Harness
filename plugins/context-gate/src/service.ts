/**
 * The Host service of the context gate.
 *
 * It owns provider registration, publication, subscriptions, the panel
 * snapshot, the per-session time engine, and the merged custom-event rule
 * engine. It is independent of VillV-Helix and of its tool editing mode. The
 * delivery bus attaches to every live Agent through a global pre-step
 * listener; there is no enable flag and no per-session mode check.
 *
 * @module @elysia/context-gate/service
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {
  AbsenceDraft, AbsencePatch, AbsenceTimer, ContextEntry, ContextEventInput, ContextKindRegistration,
  ContextSnapshot, EventParameterRegistration, EventParameterSchema, EventParameterValues, EventRule, EventRuleDraft,
  EventRulePatch, PublishReceipt, RuleTestResult, TimerDraft, TimerInstance, TimerPatch, TimerPreset, TimerSnapshot,
} from './types.ts'
import { ContextBus, type ContextDefaults } from './context-bus.ts'
import { ContextGateStore } from './state.ts'
import { TimeEngine } from './time-engine.ts'
import { RuleEngine } from './rules.ts'
import { ContextGateError, describeError } from './errors.ts'

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
  /** Scheduler wake interval, in milliseconds. */
  readonly tickMs: number
  /** Timer instances one session may own. */
  readonly maxTimersPerSession: number
  /** Timer presets in the shared library. */
  readonly maxPresets: number
  /** Absence watchers one session may own. */
  readonly maxAbsencesPerSession: number
  /** Custom-event rules one session may own. */
  readonly maxRulesPerSession: number
  /** Hostnames an HTTP-poll rule may reach; empty denies every URL. */
  readonly ruleHttpAllowedHosts: readonly string[]
  /** HTTP-poll request timeout. */
  readonly ruleHttpTimeoutMs: number
  /** Largest HTTP-poll response body. */
  readonly ruleHttpMaxBytes: number
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
 * Host-side owner of context subscriptions, queues, timers, and rules.
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
  private engine: TimeEngine | undefined
  private rules: RuleEngine | undefined
  private scheduleTimer: ReturnType<typeof setInterval> | undefined
  private pumpChain: Promise<void> = Promise.resolve()
  private closed = false

  /** @param config - state directory, delivery limits, batching, and engine limits. */
  private readonly config: HostConfig

  /**
   * @param ctx - Host context carrying `agents`.
   * @param config - state directory, delivery limits, batching, and engine limits.
   */
  constructor(ctx: Context, config: HostConfig) {
    super(ctx, 'contextGate', { namespace: 'contextGate' })
    this.config = config
    this.ready = this.start()
  }

  /**
   * Declare one publishable context kind.
   * @param registration - kind name, Chinese name, description, parameters, and delivery limits.
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
   * Read one session's context surface, recent log, and custom rules.
   * @param sessionId - the session the view renders.
   * @returns registered kinds with this session's subscription and backlog, the log, and owned rules.
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

  /**
   * Store source-defined parameter values for one subscription.
   * @param sessionId - target session.
   * @param kind - registered kind.
   * @param params - values validated against the kind's schema.
   * @returns after the document write is durable.
   * @throws ContextGateError `PARAM_UNKNOWN` or `PARAM_INVALID`.
   */
  @Remote('setSubscriptionParams')
  async setSubscriptionParams(sessionId: string, kind: string, params: EventParameterValues): Promise<void> {
    try {
      await this.ready
      this.requireAgent(sessionId)
      const resolved = this.requireBus().kind(kind)
      if (resolved === undefined) {
        throw new ContextGateError('CONTEXT_UNKNOWN', `context kind ${JSON.stringify(kind)} is not registered`, {
          eventKind: kind, sessionId,
        })
      }
      await this.requireStore().setSubscriptionParams(sessionId, kind, validateParameterValues(resolved.parameters, params, sessionId))
    } catch (error: unknown) {
      fail(error)
    }
  }

  /**
   * Subscribe this session to a kind for every session observed from now on.
   * @param sessionId - target session.
   * @param kind - registered kind.
   * @param params - source-defined parameter values.
   * @returns after the document write is durable.
   */
  @Remote('subscribeFuture')
  async subscribeFuture(sessionId: string, kind: string, params: EventParameterValues = {}): Promise<void> {
    try {
      await this.ready
      this.requireAgent(sessionId)
      const resolved = this.requireBus().kind(kind)
      if (resolved === undefined) {
        throw new ContextGateError('CONTEXT_UNKNOWN', `context kind ${JSON.stringify(kind)} is not registered`, {
          eventKind: kind, sessionId,
        })
      }
      await this.requireStore().setContext(sessionId, kind, true)
      await this.requireStore().addFutureSubscription(kind, validateParameterValues(resolved.parameters, params, sessionId), Date.now())
    } catch (error: unknown) {
      fail(error)
    }
  }

  /**
   * Subscribe one session to a registered kind.
   * @param sessionId - target session.
   * @param kind - registered kind.
   * @returns after the document write is durable.
   */
  async subscribe(sessionId: string, kind: string): Promise<void> {
    await this.setContext(sessionId, kind, true)
  }

  /**
   * Unsubscribe one session from a registered kind.
   * @param sessionId - target session.
   * @param kind - registered kind.
   * @returns after the document write is durable.
   */
  async unsubscribe(sessionId: string, kind: string): Promise<void> {
    await this.setContext(sessionId, kind, false)
  }

  /**
   * Read one session's timer surface.
   * @param sessionId - owner session.
   * @returns timers, presets, absence watchers, and server time.
   */
  @Remote('timers')
  async timers(sessionId: string): Promise<TimerSnapshot> {
    try {
      await this.ready
      this.requireAgent(sessionId)
      return this.requireEngine().snapshot(sessionId)
    } catch (error: unknown) {
      fail(error)
    }
  }

  /**
   * Create one timer.
   * @param sessionId - owner session.
   * @param draft - name, content, and one schedule.
   * @returns the stored timer.
   */
  @Remote('createTimer')
  async createTimer(sessionId: string, draft: TimerDraft): Promise<TimerInstance> {
    try {
      await this.ready
      this.requireAgent(sessionId)
      return await this.requireEngine().createTimer(sessionId, draft)
    } catch (error: unknown) {
      fail(error)
    }
  }

  /**
   * Change one timer.
   * @param sessionId - owner session.
   * @param id - timer identity.
   * @param patch - fields to change.
   * @returns the stored timer.
   */
  @Remote('updateTimer')
  async updateTimer(sessionId: string, id: string, patch: TimerPatch): Promise<TimerInstance> {
    try {
      await this.ready
      this.requireAgent(sessionId)
      return await this.requireEngine().updateTimer(sessionId, id, patch)
    } catch (error: unknown) {
      fail(error)
    }
  }

  /**
   * Pause or resume one timer.
   * @param sessionId - owner session.
   * @param id - timer identity.
   * @param paused - true pauses.
   * @returns the stored timer.
   */
  @Remote('pauseTimer')
  async pauseTimer(sessionId: string, id: string, paused: boolean): Promise<TimerInstance> {
    try {
      await this.ready
      this.requireAgent(sessionId)
      return await this.requireEngine().setTimerEnabled(sessionId, id, !paused)
    } catch (error: unknown) {
      fail(error)
    }
  }

  /**
   * Remove one timer.
   * @param sessionId - owner session.
   * @param id - timer identity.
   * @returns after the document write is durable.
   */
  @Remote('cancelTimer')
  async cancelTimer(sessionId: string, id: string): Promise<void> {
    try {
      await this.ready
      this.requireAgent(sessionId)
      await this.requireEngine().cancelTimer(sessionId, id)
    } catch (error: unknown) {
      fail(error)
    }
  }

  /**
   * Create one timer preset.
   * @param sessionId - creating session.
   * @param draft - template fields.
   * @returns the stored preset.
   */
  @Remote('createTimerPreset')
  async createTimerPreset(sessionId: string, draft: TimerDraft): Promise<TimerPreset> {
    try {
      await this.ready
      this.requireAgent(sessionId)
      return await this.requireEngine().createPreset(sessionId, draft)
    } catch (error: unknown) {
      fail(error)
    }
  }

  /**
   * Change one timer preset. Adopted instances are unaffected.
   * @param sessionId - session changing the preset.
   * @param presetId - template identity.
   * @param patch - fields to replace.
   * @returns the stored preset.
   */
  @Remote('updateTimerPreset')
  async updateTimerPreset(sessionId: string, presetId: string, patch: TimerPatch): Promise<TimerPreset> {
    try {
      await this.ready
      this.requireAgent(sessionId)
      return await this.requireEngine().updatePreset(sessionId, presetId, patch)
    } catch (error: unknown) {
      fail(error)
    }
  }

  /**
   * Adopt one preset into an independent timer.
   * @param sessionId - adopting session.
   * @param presetId - template identity.
   * @returns the stored timer.
   */
  @Remote('adoptTimerPreset')
  async adoptTimerPreset(sessionId: string, presetId: string): Promise<TimerInstance> {
    try {
      await this.ready
      this.requireAgent(sessionId)
      return await this.requireEngine().adoptPreset(sessionId, presetId)
    } catch (error: unknown) {
      fail(error)
    }
  }

  /**
   * Delete one timer preset.
   * @param sessionId - deleting session.
   * @param presetId - template identity.
   * @returns after the document write is durable.
   */
  @Remote('deleteTimerPreset')
  async deleteTimerPreset(sessionId: string, presetId: string): Promise<void> {
    try {
      await this.ready
      this.requireAgent(sessionId)
      await this.requireEngine().deletePreset(sessionId, presetId)
    } catch (error: unknown) {
      fail(error)
    }
  }

  /**
   * Create one absence watcher.
   * @param sessionId - owner session.
   * @param draft - watched kinds and quiet period.
   * @returns the stored watcher.
   */
  @Remote('createAbsence')
  async createAbsence(sessionId: string, draft: AbsenceDraft): Promise<AbsenceTimer> {
    try {
      await this.ready
      this.requireAgent(sessionId)
      return await this.requireEngine().createAbsence(sessionId, draft)
    } catch (error: unknown) {
      fail(error)
    }
  }

  /**
   * Change one absence watcher.
   * @param sessionId - owner session.
   * @param id - watcher identity.
   * @param patch - fields to change.
   * @returns the stored watcher.
   */
  @Remote('updateAbsence')
  async updateAbsence(sessionId: string, id: string, patch: AbsencePatch): Promise<AbsenceTimer> {
    try {
      await this.ready
      this.requireAgent(sessionId)
      return await this.requireEngine().updateAbsence(sessionId, id, patch)
    } catch (error: unknown) {
      fail(error)
    }
  }

  /**
   * Remove one absence watcher.
   * @param sessionId - owner session.
   * @param id - watcher identity.
   * @returns after the document write is durable.
   */
  @Remote('cancelAbsence')
  async cancelAbsence(sessionId: string, id: string): Promise<void> {
    try {
      await this.ready
      this.requireAgent(sessionId)
      await this.requireEngine().cancelAbsence(sessionId, id)
    } catch (error: unknown) {
      fail(error)
    }
  }

  /**
   * List the custom-event rules one session owns.
   * @param sessionId - owner session.
   * @returns the stored rules.
   */
  @Remote('rules')
  async rulesFor(sessionId: string): Promise<readonly EventRule[]> {
    try {
      await this.ready
      this.requireAgent(sessionId)
      return this.requireRules().list(sessionId)
    } catch (error: unknown) {
      fail(error)
    }
  }

  /**
   * Create one custom-event rule.
   * @param sessionId - owner session.
   * @param draft - declarative definition.
   * @returns the stored rule.
   */
  @Remote('createRule')
  async createRule(sessionId: string, draft: EventRuleDraft): Promise<EventRule> {
    try {
      await this.ready
      this.requireAgent(sessionId)
      return await this.requireRules().create(sessionId, draft)
    } catch (error: unknown) {
      fail(error)
    }
  }

  /**
   * Change one custom-event rule.
   * @param sessionId - owner session.
   * @param id - rule identity.
   * @param patch - fields to change.
   * @returns the stored rule.
   */
  @Remote('updateRule')
  async updateRule(sessionId: string, id: string, patch: EventRulePatch): Promise<EventRule> {
    try {
      await this.ready
      this.requireAgent(sessionId)
      return await this.requireRules().update(sessionId, id, patch)
    } catch (error: unknown) {
      fail(error)
    }
  }

  /**
   * Evaluate one rule against a synthetic trigger without publishing.
   * @param sessionId - owner session.
   * @param id - rule identity.
   * @returns the evaluation report.
   */
  @Remote('testRule')
  async testRule(sessionId: string, id: string): Promise<RuleTestResult> {
    try {
      await this.ready
      this.requireAgent(sessionId)
      return await this.requireRules().test(sessionId, id)
    } catch (error: unknown) {
      fail(error)
    }
  }

  /**
   * Pause or resume one rule.
   * @param sessionId - owner session.
   * @param id - rule identity.
   * @param paused - true pauses.
   * @returns the stored rule.
   */
  @Remote('pauseRule')
  async pauseRule(sessionId: string, id: string, paused: boolean): Promise<EventRule> {
    try {
      await this.ready
      this.requireAgent(sessionId)
      return await this.requireRules().setEnabled(sessionId, id, !paused)
    } catch (error: unknown) {
      fail(error)
    }
  }

  /**
   * Resume one paused rule.
   * @param sessionId - owner session.
   * @param id - rule identity.
   * @returns the stored rule.
   */
  async resumeRule(sessionId: string, id: string): Promise<EventRule> {
    return await this.pauseRule(sessionId, id, false)
  }

  /**
   * Remove one custom-event rule.
   * @param sessionId - owner session.
   * @param id - rule identity.
   * @returns after the document write is durable.
   */
  @Remote('cancelRule')
  async cancelRule(sessionId: string, id: string): Promise<void> {
    try {
      await this.ready
      this.requireAgent(sessionId)
      await this.requireRules().cancel(sessionId, id)
    } catch (error: unknown) {
      fail(error)
    }
  }

  /**
   * Accept one authenticated webhook call.
   * @param ruleId - target webhook rule.
   * @param token - shared secret supplied by the caller.
   * @param payload - request body.
   * @returns the evaluation report.
   */
  @Remote('webhook')
  async webhook(ruleId: string, token: string, payload: unknown): Promise<RuleTestResult> {
    try {
      await this.ready
      return await this.requireRules().ingestWebhook(ruleId, token, payload)
    } catch (error: unknown) {
      fail(error)
    }
  }

  /** Open the document, compose the bus and engines, and own their teardown. */
  private async start(): Promise<void> {
    const store = await ContextGateStore.open(this.config.stateDir)
    const startedAt = Date.now()
    const futureFloor = latestFutureRuleTime(store)
    for (const agent of this.ctx.agents.list()) {
      // A live session observed after restart already existed when earlier
      // future rules were created, so it must not match them retroactively.
      store.markSessionSeen(agent.session.id, futureFloor === 0 ? startedAt : 0)
    }
    for (const sessionId of store.sessionIds()) {
      const record = store.session(sessionId)
      if (record.firstSeenAt !== undefined) continue
      // A migrated record predates this build's future-subscription feature.
      store.markSessionSeen(sessionId, 0)
    }
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
    const engine = new TimeEngine({
      store,
      deliver: async (sessionId, input) => { await bus.deliverDirect(sessionId, input) },
      onError: (message) => { this.ctx.logger.warn(`context-gate: ${message}`) },
      maxTimersPerSession: this.config.maxTimersPerSession,
      maxPresets: this.config.maxPresets,
      maxAbsencesPerSession: this.config.maxAbsencesPerSession,
    })
    const rules = new RuleEngine({
      ctx: this.ctx,
      store,
      bus,
      onError: (message) => { this.ctx.logger.warn(`context-gate: ${message}`) },
      maxRulesPerSession: this.config.maxRulesPerSession,
      httpAllowedHosts: this.config.ruleHttpAllowedHosts,
      httpTimeoutMs: this.config.ruleHttpTimeoutMs,
      httpMaxBytes: this.config.ruleHttpMaxBytes,
    })
    this.store = store
    this.bus = bus
    this.engine = engine
    this.rules = rules
    bus.attach()
    rules.start()
    this.ctx.effect(
      () => this.ctx.on('agent/created', ({ agent }) => {
        // A session created while the gate runs is newer than every future rule
        // that exists now, including one created in the same millisecond.
        store.markSessionSeen(agent.session.id, Math.max(Date.now(), latestFutureRuleTime(store) + 1))
      }),
      'context-gate.sessions',
    )
    this.scheduleTimer = setInterval(() => { this.pump() }, this.config.tickMs)
    this.ctx.effect(() => () => {
      this.closed = true
      if (this.scheduleTimer !== undefined) clearInterval(this.scheduleTimer)
      this.scheduleTimer = undefined
      return this.pumpChain.then(() => {
        rules.dispose()
        this.rules = undefined
        this.engine = undefined
        bus.dispose()
        this.bus = undefined
        this.store = undefined
      }, () => {
        rules.dispose()
        this.rules = undefined
        this.engine = undefined
        bus.dispose()
        this.bus = undefined
        this.store = undefined
      })
    }, 'context-gate.lifecycle')
    await engine.recover()
  }

  /** Queue one scheduler tick after the previous one, containing every failure. */
  private pump(): void {
    this.pumpChain = this.pumpChain.then(async () => {
      if (this.closed) return
      try {
        await this.engine?.tick()
      } catch (error: unknown) {
        this.ctx.logger.warn(`context-gate: timer tick failed: ${describeError(error)}`)
      }
      if (this.closed) return
      try {
        await this.rules?.tick()
      } catch (error: unknown) {
        this.ctx.logger.warn(`context-gate: rule tick failed: ${describeError(error)}`)
      }
    }, () => undefined)
  }

  /**
   * Compose one session's context snapshot.
   * @param sessionId - target session.
   * @returns registered kinds, parameter values, the log, and owned rules.
   */
  private buildSnapshot(sessionId: string): ContextSnapshot {
    const store = this.requireStore()
    const bus = this.requireBus()
    const queue = store.queue(sessionId)
    const contexts: ContextEntry[] = bus.listKinds().map((kind) => {
      const subscription = store.subscription(sessionId, kind.kind)
      return {
        kind: kind.kind,
        nameZh: kind.nameZh,
        description: kind.description,
        ttlMs: kind.ttlMs,
        backlog: queue.events.filter(event => event.kind === kind.kind).length,
        enabledBy: { [sessionId]: subscription.enabled },
        parameters: kind.parameters.map(parameter => wireParameter(parameter, sessionId)),
        params: subscription.params,
        subscribed: subscription.enabled,
      }
    })
    return { contexts, events: store.events(sessionId), rules: this.requireRules().list(sessionId) }
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

  private requireEngine(): TimeEngine {
    if (this.engine === undefined) throw new Error('context-gate is not ready')
    return this.engine
  }

  private requireRules(): RuleEngine {
    if (this.rules === undefined) throw new Error('context-gate is not ready')
    return this.rules
  }
}

/**
 * Latest creation time of the stored future-session rules.
 * @param store - gate document.
 * @returns the newest rule time, or 0 when there is none.
 */
function latestFutureRuleTime(store: ContextGateStore): number {
  return store.futureSubscriptions().reduce((latest, rule) => Math.max(latest, rule.createdAt), 0)
}

/**
 * Project one registration parameter onto its wire schema.
 * @param parameter - provider declaration.
 * @param sessionId - session whose options are resolved.
 * @returns the JSON-serializable schema.
 */
function wireParameter(parameter: EventParameterRegistration, sessionId: string): EventParameterSchema {
  const options = parameter.options ?? parameter.optionsProvider?.(sessionId) ?? []
  return {
    key: parameter.key,
    labelZh: parameter.labelZh,
    ...(parameter.labelEn === undefined ? {} : { labelEn: parameter.labelEn }),
    type: parameter.type,
    ...(parameter.multiple === undefined ? {} : { multiple: parameter.multiple }),
    ...(parameter.allowAll === undefined ? {} : { allowAll: parameter.allowAll }),
    ...(parameter.allowFuture === undefined ? {} : { allowFuture: parameter.allowFuture }),
    ...(options.length === 0 ? {} : { options: options.map(option => ({ ...option })) }),
    ...(parameter.description === undefined ? {} : { description: parameter.description }),
  }
}

/**
 * Validate one subscription parameter record against a kind's schema.
 * @param parameters - provider-declared schema.
 * @param values - caller-supplied values.
 * @returns a detached, validated record.
 * @throws ContextGateError `PARAM_UNKNOWN` or `PARAM_INVALID`.
 */
function validateParameterValues(
  parameters: readonly EventParameterRegistration[],
  values: EventParameterValues,
  sessionId: string,
): EventParameterValues {
  if (typeof values !== 'object' || values === null || Array.isArray(values)) {
    throw new ContextGateError('PARAM_INVALID', 'subscription params must be an object')
  }
  const known = new Map(parameters.map(parameter => [parameter.key, parameter]))
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(values)) {
    const schema = known.get(key)
    if (schema === undefined) {
      throw new ContextGateError('PARAM_UNKNOWN', `context kind does not declare subscription parameter ${JSON.stringify(key)}`, { key })
    }
    out[key] = validateParameterValue(
      schema,
      value,
      schema.options ?? schema.optionsProvider?.(sessionId) ?? [],
    )
  }
  return out
}

function validateParameterValue(
  schema: EventParameterRegistration,
  value: unknown,
  options: readonly { readonly value: string }[],
): unknown {
  switch (schema.type) {
    case 'session':
    case 'source': {
      if (schema.multiple === true) {
        if (!Array.isArray(value) || value.length === 0 || value.some(entry => typeof entry !== 'string' || entry === '')) {
          throw new ContextGateError('PARAM_INVALID', `${schema.key} must be a non-empty string array`, { key: schema.key })
        }
        for (const entry of value) {
          if (entry === '*' && schema.allowAll !== true) {
            throw new ContextGateError('PARAM_INVALID', `${schema.key} does not allow all current sessions`, { key: schema.key })
          }
          if (entry === '+' && schema.allowFuture !== true) {
            throw new ContextGateError('PARAM_INVALID', `${schema.key} does not allow future sessions`, { key: schema.key })
          }
        }
        return [...value]
      }
      if (typeof value !== 'string' || value === '') {
        throw new ContextGateError('PARAM_INVALID', `${schema.key} must be a non-empty string`, { key: schema.key })
      }
      return value
    }
    case 'enum': {
      const allowed = (entry: unknown): boolean => typeof entry === 'string' && options.some(option => option.value === entry)
      if (schema.multiple === true) {
        if (!Array.isArray(value) || value.length === 0 || !value.every(allowed)) {
          throw new ContextGateError('PARAM_INVALID', `${schema.key} must be a non-empty array of declared options`, { key: schema.key })
        }
        return [...value]
      }
      if (!allowed(value)) {
        throw new ContextGateError('PARAM_INVALID', `${schema.key} must be one of the declared options`, { key: schema.key })
      }
      return value
    }
    case 'boolean':
      if (typeof value !== 'boolean') throw new ContextGateError('PARAM_INVALID', `${schema.key} must be a boolean`, { key: schema.key })
      return value
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new ContextGateError('PARAM_INVALID', `${schema.key} must be a finite number`, { key: schema.key })
      }
      return value
    case 'string':
      if (typeof value !== 'string') throw new ContextGateError('PARAM_INVALID', `${schema.key} must be a string`, { key: schema.key })
      return value
  }
}
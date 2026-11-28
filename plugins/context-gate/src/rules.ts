/**
 * The merged custom-event / rule engine formerly known as Event-Scripts.
 *
 * A rule is a declarative trigger, a list of conditions, a content template,
 * and an optional isolated script. It observes internal DSH events, its own
 * time/absence conditions, HTTP polls, and authenticated webhook calls. Only
 * the event it generates (`agent.script.<ruleId>`) is registered as a
 * subscribable context kind; raw internal event payloads never reach a
 * subscriber.
 *
 * Generated events are published through ContextGate, so they also feed the
 * event log and any matching subscription. Rules cannot trigger on their own
 * generated events: the internal listeners only see DSH lifecycle events, not
 * published context events.
 *
 * @module @elysia/context-gate/rules
 */

import { createHash, timingSafeEqual } from 'node:crypto'
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-subagent'
import type {
  ContextVisibility, EventRule, EventRuleDraft, EventRulePatch, InternalEventName, RuleCondition, RuleScript,
  RuleTestResult, RuleTrigger, RuleTriggerContext, TimerSchedule,
} from './types.ts'
import { INTERNAL_EVENT_NAMES, RULE_KIND_PREFIX, RULE_SOURCE } from './constants.ts'
import type { ContextBus } from './context-bus.ts'
import type { ContextGateStore } from './state.ts'
import { firstDue, normalizeSchedule, normalizeAbsenceKinds, resolveSchedule, ruleScheduleState } from './time-engine.ts'
import { runRuleScript } from './script-runner.ts'
import { ContextGateError, describeError } from './errors.ts'

/** Largest internal payload a rule condition may inspect, in UTF-8 bytes. */
const MAX_TRIGGER_BYTES = 32_768

/** Largest content a generated event may carry, in UTF-8 bytes. */
const MAX_GENERATED_BYTES = 32_768

/** Rule engine limits and external-trigger policy. */
export interface RuleEngineOptions {
  /** Host context that owns the internal listeners. */
  readonly ctx: Context
  /** Persisted rule definitions. */
  readonly store: ContextGateStore
  /** Publication and kind registration for generated events. */
  readonly bus: ContextBus
  /** Diagnostics sink. */
  readonly onError: (message: string) => void
  /** Maximum rules one session may own. */
  readonly maxRulesPerSession: number
  /** Hostnames an HTTP-poll trigger may reach; empty denies every URL. */
  readonly httpAllowedHosts: readonly string[]
  /** HTTP poll timeout. */
  readonly httpTimeoutMs: number
  /** Largest HTTP poll response body. */
  readonly httpMaxBytes: number
}

interface PollHandle {
  readonly timer: ReturnType<typeof setTimeout>
}

interface CompositeState {
  /** Child index to the latest satisfaction time. */
  readonly satisfied: Map<number, number>
  /** Latest publication time observed for an absence child. */
  readonly absenceSeen: Map<number, number>
}

interface CompositeClock {
  /** Child index inside the composite trigger. */
  readonly index: number
  /** The child's time schedule. */
  readonly schedule: TimerSchedule
  /** Next due time; null when exhausted. */
  nextDueAt: number | null
}

/**
 * Generated kind name of one rule.
 * @param ruleId - rule identity.
 * @returns the stable `agent.script.<sanitized>` kind.
 */
export function ruleKind(ruleId: string): string {
  const compact = ruleId.replaceAll('-', '').toLowerCase()
  return `${RULE_KIND_PREFIX}${compact}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function invalid(message: string, details?: Readonly<Record<string, unknown>>): ContextGateError {
  return new ContextGateError('RULE_INVALID', message, details)
}

function requiredText(value: unknown, label: string, max = 200): string {
  if (typeof value !== 'string' || value.trim() === '') throw invalid(`${label} must not be blank`)
  const text = value.trim()
  if (text.length > max) throw invalid(`${label} may not exceed ${String(max)} characters`)
  return text
}

/**
 * Bound one JSON value so a trigger payload cannot exhaust the rule engine.
 * @param value - candidate value.
 * @param limit - byte ceiling.
 * @returns the detached value, or a placeholder when it exceeds the limit.
 */
function boundedJson(value: unknown, limit = MAX_TRIGGER_BYTES): unknown {
  let json: string
  try {
    json = JSON.stringify(value) ?? 'null'
  } catch {
    return { truncated: true, reason: 'not-json' }
  }
  if (Buffer.byteLength(json, 'utf8') <= limit) return JSON.parse(json) as unknown
  return { truncated: true, bytes: Buffer.byteLength(json, 'utf8') }
}

/**
 * Read one dot path from a value.
 * @param value - root value.
 * @param path - dot-separated path.
 * @returns the value at the path, or undefined.
 */
export function pathValue(value: unknown, path: string): unknown {
  let current: unknown = value
  for (const part of path.split('.')) {
    if (!isRecord(current)) return undefined
    current = current[part]
  }
  return current
}

/** The validating owner of custom-event rules. */
export class RuleEngine {
  private readonly kinds = new Map<string, () => void>()
  private readonly polls = new Map<string, PollHandle>()
  private readonly composites = new Map<string, CompositeState>()
  private readonly compositeClocks = new Map<string, readonly CompositeClock[]>()
  private readonly firing = new Set<string>()
  private disposed = false
  private readonly options: RuleEngineOptions

  /** @param options - context, store, bus, limits, and HTTP policy. */
  constructor(options: RuleEngineOptions) {
    this.options = options
  }

  /**
   * Register the stored rules' kinds and trigger listeners. Polls and time
   * schedules are armed from the persisted definitions.
   */
  start(): void {
    this.options.ctx.effect(
      () => this.options.ctx.on('session/event', (session, event) => {
        const structural: { readonly type: string; readonly data: unknown } = event
        this.onSessionEvent(session.id, structural.type, structural.data)
      }),
      'context-gate.rules.session-event',
    )
    this.options.ctx.effect(
      () => this.options.ctx.on('subagent/start', (info) => {
        this.onInternal('subagent/start', {
          event: 'subagent/start',
          sessionId: String(info.parentSessionId),
          params: { runId: String(info.runId), provider: info.provider, childSessionId: String(info.id), local: info.local },
        })
      }),
      'context-gate.rules.subagent-start',
    )
    this.options.ctx.effect(
      () => this.options.ctx.on('subagent/end', (info) => {
        this.onInternal('subagent/end', {
          event: 'subagent/end',
          sessionId: String(info.parentSessionId),
          params: {
            runId: String(info.runId), provider: info.provider, childSessionId: String(info.id),
            stopReason: info.stopReason,
          },
        })
      }),
      'context-gate.rules.subagent-end',
    )
    this.options.ctx.effect(() => () => { this.dispose() }, 'context-gate.rules.lifecycle')
    for (const rule of this.options.store.rules()) {
      this.registerKind(rule)
      if (rule.enabled) this.armRule(rule)
    }
  }

  /** Stop every poll and drop every generated kind. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const handle of this.polls.values()) clearTimeout(handle.timer)
    this.polls.clear()
    for (const dispose of this.kinds.values()) dispose()
    this.kinds.clear()
    this.composites.clear()
    this.compositeClocks.clear()
  }

  /**
   * Evaluate every time, absence, and composite rule once.
   * @param now - decision instant.
   */
  async tick(now = Date.now()): Promise<void> {
    for (const rule of this.options.store.rules()) {
      if (!rule.enabled) continue
      try {
        if (rule.trigger.kind === 'time') await this.tickTimeRule(rule, now)
        else if (rule.trigger.kind === 'absence') await this.tickAbsenceRule(rule, now)
        else if (rule.trigger.kind === 'composite') await this.tickCompositeRule(rule, now)
      } catch (error: unknown) {
        await this.options.store.patchRule(
          rule.id, { lastError: describeError(error) }, rule.updatedAt,
        )
        this.options.onError(`rule ${rule.id} tick failed: ${describeError(error)}`)
      }
    }
  }

  /** Every rule owned by one session, without the webhook secret hash. */
  list(sessionId: string): readonly EventRule[] {
    return this.options.store.rules()
      .filter(rule => rule.ownerSessionId === sessionId)
      .map((rule) => {
        const { webhookTokenHash: _webhookTokenHash, ...rest } = rule
        return rest
      })
  }

  /**
   * Create one rule owned by a session.
   * @param sessionId - owner session.
   * @param draft - declarative definition.
   * @returns the stored rule.
   */
  async create(sessionId: string, draft: EventRuleDraft): Promise<EventRule> {
    const owned = this.options.store.rules().filter(rule => rule.ownerSessionId === sessionId)
    if (owned.length >= this.options.maxRulesPerSession) {
      throw new ContextGateError('LIMIT_EXCEEDED', `session ${JSON.stringify(sessionId)} already owns ${String(owned.length)} rules`, {
        sessionId, limit: this.options.maxRulesPerSession,
      })
    }
    const now = Date.now()
    const rule: EventRule = {
      id: randomUUID(),
      ownerSessionId: sessionId,
      name: requiredText(draft.name, 'rule name'),
      trigger: this.validateTrigger(draft.trigger, draft.webhookSecret, false),
      where: this.validateWhere(draft.where),
      contentTemplate: this.validateTemplate(draft.contentTemplate),
      ...(draft.script === undefined ? {} : { script: this.validateScript(draft.script) }),
      wake: draft.wake ?? true,
      visibility: normalizeVisibility(draft.visibility),
      cooldownMs: validateCooldown(draft.cooldownMs),
      maxFires: validateMaxFires(draft.maxFires),
      ...(draft.expiresAt === undefined ? {} : { expiresAt: parseInstant(draft.expiresAt, 'expiresAt') }),
      ...(draft.webhookSecret === undefined ? {} : { webhookTokenHash: hashToken(draft.webhookSecret) }),
      enabled: true,
      fireCount: 0,
      createdAt: now,
      updatedAt: now,
      anchorAt: now,
      ...(draft.trigger.kind === 'time' ? nextDueField(firstDue(draft.trigger.schedule, now)) : {}),
    }
    await this.options.store.putRule(rule)
    this.registerKind(rule)
    this.armRule(rule)
    return rule
  }

  /**
   * Change one rule and re-arm its triggers and generated kind.
   * @param sessionId - owner session.
   * @param id - rule identity.
   * @param patch - fields to change.
   * @returns the stored rule.
   */
  async update(sessionId: string, id: string, patch: EventRulePatch): Promise<EventRule> {
    const current = this.requireRule(sessionId, id)
    const now = Date.now()
    const next: EventRule = {
      ...current,
      ...(patch.name === undefined ? {} : { name: requiredText(patch.name, 'rule name') }),
      ...(patch.trigger === undefined
        ? {}
        : {
          trigger: this.validateTrigger(
            patch.trigger,
            patch.webhookSecret,
            current.webhookTokenHash !== undefined,
          ),
        }),
      ...(patch.where === undefined ? {} : { where: this.validateWhere(patch.where) }),
      ...(patch.contentTemplate === undefined ? {} : { contentTemplate: this.validateTemplate(patch.contentTemplate) }),
      ...(patch.script === undefined || patch.script === null ? {} : { script: this.validateScript(patch.script) }),
      ...(patch.wake === undefined ? {} : { wake: patch.wake }),
      ...(patch.visibility === undefined ? {} : { visibility: normalizeVisibility(patch.visibility) }),
      ...(patch.cooldownMs === undefined ? {} : { cooldownMs: validateCooldown(patch.cooldownMs) }),
      ...(patch.maxFires === undefined ? {} : { maxFires: validateMaxFires(patch.maxFires) }),
      ...(patch.expiresAt === undefined || patch.expiresAt === null
        ? {}
        : { expiresAt: parseInstant(patch.expiresAt, 'expiresAt') }),
      ...(patch.webhookSecret === undefined ? {} : { webhookTokenHash: hashToken(patch.webhookSecret) }),
      updatedAt: now,
    }
    const anchorAt = patch.trigger === undefined ? current.anchorAt ?? current.createdAt : now
    let stored: EventRule = { ...next, anchorAt }
    if (patch.script === null) {
      const { script: _script, ...rest } = stored
      stored = rest
    }
    if (patch.expiresAt === null) {
      const { expiresAt: _expiresAt, ...rest } = stored
      stored = rest
    }
    if (patch.trigger !== undefined) {
      const { lastFiredAt: _lastFiredAt, completedAt: _completedAt, ...withoutFire } = stored
      stored = { ...withoutFire, fireCount: 0 }
      if (patch.trigger.kind === 'time') {
        const due = firstDue(patch.trigger.schedule, anchorAt)
        if (due === null) {
          const { nextDueAt: _nextDueAt, ...rest } = stored
          stored = rest
        } else {
          stored = { ...stored, nextDueAt: due }
        }
      } else {
        const { nextDueAt: _nextDueAt, ...rest } = stored
        stored = rest
      }
    }
    await this.options.store.putRule(stored)
    this.rebind(stored)
    return stored
  }

  /**
   * Evaluate one rule against a synthetic trigger without publishing.
   * @param sessionId - owner session.
   * @param id - rule identity.
   * @returns the evaluation report.
   */
  async test(sessionId: string, id: string): Promise<RuleTestResult> {
    const rule = this.requireRule(sessionId, id)
    const context = testContext(rule.trigger)
    const assessed = await this.assess(rule, context, Date.now(), true)
    return assessed
  }

  /**
   * Pause or resume one rule.
   * @param sessionId - owner session.
   * @param id - rule identity.
   * @param enabled - false pauses.
   * @returns the stored rule.
   */
  async setEnabled(sessionId: string, id: string, enabled: boolean): Promise<EventRule> {
    const current = this.requireRule(sessionId, id)
    const next = { ...current, enabled, updatedAt: Date.now() }
    await this.options.store.putRule(next)
    if (enabled) this.armRule(next)
    else this.disarmTriggers(next.id)
    return next
  }

  /**
   * Remove one rule and its generated kind.
   * @param sessionId - owner session.
   * @param id - rule identity.
   */
  async cancel(sessionId: string, id: string): Promise<void> {
    this.requireRule(sessionId, id)
    this.kinds.get(id)?.()
    this.kinds.delete(id)
    this.disarmTriggers(id)
    await this.options.store.removeRule(id)
  }

  /**
   * Accept one authenticated webhook call and fire its rule.
   * @param ruleId - target rule.
   * @param token - plain shared secret.
   * @param payload - request body.
   * @returns the evaluation report.
   */
  async ingestWebhook(ruleId: string, token: string, payload: unknown): Promise<RuleTestResult> {
    const rule = this.options.store.rule(ruleId)
    if (rule === undefined) {
      throw new ContextGateError('RULE_UNKNOWN', `webhook rule ${JSON.stringify(ruleId)} does not exist`, { ruleId })
    }
    if (!tokenMatches(rule, token)) {
      throw new ContextGateError('WEBHOOK_INVALID', 'the webhook secret is wrong or missing', { ruleId })
    }
    if (!rule.enabled) return { matched: true, fired: false, detail: '规则已暂停' }
    const context: RuleTriggerContext = {
      event: 'webhook',
      sessionId: rule.ownerSessionId,
      summary: '外部 webhook',
      params: boundedJson(payload),
    }
    if (rule.trigger.kind === 'webhook') return await this.dispatch(rule, context, Date.now())
    if (rule.trigger.kind !== 'composite') {
      throw new ContextGateError('RULE_UNKNOWN', `rule ${JSON.stringify(ruleId)} is not a webhook rule`, { ruleId })
    }
    const indexes = rule.trigger.triggers
      .map((child, index) => child.kind === 'webhook' ? index : -1)
      .filter(index => index >= 0)
    if (indexes.length === 0) {
      throw new ContextGateError('RULE_UNKNOWN', `composite rule ${JSON.stringify(ruleId)} has no webhook child`, { ruleId })
    }
    for (const index of indexes) this.satisfyChild(rule, index, context, Date.now())
    return { matched: true, fired: false, detail: 'webhook 条件已记录' }
  }

  /**
   * Fire one rule when it is currently eligible.
   * @param rule - rule definition.
   * @param context - trigger context.
   * @param now - decision instant.
   * @param test - suppress side effects for a test call.
   * @returns evaluation report.
   */
  private async assess(rule: EventRule, context: RuleTriggerContext, now: number, test: boolean): Promise<RuleTestResult> {
    if (!rule.enabled && !test) return { matched: false, fired: false, detail: '规则已暂停' }
    if (rule.expiresAt !== undefined && now > rule.expiresAt) {
      return { matched: false, fired: false, detail: '规则已过期' }
    }
    if (rule.maxFires > 0 && rule.fireCount >= rule.maxFires) {
      return { matched: false, fired: false, detail: '规则已达最大触发次数' }
    }
    if (!test && rule.cooldownMs > 0 && rule.lastFiredAt !== undefined && now - rule.lastFiredAt < rule.cooldownMs) {
      return { matched: false, fired: false, detail: `规则处于冷却期（${String(rule.cooldownMs)} ms）` }
    }
    if (!conditionsPass(rule.where, context)) {
      return { matched: false, fired: false, detail: '条件不匹配' }
    }
    if (rule.script !== undefined) {
      const result = await runRuleScript(rule.script, {
        rule: { id: rule.id, name: rule.name },
        trigger: context,
      })
      if (!result.ok) {
        if (!test) await this.options.store.patchRule(rule.id, { lastError: result.error }, rule.updatedAt)
        return { matched: false, fired: false, detail: `脚本失败：${result.error}` }
      }
      if (!result.value) return { matched: false, fired: false, detail: '脚本条件为 false' }
    }
    const content = renderTemplate(rule.contentTemplate, context)
    if (test) return { matched: true, fired: true, detail: '条件和脚本均通过', content }
    return await this.publish(rule, context, content, now)
  }

  /**
   * Publish one generated event and update the rule's runtime counters.
   * @param rule - rule definition.
   * @param context - trigger context.
   * @param content - rendered content.
   * @param now - decision instant.
   * @returns the delivery report.
   */
  private async publish(rule: EventRule, context: RuleTriggerContext, content: string, now: number): Promise<RuleTestResult> {
    if (this.firing.has(rule.id)) return { matched: true, fired: false, detail: '规则正在触发中', content }
    this.firing.add(rule.id)
    try {
      this.registerKind(rule)
      const receipt = await this.options.bus.publish({
        kind: ruleKind(rule.id),
        source: RULE_SOURCE,
        origin: {
          plugin: 'context-gate',
          ...(context.sessionId === undefined ? {} : { sessionId: context.sessionId }),
        },
        summary: content,
        params: boundedJson({
          ruleId: rule.id,
          event: context.event,
          ...(context.sessionId === undefined ? {} : { sessionId: context.sessionId }),
          ...(context.toolName === undefined ? {} : { toolName: context.toolName }),
        }, MAX_GENERATED_BYTES),
        active: rule.wake,
        visibility: rule.visibility,
        dedupeKey: `${rule.id}:${String(now)}`,
      })
      await this.options.store.patchRule(rule.id, {
        fireCount: rule.fireCount + 1,
        lastFiredAt: now,
      }, rule.updatedAt, ['lastError'])
      return {
        matched: true,
        fired: true,
        detail: `已生成事件；投递 ${String(receipt.delivered)} 个会话，抑制 ${String(receipt.suppressed)} 个`,
        content,
      }
    } catch (error: unknown) {
      await this.options.store.patchRule(rule.id, { lastError: describeError(error) }, rule.updatedAt)
      this.options.onError(`rule ${rule.id} publish failed: ${describeError(error)}`)
      return { matched: true, fired: false, detail: `发布失败：${describeError(error)}`, content }
    } finally {
      this.firing.delete(rule.id)
    }
  }

  private async dispatch(rule: EventRule, context: RuleTriggerContext, now: number): Promise<RuleTestResult> {
    return await this.assess(rule, context, now, false)
  }

  /**
   * Handle one internal event for every matching rule.
   * @param event - exposed internal event name.
   * @param context - trigger context.
   */
  private onInternal(event: InternalEventName | 'session/event', context: RuleTriggerContext): void {
    const now = Date.now()
    for (const rule of this.options.store.rules()) {
      if (!rule.enabled) continue
      const trigger = rule.trigger
      if (trigger.kind === 'internal') {
        if (trigger.event === event) void this.dispatch(rule, context, now)
        continue
      }
      if (trigger.kind !== 'composite') continue
      if (trigger.op === 'not') {
        const childMatches = trigger.triggers.some(child => child.kind === 'internal' && child.event === event)
        // The generic session/event pass is not a concrete event; a not-rule
        // with one concrete child must be judged on the specific event only.
        const genericPass = event === 'session/event'
          && !trigger.triggers.some(child => child.kind === 'internal' && child.event === 'session/event')
        if (!childMatches && !genericPass) void this.dispatch(rule, context, now)
        continue
      }
      for (const [index, child] of trigger.triggers.entries()) {
        if (child.kind !== 'internal' || child.event !== event) continue
        if (this.satisfyChild(rule, index, context, now)) break
      }
    }
  }

  private onSessionEvent(sessionId: string, type: string, data: unknown): void {
    const record = isRecord(data) ? data : {}
    const context: RuleTriggerContext = {
      event: 'session/event',
      sessionId,
      kind: type,
      summary: `${type} in session ${sessionId}`,
      params: boundedJson(record),
      ...(typeof record['turn'] === 'number' ? { turn: record['turn'] } : {}),
      ...(typeof record['name'] === 'string' ? { toolName: record['name'] } : {}),
    }
    const specific: RuleTriggerContext = { ...context, event: type, kind: type }
    this.onInternal('session/event', context)
    const exposed = INTERNAL_EVENT_NAMES.find(name => name === type)
    if (exposed !== undefined) this.onInternal(exposed, specific)
  }

  /**
   * Record one composite child satisfaction and fire when the operator allows.
   * @param rule - composite rule.
   * @param index - satisfied child index.
   * @param context - the child's trigger context.
   * @param now - decision instant.
   * @returns true when the composite just dispatched.
   */
  private satisfyChild(rule: EventRule, index: number, context: RuleTriggerContext, now: number): boolean {
    if (rule.trigger.kind !== 'composite') return false
    if (rule.trigger.op === 'not') return false
    const state = this.compositeState(rule.id)
    state.satisfied.set(index, now)
    const windowMs = rule.trigger.windowMs ?? 60_000
    for (const [childIndex, at] of state.satisfied) {
      if (now - at > windowMs) state.satisfied.delete(childIndex)
    }
    if (!this.compositeComplete(rule, state)) return false
    state.satisfied.clear()
    void this.dispatch(rule, context, now)
    return true
  }

  private compositeState(ruleId: string): CompositeState {
    const existing = this.composites.get(ruleId)
    if (existing !== undefined) return existing
    const state: CompositeState = { satisfied: new Map(), absenceSeen: new Map() }
    this.composites.set(ruleId, state)
    return state
  }

  private compositeComplete(rule: EventRule, state: CompositeState): boolean {
    if (rule.trigger.kind !== 'composite') return false
    const count = rule.trigger.triggers.length
    switch (rule.trigger.op) {
      case 'any':
        return state.satisfied.size > 0
      case 'all':
        return state.satisfied.size === count
      case 'sequence': {
        if (state.satisfied.size !== count) return false
        const times = Array.from({ length: count }, (_, index) => state.satisfied.get(index))
        return times.every((time, index) => time !== undefined && (index === 0 || time > (times[index - 1] as number)))
      }
      case 'not':
        return false
      default:
        return false
    }
  }

  /**
   * Advance composite child clocks and absence watchers once.
   * @param rule - composite rule.
   * @param now - decision instant.
   */
  private async tickCompositeRule(rule: EventRule, now: number): Promise<void> {
    if (rule.trigger.kind !== 'composite') return
    const state = this.compositeState(rule.id)
    const anchor = rule.anchorAt ?? rule.createdAt
    for (const clock of this.compositeClocks.get(rule.id) ?? []) {
      if (clock.nextDueAt === null || clock.nextDueAt > now) continue
      const resolved = resolveSchedule(clock.schedule, anchor, clock.nextDueAt, now)
      const fired = resolved.dueAt !== null
        ? this.satisfyChild(rule, clock.index, {
          event: 'time',
          sessionId: rule.ownerSessionId,
          summary: '组合时间条件满足',
        }, now)
        : false
      clock.nextDueAt = resolved.nextDueAt
      if (fired) return
    }
    const lastSeenByKind = this.options.store.lastSeenByKind()
    for (const [index, child] of rule.trigger.triggers.entries()) {
      if (child.kind !== 'absence') continue
      const lastSeen = latestSeen(lastSeenByKind, child.kinds)
      const previous = state.absenceSeen.get(index)
      if (previous !== undefined && lastSeen <= previous) continue
      const baseline = Math.max(anchor, lastSeen, previous ?? 0)
      if (now - baseline < child.quietMs) continue
      state.absenceSeen.set(index, lastSeen)
      const fired = this.satisfyChild(rule, index, {
        event: 'absence',
        sessionId: rule.ownerSessionId,
        summary: `${child.kinds.join(' / ')} 已安静 ${String(child.quietMs)} ms`,
        params: { kinds: child.kinds, quietMs: child.quietMs },
      }, now)
      if (fired) return
    }
  }

  private async tickTimeRule(rule: EventRule, now: number): Promise<void> {
    if (rule.trigger.kind !== 'time') return
    const oneShot = rule.trigger.schedule.kind === 'once' || rule.trigger.schedule.kind === 'after'
    if (oneShot && (rule.lastFiredAt !== undefined || rule.completedAt !== undefined)) return
    const state = ruleScheduleState(rule, now)
    if (state.dueAt === null) {
      if (state.nextDueAt !== rule.nextDueAt) {
        await this.options.store.patchRule(
          rule.id,
          state.nextDueAt === null ? {} : { nextDueAt: state.nextDueAt },
          rule.updatedAt,
          state.nextDueAt === null ? ['nextDueAt'] : [],
        )
      }
      return
    }
    const context: RuleTriggerContext = { event: 'time', sessionId: rule.ownerSessionId, summary: '时间条件满足' }
    await this.dispatch(rule, context, now)
    await this.options.store.patchRule(
      rule.id,
      {
        ...(state.nextDueAt === null ? {} : { nextDueAt: state.nextDueAt }),
        ...(oneShot ? { completedAt: now } : {}),
      },
      rule.updatedAt,
      state.nextDueAt === null ? ['nextDueAt'] : [],
    )
  }

  private async tickAbsenceRule(rule: EventRule, now: number): Promise<void> {
    if (rule.trigger.kind !== 'absence') return
    const lastSeen = latestSeen(this.options.store.lastSeenByKind(), rule.trigger.kinds)
    const lastFiredAt = rule.lastFiredAt ?? 0
    // After firing, the rule waits for the watched kinds to appear again.
    if (lastFiredAt > 0 && lastSeen <= lastFiredAt) return
    const baseline = Math.max(rule.anchorAt ?? rule.createdAt, lastSeen, lastFiredAt)
    if (now - baseline < rule.trigger.quietMs) return
    const context: RuleTriggerContext = {
      event: 'absence',
      sessionId: rule.ownerSessionId,
      summary: `${rule.trigger.kinds.join(' / ')} 已安静 ${String(rule.trigger.quietMs)} ms`,
      params: { kinds: rule.trigger.kinds, quietMs: rule.trigger.quietMs },
    }
    await this.dispatch(rule, context, now)
  }

  private registerKind(rule: EventRule): void {
    if (this.kinds.has(rule.id)) return
    const dispose = this.options.bus.registerKind({
      kind: ruleKind(rule.id),
      nameZh: `自定义事件 · ${rule.name}`,
      description: `规则「${rule.name}」生成的可订阅事件。`,
      activeByDefault: rule.wake,
      ttlMs: 15 * 60_000,
      maxBytes: 65_536,
      maxQueueDepth: 32,
    })
    this.kinds.set(rule.id, dispose)
  }

  /** Re-register the generated kind after a name/wake change. */
  private rebind(rule: EventRule): void {
    this.kinds.get(rule.id)?.()
    this.kinds.delete(rule.id)
    if (rule.enabled) this.registerKind(rule)
    this.armRule(rule)
  }

  /** Arm every poll, time clock, and composite state of one enabled rule. */
  private armRule(rule: EventRule): void {
    this.disarmTriggers(rule.id)
    if (!rule.enabled) return
    if (rule.trigger.kind === 'http-poll') this.armPoll(rule, null)
    if (rule.trigger.kind !== 'composite') return
    this.composites.set(rule.id, { satisfied: new Map(), absenceSeen: new Map() })
    const anchor = rule.anchorAt ?? rule.createdAt
    const clocks: CompositeClock[] = []
    rule.trigger.triggers.forEach((child, index) => {
      if (child.kind === 'time') {
        clocks.push({ index, schedule: child.schedule, nextDueAt: firstDue(child.schedule, anchor) })
      } else if (child.kind === 'http-poll') {
        this.armPoll(rule, index)
      }
    })
    this.compositeClocks.set(rule.id, clocks)
  }

  /** Clear every poll, clock, and composite state owned by one rule. */
  private disarmTriggers(ruleId: string): void {
    const prefix = `${ruleId}:`
    for (const [key, handle] of [...this.polls]) {
      if (!key.startsWith(prefix)) continue
      clearTimeout(handle.timer)
      this.polls.delete(key)
    }
    this.compositeClocks.delete(ruleId)
    this.composites.delete(ruleId)
  }

  private pollKey(ruleId: string, index: number | null): string {
    return `${ruleId}:${index === null ? 'top' : String(index)}`
  }

  private armPoll(rule: EventRule, index: number | null): void {
    const key = this.pollKey(rule.id, index)
    const previous = this.polls.get(key)
    if (previous !== undefined) clearTimeout(previous.timer)
    this.polls.delete(key)
    if (!rule.enabled) return
    const trigger = index === null
      ? rule.trigger
      : rule.trigger.kind === 'composite' ? rule.trigger.triggers[index] : undefined
    if (trigger?.kind !== 'http-poll') return
    const interval = Math.max(1_000, trigger.intervalMs)
    const timer = setTimeout(() => { void this.poll(rule.id, index) }, interval)
    this.polls.set(key, { timer })
  }

  private async poll(ruleId: string, index: number | null): Promise<void> {
    if (this.disposed) return
    const rule = this.options.store.rule(ruleId)
    if (rule === undefined || !rule.enabled) return
    const trigger = index === null
      ? rule.trigger
      : rule.trigger.kind === 'composite' ? rule.trigger.triggers[index] : undefined
    if (trigger?.kind !== 'http-poll') return
    try {
      const body = await this.fetchPoll(trigger.url)
      const selected = trigger.jsonPath === undefined ? body : pathValue(body, trigger.jsonPath)
      const context: RuleTriggerContext = {
        event: 'http-poll',
        sessionId: rule.ownerSessionId,
        summary: `HTTP 轮询 ${trigger.url}`,
        params: boundedJson(selected),
      }
      if (index === null) await this.dispatch(rule, context, Date.now())
      else this.satisfyChild(rule, index, context, Date.now())
    } catch (error: unknown) {
      await this.options.store.patchRule(rule.id, { lastError: describeError(error) }, rule.updatedAt)
      this.options.onError(`rule ${rule.id} poll failed: ${describeError(error)}`)
    } finally {
      const current = this.options.store.rule(ruleId)
      if (current !== undefined) this.armPoll(current, index)
    }
  }

  private async fetchPoll(url: string): Promise<unknown> {
    assertAllowedUrl(url, this.options.httpAllowedHosts)
    const response = await fetch(url, {
      redirect: 'error',
      signal: AbortSignal.timeout(this.options.httpTimeoutMs),
      headers: { accept: 'application/json' },
    })
    if (!response.ok) throw new Error(`HTTP ${String(response.status)}`)
    const text = await response.text()
    if (Buffer.byteLength(text, 'utf8') > this.options.httpMaxBytes) {
      throw new Error(`response exceeds ${String(this.options.httpMaxBytes)} bytes`)
    }
    try {
      return JSON.parse(text)
    } catch {
      return text
    }
  }

  private validateTrigger(
    trigger: RuleTrigger,
    webhookSecret: string | undefined,
    hasExistingSecret: boolean,
  ): RuleTrigger {
    if (typeof trigger !== 'object' || trigger === null) throw invalid('trigger must be an object')
    switch (trigger.kind) {
      case 'time':
        return { kind: 'time', schedule: normalizeSchedule(trigger.schedule) }
      case 'absence':
        return {
          kind: 'absence',
          kinds: normalizeAbsenceKinds(trigger.kinds),
          quietMs: positiveInteger(trigger.quietMs, 'absence.quietMs'),
        }
      case 'internal': {
        if (!(INTERNAL_EVENT_NAMES as readonly string[]).includes(trigger.event)) {
          throw invalid(`trigger.event ${JSON.stringify(trigger.event)} is not an exposed internal event`)
        }
        return { kind: 'internal', event: trigger.event }
      }
      case 'http-poll': {
        assertAllowedUrl(trigger.url, this.options.httpAllowedHosts)
        return {
          kind: 'http-poll',
          url: trigger.url,
          intervalMs: positiveInteger(trigger.intervalMs, 'http-poll.intervalMs'),
          ...(trigger.jsonPath === undefined ? {} : { jsonPath: requiredText(trigger.jsonPath, 'http-poll.jsonPath', 200) }),
        }
      }
      case 'webhook':
        if (!hasExistingSecret && (webhookSecret === undefined || webhookSecret.trim() === '')) {
          throw invalid('a webhook rule needs webhookSecret')
        }
        return { kind: 'webhook' }
      case 'composite': {
        if (!['all', 'any', 'not', 'sequence'].includes(trigger.op)) throw invalid('composite.op is invalid')
        if (!Array.isArray(trigger.triggers) || trigger.triggers.length === 0) throw invalid('composite.triggers must be a non-empty array')
        if (trigger.triggers.length > 16) throw invalid('composite.triggers may contain at most 16 children')
        const children = trigger.triggers.map(child => this.validateTrigger(child, webhookSecret, hasExistingSecret))
        if (trigger.op === 'not') {
          const [only] = children
          if (children.length !== 1 || only?.kind !== 'internal') {
            throw invalid('composite.not 只接受一个内部事件子触发器')
          }
        }
        for (const child of children) {
          if (child.kind === 'composite') {
            throw invalid('暂不支持嵌套组合触发器；请拆成多个规则')
          }
        }
        return {
          kind: 'composite',
          op: trigger.op,
          triggers: children,
          ...(trigger.windowMs === undefined ? {} : { windowMs: positiveInteger(trigger.windowMs, 'composite.windowMs') }),
        }
      }
      default:
        throw invalid('trigger.kind is invalid')
    }
  }

  private validateWhere(where: readonly RuleCondition[] | undefined): readonly RuleCondition[] {
    if (where === undefined) return []
    if (!Array.isArray(where)) throw invalid('where must be an array')
    return where.map((condition, index) => {
      if (typeof condition !== 'object' || condition === null) throw invalid(`where[${String(index)}] must be an object`)
      const ops: readonly RuleCondition['op'][] = ['eq', 'neq', 'contains', 'matches', 'gt', 'lt', 'exists']
      if (!ops.includes(condition.op)) throw invalid(`where[${String(index)}].op is invalid`)
      return {
        field: requiredText(condition.field, `where[${String(index)}].field`, 200),
        op: condition.op,
        ...(condition.value === undefined ? {} : { value: boundedJson(condition.value, 4_096) }),
      }
    })
  }

  private validateTemplate(template: string): string {
    if (typeof template !== 'string' || template.trim() === '') throw invalid('contentTemplate must not be blank')
    if (Buffer.byteLength(template, 'utf8') > 16_384) throw invalid('contentTemplate may not exceed 16384 bytes')
    return template
  }

  private validateScript(script: RuleScript): RuleScript {
    if (typeof script !== 'object' || script === null) throw invalid('script must be an object')
    if (typeof script.source !== 'string' || script.source.trim() === '') throw invalid('script.source must not be blank')
    if (Buffer.byteLength(script.source, 'utf8') > 65_536) throw invalid('script.source may not exceed 65536 bytes')
    if (script.timeoutMs !== undefined && (!Number.isInteger(script.timeoutMs) || script.timeoutMs < 100 || script.timeoutMs > 10_000)) {
      throw invalid('script.timeoutMs must be an integer from 100 to 10000')
    }
    if (script.memoryMb !== undefined && (!Number.isInteger(script.memoryMb) || script.memoryMb < 1 || script.memoryMb > 64)) {
      throw invalid('script.memoryMb must be an integer from 1 to 64')
    }
    return {
      source: script.source,
      ...(script.timeoutMs === undefined ? {} : { timeoutMs: script.timeoutMs }),
      ...(script.memoryMb === undefined ? {} : { memoryMb: script.memoryMb }),
    }
  }

  private requireRule(sessionId: string, id: string): EventRule {
    const rule = this.options.store.rule(id)
    if (rule === undefined || rule.ownerSessionId !== sessionId) {
      throw new ContextGateError('RULE_UNKNOWN', `rule ${JSON.stringify(id)} does not belong to session ${JSON.stringify(sessionId)}`, {
        ruleId: id, sessionId,
      })
    }
    return rule
  }
}

function nextDueField(nextDueAt: number | null): { nextDueAt: number } | Record<string, never> {
  return nextDueAt === null ? {} : { nextDueAt }
}

function normalizeVisibility(visibility: ContextVisibility | undefined): ContextVisibility {
  if (visibility === undefined) return {}
  if (Array.isArray(visibility.sessionIds)) {
    return { sessionIds: visibility.sessionIds.filter(value => typeof value === 'string' && value !== '') }
  }
  return {}
}

function validateCooldown(value: number | undefined): number {
  if (value === undefined) return 0
  if (!Number.isFinite(value) || value < 0) throw invalid('cooldownMs must be a non-negative number')
  return value
}

function validateMaxFires(value: number | undefined): number {
  if (value === undefined) return 0
  if (!Number.isInteger(value) || value < 0) throw invalid('maxFires must be a non-negative integer')
  return value
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) throw invalid(`${label} must be a positive integer`)
  return value
}

function parseInstant(value: string, label: string): number {
  const epoch = Date.parse(value)
  if (!Number.isFinite(epoch)) throw invalid(`${label} must be an ISO-8601 instant`)
  return epoch
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function tokenMatches(rule: EventRule, token: string): boolean {
  if (rule.webhookTokenHash === undefined || typeof token !== 'string' || token === '') return false
  const left = Buffer.from(hashToken(token), 'hex')
  const right = Buffer.from(rule.webhookTokenHash, 'hex')
  return left.length === right.length && timingSafeEqual(left, right)
}

/**
 * Check one HTTP-poll URL against the Host allowlist.
 * @param url - candidate URL.
 * @param allowed - allowed hostnames.
 * @throws ContextGateError `RULE_INVALID` when the URL is not permitted.
 */
export function assertAllowedUrl(url: string, allowed: readonly string[]): void {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw invalid('http-poll.url is not a valid URL')
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw invalid('http-poll.url must use http or https')
  if (parsed.username !== '' || parsed.password !== '') throw invalid('http-poll.url may not embed credentials')
  const host = parsed.hostname.toLowerCase()
  if (host === 'localhost' || host === '0.0.0.0' || host === '::1' || host.endsWith('.local')) {
    throw invalid('http-poll.url may not target a local address')
  }
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.includes(':')) {
    throw invalid('http-poll.url may not target an IP literal')
  }
  const permitted = allowed.some(entry => {
    const candidate = entry.toLowerCase()
    return host === candidate || host.endsWith(`.${candidate}`)
  })
  if (!permitted) {
    throw invalid(`http-poll host ${JSON.stringify(host)} is not in the configured allowlist`, { host })
  }
}

/**
 * Evaluate a rule's declarative conditions.
 * @param conditions - conditions ANDed together.
 * @param context - trigger context.
 * @returns true when every condition passes.
 */
export function conditionsPass(conditions: readonly RuleCondition[], context: RuleTriggerContext): boolean {
  return conditions.every((condition) => conditionPass(condition, context))
}

function conditionPass(condition: RuleCondition, context: RuleTriggerContext): boolean {
  const actual = pathValue(context, condition.field)
  switch (condition.op) {
    case 'exists':
      return actual !== undefined
    case 'eq':
      return equalJson(actual, condition.value)
    case 'neq':
      return !equalJson(actual, condition.value)
    case 'contains':
      if (typeof actual === 'string') return actual.includes(String(condition.value))
      if (Array.isArray(actual)) return actual.some(entry => equalJson(entry, condition.value))
      return false
    case 'matches':
      if (typeof actual !== 'string' || typeof condition.value !== 'string') return false
      try {
        return new RegExp(condition.value).test(actual)
      } catch {
        return false
      }
    case 'gt':
      return typeof actual === 'number' && typeof condition.value === 'number' && actual > condition.value
    case 'lt':
      return typeof actual === 'number' && typeof condition.value === 'number' && actual < condition.value
    default:
      return false
  }
}

function equalJson(left: unknown, right: unknown): boolean {
  try {
    return JSON.stringify(left) === JSON.stringify(right)
  } catch {
    return false
  }
}

/**
 * Render one rule template against a trigger context.
 * @param template - text with optional `{{path}}` references.
 * @param context - trigger context.
 * @returns rendered content; never blank.
 */
export function renderTemplate(template: string, context: RuleTriggerContext): string {
  const rendered = template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (match, path: string) => {
    const value = pathValue(context, path)
    if (value === undefined) return match
    return typeof value === 'string' ? value : JSON.stringify(value) ?? match
  })
  return rendered.trim() === '' ? (context.summary ?? '自定义事件') : rendered
}

function testContext(trigger: RuleTrigger): RuleTriggerContext {
  switch (trigger.kind) {
    case 'internal':
      return { event: trigger.event, summary: '测试触发', params: { test: true } }
    case 'time':
      return { event: 'time', summary: '时间条件满足' }
    case 'absence':
      return { event: 'absence', summary: '安静条件满足', params: { kinds: trigger.kinds } }
    case 'http-poll':
      return { event: 'http-poll', summary: trigger.url, params: { test: true } }
    case 'webhook':
      return { event: 'webhook', summary: '外部 webhook', params: { test: true } }
    case 'composite':
      return { event: trigger.triggers[0]?.kind === 'internal' ? 'session/event' : 'time', summary: '组合条件测试', params: { test: true } }
  }
}

function latestSeen(lastSeenByKind: Readonly<Record<string, number>>, kinds: readonly string[]): number {
  const values = kinds.includes('*') ? Object.values(lastSeenByKind) : kinds.map(kind => lastSeenByKind[kind] ?? 0)
  return values.length === 0 ? 0 : Math.max(...values)
}
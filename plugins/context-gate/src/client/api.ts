/**
 * Browser-side Remote adapter for the context gate. A plugin outside the
 * vendored harness has no generated `ctx.remote` namespace, so this module
 * speaks the same `/api` channel the generated wrappers use.
 *
 * Every call is bound to one session id: each Conversation view has exactly
 * one scope, and the Host answers only for that session. A malformed Host
 * payload becomes a clear error state instead of a render crash.
 *
 * @module @elysia/context-gate/client/api
 */

import type { ClientConnectionRpc } from '@deepseek-ai/dsh-client-connection/client'
import type {
  AbsenceDraft, AbsencePatch, AbsenceTimer, ContextEntry, ContextOrigin, ContextSnapshot, EventLogEntry,
  EventOutcome, EventParameterValues, EventRule, EventRuleDraft, EventRulePatch, RuleTestResult, TimerDraft,
  TimerInstance, TimerPatch, TimerPreset, TimerSchedule, TimerSnapshot,
} from '../types.ts'

/** One refused Remote call, carrying the Host's stable code. */
export class ContextGateRemoteError extends Error {
  /**
   * @param code - `contextGate/<CODE>` as the Host answered.
   * @param message - Host-provided explanation.
   */
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'ContextGateRemoteError'
  }
}

/** Every context operation the views perform. */
export interface ContextGateApi {
  /** Read the session's context kinds, recent injection log, and owned rules. */
  list(signal: AbortSignal): Promise<ContextSnapshot>
  /** Subscribe or unsubscribe one context kind for this session. */
  setContext(kind: string, enabled: boolean, signal: AbortSignal): Promise<void>
  /** Persist source-defined parameter values. */
  setSubscriptionParams(kind: string, params: EventParameterValues, signal: AbortSignal): Promise<void>
  /** Subscribe this session and every future session. */
  subscribeFuture(kind: string, params: EventParameterValues, signal: AbortSignal): Promise<void>
  /** Read the timer surface. */
  timers(signal: AbortSignal): Promise<TimerSnapshot>
  /** Create one timer. */
  createTimer(draft: TimerDraft, signal: AbortSignal): Promise<TimerInstance>
  /** Change one timer. */
  updateTimer(id: string, patch: TimerPatch, signal: AbortSignal): Promise<TimerInstance>
  /** Pause or resume one timer. */
  pauseTimer(id: string, paused: boolean, signal: AbortSignal): Promise<TimerInstance>
  /** Remove one timer. */
  cancelTimer(id: string, signal: AbortSignal): Promise<void>
  /** Create one timer preset. */
  createTimerPreset(draft: TimerDraft, signal: AbortSignal): Promise<TimerPreset>
  /** Change one timer preset. */
  updateTimerPreset(presetId: string, patch: TimerPatch, signal: AbortSignal): Promise<TimerPreset>
  /** Adopt one timer preset. */
  adoptTimerPreset(presetId: string, signal: AbortSignal): Promise<TimerInstance>
  /** Delete one timer preset. */
  deleteTimerPreset(presetId: string, signal: AbortSignal): Promise<void>
  /** Create one absence watcher. */
  createAbsence(draft: AbsenceDraft, signal: AbortSignal): Promise<AbsenceTimer>
  /** Change one absence watcher. */
  updateAbsence(id: string, patch: AbsencePatch, signal: AbortSignal): Promise<AbsenceTimer>
  /** Remove one absence watcher. */
  cancelAbsence(id: string, signal: AbortSignal): Promise<void>
  /** Create one custom-event rule. */
  createRule(draft: EventRuleDraft, signal: AbortSignal): Promise<EventRule>
  /** Change one custom-event rule. */
  updateRule(id: string, patch: EventRulePatch, signal: AbortSignal): Promise<EventRule>
  /** Evaluate one rule without publishing. */
  testRule(id: string, signal: AbortSignal): Promise<RuleTestResult>
  /** Pause or resume one rule. */
  pauseRule(id: string, paused: boolean, signal: AbortSignal): Promise<EventRule>
  /** Remove one rule. */
  cancelRule(id: string, signal: AbortSignal): Promise<void>
}

/** Endpoint names the Host's Remote service publishes. */
const ENDPOINTS = {
  list: 'contextGate/list',
  setContext: 'contextGate/setContext',
  setSubscriptionParams: 'contextGate/setSubscriptionParams',
  subscribeFuture: 'contextGate/subscribeFuture',
  timers: 'contextGate/timers',
  createTimer: 'contextGate/createTimer',
  updateTimer: 'contextGate/updateTimer',
  pauseTimer: 'contextGate/pauseTimer',
  cancelTimer: 'contextGate/cancelTimer',
  createTimerPreset: 'contextGate/createTimerPreset',
  updateTimerPreset: 'contextGate/updateTimerPreset',
  adoptTimerPreset: 'contextGate/adoptTimerPreset',
  deleteTimerPreset: 'contextGate/deleteTimerPreset',
  createAbsence: 'contextGate/createAbsence',
  updateAbsence: 'contextGate/updateAbsence',
  cancelAbsence: 'contextGate/cancelAbsence',
  createRule: 'contextGate/createRule',
  updateRule: 'contextGate/updateRule',
  testRule: 'contextGate/testRule',
  pauseRule: 'contextGate/pauseRule',
  cancelRule: 'contextGate/cancelRule',
} as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string'
}

function isBooleanRecord(value: unknown): value is Readonly<Record<string, boolean>> {
  return isRecord(value) && Object.values(value).every(entry => typeof entry === 'boolean')
}

const EVENT_OUTCOMES: readonly EventOutcome[] = ['published', 'delivered', 'consumed', 'failed', 'dropped']

function isContextEntry(value: unknown): value is ContextEntry {
  return isRecord(value)
    && typeof value['kind'] === 'string'
    && typeof value['nameZh'] === 'string'
    && typeof value['description'] === 'string'
    && isFiniteNumber(value['ttlMs'])
    && isFiniteNumber(value['backlog'])
    && isBooleanRecord(value['enabledBy'])
    && (value['parameters'] === undefined || Array.isArray(value['parameters']))
    && (value['params'] === undefined || isRecord(value['params']))
}

function isOrigin(value: unknown): value is ContextOrigin {
  return isRecord(value)
    && typeof value['plugin'] === 'string'
    && isOptionalString(value['instance'])
    && isOptionalString(value['sessionId'])
    && isOptionalString(value['channel'])
    && isOptionalString(value['conversation'])
}

function isEventEntry(value: unknown): value is EventLogEntry {
  return isRecord(value)
    && typeof value['id'] === 'string'
    && typeof value['kind'] === 'string'
    && EVENT_OUTCOMES.includes(value['outcome'] as EventOutcome)
    && isFiniteNumber(value['at'])
    && isOptionalString(value['eventId'])
    && isOptionalString(value['source'])
    && isOptionalString(value['summary'])
    && isOptionalString(value['causationId'])
    && (value['origin'] === undefined || isOrigin(value['origin']))
    && isOptionalString(value['detail'])
}

function isRule(value: unknown): value is EventRule {
  return isRecord(value)
    && typeof value['id'] === 'string'
    && typeof value['ownerSessionId'] === 'string'
    && typeof value['name'] === 'string'
    && isRecord(value['trigger'])
    && Array.isArray(value['where'])
    && typeof value['contentTemplate'] === 'string'
    && typeof value['enabled'] === 'boolean'
    && isFiniteNumber(value['fireCount'])
}

function isSnapshot(value: unknown): value is ContextSnapshot {
  return isRecord(value)
    && Array.isArray(value['contexts']) && value['contexts'].every(isContextEntry)
    && Array.isArray(value['events']) && value['events'].every(isEventEntry)
    && (value['rules'] === undefined || (Array.isArray(value['rules']) && value['rules'].every(isRule)))
}

function isSchedule(value: unknown): value is TimerSchedule {
  if (!isRecord(value)) return false
  switch (value['kind']) {
    case 'once': return isFiniteNumber(value['at'])
    case 'after': return isFiniteNumber(value['afterMs'])
    case 'seconds': return isFiniteNumber(value['everySeconds'])
    case 'rrule': return typeof value['rrule'] === 'string' && isOptionalString(value['timeZone'])
    default: return false
  }
}

function isTimer(value: unknown): value is TimerInstance {
  return isRecord(value)
    && typeof value['id'] === 'string'
    && typeof value['ownerSessionId'] === 'string'
    && typeof value['name'] === 'string'
    && typeof value['content'] === 'string'
    && isSchedule(value['schedule'])
    && typeof value['wake'] === 'boolean'
    && typeof value['enabled'] === 'boolean'
    && (value['nextDueAt'] === null || isFiniteNumber(value['nextDueAt']))
    && isFiniteNumber(value['firedCount'])
}

function isPreset(value: unknown): value is TimerPreset {
  return isRecord(value)
    && typeof value['id'] === 'string'
    && typeof value['name'] === 'string'
    && typeof value['content'] === 'string'
    && isSchedule(value['schedule'])
    && typeof value['wake'] === 'boolean'
}

function isAbsence(value: unknown): value is AbsenceTimer {
  return isRecord(value)
    && typeof value['id'] === 'string'
    && typeof value['ownerSessionId'] === 'string'
    && Array.isArray(value['kinds']) && value['kinds'].every(kind => typeof kind === 'string')
    && isFiniteNumber(value['quietMs'])
    && isFiniteNumber(value['lastSeenAt'])
    && typeof value['fired'] === 'boolean'
    && typeof value['enabled'] === 'boolean'
}

function isTimerSnapshot(value: unknown): value is TimerSnapshot {
  return isRecord(value)
    && Array.isArray(value['timers']) && value['timers'].every(isTimer)
    && Array.isArray(value['presets']) && value['presets'].every(isPreset)
    && Array.isArray(value['absences']) && value['absences'].every(isAbsence)
    && isFiniteNumber(value['now'])
}

/**
 * Bind the views' operations to one Connection RPC caller and one session.
 * @param rpc - the Connection handle's RPC face.
 * @param sessionId - the session the view is rendering.
 * @returns the adapter the views render against.
 */
const apiCache = new WeakMap<object, Map<string, ContextGateApi>>()

export function createContextGateApi(
  rpc: Pick<ClientConnectionRpc, 'call'>,
  sessionId: string,
): ContextGateApi {
  const bySession = apiCache.get(rpc as object)
  const cached = bySession?.get(sessionId)
  if (cached !== undefined) return cached
  async function invoke(endpoint: string, args: object, signal: AbortSignal): Promise<unknown> {
    const result = await rpc.call('/api', endpoint, { args }, signal)
    signal.throwIfAborted()
    if (!result.ok) throw new ContextGateRemoteError(result.error.code, result.error.message)
    return result.value
  }
  const api: ContextGateApi = {
    async list(signal) {
      const value = await invoke(ENDPOINTS.list, { sessionId }, signal)
      if (!isSnapshot(value)) throw new Error('context-gate/invalid-list-response')
      return value
    },
    async setContext(kind, enabled, signal) {
      await invoke(ENDPOINTS.setContext, { sessionId, kind, enabled }, signal)
    },
    async setSubscriptionParams(kind, params, signal) {
      await invoke(ENDPOINTS.setSubscriptionParams, { sessionId, kind, params }, signal)
    },
    async subscribeFuture(kind, params, signal) {
      await invoke(ENDPOINTS.subscribeFuture, { sessionId, kind, params }, signal)
    },
    async timers(signal) {
      const value = await invoke(ENDPOINTS.timers, { sessionId }, signal)
      if (!isTimerSnapshot(value)) throw new Error('context-gate/invalid-timers-response')
      return value
    },
    async createTimer(draft, signal) {
      const value = await invoke(ENDPOINTS.createTimer, { sessionId, draft }, signal)
      if (!isTimer(value)) throw new Error('context-gate/invalid-timer-response')
      return value
    },
    async updateTimer(id, patch, signal) {
      const value = await invoke(ENDPOINTS.updateTimer, { sessionId, id, patch }, signal)
      if (!isTimer(value)) throw new Error('context-gate/invalid-timer-response')
      return value
    },
    async pauseTimer(id, paused, signal) {
      const value = await invoke(ENDPOINTS.pauseTimer, { sessionId, id, paused }, signal)
      if (!isTimer(value)) throw new Error('context-gate/invalid-timer-response')
      return value
    },
    async cancelTimer(id, signal) {
      await invoke(ENDPOINTS.cancelTimer, { sessionId, id }, signal)
    },
    async createTimerPreset(draft, signal) {
      const value = await invoke(ENDPOINTS.createTimerPreset, { sessionId, draft }, signal)
      if (!isPreset(value)) throw new Error('context-gate/invalid-preset-response')
      return value
    },
    async updateTimerPreset(presetId, patch, signal) {
      const value = await invoke(ENDPOINTS.updateTimerPreset, { sessionId, presetId, patch }, signal)
      if (!isPreset(value)) throw new Error('context-gate/invalid-preset-response')
      return value
    },
    async adoptTimerPreset(presetId, signal) {
      const value = await invoke(ENDPOINTS.adoptTimerPreset, { sessionId, presetId }, signal)
      if (!isTimer(value)) throw new Error('context-gate/invalid-timer-response')
      return value
    },
    async deleteTimerPreset(presetId, signal) {
      await invoke(ENDPOINTS.deleteTimerPreset, { sessionId, presetId }, signal)
    },
    async createAbsence(draft, signal) {
      const value = await invoke(ENDPOINTS.createAbsence, { sessionId, draft }, signal)
      if (!isAbsence(value)) throw new Error('context-gate/invalid-absence-response')
      return value
    },
    async updateAbsence(id, patch, signal) {
      const value = await invoke(ENDPOINTS.updateAbsence, { sessionId, id, patch }, signal)
      if (!isAbsence(value)) throw new Error('context-gate/invalid-absence-response')
      return value
    },
    async cancelAbsence(id, signal) {
      await invoke(ENDPOINTS.cancelAbsence, { sessionId, id }, signal)
    },
    async createRule(draft, signal) {
      const value = await invoke(ENDPOINTS.createRule, { sessionId, draft }, signal)
      if (!isRule(value)) throw new Error('context-gate/invalid-rule-response')
      return value
    },
    async updateRule(id, patch, signal) {
      const value = await invoke(ENDPOINTS.updateRule, { sessionId, id, patch }, signal)
      if (!isRule(value)) throw new Error('context-gate/invalid-rule-response')
      return value
    },
    async testRule(id, signal) {
      const value = await invoke(ENDPOINTS.testRule, { sessionId, id }, signal)
      if (!isRecord(value) || typeof value['matched'] !== 'boolean'
        || typeof value['fired'] !== 'boolean' || typeof value['detail'] !== 'string') {
        throw new Error('context-gate/invalid-rule-test-response')
      }
      return {
        matched: value['matched'],
        fired: value['fired'],
        detail: value['detail'],
        ...(typeof value['content'] === 'string' ? { content: value['content'] } : {}),
      }
    },
    async pauseRule(id, paused, signal) {
      const value = await invoke(ENDPOINTS.pauseRule, { sessionId, id, paused }, signal)
      if (!isRule(value)) throw new Error('context-gate/invalid-rule-response')
      return value
    },
    async cancelRule(id, signal) {
      await invoke(ENDPOINTS.cancelRule, { sessionId, id }, signal)
    },
  }
  let target = apiCache.get(rpc as object)
  if (target === undefined) {
    target = new Map()
    apiCache.set(rpc as object, target)
  }
  target.set(sessionId, api)
  return api
}
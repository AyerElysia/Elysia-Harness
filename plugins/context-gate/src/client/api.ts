/**
 * Browser-side Remote adapter for the context gate. A plugin outside the
 * vendored harness has no generated `ctx.remote` namespace, so this module
 * speaks the same `/api` channel the generated wrappers use.
 *
 * Every call is bound to one session id: each context view has exactly one
 * scope, and the Host answers `list` for that session only. A malformed Host
 * payload becomes a clear error state instead of a render crash.
 *
 * @module @elysia/context-gate/client/api
 */

import type { ClientConnectionRpc } from '@deepseek-ai/dsh-client-connection/client'
import type { ContextEntry, ContextSnapshot, EventLogEntry, EventOutcome } from '../types.ts'

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
  /** Read the session's context kinds and recent injection log. */
  list(signal: AbortSignal): Promise<ContextSnapshot>
  /** Subscribe or unsubscribe one context kind for this session. */
  setContext(kind: string, enabled: boolean, signal: AbortSignal): Promise<void>
}

/** Endpoint names the Host's Remote service publishes. */
const ENDPOINTS = {
  list: 'contextGate/list',
  setContext: 'contextGate/setContext',
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
}

function isEventEntry(value: unknown): value is EventLogEntry {
  return isRecord(value)
    && typeof value['id'] === 'string'
    && typeof value['kind'] === 'string'
    && EVENT_OUTCOMES.includes(value['outcome'] as EventOutcome)
    && isFiniteNumber(value['at'])
    && isOptionalString(value['detail'])
}

function isSnapshot(value: unknown): value is ContextSnapshot {
  return isRecord(value)
    && Array.isArray(value['contexts']) && value['contexts'].every(isContextEntry)
    && Array.isArray(value['events']) && value['events'].every(isEventEntry)
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
  }
  let target = apiCache.get(rpc as object)
  if (target === undefined) {
    target = new Map()
    apiCache.set(rpc as object, target)
  }
  target.set(sessionId, api)
  return api
}
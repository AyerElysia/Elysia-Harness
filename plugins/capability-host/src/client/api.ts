/**
 * Browser-side Remote adapter for the capability Host. A plugin outside the
 * vendored harness has no generated `ctx.remote` namespace, so this module
 * speaks the same `/api` channel the generated wrappers use.
 *
 * The Host's `list()`/`status()` payloads are its own wire shape (snapshot v2):
 * a flat `tools` array, a `scopes` array carrying each scope's effective maps,
 * and `sessions` as rows. The panel renders a normalized view, so this adapter
 * is the only place that knows both shapes. A malformed Host payload becomes a
 * clear error state instead of a render crash.
 *
 * @module @elysia/capability-host/client/api
 */

import type { ClientConnectionRpc } from '@deepseek-ai/dsh-client-connection/client'
import type {
  CapabilitySnapshot, ContextEntry, ContextEvent, EventLogEntry, HealthStatus, HostStatus,
  PublishReceipt, ScopeRowEntry, ScopeRef, StepGate, ToolEntry, ToolGroupEntry, ToolOrigin,
  ToolPresetEntry, ToolScope,
} from './types.ts'

/** One refused Remote call, carrying the Host's stable code. */
export class CapabilityRemoteError extends Error {
  /**
   * @param code - `capabilityHost/<CODE>` as the Host answered.
   * @param message - Host-provided explanation.
   */
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'CapabilityRemoteError'
  }
}

/** Every capability operation the page performs. */
export interface CapabilityPanelApi {
  /** Read the switchable surfaces and the scope lists. */
  list(signal: AbortSignal): Promise<CapabilitySnapshot>
  /** Read write authority and the health sample. */
  status(signal: AbortSignal): Promise<HostStatus>
  /** Switch one tool for one scope. */
  setTool(scope: ScopeRef, toolId: string, enabled: boolean, signal: AbortSignal): Promise<void>
  /** Subscribe or unsubscribe one context event kind for one scope. */
  setContext(scope: ScopeRef, eventKind: string, enabled: boolean, signal: AbortSignal): Promise<void>
  /** Publish one context event. No panel surface calls this yet; providers and debug surfaces do. */
  publish(event: ContextEvent, signal: AbortSignal): Promise<PublishReceipt>
  /** Save a named tool selection. */
  createToolPreset(name: string, tools: readonly string[], signal: AbortSignal): Promise<ToolPresetEntry>
  /** Delete a named tool selection. */
  deleteToolPreset(id: string, signal: AbortSignal): Promise<void>
}

/** Endpoint names the Host's Remote service publishes. */
const ENDPOINTS = {
  list: 'capabilityHost/list',
  status: 'capabilityHost/status',
  setTool: 'capabilityHost/setTool',
  setContext: 'capabilityHost/setContext',
  publish: 'capabilityHost/publish',
  createToolPreset: 'capabilityHost/createToolPreset',
  deleteToolPreset: 'capabilityHost/deleteToolPreset',
} as const

/** Host tool row as `capabilityHost/list` emits it. */
interface RawTool {
  readonly id: string
  readonly origin: ToolOrigin
  readonly locked: boolean
  readonly scope?: ToolScope
  readonly group?: string
  readonly provider?: string
  readonly description?: string
  readonly reason?: string
  readonly sourcePresetId?: string
}

/** One scope's effective maps as the Host emits them. */
interface RawScope {
  readonly ref: { readonly kind: 'preset' | 'session'; readonly id: string }
  readonly tools: Readonly<Record<string, boolean>>
  readonly contexts: Readonly<Record<string, boolean>>
}

/** One session row as the Host emits it. */
interface RawSession {
  readonly id: string
  readonly title?: string
  readonly workspace?: string
  readonly live: boolean
  readonly presetId?: string
}

/** One saved tool selection as the Host emits it. */
interface RawToolPreset {
  readonly id: string
  readonly name: string
  readonly tools: readonly string[]
  readonly createdAt: number
}

/** One context kind as the Host emits it. */
interface RawContextKind {
  readonly kind: string
  readonly activeByDefault: boolean
  readonly ttlMs: number
  readonly maxBytes: number
}

/** Host snapshot v2 */
interface RawSnapshot {
  readonly version: number
  readonly hostState: string
  readonly tools: readonly RawTool[]
  readonly contexts: readonly RawContextKind[]
  readonly scopes: readonly RawScope[]
  readonly sessions: readonly RawSession[]
  readonly toolPresets?: readonly RawToolPreset[]
}

/** Host status as `capabilityHost/status` emits it. */
interface RawStatus {
  readonly hostState: string
  readonly tools: {
    readonly static: number
    readonly global: number
    readonly agent: number
    readonly enabledNow: number
    readonly unavailable: number
  }
  readonly context: {
    readonly queued: number
    readonly oldestEventAt?: number
    readonly consumed: number
    readonly failed: number
    readonly merged: number
  }
  readonly gate: {
    readonly errorCount: number
    readonly lastErrorLoud: boolean
    readonly lastError?: string
  }
  readonly diagnostics: readonly unknown[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string'
}

function isToolScope(value: unknown): value is ToolScope {
  return value === 'global' || value === 'agent'
}

function isToolOrigin(value: unknown): value is ToolOrigin {
  return value === 'static' || value === 'dynamic'
}

function isBooleanRecord(value: unknown): value is Readonly<Record<string, boolean>> {
  return isRecord(value) && Object.values(value).every(entry => typeof entry === 'boolean')
}

function isRawTool(value: unknown): value is RawTool {
  return isRecord(value)
    && typeof value['id'] === 'string'
    && isToolOrigin(value['origin'])
    && typeof value['locked'] === 'boolean'
    && (value['scope'] === undefined || isToolScope(value['scope']))
    && isOptionalString(value['group'])
    && isOptionalString(value['provider'])
    && isOptionalString(value['description'])
    && isOptionalString(value['reason'])
    && isOptionalString(value['sourcePresetId'])
}

function isRawScope(value: unknown): value is RawScope {
  if (!isRecord(value)) return false
  const ref = value['ref']
  return isRecord(ref)
    && (ref['kind'] === 'preset' || ref['kind'] === 'session')
    && typeof ref['id'] === 'string'
    && isBooleanRecord(value['tools'])
    && isBooleanRecord(value['contexts'])
}

function isRawSession(value: unknown): value is RawSession {
  return isRecord(value)
    && typeof value['id'] === 'string'
    && isOptionalString(value['title'])
    && isOptionalString(value['workspace'])
    && typeof value['live'] === 'boolean'
    && isOptionalString(value['presetId'])
}

function isRawToolPreset(value: unknown): value is RawToolPreset {
  return isRecord(value)
    && typeof value['id'] === 'string'
    && typeof value['name'] === 'string'
    && isStringArray(value['tools'])
    && isFiniteNumber(value['createdAt'])
}

function isToolPreset(value: unknown): value is ToolPresetEntry {
  return isRawToolPreset(value)
}

function isRawContextKind(value: unknown): value is RawContextKind {
  return isRecord(value)
    && typeof value['kind'] === 'string'
    && typeof value['activeByDefault'] === 'boolean'
    && isFiniteNumber(value['ttlMs'])
    && isFiniteNumber(value['maxBytes'])
}

function isRawSnapshot(value: unknown): value is RawSnapshot {
  return isRecord(value)
    && isFiniteNumber(value['version'])
    && typeof value['hostState'] === 'string'
    && Array.isArray(value['tools']) && value['tools'].every(isRawTool)
    && Array.isArray(value['contexts']) && value['contexts'].every(isRawContextKind)
    && Array.isArray(value['scopes']) && value['scopes'].every(isRawScope)
    && Array.isArray(value['sessions']) && value['sessions'].every(isRawSession)
    && (value['toolPresets'] === undefined
      || (Array.isArray(value['toolPresets']) && value['toolPresets'].every(isRawToolPreset)))
}

function isRawStatus(value: unknown): value is RawStatus {
  if (!isRecord(value)) return false
  const tools = value['tools']
  const context = value['context']
  const gate = value['gate']
  return typeof value['hostState'] === 'string'
    && isRecord(tools)
    && ['static', 'global', 'agent', 'enabledNow', 'unavailable'].every(name => isFiniteNumber(tools[name]))
    && isRecord(context)
    && ['queued', 'consumed', 'failed', 'merged'].every(name => isFiniteNumber(context[name]))
    && (context['oldestEventAt'] === undefined || isFiniteNumber(context['oldestEventAt']))
    && isRecord(gate)
    && isFiniteNumber(gate['errorCount'])
    && typeof gate['lastErrorLoud'] === 'boolean'
    && isOptionalString(gate['lastError'])
    && Array.isArray(value['diagnostics'])
}

function scopeKey(ref: { readonly kind: 'preset' | 'session'; readonly id: string }): string {
  return `${ref.kind}:${ref.id}`
}

/** Normalize the Host's flat tool rows into the panel's rendered tools. */
function normalizeTools(raw: RawSnapshot): readonly ToolEntry[] {
  const scopes = new Map(raw.scopes.map(entry => [scopeKey(entry.ref), entry]))
  return raw.tools.map((tool): ToolEntry => {
    const group = tool.origin === 'static' ? 'static' : tool.group ?? 'other'
    const enabledBy = tool.origin === 'dynamic'
      ? Object.fromEntries([...scopes].map(([key, scope]) => [key, scope.tools[tool.id] ?? false]))
      : undefined
    const stepBy: Record<string, StepGate> | undefined = tool.origin === 'dynamic'
      ? Object.fromEntries([...scopes].map(([key, scope]) => [key, scope.tools[tool.id] ? 'active' : 'hidden']))
      : undefined
    return {
      id: tool.id,
      group,
      scope: tool.scope ?? 'agent',
      origin: tool.origin,
      locked: tool.locked,
      ...(tool.sourcePresetId === undefined ? {} : { sourcePresetId: tool.sourcePresetId }),
      ...(tool.provider === undefined ? {} : { provider: tool.provider }),
      ...(tool.reason === undefined ? {} : { failure: tool.reason }),
      ...(enabledBy === undefined ? {} : { enabledBy }),
      ...(stepBy === undefined ? {} : { stepBy }),
    }
  })
}

/** Dynamic tools grouped by their catalog group; static tools stay out. */
function normalizeGroups(tools: readonly ToolEntry[]): readonly ToolGroupEntry[] {
  const groups = new Map<string, { scope: ToolScope; tools: string[] }>()
  for (const tool of tools) {
    if (tool.origin !== 'dynamic') continue
    const current = groups.get(tool.group) ?? { scope: tool.scope, tools: [] }
    current.tools.push(tool.id)
    groups.set(tool.group, current)
  }
  return [...groups].map(([id, group]): ToolGroupEntry => ({
    id,
    scope: group.scope,
    origin: 'dynamic',
    atomic: id === 'reply',
    locked: false,
    tools: group.tools,
  }))
}

function normalizeContexts(raw: RawSnapshot): readonly ContextEntry[] {
  const scopes = new Map(raw.scopes.map(entry => [scopeKey(entry.ref), entry]))
  return raw.contexts.map((context): ContextEntry => ({
    kind: context.kind,
    active: context.activeByDefault,
    ttlMs: context.ttlMs,
    backlog: 0,
    enabledBy: Object.fromEntries([...scopes].map(([key, scope]) => [key, scope.contexts[context.kind] ?? false])),
  }))
}

function normalizeSnapshot(raw: RawSnapshot): CapabilitySnapshot {
  const tools = normalizeTools(raw)
  const sessions: ScopeRowEntry[] = raw.sessions.map(session => ({
    kind: 'session',
    id: session.id,
    title: session.title ?? session.id,
    live: session.live,
    ...(session.workspace === undefined ? {} : { workspace: session.workspace }),
    ...(session.presetId === undefined ? {} : { presetId: session.presetId }),
  }))
  const presets: ScopeRowEntry[] = raw.scopes
    .filter(scope => scope.ref.kind === 'preset')
    .map(scope => ({
      kind: 'preset',
      id: scope.ref.id,
      title: scope.ref.id,
      live: true,
      sessionCount: sessions.filter(session => session.presetId === scope.ref.id).length,
    }))
  const events: readonly EventLogEntry[] = []
  return {
    groups: normalizeGroups(tools),
    tools,
    contexts: normalizeContexts(raw),
    presets,
    sessions,
    toolPresets: (raw.toolPresets ?? []).map(preset => ({ ...preset, tools: [...preset.tools] })),
    events,
  }
}

/** Normalize the Host's status shape into the panel's health view. */
function normalizeStatus(raw: RawStatus): HostStatus {
  const health: HealthStatus = {
    tools: {
      static: raw.tools.static,
      registered: raw.tools.global + raw.tools.agent,
      enabled: raw.tools.enabledNow,
      failed: raw.tools.unavailable,
      global: raw.tools.global,
      agent: raw.tools.agent,
    },
    contexts: {
      queueDepth: raw.context.queued,
      oldestAgeMs: raw.context.oldestEventAt === undefined ? 0 : Math.max(0, Date.now() - raw.context.oldestEventAt),
      consumed: raw.context.consumed,
      failed: raw.context.failed,
      merged: raw.context.merged,
    },
    gate: {
      failClosed: raw.gate.lastErrorLoud ? 0 : raw.gate.errorCount,
      failLoud: raw.gate.lastErrorLoud ? raw.gate.errorCount : 0,
      ...(raw.gate.lastError === undefined ? {} : { lastError: raw.gate.lastError }),
    },
    capturedAt: Date.now(),
  }
  const degraded = raw.tools.unavailable > 0 || raw.gate.errorCount > 0 || raw.context.failed > 0
  return {
    writable: true,
    mode: raw.hostState === 'enabled' ? (degraded ? 'degraded' : 'live') : 'starting',
    health,
  }
}

const TOOL_HEALTH_FIELDS = ['static', 'registered', 'enabled', 'failed', 'global', 'agent'] as const
const CONTEXT_HEALTH_FIELDS = ['queueDepth', 'oldestAgeMs', 'consumed', 'failed', 'merged'] as const
const GATE_HEALTH_FIELDS = ['failClosed', 'failLoud'] as const
const EVENT_OUTCOMES = ['published', 'delivered', 'consumed', 'failed', 'dropped'] as const

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every(entry => typeof entry === 'string')
}

function isStepGate(value: unknown): value is StepGate {
  return value === 'active' || value === 'frozen' || value === 'hidden'
}

function isStepRecord(value: unknown): value is Readonly<Record<string, StepGate>> {
  return isRecord(value) && Object.values(value).every(isStepGate)
}

function isOptionalNumber(value: unknown): boolean {
  return value === undefined || isFiniteNumber(value)
}

function isEventOutcome(value: unknown): boolean {
  return EVENT_OUTCOMES.some(outcome => outcome === value)
}

function isScopeRow(value: unknown): value is ScopeRowEntry {
  return isRecord(value)
    && (value['kind'] === 'preset' || value['kind'] === 'session')
    && typeof value['id'] === 'string'
    && typeof value['live'] === 'boolean'
    && isOptionalString(value['title'])
    && isOptionalString(value['presetId'])
    && isOptionalNumber(value['lastActiveAt'])
    && isOptionalNumber(value['sessionCount'])
}

function isClientTool(value: unknown): value is ToolEntry {
  return isRecord(value)
    && typeof value['id'] === 'string'
    && typeof value['group'] === 'string'
    && isToolScope(value['scope'])
    && isToolOrigin(value['origin'])
    && typeof value['locked'] === 'boolean'
    && isOptionalString(value['sourcePresetId'])
    && (value['shadowed'] === undefined || typeof value['shadowed'] === 'boolean')
    && (value['enabledBy'] === undefined || isBooleanRecord(value['enabledBy']))
    && (value['stepBy'] === undefined || isStepRecord(value['stepBy']))
    && isOptionalString(value['provider'])
    && isOptionalString(value['failure'])
}

function isClientGroup(value: unknown): value is ToolGroupEntry {
  return isRecord(value)
    && typeof value['id'] === 'string'
    && isToolScope(value['scope'])
    && isToolOrigin(value['origin'])
    && typeof value['atomic'] === 'boolean'
    && typeof value['locked'] === 'boolean'
    && isStringArray(value['tools'])
}

function isClientContext(value: unknown): value is ContextEntry {
  return isRecord(value)
    && typeof value['kind'] === 'string'
    && typeof value['active'] === 'boolean'
    && isBooleanRecord(value['enabledBy'])
    && isOptionalNumber(value['ttlMs'])
    && isOptionalNumber(value['backlog'])
    && isOptionalString(value['failure'])
}

function isClientEvent(value: unknown): value is EventLogEntry {
  return isRecord(value)
    && typeof value['id'] === 'string'
    && typeof value['kind'] === 'string'
    && isEventOutcome(value['outcome'])
    && isFiniteNumber(value['at'])
    && isOptionalString(value['detail'])
}

function isHealth(value: unknown): value is HealthStatus {
  if (!isRecord(value)) return false
  const tools = value['tools']
  const contexts = value['contexts']
  const gate = value['gate']
  return isRecord(tools) && TOOL_HEALTH_FIELDS.every(name => isFiniteNumber(tools[name]))
    && isRecord(contexts) && CONTEXT_HEALTH_FIELDS.every(name => isFiniteNumber(contexts[name]))
    && isRecord(gate) && GATE_HEALTH_FIELDS.every(name => isFiniteNumber(gate[name]))
    && isOptionalString(gate['lastError'])
    && isFiniteNumber(value['capturedAt'])
}

/** A client-shaped snapshot, kept for fixtures and adapters that already normalize. */
function isClientSnapshot(value: unknown): value is CapabilitySnapshot {
  return isRecord(value)
    && Array.isArray(value['groups']) && value['groups'].every(isClientGroup)
    && Array.isArray(value['tools']) && value['tools'].every(isClientTool)
    && Array.isArray(value['contexts']) && value['contexts'].every(isClientContext)
    && Array.isArray(value['presets']) && value['presets'].every(isScopeRow)
    && Array.isArray(value['sessions']) && value['sessions'].every(isScopeRow)
    && (value['toolPresets'] === undefined
      || (Array.isArray(value['toolPresets']) && value['toolPresets'].every(isToolPreset)))
    && Array.isArray(value['events']) && value['events'].every(isClientEvent)
}

/** A client-shaped status, kept for fixtures and adapters that already normalize. */
function isClientStatus(value: unknown): value is HostStatus {
  return isRecord(value)
    && typeof value['writable'] === 'boolean'
    && (value['mode'] === 'live' || value['mode'] === 'starting' || value['mode'] === 'degraded')
    && isHealth(value['health'])
}

function isReceipt(value: unknown): value is PublishReceipt {
  return isRecord(value)
    && typeof value['eventId'] === 'string'
    && isFiniteNumber(value['delivered'])
    && isFiniteNumber(value['suppressed'])
    && isFiniteNumber(value['failed'])
}

/**
 * Bind the panel's operations to one Connection RPC caller.
 * @param rpc - the Connection handle's RPC face.
 * @returns the adapter the page renders against.
 */
export function createCapabilityPanelApi(rpc: Pick<ClientConnectionRpc, 'call'>): CapabilityPanelApi {
  async function invoke(endpoint: string, args: object, signal: AbortSignal): Promise<unknown> {
    const result = await rpc.call('/api', endpoint, { args }, signal)
    signal.throwIfAborted()
    if (!result.ok) throw new CapabilityRemoteError(result.error.code, result.error.message)
    return result.value
  }
  return {
    async list(signal) {
      const value = await invoke(ENDPOINTS.list, {}, signal)
      if (isClientSnapshot(value)) return value
      if (!isRawSnapshot(value)) throw new Error('control-panel/invalid-list-response')
      return normalizeSnapshot(value)
    },
    async status(signal) {
      const value = await invoke(ENDPOINTS.status, {}, signal)
      if (isClientStatus(value)) return value
      if (!isRawStatus(value)) throw new Error('control-panel/invalid-status-response')
      return normalizeStatus(value)
    },
    async setTool(scope, toolId, enabled, signal) {
      await invoke(ENDPOINTS.setTool, { scope, toolId, enabled }, signal)
    },
    async setContext(scope, eventKind, enabled, signal) {
      await invoke(ENDPOINTS.setContext, { scope, eventKind, enabled }, signal)
    },
    async publish(event, signal) {
      const value = await invoke(ENDPOINTS.publish, { event }, signal)
      if (!isReceipt(value)) throw new Error('control-panel/invalid-publish-response')
      return value
    },
    async createToolPreset(name, tools, signal) {
      const value = await invoke(ENDPOINTS.createToolPreset, { name, tools }, signal)
      if (!isToolPreset(value)) throw new Error('control-panel/invalid-tool-preset-response')
      return value
    },
    async deleteToolPreset(id, signal) {
      await invoke(ENDPOINTS.deleteToolPreset, { id }, signal)
    },
  }
}
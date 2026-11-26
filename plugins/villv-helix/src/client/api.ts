/**
 * Browser-side Remote adapter for the orchestrator's tool face. A plugin outside
 * the vendored harness has no generated `ctx.remote` namespace, so this module
 * speaks the same `/api` channel the generated wrappers use.
 *
 * Every call is bound to one session id: the panel has exactly one scope, and
 * the Host answers `list` for that session only. A malformed Host payload
 * becomes a clear error state instead of a render crash.
 *
 * @module @elysia/villv-helix/client/api
 */

import type { ClientConnectionRpc } from '@deepseek-ai/dsh-client-connection/client'
import type {
  CapabilitySnapshot, PresetPrompt, SessionRowEntry, StepGate, ToolEntry, ToolGroupEntry, ToolOrigin,
  ToolPresetEntry, ToolScope,
} from '../types.ts'

/** One refused Remote call, carrying the Host's stable code. */
export class VillvHelixRemoteError extends Error {
  /**
   * @param code - `villvHelix/<CODE>` as the Host answered.
   * @param message - Host-provided explanation.
   */
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'VillvHelixRemoteError'
  }
}

/** Every tool operation the page performs. */
export interface VillvHelixApi {
  /** Read the session's tool surface. */
  list(signal: AbortSignal): Promise<CapabilitySnapshot>
  /** Disable or enable one global tool for this session. */
  setTool(toolId: string, enabled: boolean, signal: AbortSignal): Promise<void>
  /** Read 工具编辑模式 without requiring a live Agent. */
  getMode(signal: AbortSignal): Promise<boolean>
  /** Turn 工具编辑模式 on or off for this session. */
  setMode(enabled: boolean, signal: AbortSignal): Promise<void>
  /** Save a named tool selection. */
  createToolPreset(name: string, tools: readonly string[], signal: AbortSignal): Promise<ToolPresetEntry>
  /** Delete a named tool selection. */
  deleteToolPreset(id: string, signal: AbortSignal): Promise<void>
  /** Read the active preset's prompt bundle; undefined when the manager does not own it. */
  readPresetPrompt(presetId: string, signal: AbortSignal): Promise<PresetPrompt | undefined>
  /** Render the system prompt the active session actually assembles. */
  readSystemPrompt(signal: AbortSignal): Promise<string>
}

/** Endpoint names the Host's Remote service publishes. */
const ENDPOINTS = {
  list: 'villvHelix/list',
  setTool: 'villvHelix/setTool',
  getMode: 'villvHelix/getMode',
  setMode: 'villvHelix/setMode',
  createToolPreset: 'villvHelix/createToolPreset',
  deleteToolPreset: 'villvHelix/deleteToolPreset',
  readPresetPrompt: 'presetManager/readPrompt',
  readSystemPrompt: 'villvHelix/readSystemPrompt',
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

function isOptionalNumber(value: unknown): boolean {
  return value === undefined || isFiniteNumber(value)
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every(entry => typeof entry === 'string')
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

const STEP_GATES: readonly StepGate[] = ['active', 'frozen', 'hidden']

function isStepRecord(value: unknown): value is Readonly<Record<string, StepGate>> {
  return isRecord(value) && Object.values(value).every(entry => STEP_GATES.includes(entry as StepGate))
}

function isToolEntry(value: unknown): value is ToolEntry {
  return isRecord(value)
    && typeof value['id'] === 'string'
    && typeof value['group'] === 'string'
    && isToolScope(value['scope'])
    && isToolOrigin(value['origin'])
    && typeof value['locked'] === 'boolean'
    && isOptionalString(value['nameZh'])
    && isOptionalString(value['sourcePresetId'])
    && isOptionalString(value['provider'])
    && isOptionalString(value['failure'])
    && (value['enabledBy'] === undefined || isBooleanRecord(value['enabledBy']))
    && (value['stepBy'] === undefined || isStepRecord(value['stepBy']))
}

function isToolGroup(value: unknown): value is ToolGroupEntry {
  return isRecord(value)
    && typeof value['id'] === 'string'
    && isToolScope(value['scope'])
    && isToolOrigin(value['origin'])
    && typeof value['atomic'] === 'boolean'
    && typeof value['locked'] === 'boolean'
    && isStringArray(value['tools'])
}

function isSessionRow(value: unknown): value is SessionRowEntry {
  return isRecord(value)
    && typeof value['id'] === 'string'
    && typeof value['live'] === 'boolean'
    && isOptionalString(value['title'])
    && isOptionalString(value['workspace'])
    && isOptionalString(value['presetId'])
    && isOptionalString(value['presetName'])
    && (value['orchestrated'] === undefined || typeof value['orchestrated'] === 'boolean')
    && isOptionalNumber(value['lastActiveAt'])
}

function isToolPreset(value: unknown): value is ToolPresetEntry {
  return isRecord(value)
    && typeof value['id'] === 'string'
    && typeof value['name'] === 'string'
    && isStringArray(value['tools'])
    && isFiniteNumber(value['createdAt'])
}

function isSnapshot(value: unknown): value is CapabilitySnapshot {
  return isRecord(value)
    && Array.isArray(value['tools']) && value['tools'].every(isToolEntry)
    && Array.isArray(value['groups']) && value['groups'].every(isToolGroup)
    && Array.isArray(value['sessions']) && value['sessions'].every(isSessionRow)
    && Array.isArray(value['toolPresets']) && value['toolPresets'].every(isToolPreset)
}

function isPresetPrompt(value: unknown): value is PresetPrompt {
  return isRecord(value)
    && typeof value['id'] === 'string'
    && typeof value['root'] === 'string'
    && isStringArray(value['files'])
    && typeof value['text'] === 'string'
    && isStringArray(value['missing'])
}

/**
 * Bind the panel's operations to one Connection RPC caller and one session.
 * @param rpc - the Connection handle's RPC face.
 * @param sessionId - the session the view is rendering.
 * @returns the adapter the page renders against.
 */
const apiCache = new WeakMap<object, Map<string, VillvHelixApi>>()

export function createVillvHelixApi(
  rpc: Pick<ClientConnectionRpc, 'call'>,
  sessionId: string,
): VillvHelixApi {
  const bySession = apiCache.get(rpc as object)
  const cached = bySession?.get(sessionId)
  if (cached !== undefined) return cached
  async function invoke(endpoint: string, args: object, signal: AbortSignal): Promise<unknown> {
    const result = await rpc.call('/api', endpoint, { args }, signal)
    signal.throwIfAborted()
    if (!result.ok) throw new VillvHelixRemoteError(result.error.code, result.error.message)
    return result.value
  }
  const api: VillvHelixApi = {
    async list(signal) {
      const value = await invoke(ENDPOINTS.list, { sessionId }, signal)
      if (!isSnapshot(value)) throw new Error('villv-helix/invalid-list-response')
      return value
    },
    async setTool(toolId, enabled, signal) {
      await invoke(ENDPOINTS.setTool, { sessionId, toolId, enabled }, signal)
    },
    async getMode(signal) {
      const value = await invoke(ENDPOINTS.getMode, { sessionId }, signal)
      return value === true
    },
    async setMode(enabled, signal) {
      await invoke(ENDPOINTS.setMode, { sessionId, enabled }, signal)
    },
    async createToolPreset(name, tools, signal) {
      const value = await invoke(ENDPOINTS.createToolPreset, { name, tools }, signal)
      if (!isToolPreset(value)) throw new Error('villv-helix/invalid-tool-preset-response')
      return value
    },
    async deleteToolPreset(id, signal) {
      await invoke(ENDPOINTS.deleteToolPreset, { id }, signal)
    },
    async readPresetPrompt(presetId, signal) {
      try {
        const value = await invoke(ENDPOINTS.readPresetPrompt, { id: presetId }, signal)
        if (!isPresetPrompt(value)) return undefined
        return value
      } catch {
        return undefined
      }
    },
    async readSystemPrompt(signal) {
      const value = await invoke(ENDPOINTS.readSystemPrompt, { sessionId }, signal)
      return typeof value === 'string' ? value : ''
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
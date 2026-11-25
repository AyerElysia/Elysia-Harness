/**
 * Browser-side Remote adapter for the preset manager. A plugin outside the
 * vendored harness has no generated `ctx.remote` namespace, so this module
 * speaks the same `/api` channel the generated wrappers use.
 *
 * @module @elysia/mobius-infinity/client/api
 */

import type { ClientConnectionRpc } from '@deepseek-ai/dsh-client-connection/client'
import type {
  CustomToolFaceInput, DeletePresetOptions, PresetDraft, PresetSummary, PromptCandidate,
  ToolFace, ToolFaceCatalog,
} from '../types.ts'

/** One refused Remote call, carrying the Host's stable code. */
export class PresetManagerRemoteError extends Error {
  /**
   * @param code - `presetManager/<PRESET_ERROR_CODE>` as the Host answered.
   * @param message - Host-provided explanation.
   */
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'PresetManagerRemoteError'
  }
}

/** Every preset-manager operation the page performs. */
export interface PresetManagerApi {
  /** Read the merged roster. */
  list(signal: AbortSignal): Promise<PresetSummary[]>
  /** Read the tool switches and faces this deployment can compose. */
  listToolFaces(signal: AbortSignal): Promise<ToolFaceCatalog>
  /** Store a custom face built from the current switches. */
  createToolFace(input: CustomToolFaceInput, signal: AbortSignal): Promise<ToolFace>
  /** Remove one custom face. */
  deleteToolFace(id: string, signal: AbortSignal): Promise<void>
  /** Register one preset from the create page. */
  create(draft: PresetDraft, signal: AbortSignal): Promise<PresetSummary>
  /** Remove one manager-owned preset. */
  remove(id: string, options: DeletePresetOptions | undefined, signal: AbortSignal): Promise<void>
  /** Read the Markdown candidates of one directory. */
  listPromptCandidates(root: string, signal: AbortSignal): Promise<PromptCandidate[]>
  /** Open the Host directory picker. */
  pickDirectory(signal: AbortSignal): Promise<string | null>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isSummary(value: unknown): value is PresetSummary {
  return isRecord(value)
    && typeof value['id'] === 'string'
    && typeof value['managed'] === 'boolean'
    && Array.isArray(value['inUse'])
}

function isCandidate(value: unknown): value is PromptCandidate {
  return isRecord(value) && typeof value['path'] === 'string' && typeof value['bytes'] === 'number'
}

function isToolOption(value: unknown): boolean {
  return isRecord(value)
    && typeof value['id'] === 'string'
    && typeof value['module'] === 'string'
    && typeof value['available'] === 'boolean'
}

function isFace(value: unknown): value is ToolFace {
  return isRecord(value)
    && typeof value['id'] === 'string'
    && typeof value['kind'] === 'string'
    && typeof value['name'] === 'string'
    && Array.isArray(value['tools'])
}

/**
 * Bind the page's operations to one Connection RPC caller.
 * @param rpc - the Connection handle's RPC face.
 * @returns the adapter the page renders against.
 */
export function createPresetManagerApi(rpc: Pick<ClientConnectionRpc, 'call'>): PresetManagerApi {
  async function invoke(endpoint: string, args: object, signal: AbortSignal): Promise<unknown> {
    const result = await rpc.call('/api', endpoint, { args }, signal)
    signal.throwIfAborted()
    if (!result.ok) throw new PresetManagerRemoteError(result.error.code, result.error.message)
    return result.value
  }
  return {
    async list(signal) {
      const value = await invoke('presetManager/list', {}, signal)
      if (!Array.isArray(value) || !value.every(isSummary)) {
        throw new Error('preset-manager/invalid-list-response')
      }
      return value
    },
    async listToolFaces(signal) {
      const value = await invoke('presetManager/listToolFaces', {}, signal)
      if (!isRecord(value) || !Array.isArray(value['tools']) || !value['tools'].every(isToolOption)
        || !Array.isArray(value['faces']) || !value['faces'].every(isFace)) {
        throw new Error('preset-manager/invalid-tool-faces-response')
      }
      return { tools: value['tools'] as ToolFaceCatalog['tools'], faces: value['faces'] as ToolFaceCatalog['faces'] }
    },
    async createToolFace(input, signal) {
      const value = await invoke('presetManager/createToolFace', { input }, signal)
      if (!isFace(value)) throw new Error('preset-manager/invalid-tool-face-response')
      return value
    },
    async deleteToolFace(id, signal) {
      await invoke('presetManager/deleteToolFace', { id }, signal)
    },
    async create(draft, signal) {
      const value = await invoke('presetManager/create', { draft }, signal)
      if (!isSummary(value)) throw new Error('preset-manager/invalid-create-response')
      return value
    },
    async remove(id, options, signal) {
      await invoke('presetManager/delete', options === undefined ? { id } : { id, options }, signal)
    },
    async listPromptCandidates(root, signal) {
      const value = await invoke('presetManager/listPromptCandidates', { root }, signal)
      if (!Array.isArray(value) || !value.every(isCandidate)) {
        throw new Error('preset-manager/invalid-candidates-response')
      }
      return value
    },
    async pickDirectory(signal) {
      const value = await invoke('directoryPicker/pick', {}, signal)
      if (value === null) return null
      if (typeof value !== 'string') throw new Error('preset-manager/invalid-pick-response')
      return value
    },
  }
}

/** Session-bound adapter over the existing authenticated DSH Gateway carrier. */
import type { ClientConnectionRpc } from '@deepseek-ai/dsh-client-connection/client'
import type { LatestResponse, ReadResponse, Section, SnapshotMetadata } from '../types.ts'

export const SECTIONS: readonly Section[] = ['system', 'messages', 'tools', 'raw']
export const PAGE_BYTES = 64 * 1024

export interface InspectorApi {
  latest(signal: AbortSignal): Promise<LatestResponse>
  read(request: SnapshotMetadata, section: Section, offset: number, signal: AbortSignal): Promise<ReadResponse>
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function natural(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function metadata(value: unknown, sessionId: string): value is SnapshotMetadata {
  if (!record(value) || value.sessionId !== sessionId
    || typeof value.requestId !== 'string' || value.requestId === ''
    || typeof value.recordedAt !== 'string' || typeof value.provider !== 'string' || typeof value.model !== 'string'
    || !natural(value.messageCount) || !natural(value.toolCount) || typeof value.loop !== 'boolean'
    || !record(value.sections)) return false
  return SECTIONS.every(section => {
    const item = (value.sections as Record<string, unknown>)[section]
    return record(item) && natural(item.bytes)
  })
}

/** Bind the session selected by the official Conversation slot; never infer it from location or a global. */
export function createInspectorApi(rpc: Pick<ClientConnectionRpc, 'call'>, sessionId: string): InspectorApi {
  async function invoke(method: 'latest' | 'read', request: object, signal: AbortSignal): Promise<unknown> {
    const result = await rpc.call('/api', `contextInspector/${method}`, { args: { request } }, signal)
    signal.throwIfAborted()
    if (!result.ok) throw new Error('context-inspector/request-failed')
    return result.value
  }
  return {
    async latest(signal) {
      const value = await invoke('latest', { sessionId }, signal)
      if (!record(value)
        || !(value.request === null || metadata(value.request, sessionId))
        || (value.reason !== undefined && value.reason !== 'not-recorded' && value.reason !== 'index-unavailable')) {
        throw new Error('context-inspector/invalid-response')
      }
      return value as unknown as LatestResponse
    },
    async read(request, section, offset, signal) {
      if (request.sessionId !== sessionId) throw new Error('context-inspector/session-mismatch')
      const value = await invoke('read', {
        sessionId, requestId: request.requestId, section, offset, maxBytes: PAGE_BYTES,
      }, signal)
      if (!record(value) || value.requestId !== request.requestId || value.section !== section
        || !natural(value.offset) || !natural(value.nextOffset) || !natural(value.totalBytes)
        || typeof value.text !== 'string' || typeof value.complete !== 'boolean') {
        throw new Error('context-inspector/invalid-response')
      }
      return value as unknown as ReadResponse
    },
  }
}

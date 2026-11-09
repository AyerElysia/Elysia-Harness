import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { isAgentLoopRequest, type GenerateOptions } from '@deepseek-ai/dsh-llm'
import type { ArchiveIndexEntry } from './index-store.ts'

/** The archive could not be written, so the model call must not proceed. */
export class RequestArchiveError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'RequestArchiveError'
  }
}

/** One retained model request, independent of later session projection. */
export interface ArchivedRequest {
  id: string
  recordedAt: string
  /** Whether dsh-agent-loop assembled this exact object. */
  loop: boolean
  request: {
    provider: string
    model: string
    messages: GenerateOptions['messages']
    reasoningEffort?: GenerateOptions['reasoningEffort']
    system?: string
    tools?: GenerateOptions['tools']
    toolHistory?: GenerateOptions['toolHistory']
    temperature?: number
    maxTokens?: number
    stop?: string[]
    sessionId?: string
    purpose?: GenerateOptions['purpose']
  }
}

/** Copy the request fields that reach the adapter. The abort signal is not part of the prompt. */
export function snapshotRequest(options: GenerateOptions): ArchivedRequest['request'] {
  return {
    provider: options.provider,
    model: options.model,
    messages: options.messages,
    ...options.reasoningEffort === undefined ? {} : { reasoningEffort: options.reasoningEffort },
    ...options.system === undefined ? {} : { system: options.system },
    ...options.tools === undefined ? {} : { tools: options.tools },
    ...options.toolHistory === undefined ? {} : { toolHistory: options.toolHistory },
    ...options.temperature === undefined ? {} : { temperature: options.temperature },
    ...options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens },
    ...options.stop === undefined ? {} : { stop: options.stop },
    ...options.sessionId === undefined ? {} : { sessionId: options.sessionId },
    ...options.purpose === undefined ? {} : { purpose: options.purpose },
  }
}

/**
 * Write one complete request as its own JSON file.
 * A crash during the write leaves only a `.partial` file, never a truncated final record.
 */
export function archiveRequest(
  dir: string, options: GenerateOptions, onArchived?: (entry: ArchiveIndexEntry) => void,
): string {
  const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomBytes(4).toString('hex')}`
  const record: ArchivedRequest = {
    id,
    recordedAt: new Date().toISOString(),
    loop: isAgentLoopRequest(options),
    request: snapshotRequest(options),
  }
  const finalPath = join(dir, `${id}.json`)
  const partialPath = `${finalPath}.partial`
  let serialized: string
  try {
    serialized = JSON.stringify(record, null, 2) + '\n'
    mkdirSync(dir, { recursive: true })
    writeFileSync(partialPath, serialized, { mode: 0o600 })
    renameSync(partialPath, finalPath)
  } catch (error) {
    throw new RequestArchiveError(`failed to archive the model request: ${finalPath}`, { cause: error })
  }
  if (options.sessionId !== undefined) {
    try {
      onArchived?.({
        version: 1, sessionId: options.sessionId, requestId: id, fileName: id + '.json',
        recordedAt: record.recordedAt, bytes: Buffer.byteLength(serialized),
      })
    } catch {
      // A metadata observer cannot undo a completed archive or stop its model call.
      process.stderr.write('[request-archive] metadata index notification failed\n')
    }
  }
  return finalPath
}

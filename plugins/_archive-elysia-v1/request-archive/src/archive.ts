import { chmodSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
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

/** Serialized archive layout. */
export interface ArchiveFormat {
  /** Single-line JSON. Indented JSON is opt-in because it only serves human reading. */
  compact?: boolean
}

/** One published archive file. */
export interface ArchiveWrite {
  path: string
  /** Published size in bytes, already authoritative for retention accounting. */
  bytes: number
  record: ArchivedRequest
}

/**
 * Directories whose POSIX mode this process already tightened.
 * The check is per process because mkdir's mode only governs new directories.
 */
const tightened = new Set<string>()

/**
 * Create the archive directory owner-only.
 * A pre-existing 0755 directory is tightened once per process; Windows keeps its
 * inherited ACLs because POSIX modes do not describe them.
 * @param dir - absolute archive directory.
 */
export function ensureArchiveDirectory(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  if (process.platform === 'win32' || tightened.has(dir)) return
  tightened.add(dir)
  try { chmodSync(dir, 0o700) }
  catch {
    // A filesystem without POSIX modes cannot express 0700; the directory still works.
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
 * Publish one complete request as a new immutable JSON file.
 * No earlier record is read or rewritten, so a call costs one serialization of
 * its own payload; a crash during the write leaves only a `.partial` file.
 * @param dir - archive directory; created owner-only when missing.
 * @param options - the request the adapter is about to receive.
 * @param format - archive serialization options.
 * @returns the published path, its byte size, and the record that was written.
 */
export function writeArchiveRequest(
  dir: string, options: GenerateOptions, format: ArchiveFormat = {},
): ArchiveWrite {
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
    serialized = JSON.stringify(record, null, format.compact === false ? 2 : undefined) + '\n'
    ensureArchiveDirectory(dir)
    writeFileSync(partialPath, serialized, { mode: 0o600 })
    renameSync(partialPath, finalPath)
  } catch (error) {
    throw new RequestArchiveError(`failed to archive the model request: ${finalPath}`, { cause: error })
  }
  return { path: finalPath, bytes: Buffer.byteLength(serialized), record }
}

/**
 * Publish one request and report it to the derived per-session index.
 * @param dir - archive directory; created owner-only when missing.
 * @param options - the request the adapter is about to receive.
 * @param onArchived - receives the index entry for requests that carry a sessionId.
 * @param format - archive serialization options.
 * @returns the published path and its byte size.
 */
export function archiveRequest(
  dir: string, options: GenerateOptions, onArchived?: (entry: ArchiveIndexEntry) => void,
  format: ArchiveFormat = {},
): ArchiveWrite {
  const written = writeArchiveRequest(dir, options, format)
  if (options.sessionId !== undefined) {
    try {
      onArchived?.({
        version: 1, sessionId: options.sessionId, requestId: written.record.id, fileName: written.record.id + '.json',
        recordedAt: written.record.recordedAt, bytes: written.bytes,
      })
    } catch {
      // A metadata observer cannot undo a completed archive or stop its model call.
      process.stderr.write('[request-archive] metadata index notification failed\n')
    }
  }
  return written
}

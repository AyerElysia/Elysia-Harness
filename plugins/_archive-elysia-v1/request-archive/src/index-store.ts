/** Atomic per-session metadata pointers; never scans archived request bodies. */
import { createHash, randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, opendir, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'

export const ARCHIVE_INDEX_DIRECTORY = '.session-index-v1'
export interface ArchiveIndexEntry {
  version: 1
  sessionId: string
  requestId: string
  fileName: string
  recordedAt: string
  bytes: number
}
export class ArchiveIndexError extends Error {
  constructor() { super('Request archive index is unavailable'); this.name = 'ArchiveIndexError' }
}
export type ArchiveIndexLookup =
  | { entry: ArchiveIndexEntry }
  | { entry: null; reason: 'not-recorded' | 'index-unavailable' }

export function validArchiveRequestId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,180}$/.test(value)
    && !value.includes('..')
}
export function validArchiveSessionId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096 && !value.includes('\0')
}
export function archiveIndexPath(dir: string, sessionId: string): string {
  if (!validArchiveSessionId(sessionId)) throw new ArchiveIndexError()
  return join(dir, ARCHIVE_INDEX_DIRECTORY, createHash('sha256').update(sessionId).digest('hex') + '.json')
}
function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}
function entryValue(value: unknown, sessionId: string): ArchiveIndexEntry {
  if (typeof value !== 'object' || value === null) throw new ArchiveIndexError()
  const entry = value as Partial<ArchiveIndexEntry>
  if (entry.version !== 1 || entry.sessionId !== sessionId
    || !validArchiveRequestId(entry.requestId) || entry.fileName !== entry.requestId + '.json'
    || typeof entry.recordedAt !== 'string' || !Number.isFinite(Date.parse(entry.recordedAt))
    || typeof entry.bytes !== 'number' || !Number.isSafeInteger(entry.bytes) || entry.bytes < 1) {
    throw new ArchiveIndexError()
  }
  return entry as ArchiveIndexEntry
}
async function readEntry(path: string, sessionId: string): Promise<ArchiveIndexEntry> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.size < 1 || stat.size > 8192) throw new ArchiveIndexError()
    const bytes = Buffer.alloc(stat.size + 1)
    let used = 0
    while (used < bytes.length) {
      const read = await file.read(bytes, used, bytes.length - used, used)
      if (read.bytesRead === 0) break
      used += read.bytesRead
    }
    if (used !== stat.size) throw new ArchiveIndexError()
    let value: unknown
    try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, used))) }
    catch { throw new ArchiveIndexError() }
    return entryValue(value, sessionId)
  } finally { await file.close() }
}

export class RequestArchiveIndex {
  private readonly writes = new Map<string, Promise<void>>()
  constructor(readonly dir: string) {}

  async latest(sessionId: string): Promise<ArchiveIndexLookup> {
    const path = archiveIndexPath(this.dir, sessionId)
    try {
      const directory = await lstat(join(this.dir, ARCHIVE_INDEX_DIRECTORY))
      if (!directory.isDirectory() || directory.isSymbolicLink()) throw new ArchiveIndexError()
      return { entry: await readEntry(path, sessionId) }
    }
    catch (error) {
      if (!isMissing(error)) throw new ArchiveIndexError()
      let directory
      try { directory = await opendir(this.dir) }
      catch (missing) {
        if (isMissing(missing)) return { entry: null, reason: 'not-recorded' }
        throw new ArchiveIndexError()
      }
      let count = 0
      for await (const item of directory) {
        if (item.name.endsWith('.json') || ++count >= 64) {
          return { entry: null, reason: 'index-unavailable' }
        }
      }
      return { entry: null, reason: 'not-recorded' }
    }
  }

  record(entry: ArchiveIndexEntry, options: { repair?: boolean } = {}): Promise<void> {
    const validated = entryValue(entry, entry.sessionId)
    const path = archiveIndexPath(this.dir, validated.sessionId)
    const previous = this.writes.get(path) ?? Promise.resolve()
    const write = previous.catch(() => {}).then(async () => {
      const directory = join(this.dir, ARCHIVE_INDEX_DIRECTORY)
      await mkdir(directory, { recursive: true, mode: 0o700 })
      const indexDirectory = await lstat(directory)
      if (!indexDirectory.isDirectory() || indexDirectory.isSymbolicLink()) throw new ArchiveIndexError()
      try {
        const current = await readEntry(path, validated.sessionId)
        if (Date.parse(current.recordedAt) > Date.parse(validated.recordedAt)) return
      } catch (error) {
        if (!isMissing(error) && options.repair !== true) throw new ArchiveIndexError()
      }
      const temporary = path + '.' + randomBytes(6).toString('hex') + '.partial'
      try {
        const file = await open(temporary, 'wx', 0o600)
        try { await file.writeFile(JSON.stringify(validated) + '\n') }
        finally { await file.close() }
        await rename(temporary, path)
      } finally {
        try { await unlink(temporary) }
        catch (error) { if (!isMissing(error)) throw new ArchiveIndexError() }
      }
    })
    this.writes.set(path, write)
    void write.finally(() => { if (this.writes.get(path) === write) this.writes.delete(path) }).catch(() => {})
    return write
  }

  async flush(): Promise<void> { await Promise.allSettled([...this.writes.values()]) }
}

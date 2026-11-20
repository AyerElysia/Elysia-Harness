/**
 * Bounded retention for the immutable request archive: the oldest records leave first.
 * The writer never waits for a directory scan. Each write only adds to an estimate; a
 * scan runs once that estimate passes a headroom above the configured limit, so the
 * scan cost is amortized across the writes that filled the headroom.
 * @module @elysia/request-archive/retention
 */
import { lstat, opendir, readFile, readdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { ARCHIVE_INDEX_DIRECTORY, validArchiveRequestId } from './index-store.ts'

/** Retention bounds; 0 disables one bound. */
export interface RetentionLimits {
  /** Archived files kept before the oldest leave. */
  maxFiles: number
  /** Total archived bytes kept before the oldest leave. */
  maxBytes: number
  /** Age in days after which a record leaves even inside the other bounds. */
  maxAgeDays: number
}

/** Files kept when the deployment does not configure a count bound. */
export const DEFAULT_MAX_FILES = 5000
/** Bytes kept when the deployment does not configure a byte bound. */
export const DEFAULT_MAX_BYTES = 512 * 1024 * 1024
/** Days a record survives when the deployment does not configure an age bound. */
export const DEFAULT_MAX_AGE_DAYS = 30

/** What one retention pass removed and left behind. */
export interface RetentionReport {
  /** File names removed from the archive directory. */
  removed: string[]
  keptFiles: number
  keptBytes: number
  removedBytes: number
}

const ARCHIVE_SUFFIX = '.json'
/**
 * A scan is only worth its directory walk once the count or byte budget grew by this
 * share, or once possible age expiry needs a fresh look.
 */
const HEADROOM_RATIO = 0.05
const AGE_RESCAN_MS = 60 * 60 * 1000
/** A per-session pointer larger than this is not one this module wrote. */
const POINTER_LIMIT = 8192

interface Entry {
  name: string
  bytes: number
  recordedAt: number
}

function emptyReport(): RetentionReport {
  return { removed: [], keptFiles: 0, keptBytes: 0, removedBytes: 0 }
}

function bound(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}

function headroom(limit: number): number {
  return Math.max(1, Math.ceil(limit * HEADROOM_RATIO))
}

/** Archive ids start with their record time, so a name alone orders records without a read. */
function recordedAt(name: string, fallback: number): number {
  if (name.length < 23 || name[10] !== 'T') return fallback
  const parsed = Date.parse(
    `${name.slice(0, 10)}T${name.slice(11, 13)}:${name.slice(14, 16)}:${name.slice(17, 19)}.${name.slice(20, 23)}Z`,
  )
  return Number.isFinite(parsed) ? parsed : fallback
}

/**
 * Enforces the archive bounds without delaying the writer.
 * Eviction order is record time, oldest first; a per-session pointer whose record
 * left the archive is dropped so a reader reports an unavailable index instead of
 * following the pointer to a deleted file.
 */
export class ArchiveRetention {
  private readonly maxFiles: number
  private readonly maxBytes: number
  private readonly maxAgeMs: number
  private readonly fileHeadroom: number
  private readonly byteHeadroom: number
  /** Counted records, or null until the first scan knows the directory. */
  private files: number | null = null
  /** Counted bytes, or null until the first scan knows the directory. */
  private bytes: number | null = null
  private scannedAt = 0
  private pending: Promise<RetentionReport> | null = null
  /** Whether a write arrived while a scan was running and needs the next scan. */
  private dirty = false
  private closed = false

  /**
   * @param dir - archive directory; a missing directory retains nothing.
   * @param limits - plugin configuration; a non-positive bound is disabled.
   * @param clock - current epoch milliseconds, injectable for tests.
   */
  constructor(
    readonly dir: string, limits: RetentionLimits, private readonly clock: () => number = Date.now,
  ) {
    this.maxFiles = bound(limits.maxFiles)
    this.maxBytes = bound(limits.maxBytes)
    this.maxAgeMs = bound(limits.maxAgeDays) * 24 * 60 * 60 * 1000
    this.fileHeadroom = headroom(this.maxFiles)
    this.byteHeadroom = headroom(this.maxBytes)
  }

  /**
   * Count one published record and schedule a pass only when the budget is over.
   * Synchronous by contract: retention never delays the model call.
   * @param bytes - published size of the new record.
   */
  afterWrite(bytes: number): void {
    if (this.closed) return
    if (this.files !== null) this.files += 1
    if (this.bytes !== null) this.bytes += Math.max(0, Math.floor(bytes))
    if (this.overLimit()) this.schedule()
  }

  /**
   * Scan once and remove every record outside the bounds.
   * A concurrent call joins the in-flight scan; writes that arrive meanwhile are
   * folded into the following scan.
   * @returns what this pass removed and kept.
   */
  prune(): Promise<RetentionReport> {
    if (this.closed) return Promise.resolve(emptyReport())
    if (this.pending === null) this.start()
    return this.pending ?? Promise.resolve(emptyReport())
  }

  /**
   * Wait until no scan is queued or running, including one folded in by a write
   * that arrived mid-scan.
   * @returns a promise that settles after the last pass.
   */
  async flush(): Promise<void> {
    while (this.pending !== null || (this.dirty && !this.closed)) {
      if (this.pending !== null) await this.pending.catch(() => {})
      else if (this.dirty) { this.dirty = false; this.start() }
    }
  }

  /**
   * Finish the work already scheduled, then stop counting writes.
   * @returns a promise that settles after teardown.
   */
  async dispose(): Promise<void> {
    await this.flush()
    this.closed = true
  }

  private overLimit(): boolean {
    if (this.files === null || this.bytes === null) return true
    if (this.maxFiles > 0 && this.files > this.maxFiles + this.fileHeadroom) return true
    if (this.maxBytes > 0 && this.bytes > this.maxBytes + this.byteHeadroom) return true
    return this.maxAgeMs > 0 && this.clock() - this.scannedAt >= AGE_RESCAN_MS
  }

  private schedule(): void {
    if (this.closed) return
    if (this.pending !== null) { this.dirty = true; return }
    this.start()
  }

  private start(): void {
    const run = this.scan()
    this.pending = run
    void run.then(() => {
      if (this.pending === run) this.pending = null
      if (this.dirty && !this.closed) { this.dirty = false; this.start() }
    }).catch(() => {
      if (this.pending === run) this.pending = null
      this.dirty = false
    })
  }

  private async scan(): Promise<RetentionReport> {
    const now = this.clock()
    const entries = await this.inventory()
    entries.sort((left, right) => left.recordedAt - right.recordedAt || left.name.localeCompare(right.name))
    const cutoff = this.maxAgeMs > 0 ? now - this.maxAgeMs : Number.NEGATIVE_INFINITY
    let files = entries.length
    let bytes = entries.reduce((total, entry) => total + entry.bytes, 0)
    let next = 0
    const removed: Entry[] = []
    const evict = (): void => {
      const entry = entries[next]!
      next += 1
      files -= 1
      bytes -= entry.bytes
      removed.push(entry)
    }
    while (next < entries.length && entries[next]!.recordedAt < cutoff) evict()
    while (next < entries.length && this.maxFiles > 0 && files > this.maxFiles) evict()
    while (next < entries.length && this.maxBytes > 0 && bytes > this.maxBytes) evict()
    let removedBytes = 0
    for (const entry of removed) {
      removedBytes += entry.bytes
      try { await unlink(join(this.dir, entry.name)) }
      catch {
        // A record already gone leaves the archive in the intended state.
      }
    }
    if (removed.length > 0) {
      await this.dropPointers(new Set(removed.map(entry => entry.name.slice(0, -ARCHIVE_SUFFIX.length))))
    }
    this.files = files
    this.bytes = bytes
    this.scannedAt = now
    return { removed: removed.map(entry => entry.name), keptFiles: files, keptBytes: bytes, removedBytes }
  }

  private async inventory(): Promise<Entry[]> {
    const entries: Entry[] = []
    let directory
    try { directory = await opendir(this.dir) }
    catch {
      // A missing archive directory holds nothing to retain.
      return entries
    }
    for await (const item of directory) {
      if (!item.isFile() || !item.name.endsWith(ARCHIVE_SUFFIX)) continue
      if (!validArchiveRequestId(item.name.slice(0, -ARCHIVE_SUFFIX.length))) continue
      let stats
      try { stats = await lstat(join(this.dir, item.name)) }
      catch { continue }
      if (!stats.isFile()) continue
      entries.push({ name: item.name, bytes: stats.size, recordedAt: recordedAt(item.name, stats.mtimeMs) })
    }
    return entries
  }

  private async dropPointers(requestIds: Set<string>): Promise<void> {
    const directory = join(this.dir, ARCHIVE_INDEX_DIRECTORY)
    let items
    try {
      // A symlinked pointer directory belongs to someone else; a reader already refuses it.
      const stats = await lstat(directory)
      if (!stats.isDirectory() || stats.isSymbolicLink()) return
      items = await readdir(directory, { withFileTypes: true })
    }
    catch {
      // No derived index yet means no pointer references the removed records.
      return
    }
    for (const item of items) {
      if (!item.isFile() || !item.name.endsWith(ARCHIVE_SUFFIX)) continue
      const path = join(directory, item.name)
      let requestId: unknown
      try {
        const stats = await lstat(path)
        if (!stats.isFile() || stats.size < 1 || stats.size > POINTER_LIMIT) continue
        const pointer = JSON.parse(await readFile(path, 'utf8')) as { requestId?: unknown }
        requestId = pointer.requestId
      } catch { continue }
      if (typeof requestId !== 'string' || !requestIds.has(requestId)) continue
      try { await unlink(path) }
      catch {
        // A pointer already gone cannot mislead a reader.
      }
    }
  }
}

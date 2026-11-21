/** Indexed, session-isolated snapshot reads with off-thread JSON work and a bounded LRU. */
import { Worker } from 'node:worker_threads'
import {
  ArchiveIndexError, RequestArchiveIndex, validArchiveRequestId, validArchiveSessionId,
} from '@elysia/request-archive/index-store'
import type { LatestResponse, ReadRequest, ReadResponse, Section, SnapshotMetadata } from '../types.ts'
import { InspectionError, type InspectionErrorCode } from './errors.ts'
import { WORKER_PROGRAM } from './worker-program.ts'

const SECTIONS: readonly Section[] = ['system', 'messages', 'tools', 'raw']
export interface ReaderLimits {
  maxArchiveBytes: number
  maxCacheBytes: number
  maxWorkers: number
  maxChunkBytes: number
  workerTimeoutMs?: number
}
interface Snapshot {
  metadata: SnapshotMetadata
  sections: Record<Section, Buffer>
  bytes: number
}
interface Job {
  promise: Promise<Snapshot>
  readers: number
  settled: boolean
  cancel(): void
}
type WorkerResult =
  | { ok: true; metadata: SnapshotMetadata; sections: Record<Section, ArrayBuffer> }
  | { ok: false; code: InspectionErrorCode }

export class SnapshotReader {
  private readonly index: RequestArchiveIndex
  private readonly cache = new Map<string, Snapshot>()
  private readonly jobs = new Map<string, Job>()
  private readonly workers = new Set<Worker>()
  private readonly terminations = new Set<Promise<number>>()
  private cachedBytes = 0
  private closed = false

  constructor(readonly dir: string, readonly limits: ReaderLimits) {
    if (!Number.isSafeInteger(limits.maxArchiveBytes) || limits.maxArchiveBytes < 1
      || !Number.isSafeInteger(limits.maxCacheBytes) || limits.maxCacheBytes < limits.maxArchiveBytes
      || !Number.isSafeInteger(limits.maxWorkers) || limits.maxWorkers < 1 || limits.maxWorkers > 4
      || (limits.workerTimeoutMs !== undefined && (!Number.isSafeInteger(limits.workerTimeoutMs) || limits.workerTimeoutMs < 1 || limits.workerTimeoutMs > 60000))
      || !Number.isSafeInteger(limits.maxChunkBytes) || limits.maxChunkBytes < 4 || limits.maxChunkBytes > 65536) {
      throw new InspectionError('invalid-request')
    }
    this.index = new RequestArchiveIndex(dir)
  }

  async latest(sessionId: string, signal: AbortSignal): Promise<LatestResponse> {
    this.check(sessionId, signal)
    let pointer
    try { pointer = await this.index.latest(sessionId) }
    catch (error) {
      this.check(sessionId, signal)
      if (error instanceof ArchiveIndexError) return { request: null, reason: 'index-unavailable' }
      throw new InspectionError('index-unavailable')
    }
    this.check(sessionId, signal)
    if (pointer.entry === null) return { request: null, reason: pointer.reason }
    const snapshot = await this.load(sessionId, pointer.entry.requestId, signal)
    this.check(sessionId, signal)
    if (snapshot.metadata.recordedAt !== pointer.entry.recordedAt
      || snapshot.metadata.sections.raw.bytes !== pointer.entry.bytes) {
      throw new InspectionError('archive-invalid')
    }
    return { request: structuredClone(snapshot.metadata) }
  }

  async read(request: ReadRequest, signal: AbortSignal): Promise<ReadResponse> {
    this.check(request?.sessionId, signal)
    if (!validArchiveRequestId(request.requestId) || !SECTIONS.includes(request.section)
      || !Number.isSafeInteger(request.offset) || request.offset < 0
      || (request.maxBytes !== undefined && (!Number.isSafeInteger(request.maxBytes)
        || request.maxBytes < 4 || request.maxBytes > this.limits.maxChunkBytes))) {
      throw new InspectionError('invalid-request')
    }
    const snapshot = await this.load(request.sessionId, request.requestId, signal)
    this.check(request.sessionId, signal)
    const bytes = snapshot.sections[request.section]
    const offset = request.offset
    if (offset > bytes.length || (offset < bytes.length && (bytes[offset]! & 0xc0) === 0x80)) {
      throw new InspectionError('invalid-request')
    }
    let end = Math.min(bytes.length, offset + (request.maxBytes ?? this.limits.maxChunkBytes))
    while (end < bytes.length && end > offset && (bytes[end]! & 0xc0) === 0x80) end--
    return {
      requestId: request.requestId, section: request.section, offset, nextOffset: end,
      totalBytes: bytes.length, text: bytes.subarray(offset, end).toString('utf8'),
      complete: end === bytes.length,
    }
  }

  /** Explicit maintenance seed of one already-known file; never discovers archive bodies. */
  async seed(sessionId: string, requestId: string, signal: AbortSignal): Promise<SnapshotMetadata> {
    this.check(sessionId, signal)
    if (!validArchiveRequestId(requestId)) throw new InspectionError('invalid-request')
    const snapshot = await this.load(sessionId, requestId, signal)
    await this.index.record({
      version: 1, sessionId, requestId, fileName: requestId + '.json',
      recordedAt: snapshot.metadata.recordedAt, bytes: snapshot.metadata.sections.raw.bytes,
    }, { repair: true })
    this.check(sessionId, signal)
    return structuredClone(snapshot.metadata)
  }

  async dispose(): Promise<void> {
    if (this.closed) return
    this.closed = true
    for (const job of [...this.jobs.values()]) job.cancel()
    this.cache.clear()
    this.cachedBytes = 0
    await Promise.allSettled([...this.terminations])
    await this.index.flush()
  }

  private check(sessionId: unknown, signal: AbortSignal): asserts sessionId is string {
    if (this.closed) throw new InspectionError('disposed')
    if (signal.aborted) throw new InspectionError('cancelled')
    if (!validArchiveSessionId(sessionId)) throw new InspectionError('invalid-request')
  }

  private async load(sessionId: string, requestId: string, signal: AbortSignal): Promise<Snapshot> {
    this.check(sessionId, signal)
    const key = sessionId + '\0' + requestId
    const cached = this.cache.get(key)
    if (cached !== undefined) {
      this.cache.delete(key)
      this.cache.set(key, cached)
      return cached
    }
    const job = this.jobs.get(key) ?? this.startJob(key, sessionId, requestId)
    job.readers++
    try {
      return await new Promise<Snapshot>((resolve, reject) => {
        const abort = (): void => { reject(new InspectionError('cancelled')) }
        signal.addEventListener('abort', abort, { once: true })
        void job.promise.then(resolve, reject).finally(() => { signal.removeEventListener('abort', abort) })
        if (signal.aborted) abort()
      })
    } finally {
      job.readers--
      if (job.readers === 0 && !job.settled) job.cancel()
    }
  }

  private startJob(key: string, sessionId: string, requestId: string): Job {
    if (this.workers.size >= this.limits.maxWorkers) throw new InspectionError('busy')
    const worker = new Worker(WORKER_PROGRAM, {
      eval: true,
      // The pure-JS CommonJS worker owns its runtime; never inherit host TS/preflight flags.
      execArgv: [],
      workerData: { dir: this.dir, requestId, sessionId, maxArchiveBytes: this.limits.maxArchiveBytes },
      resourceLimits: { maxOldGenerationSizeMb: 128 },
    })
    this.workers.add(worker)
    const pending = Promise.withResolvers<Snapshot>()
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (error?: InspectionError, snapshot?: Snapshot): void => {
      if (job.settled) return
      job.settled = true
      if (timer !== undefined) clearTimeout(timer)
      this.jobs.delete(key)
      worker.removeAllListeners()
      const termination = worker.terminate()
      this.terminations.add(termination)
      void termination.finally(() => {
        this.workers.delete(worker)
        this.terminations.delete(termination)
      }).catch(() => {})
      if (error !== undefined) pending.reject(error)
      else if (snapshot !== undefined) pending.resolve(snapshot)
    }
    const job: Job = {
      promise: pending.promise, readers: 0, settled: false,
      cancel: () => { finish(new InspectionError(this.closed ? 'disposed' : 'cancelled')) },
    }
    void job.promise.catch(() => {})
    this.jobs.set(key, job)
    timer = setTimeout(() => { finish(new InspectionError('archive-unavailable')) }, this.limits.workerTimeoutMs ?? 10000)
    timer.unref()
    worker.once('message', (result: WorkerResult) => {
      if (!result.ok) { finish(new InspectionError(result.code)); return }
      try {
        if (result.metadata.sessionId !== sessionId || result.metadata.requestId !== requestId) {
          throw new InspectionError('archive-invalid')
        }
        const sections = {} as Record<Section, Buffer>
        let total = 0
        for (const section of SECTIONS) {
          const value = result.sections[section]
          if (!(value instanceof ArrayBuffer) || value.byteLength !== result.metadata.sections[section].bytes) {
            throw new InspectionError('archive-invalid')
          }
          sections[section] = Buffer.from(value)
          total += value.byteLength
        }
        if (total > this.limits.maxCacheBytes) throw new InspectionError('archive-too-large')
        while (this.cache.size >= 2 || this.cachedBytes + total > this.limits.maxCacheBytes) {
          const oldest = this.cache.keys().next().value
          if (oldest === undefined) break
          this.cachedBytes -= this.cache.get(oldest)!.bytes
          this.cache.delete(oldest)
        }
        const snapshot: Snapshot = { metadata: result.metadata, sections, bytes: total }
        this.cache.set(key, snapshot)
        this.cachedBytes += total
        finish(undefined, snapshot)
      } catch (error) {
        finish(error instanceof InspectionError ? error : new InspectionError('archive-invalid'))
      }
    })
    worker.once('error', () => { finish(new InspectionError('archive-invalid')) })
    worker.once('exit', () => { finish(new InspectionError('archive-unavailable')) })
    return job
  }
}

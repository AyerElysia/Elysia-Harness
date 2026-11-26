/**
 * The session-scoped state document of the context gate: subscriptions,
 * queues, and the event log. It is separate from any other plugin's state and
 * never reads Helix documents.
 *
 * Every mutation rewrites the whole document through a temporary file and one
 * rename, so a reader never observes a partial write. Mutations are serialized
 * because a publication and a step injection can interleave on the event loop.
 *
 * Unknown document fields are ignored on read: a document written by a later
 * build that adds fields remains readable, and the next write drops nothing the
 * current build does not know about.
 *
 * @module @elysia/context-gate/state
 */

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import type {
  ContextEvent, EventLogEntry, EventOutcome, GateDocument, QueueRecord, SessionRecord,
} from './types.ts'
import { ContextGateError, describeError } from './errors.ts'

/** File name of the gate document inside the configured state directory. */
export const DOCUMENT_FILE_NAME = 'context-gate-state.json'

/** Document generation this build writes and reads. */
export const DOCUMENT_VERSION = 1

/** Retained event-log rows per session. */
export const EVENT_LOG_LIMIT = 50

/** Retained consumed ids and dedupe keys per session. */
export const QUEUE_HISTORY_LIMIT = 64

/** A session with no stored state. */
const EMPTY_SESSION: SessionRecord = { contexts: {}, events: [] }

/** A session with no queued events. */
const EMPTY_QUEUE: QueueRecord = { events: [], consumed: [], dedupe: {} }

/** A fresh, never-written document. */
function emptyDocument(): GateDocument {
  return { version: DOCUMENT_VERSION, sessions: {}, queues: {}, updatedAt: new Date(0).toISOString() }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isMissingFile(error: unknown): boolean {
  return isRecord(error) && error['code'] === 'ENOENT'
}

function invalid(file: string, message: string): ContextGateError {
  return new ContextGateError('STATE_INVALID', `context-gate cannot use ${file}: ${message}`, { path: file })
}

function stringArray(value: unknown, label: string, file: string): string[] {
  if (!Array.isArray(value) || value.some(entry => typeof entry !== 'string')) {
    throw invalid(file, `${label} must be a string array`)
  }
  return [...value]
}

function booleanRecord(value: unknown, label: string, file: string): Record<string, boolean> {
  if (!isRecord(value) || Object.values(value).some(entry => typeof entry !== 'boolean')) {
    throw invalid(file, `${label} must be a boolean record`)
  }
  return { ...value } as Record<string, boolean>
}

function requiredString(value: unknown, label: string, file: string): string {
  if (typeof value !== 'string') throw invalid(file, `${label} must be a string`)
  return value
}

function parseEvent(value: unknown, label: string, file: string): ContextEvent {
  if (!isRecord(value)) throw invalid(file, `${label} is not an object`)
  const visibility = value['visibility']
  if (!isRecord(visibility)) throw invalid(file, `${label}.visibility must be an object`)
  const sessionIds = visibility['sessionIds']
  return {
    id: requiredString(value['id'], `${label}.id`, file),
    kind: requiredString(value['kind'], `${label}.kind`, file),
    source: requiredString(value['source'], `${label}.source`, file),
    summary: requiredString(value['summary'], `${label}.summary`, file),
    payload: value['payload'],
    visibility: sessionIds === undefined ? {} : { sessionIds: stringArray(sessionIds, `${label}.visibility.sessionIds`, file) },
    active: value['active'] === true,
    dedupeKey: typeof value['dedupeKey'] === 'string' ? value['dedupeKey'] : '',
    ...(typeof value['ttlMs'] === 'number' ? { ttlMs: value['ttlMs'] } : {}),
    ...(typeof value['maxBytes'] === 'number' ? { maxBytes: value['maxBytes'] } : {}),
    createdAt: typeof value['createdAt'] === 'number' ? value['createdAt'] : 0,
  }
}

function parseLogEntry(value: unknown, label: string, file: string): EventLogEntry {
  if (!isRecord(value)) throw invalid(file, `${label} is not an object`)
  const outcome = value['outcome']
  const outcomes: readonly EventOutcome[] = ['published', 'delivered', 'consumed', 'failed', 'dropped']
  if (typeof value['id'] !== 'string' || typeof value['kind'] !== 'string'
    || !outcomes.includes(outcome as EventOutcome) || typeof value['at'] !== 'number') {
    throw invalid(file, `${label} is not an event-log row`)
  }
  return {
    id: value['id'],
    kind: value['kind'],
    outcome: outcome as EventOutcome,
    at: value['at'],
    ...(typeof value['detail'] === 'string' ? { detail: value['detail'] } : {}),
  }
}

function parseSession(value: unknown, label: string, file: string): SessionRecord {
  if (!isRecord(value)) throw invalid(file, `${label} is not an object`)
  return {
    contexts: value['contexts'] === undefined ? {} : booleanRecord(value['contexts'], `${label}.contexts`, file),
    events: Array.isArray(value['events'])
      ? value['events'].map((entry, index) => parseLogEntry(entry, `${label}.events[${String(index)}]`, file))
      : [],
  }
}

function parseQueue(value: unknown, label: string, file: string): QueueRecord {
  if (!isRecord(value)) throw invalid(file, `${label} is not an object`)
  const events = value['events']
  if (!Array.isArray(events)) throw invalid(file, `${label}.events must be an array`)
  const dedupe = value['dedupe']
  if (dedupe !== undefined && (!isRecord(dedupe) || Object.values(dedupe).some(entry => typeof entry !== 'number'))) {
    throw invalid(file, `${label}.dedupe must be a number record`)
  }
  return {
    events: events.map((entry, index) => parseEvent(entry, `${label}.events[${String(index)}]`, file)),
    consumed: value['consumed'] === undefined ? [] : stringArray(value['consumed'], `${label}.consumed`, file),
    dedupe: dedupe === undefined ? {} : { ...dedupe } as Record<string, number>,
  }
}

function parseDocument(value: unknown, file: string): GateDocument {
  if (!isRecord(value)) throw invalid(file, 'the document is not an object')
  if (value['version'] !== DOCUMENT_VERSION) throw invalid(file, `unsupported document version ${String(value['version'])}`)
  const sessions: Record<string, SessionRecord> = {}
  const sessionSection = value['sessions']
  if (sessionSection !== undefined) {
    if (!isRecord(sessionSection)) throw invalid(file, '"sessions" must be an object')
    for (const [id, entry] of Object.entries(sessionSection)) sessions[id] = parseSession(entry, `sessions.${id}`, file)
  }
  const queues: Record<string, QueueRecord> = {}
  const queueSection = value['queues']
  if (queueSection !== undefined) {
    if (!isRecord(queueSection)) throw invalid(file, '"queues" must be an object')
    for (const [id, entry] of Object.entries(queueSection)) queues[id] = parseQueue(entry, `queues.${id}`, file)
  }
  return {
    version: DOCUMENT_VERSION,
    sessions,
    queues,
    updatedAt: typeof value['updatedAt'] === 'string' ? value['updatedAt'] : new Date(0).toISOString(),
  }
}

/** Persisted per-session subscriptions, queues, and event log. */
export class ContextGateStore {
  private document: GateDocument
  private writing: Promise<void> = Promise.resolve()
  private readonly file: string

  private constructor(file: string, document: GateDocument) {
    this.file = file
    this.document = document
  }

  /**
   * Open (or create) the document in one state directory.
   * @param stateDir - absolute directory holding the document.
   * @returns the opened store.
   * @throws ContextGateError `STATE_INVALID` when the directory is relative or the document is unreadable.
   */
  static async open(stateDir: string): Promise<ContextGateStore> {
    if (!isAbsolute(stateDir)) {
      throw new ContextGateError('STATE_INVALID', `context-gate stateDir must be absolute, got ${JSON.stringify(stateDir)}`, {
        path: stateDir, reason: 'not-absolute',
      })
    }
    try {
      await mkdir(stateDir, { recursive: true })
    } catch (error: unknown) {
      throw new ContextGateError('STATE_INVALID', `context-gate cannot create ${stateDir}: ${describeError(error)}`, {
        path: stateDir, reason: 'mkdir',
      })
    }
    const file = join(stateDir, DOCUMENT_FILE_NAME)
    let raw: string | undefined
    try {
      raw = await readFile(file, 'utf8')
    } catch (error: unknown) {
      if (!isMissingFile(error)) {
        throw new ContextGateError('STATE_INVALID', `context-gate cannot read ${file}: ${describeError(error)}`, {
          path: file, reason: 'unreadable',
        })
      }
    }
    if (raw === undefined) return new ContextGateStore(file, emptyDocument())
    let parsed: unknown
    try {
      parsed = JSON.parse(raw) as unknown
    } catch (error: unknown) {
      throw invalid(file, `not valid JSON: ${describeError(error)}`)
    }
    return new ContextGateStore(file, parseDocument(parsed, file))
  }

  /** ISO timestamp of the last committed write. */
  get updatedAt(): string {
    return this.document.updatedAt
  }

  /** Every session id the document knows. */
  sessionIds(): readonly string[] {
    return Object.keys(this.document.sessions)
  }

  /** One session's gate state; an unknown session reads as empty. */
  session(sessionId: string): SessionRecord {
    return this.document.sessions[sessionId] ?? EMPTY_SESSION
  }

  /** Context subscriptions of one session; a missing kind means off. */
  contexts(sessionId: string): Readonly<Record<string, boolean>> {
    return this.session(sessionId).contexts
  }

  /**
   * Subscribe or unsubscribe one context kind for one session.
   * @param sessionId - target session.
   * @param kind - registered kind.
   * @param enabled - false unsubscribes it.
   * @returns after the document is durable.
   */
  async setContext(sessionId: string, kind: string, enabled: boolean): Promise<void> {
    const current = this.session(sessionId)
    await this.commit({
      ...this.document,
      sessions: {
        ...this.document.sessions,
        [sessionId]: { ...current, contexts: { ...current.contexts, [kind]: enabled } },
      },
    })
  }

  /**
   * Append one event-log row for one session, newest first.
   * @param sessionId - target session.
   * @param entry - the row.
   * @returns after the document is durable.
   */
  async logEvent(sessionId: string, entry: EventLogEntry): Promise<void> {
    const current = this.session(sessionId)
    await this.commit({
      ...this.document,
      sessions: {
        ...this.document.sessions,
        [sessionId]: { ...current, events: [entry, ...current.events].slice(0, EVENT_LOG_LIMIT) },
      },
    })
  }

  /** One session's recent event-log rows, newest first. */
  events(sessionId: string): readonly EventLogEntry[] {
    return this.session(sessionId).events
  }

  /** The queue of one session. */
  queue(sessionId: string): QueueRecord {
    return this.document.queues[sessionId] ?? EMPTY_QUEUE
  }

  /**
   * Replace one session's queue.
   * @param sessionId - target session.
   * @param mutate - receives the current queue and returns the next one.
   * @returns after the document is durable.
   */
  async mutateQueue(sessionId: string, mutate: (queue: QueueRecord) => QueueRecord): Promise<void> {
    const current = this.queue(sessionId)
    const next = mutate(current)
    if (next === current) return
    await this.commit({ ...this.document, queues: { ...this.document.queues, [sessionId]: next } })
  }

  /**
   * Serialize and persist one document generation.
   * @param next - the next document.
   * @returns after the rename settles.
   */
  private async commit(next: GateDocument): Promise<void> {
    const document: GateDocument = { ...next, updatedAt: new Date().toISOString() }
    const write = this.writing.then(async () => {
      const temporary = `${this.file}.${String(process.pid)}.${randomUUID()}.tmp`
      try {
        await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, 'utf8')
        await rename(temporary, this.file)
      } catch (error: unknown) {
        throw new ContextGateError('STATE_WRITE_FAILED', `context-gate cannot write ${this.file}: ${describeError(error)}`, {
          path: this.file, reason: 'write',
        })
      }
      this.document = document
    })
    this.writing = write.then(() => undefined, () => undefined)
    await write
  }
}
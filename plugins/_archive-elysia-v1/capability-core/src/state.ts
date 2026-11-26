/**
 * The panel's persisted document: per-preset and per-session switches, the
 * session-to-preset mapping observed at runtime, and every undelivered context
 * event with its per-session consumption cursor.
 *
 * The panel is the only writer of switch state; the Host validates, merges, and
 * writes. Each mutation rewrites the whole document through a temporary file and
 * one rename, so a reader never observes a partial write. Queues are persisted
 * with the switches because an idle session must not lose events across a
 * restart.
 *
 * @module @elysia/capability-core/state
 */

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import type { ContextEvent, ScopeOverrides, ScopeRef, SwitchOrigin } from './types.ts'
import { CapabilityHostError, describeError } from './errors.ts'

/** File name of the panel document inside the configured state directory. */
export const DOCUMENT_FILE_NAME = 'capability-state.json'

/** Document generation this build writes and reads. */
export const DOCUMENT_VERSION = 1

/** One scope's explicit switches. An absent key inherits the parent layer. */
export interface ScopeStateRecord {
  /** Tool id to explicit on/off. */
  readonly tools?: Readonly<Record<string, boolean>>
  /** Context kind to explicit subscription on/off. */
  readonly contexts?: Readonly<Record<string, boolean>>
}

/** One session's undelivered events and consumption cursor. */
export interface QueueRecord {
  /** Undelivered events in enqueue order. */
  readonly events: readonly ContextEvent[]
  /** Recently consumed event ids, oldest first. */
  readonly consumed: readonly string[]
  /** `dedupeKey` to the time it was last accepted, for repeat suppression. */
  readonly dedupe: Readonly<Record<string, number>>
}

/** One saved dynamic-tool selection. */
export interface ToolPresetRecord {
  /** Stable id minted by the Host. */
  readonly id: string
  /** Operator-provided display name. */
  readonly name: string
  /** Dynamic tool ids the preset switches on. */
  readonly tools: readonly string[]
  /** Creation time in milliseconds since the epoch. */
  readonly createdAt: number
}

/** The whole persisted document. */
export interface CapabilityDocument {
  /** Document generation. */
  readonly version: typeof DOCUMENT_VERSION
  /** Deployment-wide switches for global catalog tools. */
  readonly global: ScopeStateRecord
  /** Switches per preset id. Static tools are never stored. */
  readonly presets: Readonly<Record<string, ScopeStateRecord>>
  /** Switches and queues per session id. */
  readonly sessions: Readonly<Record<string, ScopeStateRecord>>
  /** Session id to the preset it runs, observed while live. */
  readonly sessionPresets: Readonly<Record<string, string>>
  /** Undelivered context events per session id. */
  readonly queues: Readonly<Record<string, QueueRecord>>
  /** Saved dynamic-tool selections, in creation order. */
  readonly toolPresets: readonly ToolPresetRecord[]
  /** ISO timestamp of the last committed write. */
  readonly updatedAt: string
}

/** The switch dimension one operation addresses. */
export type SwitchDimension = 'tools' | 'contexts'

/** Upper bound on retained consumed ids and dedupe keys per session. */
export const QUEUE_HISTORY_LIMIT = 128

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function invalid(file: string, reason: string): CapabilityHostError {
  return new CapabilityHostError('STATE_INVALID', `capability-host document ${file} is unusable: ${reason}`, {
    path: file, reason,
  })
}

/**
 * Read one switch record.
 * @param value - candidate `tools` or `contexts` field.
 * @param label - position label used in the diagnostic.
 * @param file - document path, used in the diagnostic.
 * @returns the stored booleans, or an empty record when the field is absent.
 */
function parseSwitches(value: unknown, label: string, file: string): Record<string, boolean> {
  if (value === undefined) return {}
  if (!isRecord(value)) throw invalid(file, `${label} must be an object`)
  const switches: Record<string, boolean> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (key === '') throw invalid(file, `${label} has an empty key`)
    if (typeof entry !== 'boolean') throw invalid(file, `${label}.${key} must be a boolean`)
    switches[key] = entry
  }
  return switches
}

/**
 * Read one scope record.
 * @param value - candidate scope entry.
 * @param label - position label used in the diagnostic.
 * @param file - document path, used in the diagnostic.
 * @returns the validated record.
 */
function parseScope(value: unknown, label: string, file: string): ScopeStateRecord {
  if (!isRecord(value)) throw invalid(file, `${label} is not an object`)
  return {
    tools: parseSwitches(value['tools'], `${label}.tools`, file),
    contexts: parseSwitches(value['contexts'], `${label}.contexts`, file),
  }
}

/**
 * Read one persisted context event. Events are written only by this Host, so a
 * malformed one means another writer touched the file.
 * @param value - candidate event entry.
 * @param label - position label used in the diagnostic.
 * @param file - document path, used in the diagnostic.
 * @returns the validated event.
 */
function parseEvent(value: unknown, label: string, file: string): ContextEvent {
  if (!isRecord(value)) throw invalid(file, `${label} is not an object`)
  const field = (name: string): string => {
    const read = value[name]
    if (typeof read !== 'string' || read === '') throw invalid(file, `${label}.${name} is missing`)
    return read
  }
  const active = value['active']
  if (typeof active !== 'boolean') throw invalid(file, `${label}.active must be a boolean`)
  const createdAt = value['createdAt']
  if (typeof createdAt !== 'number' || !Number.isFinite(createdAt)) {
    throw invalid(file, `${label}.createdAt must be a finite number`)
  }
  const visibility = value['visibility']
  if (!isRecord(visibility)) throw invalid(file, `${label}.visibility must be an object`)
  const ids = (name: string): string[] | undefined => {
    const read = visibility[name]
    if (read === undefined) return undefined
    if (!Array.isArray(read) || read.some(entry => typeof entry !== 'string')) {
      throw invalid(file, `${label}.visibility.${name} must be a string array`)
    }
    return [...read] as string[]
  }
  const presetIds = ids('presetIds')
  const sessionIds = ids('sessionIds')
  const ttlMs = value['ttlMs']
  if (ttlMs !== undefined && (typeof ttlMs !== 'number' || !Number.isFinite(ttlMs) || ttlMs <= 0)) {
    throw invalid(file, `${label}.ttlMs must be a positive finite number`)
  }
  const maxBytes = value['maxBytes']
  if (maxBytes !== undefined && (typeof maxBytes !== 'number' || !Number.isFinite(maxBytes) || maxBytes <= 0)) {
    throw invalid(file, `${label}.maxBytes must be a positive finite number`)
  }
  return {
    id: field('id'),
    kind: field('kind'),
    source: field('source'),
    summary: typeof value['summary'] === 'string' ? value['summary'] : '',
    payload: value['payload'] ?? null,
    visibility: {
      ...(presetIds === undefined ? {} : { presetIds }),
      ...(sessionIds === undefined ? {} : { sessionIds }),
    },
    active,
    dedupeKey: field('dedupeKey'),
    createdAt,
    ...(ttlMs === undefined ? {} : { ttlMs }),
    ...(maxBytes === undefined ? {} : { maxBytes }),
  }
}

/**
 * Read one session queue.
 * @param value - candidate queue entry.
 * @param label - position label used in the diagnostic.
 * @param file - document path, used in the diagnostic.
 * @returns the validated queue.
 */
function parseQueue(value: unknown, label: string, file: string): QueueRecord {
  if (!isRecord(value)) throw invalid(file, `${label} is not an object`)
  const events = value['events']
  if (!Array.isArray(events)) throw invalid(file, `${label}.events must be an array`)
  const consumed = value['consumed']
  if (consumed !== undefined && (!Array.isArray(consumed) || consumed.some(entry => typeof entry !== 'string'))) {
    throw invalid(file, `${label}.consumed must be a string array`)
  }
  const dedupe = value['dedupe']
  if (dedupe !== undefined && !isRecord(dedupe)) throw invalid(file, `${label}.dedupe must be an object`)
  const dedupeRecord: Record<string, number> = {}
  for (const [key, entry] of Object.entries(dedupe ?? {})) {
    if (typeof entry !== 'number' || !Number.isFinite(entry)) {
      throw invalid(file, `${label}.dedupe.${key} must be a finite number`)
    }
    dedupeRecord[key] = entry
  }
  return {
    events: events.map((event, index) => parseEvent(event, `${label}.events[${String(index)}]`, file)),
    consumed: [...(consumed ?? [])] as string[],
    dedupe: dedupeRecord,
  }
}

/**
 * Read saved tool selections.
 * @param value - candidate `toolPresets` field.
 * @param file - document path, used in the diagnostic.
 * @returns validated records in stored order.
 */
function parseToolPresets(value: unknown, file: string): ToolPresetRecord[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw invalid(file, '"toolPresets" must be an array')
  const records: ToolPresetRecord[] = []
  const ids = new Set<string>()
  for (const [index, entry] of value.entries()) {
    const label = `toolPresets[${String(index)}]`
    if (!isRecord(entry)) throw invalid(file, `${label} is not an object`)
    const id = entry['id']
    const name = entry['name']
    const createdAt = entry['createdAt']
    const tools = entry['tools']
    if (typeof id !== 'string' || id === '') throw invalid(file, `${label}.id is missing`)
    if (ids.has(id)) throw invalid(file, `${label}.id is duplicated`)
    if (typeof name !== 'string' || name.trim() === '') throw invalid(file, `${label}.name is missing`)
    if (typeof createdAt !== 'number' || !Number.isFinite(createdAt)) {
      throw invalid(file, `${label}.createdAt must be a finite number`)
    }
    if (!Array.isArray(tools) || tools.some(tool => typeof tool !== 'string')) {
      throw invalid(file, `${label}.tools must be a string array`)
    }
    const unique = [...new Set(tools)]
    ids.add(id)
    records.push({ id, name: name.trim(), tools: unique, createdAt })
  }
  return records
}

/**
 * Validate a parsed document. An absent document is the empty one; a present
 * one must carry a generation this build reads.
 * @param value - parsed JSON, or undefined when the file does not exist.
 * @param file - document path, used in the diagnostic.
 * @returns the validated document at this build's generation.
 */
export function parseDocument(value: unknown, file: string): CapabilityDocument {
  if (value === undefined) {
    return {
      version: DOCUMENT_VERSION,
      global: {},
      presets: {},
      sessions: {},
      sessionPresets: {},
      queues: {},
      toolPresets: [],
      updatedAt: new Date(0).toISOString(),
    }
  }
  if (!isRecord(value)) throw invalid(file, 'the document must be an object')
  const version = value['version']
  if (version !== DOCUMENT_VERSION) {
    throw invalid(file, `unsupported version ${String(version)}; this build reads ${String(DOCUMENT_VERSION)}`)
  }
  const section = (name: string): Record<string, unknown> => {
    const read = value[name]
    if (read === undefined) return {}
    if (!isRecord(read)) throw invalid(file, `"${name}" must be an object`)
    return read
  }
  const global = value['global'] === undefined
    ? {}
    : parseScope(value['global'], 'global', file)
  const presets: Record<string, ScopeStateRecord> = {}
  for (const [id, entry] of Object.entries(section('presets'))) {
    presets[id] = parseScope(entry, `presets.${id}`, file)
  }
  const sessions: Record<string, ScopeStateRecord> = {}
  for (const [id, entry] of Object.entries(section('sessions'))) {
    sessions[id] = parseScope(entry, `sessions.${id}`, file)
  }
  const sessionPresets: Record<string, string> = {}
  for (const [id, entry] of Object.entries(section('sessionPresets'))) {
    if (typeof entry !== 'string' || entry === '') throw invalid(file, `sessionPresets.${id} must be a preset id`)
    sessionPresets[id] = entry
  }
  const queues: Record<string, QueueRecord> = {}
  for (const [id, entry] of Object.entries(section('queues'))) {
    queues[id] = parseQueue(entry, `queues.${id}`, file)
  }
  const updatedAt = value['updatedAt']
  if (updatedAt !== undefined && typeof updatedAt !== 'string') throw invalid(file, '"updatedAt" must be a string')
  return {
    version: DOCUMENT_VERSION,
    global,
    presets,
    sessions,
    sessionPresets,
    queues,
    toolPresets: parseToolPresets(value['toolPresets'], file),
    updatedAt: updatedAt ?? new Date(0).toISOString(),
  }
}

/** The empty queue of a session that has never received an event. */
const EMPTY_QUEUE: QueueRecord = { events: [], consumed: [], dedupe: {} }

/**
 * The panel's persisted switch and queue document.
 *
 * Reads are synchronous against the in-memory copy so a step-time gate never
 * waits on disk; writes are serialized by awaiting each commit in turn.
 */
export class CapabilityStateStore {
  private document: CapabilityDocument
  private writing: Promise<void> = Promise.resolve()

  private readonly file: string

  private constructor(
    file: string,
    document: CapabilityDocument,
  ) {
    this.file = file
    this.document = document
  }

  /**
   * Open the document under one state directory, creating the directory when it
   * is absent.
   * @param stateDir - absolute directory the document lives in.
   * @returns the store over the persisted document.
   * @throws CapabilityHostError `STATE_INVALID` for a non-absolute directory or a malformed document.
   */
  static async open(stateDir: string): Promise<CapabilityStateStore> {
    if (!isAbsolute(stateDir)) {
      throw new CapabilityHostError('STATE_INVALID', `capability-host stateDir must be absolute, got ${JSON.stringify(stateDir)}`, {
        path: stateDir, reason: 'not-absolute',
      })
    }
    try {
      await mkdir(stateDir, { recursive: true })
    } catch (error: unknown) {
      throw new CapabilityHostError('STATE_INVALID', `capability-host cannot create stateDir ${stateDir}: ${describeError(error)}`, {
        path: stateDir, reason: 'uncreatable',
      })
    }
    const file = join(stateDir, DOCUMENT_FILE_NAME)
    let raw: string | undefined
    try {
      raw = await readFile(file, 'utf8')
    } catch (error: unknown) {
      if (!isMissingFile(error)) {
        throw new CapabilityHostError('STATE_INVALID', `capability-host cannot read ${file}: ${describeError(error)}`, {
          path: file, reason: 'unreadable',
        })
      }
    }
    let parsed: unknown
    if (raw !== undefined) {
      try {
        parsed = JSON.parse(raw)
      } catch (error: unknown) {
        throw new CapabilityHostError('STATE_INVALID', `capability-host document ${file} is not JSON: ${describeError(error)}`, {
          path: file, reason: 'not-json',
        })
      }
    }
    return new CapabilityStateStore(file, parseDocument(parsed, file))
  }

  /** The persisted path of this document. */
  get path(): string {
    return this.file
  }

  /** A read-only view of the whole document. */
  snapshot(): CapabilityDocument {
    return this.document
  }

  /** Saved dynamic-tool selections, in creation order. */
  toolPresets(): readonly ToolPresetRecord[] {
    return this.document.toolPresets
  }

  /**
   * Append one saved tool selection and persist it.
   * @param name - display name; trimmed and non-empty.
   * @param tools - dynamic tool ids to store.
   * @returns the committed record.
   */
  async addToolPreset(name: string, tools: readonly string[]): Promise<ToolPresetRecord> {
    const record: ToolPresetRecord = {
      id: `toolset-${randomUUID().slice(0, 8)}`,
      name: name.trim(),
      tools: [...new Set(tools)],
      createdAt: Date.now(),
    }
    await this.commit({ ...this.document, toolPresets: [...this.document.toolPresets, record] })
    return record
  }

  /**
   * Remove one saved tool selection.
   * @param id - preset id.
   * @returns whether a record was removed.
   */
  async removeToolPreset(id: string): Promise<boolean> {
    const next = this.document.toolPresets.filter(record => record.id !== id)
    if (next.length === this.document.toolPresets.length) return false
    await this.commit({ ...this.document, toolPresets: next })
    return true
  }

  /** Explicit switches stored at one scope. */
  overrides(ref: ScopeRef): ScopeOverrides {
    const record = this.scopeRecord(ref)
    return { tools: record.tools ?? {}, contexts: record.contexts ?? {} }
  }

  /** Preset ids with any stored switch. */
  presetIds(): readonly string[] {
    return Object.keys(this.document.presets)
  }

  /** Session ids known to the document, live or offline. */
  sessionIds(): readonly string[] {
    const ids = new Set<string>([
      ...Object.keys(this.document.sessions),
      ...Object.keys(this.document.queues),
      ...Object.keys(this.document.sessionPresets),
    ])
    return [...ids]
  }

  /** The preset recorded for one session, when known. */
  sessionPreset(sessionId: string): string | undefined {
    return this.document.sessionPresets[sessionId]
  }

  /**
   * Read one switch value at one scope.
   * @param ref - scope to read.
   * @param dimension - switch dimension.
   * @param id - tool id or context kind.
   * @returns the stored value, or undefined when this scope does not override it.
   */
  switchValue(ref: ScopeRef, dimension: SwitchDimension, id: string): boolean | undefined {
    return this.scopeRecord(ref)[dimension]?.[id]
  }

  /**
   * Explain which layer decided one switch value.
   * @param ref - scope being described.
   * @param dimension - switch dimension.
   * @param id - tool id or context kind.
   * @returns the overriding layer, or `default` when nothing is set.
   */
  switchOrigin(ref: ScopeRef, dimension: SwitchDimension, id: string): SwitchOrigin {
    const own = this.switchValue(ref, dimension, id)
    if (ref.kind === 'global') return own === undefined ? 'default' : 'global'
    if (ref.kind === 'preset') {
      if (own !== undefined) return 'preset'
      return this.switchValue({ kind: 'global' }, dimension, id) === undefined ? 'default' : 'global'
    }
    if (own !== undefined) return 'session'
    const presetId = this.sessionPreset(ref.id)
    if (presetId !== undefined) {
      const inherited = this.switchValue({ kind: 'preset', id: presetId }, dimension, id)
      if (inherited !== undefined) return 'preset'
    }
    return this.switchValue({ kind: 'global' }, dimension, id) === undefined ? 'default' : 'global'
  }

  /** The queue of one session. */
  queue(sessionId: string): QueueRecord {
    return this.document.queues[sessionId] ?? EMPTY_QUEUE
  }

  /** Total undelivered events across every session. */
  queuedCount(): number {
    let total = 0
    for (const queue of Object.values(this.document.queues)) total += queue.events.length
    return total
  }

  /**
   * Store one explicit switch and persist the document.
   * @param ref - preset or session scope.
   * @param dimension - switch dimension.
   * @param id - tool id or context kind.
   * @param enabled - explicit on or explicit off.
   * @returns after the document is durable.
   * @throws CapabilityHostError `SCOPE_READ_ONLY` when a static tool is addressed.
   */
  async setSwitch(ref: ScopeRef, dimension: SwitchDimension, id: string, enabled: boolean): Promise<void> {
    if (ref.kind === 'global') {
      const nextSwitches = { ...(this.document.global[dimension] ?? {}), [id]: enabled }
      await this.commit({
        ...this.document,
        global: { ...this.document.global, [dimension]: nextSwitches },
      })
      return
    }
    const section = ref.kind === 'preset' ? this.document.presets : this.document.sessions
    const current = section[ref.id] ?? {}
    const nextSwitches = { ...(current[dimension] ?? {}), [id]: enabled }
    const nextRecord: ScopeStateRecord = { ...current, [dimension]: nextSwitches }
    await this.commit({
      ...this.document,
      [ref.kind === 'preset' ? 'presets' : 'sessions']: { ...section, [ref.id]: nextRecord },
    })
  }

  /**
   * Record the preset one session runs.
   * @param sessionId - session identity.
   * @param presetId - preset the session resolves.
   * @returns after the document is durable, or immediately when already recorded.
   */
  async setSessionPreset(sessionId: string, presetId: string): Promise<void> {
    if (this.document.sessionPresets[sessionId] === presetId) return
    await this.commit({
      ...this.document,
      sessionPresets: { ...this.document.sessionPresets, [sessionId]: presetId },
    })
  }

  /**
   * Replace one session queue.
   * @param sessionId - session identity.
   * @param mutate - receives the current queue and returns the next one.
   * @returns after the document is durable.
   */
  async mutateQueue(sessionId: string, mutate: (queue: QueueRecord) => QueueRecord): Promise<void> {
    const current = this.queue(sessionId)
    const next = mutate(current)
    if (next === current) return
    await this.commit({
      ...this.document,
      queues: { ...this.document.queues, [sessionId]: next },
    })
  }

  /**
   * Drop one session's queue and switches.
   * @param sessionId - archived or deleted session identity.
   * @returns after the document is durable, or immediately when nothing was stored.
   */
  async forgetSession(sessionId: string): Promise<void> {
    if (this.document.queues[sessionId] === undefined
      && this.document.sessions[sessionId] === undefined
      && this.document.sessionPresets[sessionId] === undefined) return
    const queues = { ...this.document.queues }
    const sessions = { ...this.document.sessions }
    const sessionPresets = { ...this.document.sessionPresets }
    delete queues[sessionId]
    delete sessions[sessionId]
    delete sessionPresets[sessionId]
    await this.commit({ ...this.document, queues, sessions, sessionPresets })
  }

  /**
   * Translate one scope reference into its stored record, empty when the scope
   * has no switch yet.
   * @param ref - scope to read.
   * @returns the stored record.
   */
  private scopeRecord(ref: ScopeRef): ScopeStateRecord {
    if (ref.kind === 'global') return this.document.global
    return (ref.kind === 'preset' ? this.document.presets : this.document.sessions)[ref.id] ?? {}
  }

  private async commit(next: CapabilityDocument): Promise<void> {
    const stamped: CapabilityDocument = { ...next, updatedAt: new Date().toISOString() }
    const text = `${JSON.stringify(stamped, undefined, 2)}\n`
    const temporary = `${this.file}.${String(process.pid)}.${randomUUID()}.tmp`
    const run = async (): Promise<void> => {
      try {
        await writeFile(temporary, text, 'utf8')
        await rename(temporary, this.file)
      } catch (error: unknown) {
        throw new CapabilityHostError('STATE_WRITE_FAILED', `capability-host cannot write ${this.file}: ${describeError(error)}`, {
          path: this.file, reason: 'write-failed',
        })
      }
      this.document = stamped
    }
    // Serialize commits so two writers never race the same temporary name.
    this.writing = this.writing.then(run, run)
    await this.writing
  }
}

/**
 * Whether a read failure is the document not existing yet.
 * @param error - the caught read failure.
 * @returns true for ENOENT only.
 */
function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT'
}

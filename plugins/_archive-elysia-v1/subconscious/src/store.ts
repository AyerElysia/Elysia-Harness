import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import {
  MAIN_SOURCE_INSTANCE, MAIN_SOURCE_KIND, observationFromMainEvent, observationIdentity, payloadHash,
  type MainSessionEvent, type Observation, type ObservationDraft, type ReviewState, type RouterBatch,
} from './model.ts'

export class RouteError extends Error {
  constructor(readonly code: string, message: string, readonly retryable = false) {
    super(message)
    this.name = 'RouteError'
  }
}

/** 批次耗尽运行预算后的固定放弃原因：输入保留为可查的 Decision，不静默丢弃。 */
export const BATCH_ATTEMPTS_EXHAUSTED = 'BATCH_ATTEMPTS_EXHAUSTED'

export interface RouterHealth {
  observations: number
  pendingObservations: number
  readyBatches: number
  deferredBatches: number
  completedBatches: number
  failedBatches: number
  triggerBatchCount: number
  sourceCursor?: number
  sourceCursors: Record<string, number>
  lastDecisionAt?: string
  lastError?: string
}

interface IntakeTurn {
  internal: boolean
  external: boolean
}

const communicationTools = new Set(['session_list', 'session_read', 'session_send'])
const communicationSource = 'elysia-session-communication'

interface ObservationRow {
  id: string
  source_kind: string
  source_instance: string
  source_event_id: string
  ingest_seq: number
  kind: Observation['kind']
  event_time: number
  recorded_at: number
  content_hash: string
  payload: string
  content: string
  thread_refs: string
  correlation_refs: string
  visibility_ref: string
  review_state: ReviewState
  session_id: string | null
  event_seq: number | null
  actor: string | null
  turn: number | null
  step: number | null
  call_id: string | null
  projection?: string | null
  projection_complete?: number | null
}

interface BatchRow {
  id: string
  state: RouterBatch['state']
  trigger_group_id: string | null
  previous_batch_id: string | null
  successor_batch_id: string | null
  attempt_count: number
  available_at: number
  created_at: number
  session_seq: number | null
  accepted_at: number | null
  presented_turn: number | null
  presented_step: number | null
  presented_at: number | null
  completed_turn: number | null
  completed_at: number | null
}

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T
}

function observation(row: ObservationRow): Observation {
  const source = { kind: row.source_kind, instance: row.source_instance, eventId: row.source_event_id }
  return {
    id: row.id, source, ingestSeq: row.ingest_seq, kind: row.kind, eventTime: row.event_time,
    recordedAt: row.recorded_at, contentHash: row.content_hash, payload: row.payload,
    content: parseJson<ContentBlock[]>(row.content), threadRefs: parseJson<string[]>(row.thread_refs),
    correlationRefs: parseJson<string[]>(row.correlation_refs), visibilityRef: row.visibility_ref,
    reviewState: row.review_state,
    ...row.session_id === null ? {} : { sessionId: row.session_id },
    ...row.event_seq === null ? {} : { eventSeq: row.event_seq },
    ...row.actor === null ? {} : { actor: row.actor },
    ...row.turn === null ? {} : { turn: row.turn },
    ...row.step === null ? {} : { step: row.step },
    ...row.call_id === null ? {} : { callId: row.call_id },
    ...row.projection == null ? {} : { projectedContent: parseJson<ContentBlock[]>(row.projection) },
    ...row.projection_complete == null ? {} : { projectionComplete: row.projection_complete === 1 },
  }
}

function truncateUtf8(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text) <= maxBytes) return text
  let low = 0
  let high = text.length
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (Buffer.byteLength(text.slice(0, middle)) <= maxBytes) low = middle
    else high = middle - 1
  }
  return text.slice(0, low)
}

/** Keep every attachment reference; only oversized text needs a bounded projection. */
function projectContent(item: Observation, maxBytes: number): { content: ContentBlock[]; complete: boolean; bytes: number } {
  const originalBytes = Buffer.byteLength(JSON.stringify(item.content))
  if (originalBytes <= maxBytes) return { content: item.content, complete: true, bytes: originalBytes }
  const marker = '\n…[内容已节选；完整观察已持久保存]'
  let remaining = Math.max(2, maxBytes)
  const projected: ContentBlock[] = []
  for (const block of item.content) {
    if (block.type !== 'text') {
      const copy = structuredClone(block)
      projected.push(copy)
      remaining = Math.max(0, remaining - Buffer.byteLength(JSON.stringify(copy)) - 1)
      continue
    }
    const budget = Math.max(0, remaining - Buffer.byteLength(marker) - 16)
    projected.push({ type: 'text', text: `${truncateUtf8(block.text, budget)}${marker}` })
    remaining = 0
  }
  let content = projected
  let bytes = Buffer.byteLength(JSON.stringify(content))
  while (bytes > maxBytes && content.some(block => block.type === 'text' && block.text.length > 0)) {
    const index = content.findIndex(block => block.type === 'text' && block.text.length > 0)
    const block = content[index]!
    if (block.type !== 'text') break
    const excess = bytes - maxBytes
    content = content.map((candidate, candidateIndex) => {
      if (candidateIndex !== index || candidate.type !== 'text') return candidate
      const markerAt = candidate.text.lastIndexOf(marker)
      const prefix = markerAt < 0 ? candidate.text : candidate.text.slice(0, markerAt)
      const suffix = markerAt < 0 ? '' : marker
      return { ...candidate, text: `${truncateUtf8(prefix, Math.max(0, Buffer.byteLength(prefix) - excess - 2))}${suffix}` }
    })
    bytes = Buffer.byteLength(JSON.stringify(content))
  }
  if (bytes > maxBytes) {
    const references = item.content.map(block => {
      if (block.type === 'text') return block.text
      const attachment = 'attachment' in block ? block.attachment.attachmentId : 'unknown'
      return `[${block.type} attachment: ${String(attachment)}]`
    }).join('\n')
    const budget = Math.max(0, maxBytes - Buffer.byteLength(marker) - 24)
    content = [{ type: 'text', text: `${truncateUtf8(references, budget)}${marker}` }]
    bytes = Buffer.byteLength(JSON.stringify(content))
  }
  return { content, complete: false, bytes }
}

/** The sole writer for observations, batches, decisions, cursors, and rest state. */
export class RouterStore {
  private readonly db: DatabaseSync

  constructor(readonly stateDir: string, defaultTriggerBatchCount = 1) {
    mkdirSync(stateDir, { recursive: true })
    this.db = new DatabaseSync(join(stateDir, 'router.sqlite'))
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS observations (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        event_seq INTEGER NOT NULL UNIQUE,
        event_time INTEGER NOT NULL,
        source_kind TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        payload TEXT NOT NULL,
        routing_state TEXT NOT NULL CHECK (routing_state IN ('pending', 'in_batch', 'deferred', 'closed')),
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS batches (
        id TEXT PRIMARY KEY,
        state TEXT NOT NULL CHECK (state IN ('ready', 'presenting', 'presented', 'decided', 'deferred')),
        previous_batch_id TEXT REFERENCES batches(id),
        successor_batch_id TEXT REFERENCES batches(id),
        attempt_count INTEGER NOT NULL DEFAULT 0,
        available_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS batch_observations (
        batch_id TEXT NOT NULL REFERENCES batches(id),
        observation_id TEXT NOT NULL REFERENCES observations(id),
        position INTEGER NOT NULL,
        PRIMARY KEY (batch_id, observation_id)
      );
      CREATE TABLE IF NOT EXISTS decisions (
        id TEXT PRIMARY KEY,
        batch_id TEXT NOT NULL UNIQUE REFERENCES batches(id),
        action TEXT NOT NULL CHECK (action IN ('ignore', 'defer')),
        reason TEXT NOT NULL,
        not_before INTEGER,
        request_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS runtime_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS surface_observations (
        id TEXT PRIMARY KEY,
        source_kind TEXT NOT NULL,
        source_instance TEXT NOT NULL,
        source_event_id TEXT NOT NULL,
        ingest_seq INTEGER NOT NULL UNIQUE,
        kind TEXT NOT NULL,
        event_time INTEGER NOT NULL,
        recorded_at INTEGER NOT NULL,
        content_hash TEXT NOT NULL,
        payload TEXT NOT NULL,
        content TEXT NOT NULL,
        thread_refs TEXT NOT NULL,
        correlation_refs TEXT NOT NULL,
        visibility_ref TEXT NOT NULL,
        review_state TEXT NOT NULL CHECK (review_state IN ('pending', 'in_batch', 'deferred', 'reviewed')),
        session_id TEXT,
        event_seq INTEGER,
        actor TEXT,
        turn INTEGER,
        step INTEGER,
        call_id TEXT,
        UNIQUE(source_kind, source_instance, source_event_id)
      );
      CREATE TABLE IF NOT EXISTS observation_threads (
        observation_id TEXT NOT NULL REFERENCES surface_observations(id) ON DELETE CASCADE,
        thread TEXT NOT NULL,
        PRIMARY KEY(observation_id, thread)
      );
      CREATE TABLE IF NOT EXISTS batch_items (
        batch_id TEXT NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
        observation_id TEXT NOT NULL REFERENCES surface_observations(id),
        position INTEGER NOT NULL,
        projection TEXT NOT NULL,
        complete INTEGER NOT NULL,
        PRIMARY KEY(batch_id, observation_id)
      );
      CREATE INDEX IF NOT EXISTS surface_pending ON surface_observations(review_state, ingest_seq);
      CREATE INDEX IF NOT EXISTS observation_threads_order ON observation_threads(thread, observation_id);
      CREATE INDEX IF NOT EXISTS batch_items_order ON batch_items(batch_id, position);
      CREATE INDEX IF NOT EXISTS batches_work ON batches(state, available_at, created_at);
    `)
    this.migrate()
    if (this.state('trigger_batch_count') === undefined) this.setTriggerBatchCount(defaultTriggerBatchCount)
  }

  private migrate(): void {
    const columns = this.db.prepare('PRAGMA table_info(batches)').all() as unknown as { name: string }[]
    const existing = new Set(columns.map(column => column.name))
    const additions: [string, string][] = [
      ['session_seq', 'INTEGER'], ['accepted_at', 'INTEGER'], ['presented_turn', 'INTEGER'],
      ['presented_step', 'INTEGER'], ['presented_at', 'INTEGER'], ['completed_turn', 'INTEGER'], ['completed_at', 'INTEGER'],
      ['trigger_group_id', 'TEXT'],
    ]
    this.transaction(() => {
      for (const [name, type] of additions) {
        if (!existing.has(name)) this.db.exec(`ALTER TABLE batches ADD COLUMN ${name} ${type}`)
      }
      const legacy = this.db.prepare('SELECT * FROM observations ORDER BY event_seq').all() as unknown as {
        id: string; session_id: string; event_seq: number; event_time: number; source_kind: string;
        content_hash: string; payload: string; routing_state: string; created_at: number
      }[]
      const insert = this.db.prepare(`INSERT OR IGNORE INTO surface_observations(
        id, source_kind, source_instance, source_event_id, ingest_seq, kind, event_time, recorded_at,
        content_hash, payload, content, thread_refs, correlation_refs, visibility_ref, review_state, session_id, event_seq
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?, ?, ?)`)
      const threadInsert = this.db.prepare('INSERT OR IGNORE INTO observation_threads(observation_id, thread) VALUES (?, ?)')
      let ingestSeq = Number(this.state('ingest_seq') ?? 0)
      for (const row of legacy) {
        const found = this.db.prepare(`SELECT 1 AS found FROM surface_observations
          WHERE source_kind = ? AND source_instance = ? AND source_event_id = ?`)
          .get(MAIN_SOURCE_KIND, MAIN_SOURCE_INSTANCE, String(row.event_seq))
        if (found !== undefined) continue
        const payload = parseJson<{ content?: ContentBlock[] }>(row.payload)
        const content = Array.isArray(payload.content) ? payload.content : []
        const thread = `conscious:elysia-conscious-mind`
        ingestSeq++
        const hash = payloadHash(payload, content)
        insert.run(row.id, MAIN_SOURCE_KIND, MAIN_SOURCE_INSTANCE, String(row.event_seq), ingestSeq,
          'external_input', row.event_time, row.created_at, hash, row.payload, JSON.stringify(content),
          JSON.stringify([thread]), thread, row.routing_state === 'closed' ? 'reviewed' : row.routing_state,
          row.session_id, row.event_seq)
        threadInsert.run(row.id, thread)
      }
      this.setState('ingest_seq', String(ingestSeq))
      const oldCursor = this.state('source_cursor')
      const cursorKey = this.cursorKey(MAIN_SOURCE_KIND, MAIN_SOURCE_INSTANCE)
      if (oldCursor !== undefined && this.state(cursorKey) === undefined) this.setState(cursorKey, oldCursor)
      this.db.exec(`INSERT OR IGNORE INTO batch_items(batch_id, observation_id, position, projection, complete)
        SELECT bo.batch_id, bo.observation_id, bo.position, so.content, 1
        FROM batch_observations bo JOIN surface_observations so ON so.id = bo.observation_id`)
    })
  }

  close(): void {
    this.db.close()
  }

  private transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = work()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  private state(key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM runtime_state WHERE key = ?').get(key) as { value: string } | undefined
    return row?.value
  }

  private setState(key: string, value: string): void {
    this.db.prepare('INSERT INTO runtime_state(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value)
  }

  triggerBatchCount(): number {
    const value = Number(this.state('trigger_batch_count') ?? 1)
    return Number.isSafeInteger(value) && value > 0 ? value : 1
  }

  setTriggerBatchCount(count: number): void {
    if (!Number.isSafeInteger(count) || count < 1) throw new RouteError('INVALID_TRIGGER_BATCH_COUNT', '触发批次数必须是正整数')
    this.transaction(() => this.setState('trigger_batch_count', String(count)))
  }

  private cursorKey(kind: string, instance: string): string {
    return `source_cursor:${kind}:${instance}`
  }

  sourceCursor(kind = MAIN_SOURCE_KIND, instance = MAIN_SOURCE_INSTANCE): number | undefined {
    const value = this.state(this.cursorKey(kind, instance))
    return value === undefined ? undefined : Number(value)
  }

  initializeCursor(seq: number, kind = MAIN_SOURCE_KIND, instance = MAIN_SOURCE_INSTANCE): void {
    this.transaction(() => {
      if (this.sourceCursor(kind, instance) === undefined) this.setState(this.cursorKey(kind, instance), String(seq))
    })
  }

  private insertObservation(draft: ObservationDraft, reviewState: ReviewState = 'pending'): boolean {
    if (!draft.source.kind || !draft.source.instance || !draft.source.eventId) {
      throw new RouteError('INVALID_OBSERVATION', 'Observation 缺少稳定来源身份')
    }
    const id = observationIdentity(draft.source)
    const hash = payloadHash(draft.payload, draft.content)
    const existing = this.db.prepare(`SELECT content_hash FROM surface_observations
      WHERE source_kind = ? AND source_instance = ? AND source_event_id = ?`)
      .get(draft.source.kind, draft.source.instance, draft.source.eventId) as { content_hash: string } | undefined
    if (existing !== undefined) {
      if (existing.content_hash !== hash) throw new RouteError('SOURCE_CONFLICT', `来源事件 ${draft.source.kind}/${draft.source.instance}/${draft.source.eventId} 的内容与既有观察不一致`)
      return false
    }
    const ingestSeq = Number(this.state('ingest_seq') ?? 0) + 1
    const recordedAt = Date.now()
    this.db.prepare(`INSERT INTO surface_observations(
      id, source_kind, source_instance, source_event_id, ingest_seq, kind, event_time, recorded_at,
      content_hash, payload, content, thread_refs, correlation_refs, visibility_ref, review_state,
      session_id, event_seq, actor, turn, step, call_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, draft.source.kind, draft.source.instance, draft.source.eventId, ingestSeq, draft.kind,
        draft.occurredAt, recordedAt, hash, JSON.stringify(draft.payload), JSON.stringify(draft.content),
        JSON.stringify(draft.threadRefs), JSON.stringify(draft.correlationRefs ?? []), draft.visibilityRef, reviewState,
        draft.consciousSessionId ?? null, Number.isSafeInteger(Number(draft.source.eventId)) ? Number(draft.source.eventId) : null,
        draft.actor ?? null, draft.turn ?? null, draft.step ?? null, draft.callId ?? null)
    const thread = this.db.prepare('INSERT OR IGNORE INTO observation_threads(observation_id, thread) VALUES (?, ?)')
    for (const ref of new Set(draft.threadRefs)) thread.run(id, ref)
    this.setState('ingest_seq', String(ingestSeq))
    return true
  }

  /** Admit one event from any source; source identity, not a global event_seq, owns deduplication. */
  recordObservation(draft: ObservationDraft, cursor?: number): boolean {
    return this.transaction(() => {
      const inserted = this.insertObservation(draft)
      if (cursor !== undefined) this.setState(this.cursorKey(draft.source.kind, draft.source.instance), String(cursor))
      return inserted
    })
  }

  /** Advance the exact main-session cursor and atomically retain its admitted projection. */
  recordEvent(event: MainSessionEvent): boolean {
    return this.transaction(() => {
      const cursor = this.sourceCursor()
      if (cursor !== undefined && event.seq <= cursor) return false
      // Record routing provenance with the cursor so a restart cannot turn an
      // internal message's later output into a new external Router wake.
      if (event.type === 'turn/start') {
        this.setState('intake_current_turn', String(event.data.turn))
        this.setState(`intake_turn:${event.data.turn}`, JSON.stringify({ internal: false, external: false }))
      }
      const current = this.state('intake_current_turn')
      let turn = event.type === 'assistant/message' || event.type === 'tool/call'
        ? event.data.turn
        : current === undefined ? undefined : Number(current)
      let draft = observationFromMainEvent(event)
      if (draft?.kind === 'tool_result' && draft.callId !== undefined) {
        const call = this.db.prepare(`SELECT id, turn, step, thread_refs FROM surface_observations
          WHERE source_kind = ? AND source_instance = ? AND call_id = ? ORDER BY ingest_seq DESC LIMIT 1`)
          .get(MAIN_SOURCE_KIND, MAIN_SOURCE_INSTANCE, draft.callId) as { id: string; turn: number | null; step: number | null; thread_refs: string } | undefined
        if (call !== undefined) {
          const threads = parseJson<string[]>(call.thread_refs)
          draft = {
            ...draft, ...call.turn === null ? {} : { turn: call.turn }, ...call.step === null ? {} : { step: call.step },
            threadRefs: threads, visibilityRef: threads[0] ?? draft.visibilityRef,
            correlationRefs: [...new Set([...draft.correlationRefs ?? [], call.id])],
          }
        }
      }
      if (draft?.turn !== undefined) turn = draft.turn
      const key = turn === undefined ? undefined : `intake_turn:${turn}`
      const storedOrigin = key === undefined ? undefined : this.state(key)
      let origin: IntakeTurn = storedOrigin === undefined
        ? { internal: false, external: false }
        : parseJson<IntakeTurn>(storedOrigin)
      const internalInput = event.type === 'user/message' && String(event.data.source.kind) === communicationSource
      if (event.type === 'user/message' && draft !== undefined && key !== undefined) {
        origin = {
          internal: origin.internal || internalInput,
          external: origin.external || !internalInput,
        }
        this.setState(key, JSON.stringify(origin))
        draft = { ...draft, ...turn === undefined ? {} : { turn } }
      }
      const internalTurn = origin.internal && !origin.external
      const communicationCall = event.type === 'tool/call' && communicationTools.has(event.data.name)
      const internalCallResult = draft?.kind === 'tool_result' && draft.callId !== undefined
        && this.state(`intake_internal_call:${draft.callId}`) === 'true'
      const reviewed = internalInput || internalTurn || communicationCall || internalCallResult
      if (reviewed && event.type === 'tool/call') {
        this.setState(`intake_internal_call:${event.data.callId}`, 'true')
      }
      if (draft !== undefined) this.insertObservation(draft, reviewed ? 'reviewed' : 'pending')
      this.setState(this.cursorKey(MAIN_SOURCE_KIND, MAIN_SOURCE_INSTANCE), String(event.seq))
      return true
    })
  }

  /** Form all currently pending observations into ordered, bounded ready batches. */
  formBatches(maxObservations: number, maxBytes: number): number {
    return this.transaction(() => {
      let formed = 0
      for (;;) {
        const rows = this.db.prepare(`SELECT * FROM surface_observations WHERE review_state = 'pending'
          ORDER BY ingest_seq LIMIT ?`).all(maxObservations) as unknown as ObservationRow[]
        if (rows.length === 0) return formed
        const selected: { row: ObservationRow; projection: ContentBlock[]; complete: boolean; bytes: number }[] = []
        let bytes = 0
        for (const row of rows) {
          if (selected.length >= maxObservations) break
          const item = observation(row)
          const projected = projectContent(item, Math.max(2, maxBytes - bytes))
          if (selected.length > 0 && bytes + projected.bytes > maxBytes) break
          selected.push({ row, projection: projected.content, complete: projected.complete, bytes: projected.bytes })
          bytes += projected.bytes
        }
        if (selected.length === 0) throw new RouteError('BATCH_PROJECTION_FAILED', '无法为有界批次生成观察投影')
        const batchId = `batch_${randomUUID()}`
        const now = Date.now()
        this.db.prepare(`INSERT INTO batches(id, state, attempt_count, available_at, created_at) VALUES (?, 'ready', 0, ?, ?)`)
          .run(batchId, now, now)
        const link = this.db.prepare('INSERT INTO batch_items(batch_id, observation_id, position, projection, complete) VALUES (?, ?, ?, ?, ?)')
        const mark = this.db.prepare(`UPDATE surface_observations SET review_state = 'in_batch' WHERE id = ?`)
        selected.forEach(({ row, projection, complete }, index) => {
          link.run(batchId, row.id, index, JSON.stringify(projection), complete ? 1 : 0)
          mark.run(row.id)
        })
        formed++
      }
    })
  }

  private batchRow(id: string): BatchRow | undefined {
    return this.db.prepare('SELECT * FROM batches WHERE id = ?').get(id) as BatchRow | undefined
  }

  getObservation(id: string): Observation | undefined {
    const row = this.db.prepare('SELECT * FROM surface_observations WHERE id = ?').get(id) as ObservationRow | undefined
    return row === undefined ? undefined : observation(row)
  }

  listObservations(options: { thread?: string; offset?: number; limit?: number } = {}): Observation[] {
    const offset = options.offset ?? 0
    const limit = options.limit ?? 20
    const parameters: (string | number)[] = []
    const where = options.thread === undefined ? '' : 'JOIN observation_threads ot ON ot.observation_id = o.id AND ot.thread = ?'
    if (options.thread !== undefined) parameters.push(options.thread)
    parameters.push(limit, offset)
    const rows = this.db.prepare(`SELECT o.* FROM surface_observations o ${where}
      ORDER BY o.ingest_seq LIMIT ? OFFSET ?`).all(...parameters) as unknown as ObservationRow[]
    return rows.map(observation)
  }

  private fromRow(row: BatchRow, observations: Observation[], id = row.id, batchIds = [row.id]): RouterBatch {
    return {
      id, batchIds, state: row.state,
      ...row.previous_batch_id === null ? {} : { previousBatchId: row.previous_batch_id },
      ...row.successor_batch_id === null ? {} : { successorBatchId: row.successor_batch_id },
      attemptCount: row.attempt_count, availableAt: row.available_at, createdAt: row.created_at,
      ...row.session_seq === null ? {} : { sessionSeq: row.session_seq },
      ...row.accepted_at === null ? {} : { acceptedAt: row.accepted_at },
      ...row.presented_turn === null ? {} : { presentedTurn: row.presented_turn },
      ...row.presented_step === null ? {} : { presentedStep: row.presented_step },
      ...row.presented_at === null ? {} : { presentedAt: row.presented_at },
      ...row.completed_turn === null ? {} : { completedTurn: row.completed_turn },
      ...row.completed_at === null ? {} : { completedAt: row.completed_at },
      observations,
    }
  }

  getBatch(id: string): RouterBatch | undefined {
    const row = this.batchRow(id)
    if (row === undefined) return undefined
    const observations = (this.db.prepare(`SELECT o.*, bi.projection, bi.complete AS projection_complete
      FROM surface_observations o JOIN batch_items bi ON bi.observation_id = o.id
      WHERE bi.batch_id = ? ORDER BY bi.position`).all(id) as unknown as ObservationRow[]).map(observation)
    return this.fromRow(row, observations)
  }

  private getBatchGroup(id: string): RouterBatch | undefined {
    const rows = this.db.prepare(`SELECT * FROM batches WHERE trigger_group_id = ? OR id = ?
      ORDER BY created_at, rowid`).all(id, id) as unknown as BatchRow[]
    const first = rows.find(row => row.id === id)
    if (first === undefined) return undefined
    const observations = (this.db.prepare(`SELECT o.*, bi.projection, bi.complete AS projection_complete
      FROM surface_observations o JOIN batch_items bi ON bi.observation_id = o.id
      JOIN batches b ON b.id = bi.batch_id
      WHERE b.trigger_group_id = ? OR b.id = ?
      ORDER BY b.created_at, b.rowid, bi.position`).all(id, id) as unknown as ObservationRow[]).map(observation)
    return this.fromRow(first, observations, id, rows.map(row => row.id))
  }

  /** Form a stable N-Batch trigger once, or resume its exact members after restart. */
  nextBatch(now = Date.now()): RouterBatch | undefined {
    const active = this.db.prepare(`SELECT trigger_group_id AS id FROM batches
      WHERE trigger_group_id IS NOT NULL AND state IN ('ready', 'presenting', 'presented') AND completed_turn IS NULL
      GROUP BY trigger_group_id ORDER BY MIN(created_at) LIMIT 1`).get() as { id: string } | undefined
    if (active !== undefined) return this.getBatchGroup(active.id)

    const grouped = this.transaction(() => {
      const rows = this.db.prepare(`SELECT id FROM batches
        WHERE trigger_group_id IS NULL AND state IN ('ready', 'presenting', 'presented') AND completed_turn IS NULL
        ORDER BY created_at, rowid LIMIT ?`).all(this.triggerBatchCount()) as { id: string }[]
      if (rows.length < this.triggerBatchCount()) return undefined
      const id = rows[0]!.id
      const mark = this.db.prepare('UPDATE batches SET trigger_group_id = ? WHERE id = ? AND trigger_group_id IS NULL')
      for (const row of rows) mark.run(id, row.id)
      return this.getBatchGroup(id)
    })
    if (grouped !== undefined) return grouped

    const due = this.db.prepare(`SELECT id FROM batches
      WHERE state = 'deferred' AND successor_batch_id IS NULL AND available_at <= ?
      ORDER BY available_at LIMIT 1`).get(now) as { id: string } | undefined
    if (due !== undefined) {
      const successor = this.transaction(() => {
        const previous = this.batchRow(due.id)
        if (previous === undefined || previous.successor_batch_id !== null) return previous?.successor_batch_id ?? undefined
        const id = `batch_${randomUUID()}`
        this.db.prepare(`INSERT INTO batches(id, state, previous_batch_id, attempt_count, available_at, created_at, trigger_group_id)
          VALUES (?, 'ready', ?, 0, ?, ?, ?)`).run(id, due.id, now, now, id)
        this.db.prepare(`INSERT INTO batch_items(batch_id, observation_id, position, projection, complete)
          SELECT ?, observation_id, position, projection, complete FROM batch_items WHERE batch_id = ? ORDER BY position`).run(id, due.id)
        this.db.prepare(`UPDATE surface_observations SET review_state = 'in_batch'
          WHERE id IN (SELECT observation_id FROM batch_items WHERE batch_id = ?)`).run(due.id)
        this.db.prepare('UPDATE batches SET successor_batch_id = ? WHERE id = ?').run(id, due.id)
        return id
      })
      if (successor !== undefined) return this.getBatchGroup(successor)
    }
    return undefined
  }

  nextWakeAt(): number | undefined {
    const row = this.db.prepare(`SELECT MIN(available_at) AS next FROM batches
      WHERE state = 'deferred' AND successor_batch_id IS NULL`).get() as { next: number | null }
    return row.next ?? undefined
  }

  /** 本次触发组已经历的 Router 运行次数（markPresenting 每次 +1）。 */
  batchAttempts(id: string): number {
    const row = this.db.prepare(`SELECT MAX(attempt_count) AS attempts FROM batches
      WHERE trigger_group_id = ? OR id = ?`).get(id, id) as { attempts: number | null }
    return row.attempts ?? 0
  }

  decision(batchId: string): { action: 'ignore' | 'defer'; reason: string } | undefined {
    return this.db.prepare('SELECT action, reason FROM decisions WHERE batch_id = ?').get(batchId) as
      { action: 'ignore' | 'defer'; reason: string } | undefined
  }

  /**
   * 运行预算耗尽后退役整个触发组：批次置 decided、输入置 reviewed、并写入 ignore Decision。
   * 这样输入仍可按 Decision 查询与复盘，而不是被静默丢掉或让 readyBatches 永远堆积。
   */
  abandonBatch(id: string, reason: string): void {
    this.transaction(() => {
      const now = Date.now()
      const rows = this.db.prepare(`SELECT id FROM batches WHERE trigger_group_id = ? OR id = ?
        ORDER BY created_at, rowid`).all(id, id) as { id: string }[]
      for (const row of rows) {
        // Decision 与批次一一对应；重复放弃不能覆盖已经存在的真实决定。
        if (this.decision(row.id) === undefined) {
          this.db.prepare(`INSERT INTO decisions(id, batch_id, action, reason, not_before, request_hash, created_at)
            VALUES (?, ?, 'ignore', ?, NULL, ?, ?)`).run(
            `decision_${randomUUID()}`, row.id, reason,
            createHash('sha256').update(`${reason}:${row.id}`).digest('hex'), now,
          )
        }
        this.db.prepare("UPDATE batches SET state = 'decided', available_at = ? WHERE id = ?").run(now, row.id)
        this.db.prepare(`UPDATE surface_observations SET review_state = 'reviewed'
          WHERE id IN (SELECT observation_id FROM batch_items WHERE batch_id = ?)`).run(row.id)
      }
    })
  }

  markPresenting(id: string): void {
    this.db.prepare(`UPDATE batches SET state = 'presenting', attempt_count = attempt_count + 1
      WHERE (trigger_group_id = ? OR id = ?) AND state IN ('ready', 'presenting', 'presented')`).run(id, id)
  }

  markAccepted(id: string, sessionSeq: number, acceptedAt = Date.now()): void {
    this.db.prepare(`UPDATE batches SET session_seq = COALESCE(session_seq, ?), accepted_at = COALESCE(accepted_at, ?)
      WHERE trigger_group_id = ? OR id = ?`).run(sessionSeq, acceptedAt, id, id)
  }

  markPresented(id: string, turn?: number, step?: number, presentedAt = Date.now()): void {
    this.db.prepare(`UPDATE batches SET state = 'presented', presented_turn = COALESCE(?, presented_turn),
      presented_step = COALESCE(?, presented_step), presented_at = COALESCE(presented_at, ?)
      WHERE (trigger_group_id = ? OR id = ?) AND state IN ('presenting', 'presented')`)
      .run(turn ?? null, step ?? null, presentedAt, id, id)
  }

  markCompleted(id: string, turn: number, completedAt: number): void {
    this.transaction(() => {
      const rows = this.db.prepare(`SELECT id FROM batches WHERE trigger_group_id = ? OR id = ?
        ORDER BY created_at, rowid`).all(id, id) as { id: string }[]
      for (const row of rows) {
        const batchId = row.id
        this.db.prepare('UPDATE batches SET completed_turn = ?, completed_at = ? WHERE id = ?').run(turn, completedAt, batchId)
        // Legacy defer decisions still govern batches created before route tools were removed.
        const decision = this.db.prepare('SELECT action FROM decisions WHERE batch_id = ?').get(batchId) as { action: 'ignore' | 'defer' } | undefined
        if (decision?.action === 'defer') {
          this.db.prepare(`UPDATE batches SET state = 'deferred' WHERE id = ?`).run(batchId)
          this.db.prepare(`UPDATE surface_observations SET review_state = 'deferred'
            WHERE id IN (SELECT observation_id FROM batch_items WHERE batch_id = ?)`).run(batchId)
        } else {
          // A normal DSH turn is sufficient. No model-generated route receipt is required.
          this.db.prepare(`UPDATE batches SET state = 'decided' WHERE id = ?`).run(batchId)
          this.db.prepare(`UPDATE surface_observations SET review_state = 'reviewed'
            WHERE id IN (SELECT observation_id FROM batch_items WHERE batch_id = ?)`).run(batchId)
        }
      }
    })
  }

  resting(): boolean {
    return this.state('resting') === 'true'
  }

  setResting(resting: boolean): void {
    this.transaction(() => this.setState('resting', String(resting)))
  }

  health(lastError?: string): RouterHealth {
    const count = (sql: string): number => (this.db.prepare(sql).get() as { count: number }).count
    const last = this.db.prepare('SELECT MAX(created_at) AS time FROM decisions').get() as { time: number | null }
    const cursor = this.sourceCursor()
    const cursors = this.db.prepare(`SELECT key, value FROM runtime_state WHERE key LIKE 'source_cursor:%'`)
      .all() as unknown as { key: string; value: string }[]
    return {
      observations: count('SELECT COUNT(*) AS count FROM surface_observations'),
      pendingObservations: count(`SELECT COUNT(*) AS count FROM surface_observations WHERE review_state != 'reviewed'`),
      readyBatches: count(`SELECT COUNT(*) AS count FROM batches WHERE state IN ('ready', 'presenting', 'presented')`),
      deferredBatches: count(`SELECT COUNT(*) AS count FROM batches WHERE state = 'deferred'`),
      completedBatches: count('SELECT COUNT(*) AS count FROM batches WHERE completed_turn IS NOT NULL'),
      failedBatches: (this.db.prepare('SELECT COUNT(*) AS count FROM decisions WHERE reason = ?')
        .get(BATCH_ATTEMPTS_EXHAUSTED) as { count: number }).count,
      triggerBatchCount: this.triggerBatchCount(),
      ...cursor === undefined ? {} : { sourceCursor: cursor },
      sourceCursors: Object.fromEntries(cursors.map(row => [row.key.slice('source_cursor:'.length), Number(row.value)])),
      ...last.time === null ? {} : { lastDecisionAt: new Date(last.time).toISOString() },
      ...lastError === undefined ? {} : { lastError },
    }
  }
}

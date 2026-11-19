import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import {
  DEFAULT_MEMORY_SESSION_CWD, MEMORY_SESSION_ID,
  type AssignmentState, type DispatchHealth, type DispatchInput, type Formation, type ReportInput,
  type ReportStatus, type SubconsciousTask, type TaskAssignment, type TaskMandate, type TaskReport, type TaskState,
} from './dispatch.ts'
import type { Observation, ReviewState } from './model.ts'

export class DispatchError extends Error {
  constructor(readonly code: string, message: string, readonly retryable = false, readonly existingTaskId?: string) {
    super(message)
    this.name = 'DispatchError'
  }
}

export interface DispatchStoreOptions {
  memoryWorkspaceDir?: string
  maxInputBytes?: number
  maxRunMs?: number
  maxTasksPerTrigger?: number
  maxQueuedTasks?: number
}

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
}

interface TaskRow {
  id: string
  revision: number
  kind: string
  title: string
  reason: string
  instruction: string
  source_refs: string
  formation: string
  mandate_id: string
  dedupe_key: string
  visibility_ref: string
  state: TaskState
  current_assignment_id: string
  created_at: number
  updated_at: number
  closed_at: number | null
  close_reason: string | null
}

interface AssignmentRow {
  id: string
  task_id: string
  task_revision: number
  specialist: string
  session_id: string
  attempt: number
  state: AssignmentState
  delivery_id: string
  input_refs: string
  created_at: number
  session_seq: number | null
  accepted_at: number | null
  presented_turn: number | null
  presented_step: number | null
  presented_at: number | null
  ended_at: number | null
  last_error: string | null
}

interface ReportRow {
  id: string
  task_id: string
  assignment_id: string
  specialist: string
  session_id: string
  turn: number | null
  tool_call_id: string
  status: ReportStatus
  summary: string
  output_refs: string
  request_hash: string
  created_at: number
}

function parse<T>(value: string): T {
  return JSON.parse(value) as T
}

function observation(row: ObservationRow): Observation {
  return {
    id: row.id,
    source: { kind: row.source_kind, instance: row.source_instance, eventId: row.source_event_id },
    ingestSeq: row.ingest_seq,
    kind: row.kind,
    eventTime: row.event_time,
    recordedAt: row.recorded_at,
    contentHash: row.content_hash,
    payload: row.payload,
    content: parse<ContentBlock[]>(row.content),
    threadRefs: parse<string[]>(row.thread_refs),
    correlationRefs: parse<string[]>(row.correlation_refs),
    visibilityRef: row.visibility_ref,
    reviewState: row.review_state,
    ...row.session_id === null ? {} : { sessionId: row.session_id },
    ...row.event_seq === null ? {} : { eventSeq: row.event_seq },
    ...row.actor === null ? {} : { actor: row.actor },
    ...row.turn === null ? {} : { turn: row.turn },
    ...row.step === null ? {} : { step: row.step },
    ...row.call_id === null ? {} : { callId: row.call_id },
  }
}

function taskFrom(row: TaskRow): SubconsciousTask {
  return {
    id: row.id, revision: row.revision, kind: row.kind, title: row.title, reason: row.reason,
    instruction: row.instruction, sourceRefs: parse<string[]>(row.source_refs), formation: parse<Formation>(row.formation),
    mandateId: row.mandate_id, dedupeKey: row.dedupe_key, visibilityRef: row.visibility_ref, state: row.state,
    currentAssignmentId: row.current_assignment_id, createdAt: row.created_at, updatedAt: row.updated_at,
    ...row.closed_at === null ? {} : { closedAt: row.closed_at },
    ...row.close_reason === null ? {} : { closeReason: row.close_reason },
  }
}

function assignmentFrom(row: AssignmentRow): TaskAssignment {
  return {
    id: row.id, taskId: row.task_id, taskRevision: row.task_revision, specialist: row.specialist,
    sessionId: row.session_id, attempt: row.attempt, state: row.state, deliveryId: row.delivery_id,
    inputRefs: parse<string[]>(row.input_refs), createdAt: row.created_at,
    ...row.session_seq === null ? {} : { sessionSeq: row.session_seq },
    ...row.accepted_at === null ? {} : { acceptedAt: row.accepted_at },
    ...row.presented_turn === null ? {} : { presentedTurn: row.presented_turn },
    ...row.presented_step === null ? {} : { presentedStep: row.presented_step },
    ...row.presented_at === null ? {} : { presentedAt: row.presented_at },
    ...row.ended_at === null ? {} : { endedAt: row.ended_at },
    ...row.last_error === null ? {} : { lastError: row.last_error },
  }
}

function reportFrom(row: ReportRow): TaskReport {
  return {
    id: row.id, taskId: row.task_id, assignmentId: row.assignment_id, specialist: row.specialist,
    sessionId: row.session_id, toolCallId: row.tool_call_id, status: row.status, summary: row.summary,
    outputRefs: parse<string[]>(row.output_refs), requestHash: row.request_hash, createdAt: row.created_at,
    ...row.turn === null ? {} : { turn: row.turn },
  }
}

function requestHash(input: DispatchInput): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex')
}

function reportHash(input: ReportInput): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex')
}

function sourceId(ref: string): string {
  if (!ref.startsWith('observation/obs_')) throw new DispatchError('VALIDATION_FAILED', `无效来源引用：${ref}`)
  return ref.slice('observation/'.length)
}

/** Durable Task / Mandate / Assignment / Report writer sharing the Observation SQLite file. */
export class DispatchStore {
  private readonly db: DatabaseSync
  readonly memoryWorkspaceDir: string
  readonly maxInputBytes: number
  readonly maxRunMs: number
  readonly maxTasksPerTrigger: number
  readonly maxQueuedTasks: number

  constructor(stateDir: string, options: DispatchStoreOptions = {}) {
    mkdirSync(stateDir, { recursive: true })
    this.memoryWorkspaceDir = options.memoryWorkspaceDir ?? DEFAULT_MEMORY_SESSION_CWD
    this.maxInputBytes = options.maxInputBytes ?? 65_536
    this.maxRunMs = options.maxRunMs ?? 900_000
    this.maxTasksPerTrigger = options.maxTasksPerTrigger ?? 3
    this.maxQueuedTasks = options.maxQueuedTasks ?? 20
    this.db = new DatabaseSync(join(stateDir, 'router.sqlite'))
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS subconscious_task (
        id TEXT PRIMARY KEY,
        revision INTEGER NOT NULL,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        reason TEXT NOT NULL,
        instruction TEXT NOT NULL,
        source_refs TEXT NOT NULL,
        formation TEXT NOT NULL,
        mandate_id TEXT NOT NULL,
        dedupe_key TEXT NOT NULL,
        visibility_ref TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('assigned','running','report_pending','completed','blocked','failed','dropped','cancelled')),
        current_assignment_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        closed_at INTEGER,
        close_reason TEXT
      );
      CREATE TABLE IF NOT EXISTS task_mandate (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES subconscious_task(id),
        kind TEXT NOT NULL,
        specialist TEXT NOT NULL,
        session_id TEXT NOT NULL,
        policy_version TEXT NOT NULL,
        source_refs TEXT NOT NULL,
        visibility_ref TEXT NOT NULL,
        read_roots TEXT NOT NULL,
        write_roots TEXT NOT NULL,
        tools TEXT NOT NULL,
        output_kinds TEXT NOT NULL,
        max_input_bytes INTEGER NOT NULL,
        max_run_ms INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS task_assignment (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES subconscious_task(id),
        task_revision INTEGER NOT NULL,
        specialist TEXT NOT NULL,
        session_id TEXT NOT NULL,
        attempt INTEGER NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('pending','delivering','running','report_pending','ended','interrupted')),
        delivery_id TEXT NOT NULL UNIQUE,
        input_refs TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        session_seq INTEGER,
        accepted_at INTEGER,
        presented_turn INTEGER,
        presented_step INTEGER,
        presented_at INTEGER,
        ended_at INTEGER,
        last_error TEXT
      );
      CREATE TABLE IF NOT EXISTS task_report (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        assignment_id TEXT NOT NULL UNIQUE REFERENCES task_assignment(id),
        specialist TEXT NOT NULL,
        session_id TEXT NOT NULL,
        turn INTEGER,
        tool_call_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('completed','blocked','failed','dropped')),
        summary TEXT NOT NULL,
        output_refs TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS dispatch_effect (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('deliver_assignment','relay_report')),
        target_session_id TEXT NOT NULL,
        aggregate_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('pending','running','completed','retry_wait','failed')),
        attempt_count INTEGER NOT NULL,
        available_at INTEGER NOT NULL,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        completed_at INTEGER,
        UNIQUE(kind, aggregate_id)
      );
      CREATE TABLE IF NOT EXISTS dispatch_request (
        trigger_ref TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        task_id TEXT NOT NULL REFERENCES subconscious_task(id),
        response TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY(trigger_ref, request_hash)
      );
      CREATE INDEX IF NOT EXISTS subconscious_task_work ON subconscious_task(state, created_at);
      CREATE INDEX IF NOT EXISTS subconscious_task_dedupe ON subconscious_task(dedupe_key, state);
      CREATE INDEX IF NOT EXISTS task_assignment_work ON task_assignment(state, created_at);
      CREATE INDEX IF NOT EXISTS dispatch_effect_work ON dispatch_effect(kind, state, available_at, created_at);
    `)
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

  private taskRow(id: string): TaskRow | undefined {
    return this.db.prepare('SELECT * FROM subconscious_task WHERE id = ?').get(id) as TaskRow | undefined
  }

  private assignmentRow(id: string): AssignmentRow | undefined {
    return this.db.prepare('SELECT * FROM task_assignment WHERE id = ?').get(id) as AssignmentRow | undefined
  }

  private reportRow(id: string): ReportRow | undefined {
    return this.db.prepare('SELECT * FROM task_report WHERE id = ?').get(id) as ReportRow | undefined
  }

  getTask(id: string): SubconsciousTask | undefined {
    const row = this.taskRow(id)
    return row === undefined ? undefined : taskFrom(row)
  }

  getMandate(taskId: string): TaskMandate | undefined {
    const row = this.db.prepare('SELECT * FROM task_mandate WHERE task_id = ?').get(taskId) as {
      id: string; task_id: string; kind: string; specialist: string; session_id: string; policy_version: string;
      source_refs: string; visibility_ref: string; read_roots: string; write_roots: string; tools: string;
      output_kinds: string; max_input_bytes: number; max_run_ms: number; created_at: number
    } | undefined
    if (row === undefined) return undefined
    return {
      id: row.id, taskId: row.task_id, kind: row.kind, specialist: row.specialist, sessionId: row.session_id,
      policyVersion: row.policy_version, sourceRefs: parse<string[]>(row.source_refs), visibilityRef: row.visibility_ref,
      allowedReadRoots: parse<string[]>(row.read_roots), allowedWriteRoots: parse<string[]>(row.write_roots),
      allowedTools: parse<string[]>(row.tools), allowedOutputKinds: parse<string[]>(row.output_kinds),
      maxInputBytes: row.max_input_bytes, maxRunMs: row.max_run_ms, createdAt: row.created_at,
    }
  }

  getAssignment(id: string): TaskAssignment | undefined {
    const row = this.assignmentRow(id)
    return row === undefined ? undefined : assignmentFrom(row)
  }

  getReport(id: string): TaskReport | undefined {
    const row = this.reportRow(id)
    return row === undefined ? undefined : reportFrom(row)
  }

  getReportByAssignment(assignmentId: string): TaskReport | undefined {
    const row = this.db.prepare('SELECT * FROM task_report WHERE assignment_id = ?').get(assignmentId) as ReportRow | undefined
    return row === undefined ? undefined : reportFrom(row)
  }

  private observation(id: string): Observation | undefined {
    const row = this.db.prepare('SELECT * FROM surface_observations WHERE id = ?').get(id) as ObservationRow | undefined
    return row === undefined ? undefined : observation(row)
  }

  private allowedSources(triggerRef: string): { allowed: Set<string>; inherited?: string[] } {
    if (triggerRef.startsWith('batch/batch_')) {
      const batchId = triggerRef.slice('batch/'.length)
      const batch = this.db.prepare('SELECT id FROM batches WHERE id = ?').get(batchId)
      if (batch === undefined) throw new DispatchError('TRIGGER_NOT_CURRENT', '当前 Batch 不存在')
      const rows = this.db.prepare(`SELECT bi.observation_id FROM batch_items bi
        JOIN batches b ON b.id = bi.batch_id
        WHERE b.trigger_group_id = ? OR b.id = ?
        ORDER BY b.created_at, bi.position`).all(batchId, batchId) as unknown as { observation_id: string }[]
      return { allowed: new Set(rows.map(row => `observation/${row.observation_id}`)) }
    }
    if (triggerRef.startsWith('report/report_')) {
      const reportId = triggerRef.slice('report/'.length)
      const report = this.reportRow(reportId)
      if (report === undefined) throw new DispatchError('TRIGGER_NOT_CURRENT', '当前 Report 不存在')
      const task = this.taskRow(report.task_id)
      if (task === undefined) throw new DispatchError('SOURCE_MATERIAL_UNAVAILABLE', 'Report 原任务不存在')
      return { allowed: new Set(parse<string[]>(task.source_refs)), inherited: parse<string[]>(task.source_refs) }
    }
    throw new DispatchError('TRIGGER_NOT_CURRENT', 'trigger_ref 不是当前 Batch 或 Report')
  }

  private sourceObservations(triggerRef: string, refs: string[]): Observation[] {
    if (refs.length === 0 || refs.length > 20 || new Set(refs).size !== refs.length) {
      throw new DispatchError('VALIDATION_FAILED', 'source_refs 必须包含 1～20 个不重复来源')
    }
    const { allowed } = this.allowedSources(triggerRef)
    const result: Observation[] = []
    for (const ref of refs) {
      if (!allowed.has(ref)) throw new DispatchError('SOURCE_NOT_ALLOWED', `来源不属于当前输入：${ref}`)
      const item = this.observation(sourceId(ref))
      if (item === undefined) throw new DispatchError('SOURCE_MATERIAL_UNAVAILABLE', `来源正文不存在：${ref}`)
      result.push(item)
    }
    const visibility = new Set(result.map(item => item.visibilityRef))
    if (visibility.size !== 1) throw new DispatchError('VISIBILITY_CONFLICT', '最小派工不允许跨可见性域合并来源')
    return result
  }

  createTask(input: DispatchInput, formation: Formation): {
    task_id: string; assignment_id: string; kind: string; state: 'assigned'; idempotent_replay: boolean
  } {
    if (formation.triggerRef !== input.trigger_ref) throw new DispatchError('TRIGGER_NOT_CURRENT', '只能为当前真实输入派工')
    if (formation.sessionId !== 'elysia-subconscious-router') throw new DispatchError('ASSIGNMENT_NOT_OWNED', '只有 Router 可以派工')
    if (input.kind !== 'memory') throw new DispatchError('KIND_NOT_REGISTERED', `未注册任务类型：${input.kind}`)
    for (const [field, value, maximum] of [
      ['title', input.title, 120], ['reason', input.reason, 2000], ['instruction', input.instruction, 8000],
    ] as const) {
      if (typeof value !== 'string' || value.trim().length === 0 || value.length > maximum) {
        throw new DispatchError('VALIDATION_FAILED', `${field} 长度或内容无效`)
      }
    }
    const observations = this.sourceObservations(input.trigger_ref, input.source_refs)
    const inputBytes = Buffer.byteLength(JSON.stringify({
      title: input.title, reason: input.reason, instruction: input.instruction,
      observations: observations.map(item => item.content),
    }))
    if (inputBytes > this.maxInputBytes) throw new DispatchError('SOURCE_MATERIAL_TOO_LARGE', '任务包超过输入预算')
    const hash = requestHash(input)
    return this.transaction(() => {
      const existing = this.db.prepare('SELECT response FROM dispatch_request WHERE trigger_ref = ? AND request_hash = ?')
        .get(input.trigger_ref, hash) as { response: string } | undefined
      if (existing !== undefined) return { ...parse<{
        task_id: string; assignment_id: string; kind: string; state: 'assigned'; idempotent_replay: boolean
      }>(existing.response), idempotent_replay: true }
      const requestCount = this.db.prepare('SELECT COUNT(*) AS count FROM dispatch_request WHERE trigger_ref = ?')
        .get(input.trigger_ref) as { count: number }
      if (requestCount.count >= this.maxTasksPerTrigger) throw new DispatchError('BUDGET_EXCEEDED', '当前输入的派工数量已达上限')
      const queued = this.db.prepare(`SELECT COUNT(*) AS count FROM subconscious_task
        WHERE kind = 'memory' AND state IN ('assigned','running','report_pending')`).get() as { count: number }
      if (queued.count >= this.maxQueuedTasks) throw new DispatchError('BUDGET_EXCEEDED', '记忆专业待处理任务已达上限')
      const dedupeKey = createHash('sha256').update(JSON.stringify({
        kind: input.kind, visibility: observations[0]!.visibilityRef, sources: [...input.source_refs].sort(),
      })).digest('hex')
      const active = this.db.prepare(`SELECT id FROM subconscious_task WHERE dedupe_key = ?
        AND state IN ('assigned','running','report_pending') LIMIT 1`).get(dedupeKey) as { id: string } | undefined
      if (active !== undefined) throw new DispatchError('ACTIVE_TASK_EXISTS', `已有活动任务 ${active.id}`, false, active.id)

      const now = Date.now()
      const taskId = `task_${randomUUID()}`
      const mandateId = `mandate_${randomUUID()}`
      const assignmentId = `assignment_${randomUUID()}`
      const deliveryId = `delivery_${randomUUID()}`
      const formationRecord: Formation = { ...formation }
      this.db.prepare(`INSERT INTO subconscious_task(
        id, revision, kind, title, reason, instruction, source_refs, formation, mandate_id, dedupe_key,
        visibility_ref, state, current_assignment_id, created_at, updated_at
      ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'assigned', ?, ?, ?)`).run(
        taskId, input.kind, input.title.trim(), input.reason.trim(), input.instruction.trim(), JSON.stringify(input.source_refs),
        JSON.stringify(formationRecord), mandateId, dedupeKey, observations[0]!.visibilityRef, assignmentId, now, now,
      )
      this.db.prepare(`INSERT INTO task_mandate(
        id, task_id, kind, specialist, session_id, policy_version, source_refs, visibility_ref,
        read_roots, write_roots, tools, output_kinds, max_input_bytes, max_run_ms, created_at
      ) VALUES (?, ?, ?, 'memory', ?, 'dispatch-v1', ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        mandateId, taskId, input.kind, String(MEMORY_SESSION_ID), JSON.stringify(input.source_refs), observations[0]!.visibilityRef,
        JSON.stringify([this.memoryWorkspaceDir]), JSON.stringify([this.memoryWorkspaceDir]),
        JSON.stringify(['read', 'read_image', 'write', 'edit', 'glob', 'grep', 'subconscious_report']),
        JSON.stringify(['file', 'tool']), this.maxInputBytes, this.maxRunMs, now,
      )
      this.db.prepare(`INSERT INTO task_assignment(
        id, task_id, task_revision, specialist, session_id, attempt, state, delivery_id, input_refs, created_at
      ) VALUES (?, ?, 1, 'memory', ?, 1, 'pending', ?, ?, ?)`).run(
        assignmentId, taskId, String(MEMORY_SESSION_ID), deliveryId, JSON.stringify(input.source_refs), now,
      )
      this.db.prepare(`INSERT INTO dispatch_effect(
        id, kind, target_session_id, aggregate_id, state, attempt_count, available_at, created_at
      ) VALUES (?, 'deliver_assignment', ?, ?, 'pending', 0, ?, ?)`).run(
        `effect_${randomUUID()}`, String(MEMORY_SESSION_ID), assignmentId, now, now,
      )
      const response = { task_id: taskId, assignment_id: assignmentId, kind: input.kind, state: 'assigned' as const, idempotent_replay: false }
      this.db.prepare(`INSERT INTO dispatch_request(trigger_ref, request_hash, task_id, response, created_at)
        VALUES (?, ?, ?, ?, ?)`).run(input.trigger_ref, hash, taskId, JSON.stringify(response), now)
      return response
    })
  }

  getTaskPackage(assignmentId: string): {
    task: SubconsciousTask; assignment: TaskAssignment; mandate: TaskMandate; observations: Observation[]
  } {
    const assignment = this.getAssignment(assignmentId)
    if (assignment === undefined) throw new DispatchError('ASSIGNMENT_NOT_CURRENT', 'Assignment 不存在')
    const task = this.getTask(assignment.taskId)
    const mandate = this.getMandate(assignment.taskId)
    if (task === undefined || mandate === undefined) throw new DispatchError('SOURCE_MATERIAL_UNAVAILABLE', '任务或授权不存在')
    const observations = task.sourceRefs.map(ref => {
      const item = this.observation(sourceId(ref))
      if (item === undefined) throw new DispatchError('SOURCE_MATERIAL_UNAVAILABLE', `任务材料不存在：${ref}`)
      return item
    })
    return { task, assignment, mandate, observations }
  }

  nextAssignment(now = Date.now()): TaskAssignment | undefined {
    return this.transaction(() => {
      const row = this.db.prepare(`SELECT a.* FROM task_assignment a
        JOIN dispatch_effect e ON e.kind = 'deliver_assignment' AND e.aggregate_id = a.id
        WHERE e.state IN ('pending','retry_wait') AND e.available_at <= ?
          AND a.state IN ('pending','delivering','running','report_pending','interrupted')
        ORDER BY a.created_at LIMIT 1`).get(now) as AssignmentRow | undefined
      if (row === undefined) return undefined
      if (row.state === 'pending' || row.state === 'interrupted') {
        this.db.prepare(`UPDATE task_assignment SET state = 'delivering', last_error = NULL WHERE id = ?`).run(row.id)
        row.state = 'delivering'
      }
      return assignmentFrom(row)
    })
  }

  markAssignmentAccepted(id: string, sessionSeq: number, acceptedAt = Date.now()): void {
    this.db.prepare(`UPDATE task_assignment SET session_seq = COALESCE(session_seq, ?),
      accepted_at = COALESCE(accepted_at, ?) WHERE id = ?`).run(sessionSeq, acceptedAt, id)
  }

  markAssignmentPresented(id: string, turn?: number, step?: number, presentedAt = Date.now()): void {
    this.transaction(() => {
      this.db.prepare(`UPDATE task_assignment SET state = 'running', presented_turn = COALESCE(?, presented_turn),
        presented_step = COALESCE(?, presented_step), presented_at = COALESCE(presented_at, ?) WHERE id = ?`)
        .run(turn ?? null, step ?? null, presentedAt, id)
      this.db.prepare(`UPDATE subconscious_task SET state = 'running', updated_at = ?
        WHERE current_assignment_id = ? AND state IN ('assigned','running','report_pending')`).run(presentedAt, id)
    })
  }

  markReportPending(assignmentId: string): void {
    this.transaction(() => {
      const now = Date.now()
      this.db.prepare(`UPDATE task_assignment SET state = 'report_pending' WHERE id = ? AND state != 'ended'`).run(assignmentId)
      this.db.prepare(`UPDATE subconscious_task SET state = 'report_pending', updated_at = ?
        WHERE current_assignment_id = ? AND state IN ('assigned','running','report_pending')`).run(now, assignmentId)
    })
  }

  failMissingReport(assignmentId: string): void {
    this.transaction(() => {
      const now = Date.now()
      this.db.prepare(`UPDATE task_assignment SET state = 'ended', ended_at = ?, last_error = 'REPORT_MISSING' WHERE id = ?`).run(now, assignmentId)
      this.db.prepare(`UPDATE subconscious_task SET state = 'failed', updated_at = ?, closed_at = ?, close_reason = 'REPORT_MISSING'
        WHERE current_assignment_id = ? AND state IN ('assigned','running','report_pending')`).run(now, now, assignmentId)
    })
  }

  completeDelivery(assignmentId: string): void {
    this.transaction(() => {
      const now = Date.now()
      this.db.prepare(`UPDATE dispatch_effect SET state = 'completed', completed_at = ?, last_error = NULL
        WHERE kind = 'deliver_assignment' AND aggregate_id = ?`).run(now, assignmentId)
      if (this.getReportByAssignment(assignmentId) === undefined) {
        const assignment = this.assignmentRow(assignmentId)
        if (assignment?.state !== 'ended') {
          this.db.prepare(`UPDATE task_assignment SET state = 'report_pending' WHERE id = ?`).run(assignmentId)
          this.db.prepare(`UPDATE subconscious_task SET state = 'report_pending', updated_at = ?
            WHERE current_assignment_id = ? AND state IN ('assigned','running','report_pending')`).run(now, assignmentId)
        }
      }
    })
  }

  failDelivery(assignmentId: string, message: string, retryAt: number): void {
    this.transaction(() => {
      this.db.prepare(`UPDATE task_assignment SET state = 'interrupted', last_error = ? WHERE id = ? AND state != 'ended'`).run(message, assignmentId)
      this.db.prepare(`UPDATE dispatch_effect SET state = 'retry_wait', attempt_count = attempt_count + 1,
        available_at = ?, last_error = ? WHERE kind = 'deliver_assignment' AND aggregate_id = ?`).run(retryAt, message, assignmentId)
    })
  }

  saveReport(input: ReportInput, identity: { sessionId: string; toolCallId: string; turn?: number }): {
    report: TaskReport; idempotentReplay: boolean; relayState: string
  } {
    const hash = reportHash(input)
    return this.transaction(() => {
      const existing = this.db.prepare('SELECT * FROM task_report WHERE assignment_id = ?').get(input.assignment_id) as ReportRow | undefined
      if (existing !== undefined) {
        if (existing.session_id !== identity.sessionId) throw new DispatchError('ASSIGNMENT_NOT_OWNED', '当前 Session 不拥有此 Assignment')
        if (existing.request_hash !== hash) throw new DispatchError('REPORT_CONFLICT', '当前 Assignment 已有不同终态报告')
        const effect = this.db.prepare(`SELECT state FROM dispatch_effect WHERE kind = 'relay_report' AND aggregate_id = ?`).get(existing.id) as { state: string } | undefined
        return { report: reportFrom(existing), idempotentReplay: true, relayState: effect?.state ?? 'pending' }
      }
      const assignment = this.assignmentRow(input.assignment_id)
      if (assignment === undefined || assignment.task_id !== input.task_id || assignment.state === 'ended') {
        throw new DispatchError('ASSIGNMENT_NOT_CURRENT', 'Assignment 不存在、任务不符或已经结束')
      }
      if (assignment.session_id !== identity.sessionId) throw new DispatchError('ASSIGNMENT_NOT_OWNED', '当前 Session 不拥有此 Assignment')
      if (input.summary.trim().length === 0 || input.summary.length > 4000) throw new DispatchError('VALIDATION_FAILED', 'summary 无效')
      if (input.status === 'dropped' && input.output_refs.length !== 0) throw new DispatchError('VALIDATION_FAILED', 'dropped 不应声明产物')
      const now = Date.now()
      const reportId = `report_${randomUUID()}`
      this.db.prepare(`INSERT INTO task_report(
        id, task_id, assignment_id, specialist, session_id, turn, tool_call_id, status, summary,
        output_refs, request_hash, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        reportId, input.task_id, input.assignment_id, assignment.specialist, identity.sessionId, identity.turn ?? null,
        identity.toolCallId, input.status, input.summary.trim(), JSON.stringify(input.output_refs), hash, now,
      )
      this.db.prepare(`UPDATE task_assignment SET state = 'ended', ended_at = ?, last_error = NULL WHERE id = ?`).run(now, input.assignment_id)
      this.db.prepare(`UPDATE subconscious_task SET state = ?, updated_at = ?, closed_at = ?, close_reason = NULL
        WHERE id = ? AND current_assignment_id = ?`).run(input.status, now, now, input.task_id, input.assignment_id)
      this.db.prepare(`INSERT INTO dispatch_effect(
        id, kind, target_session_id, aggregate_id, state, attempt_count, available_at, created_at
      ) VALUES (?, 'relay_report', 'elysia-subconscious-router', ?, 'pending', 0, ?, ?)`).run(
        `effect_${randomUUID()}`, reportId, now, now,
      )
      const report = this.getReport(reportId)!
      return { report, idempotentReplay: false, relayState: 'pending' }
    })
  }

  nextReportRelay(now = Date.now()): TaskReport | undefined {
    const row = this.db.prepare(`SELECT r.* FROM task_report r
      JOIN dispatch_effect e ON e.kind = 'relay_report' AND e.aggregate_id = r.id
      WHERE e.state IN ('pending','retry_wait') AND e.available_at <= ?
      ORDER BY r.created_at LIMIT 1`).get(now) as ReportRow | undefined
    return row === undefined ? undefined : reportFrom(row)
  }

  completeReportRelay(reportId: string): void {
    this.db.prepare(`UPDATE dispatch_effect SET state = 'completed', completed_at = ?, last_error = NULL
      WHERE kind = 'relay_report' AND aggregate_id = ?`).run(Date.now(), reportId)
  }

  failReportRelay(reportId: string, message: string, retryAt: number): void {
    this.db.prepare(`UPDATE dispatch_effect SET state = 'retry_wait', attempt_count = attempt_count + 1,
      available_at = ?, last_error = ? WHERE kind = 'relay_report' AND aggregate_id = ?`).run(retryAt, message, reportId)
  }

  /** Attempts already recorded on the delivery Effect of this Assignment. */
  deliveryAttempts(assignmentId: string): number {
    return this.attempts('deliver_assignment', assignmentId)
  }

  /** Attempts already recorded on the relay Effect of this Report. */
  reportRelayAttempts(reportId: string): number {
    return this.attempts('relay_report', reportId)
  }

  private attempts(kind: 'deliver_assignment' | 'relay_report', aggregateId: string): number {
    const row = this.db.prepare('SELECT attempt_count FROM dispatch_effect WHERE kind = ? AND aggregate_id = ?')
      .get(kind, aggregateId) as { attempt_count: number } | undefined
    return row?.attempt_count ?? 0
  }

  /** End a delivery whose retry budget is spent: the Effect is terminal and the Assignment stops retrying. */
  abandonDelivery(assignmentId: string, message: string): void {
    this.transaction(() => {
      const now = Date.now()
      // A terminal Report proves the specialist was reached; that Effect is a success, not a failure.
      if (this.getReportByAssignment(assignmentId) !== undefined) {
        this.db.prepare(`UPDATE dispatch_effect SET state = 'completed', completed_at = ?, last_error = NULL
          WHERE kind = 'deliver_assignment' AND aggregate_id = ?`).run(now, assignmentId)
        return
      }
      this.db.prepare(`UPDATE dispatch_effect SET state = 'failed', available_at = ?, last_error = ?
        WHERE kind = 'deliver_assignment' AND aggregate_id = ?`).run(now, message, assignmentId)
      this.db.prepare(`UPDATE task_assignment SET state = 'interrupted', last_error = ? WHERE id = ? AND state != 'ended'`)
        .run(message, assignmentId)
      // Leaving the Task active would keep blocking its dedupe key and inflate activeTasks forever.
      this.db.prepare(`UPDATE subconscious_task SET state = 'failed', updated_at = ?, closed_at = ?,
        close_reason = 'DELIVERY_ATTEMPTS_EXHAUSTED'
        WHERE current_assignment_id = ? AND state IN ('assigned','running','report_pending')`).run(now, now, assignmentId)
    })
  }

  /** End a Report relay whose retry budget is spent; the Report itself stays readable. */
  abandonReportRelay(reportId: string, message: string): void {
    this.db.prepare(`UPDATE dispatch_effect SET state = 'failed', available_at = ?, last_error = ?
      WHERE kind = 'relay_report' AND aggregate_id = ?`).run(Date.now(), message, reportId)
  }

  recover(): void {
    this.transaction(() => {
      const now = Date.now()
      // A Report already ends its Assignment. Reconcile any stale delivery Effect left by a
      // crash or a later context-overflow instead of waiting forever for an ineligible retry.
      this.db.prepare(`UPDATE dispatch_effect SET state = 'completed', completed_at = ?, last_error = NULL
        WHERE kind = 'deliver_assignment' AND state != 'completed'
          AND EXISTS (SELECT 1 FROM task_report r WHERE r.assignment_id = dispatch_effect.aggregate_id)`).run(now)
      this.db.prepare(`UPDATE task_assignment SET state = 'interrupted' WHERE state = 'delivering'`).run()
      this.db.prepare(`UPDATE dispatch_effect SET state = 'pending' WHERE state = 'running'`).run()
    })
  }

  listTasks(): SubconsciousTask[] {
    return (this.db.prepare('SELECT * FROM subconscious_task ORDER BY created_at').all() as unknown as TaskRow[]).map(taskFrom)
  }

  listReports(): TaskReport[] {
    return (this.db.prepare('SELECT * FROM task_report ORDER BY created_at').all() as unknown as ReportRow[]).map(reportFrom)
  }

  nextWakeAt(): number | undefined {
    const row = this.db.prepare(`SELECT MIN(available_at) AS next FROM dispatch_effect WHERE state = 'retry_wait'`).get() as { next: number | null }
    return row.next ?? undefined
  }

  health(): DispatchHealth {
    const count = (sql: string): number => (this.db.prepare(sql).get() as { count: number }).count
    const lastTask = this.db.prepare('SELECT MAX(created_at) AS time FROM subconscious_task').get() as { time: number | null }
    const lastReport = this.db.prepare('SELECT MAX(created_at) AS time FROM task_report').get() as { time: number | null }
    return {
      tasks: count('SELECT COUNT(*) AS count FROM subconscious_task'),
      activeTasks: count(`SELECT COUNT(*) AS count FROM subconscious_task WHERE state IN ('assigned','running','report_pending')`),
      completedTasks: count(`SELECT COUNT(*) AS count FROM subconscious_task WHERE state = 'completed'`),
      pendingAssignments: count(`SELECT COUNT(*) AS count FROM dispatch_effect
        WHERE kind = 'deliver_assignment' AND state IN ('pending','running','retry_wait')`),
      pendingReportRelays: count(`SELECT COUNT(*) AS count FROM dispatch_effect
        WHERE kind = 'relay_report' AND state IN ('pending','running','retry_wait')`),
      failedEffects: count(`SELECT COUNT(*) AS count FROM dispatch_effect WHERE state = 'failed'`),
      ...lastTask.time === null ? {} : { lastTaskAt: new Date(lastTask.time).toISOString() },
      ...lastReport.time === null ? {} : { lastReportAt: new Date(lastReport.time).toISOString() },
    }
  }

  close(): void {
    this.db.close()
  }
}

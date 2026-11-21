import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export type MessageContent = { type: 'text'; text: string } | { type: 'attachment_ref'; ref: string }

export class CommunicationError extends Error {
  constructor(readonly code: string, message: string, readonly retryable = false) {
    super(message)
    this.name = 'CommunicationError'
  }
}

export interface DeliveryError {
  code: string
  message: string
  retryable: boolean
}

export interface StoredMessage {
  id: string
  conversationId: string
  senderSessionId: string
  targetSessionId: string
  content: unknown[]
  contentHash: string
  replyTo?: string
  storedAt: number
  deliveryState: 'stored' | 'queued' | 'accepted' | 'unknown'
  queuedAt?: number
  acceptedAt?: number
  modelPresentedAt?: number
  targetEventSeq?: number
  requestRef?: string
  turn?: number
  step?: number
  endedAt?: number
  turnEndReason?: string
  attemptCount: number
  nextAttemptAt: number
  lastError?: DeliveryError
}

export interface SaveMessage {
  senderSessionId: string
  targetSessionId: string
  content: readonly unknown[]
  conversationId?: string
  replyTo?: string
  idempotencyKey?: string
  callIdentity?: string
  maxPending?: number
}

interface MessageRow {
  id: string
  conversation_id: string
  sender_session_id: string
  target_session_id: string
  content: string
  content_hash: string
  request_hash: string
  reply_to: string | null
  stored_at: number
  delivery_state: StoredMessage['deliveryState']
  queued_at: number | null
  accepted_at: number | null
  presented_at: number | null
  target_event_seq: number | null
  request_ref: string | null
  turn: number | null
  step: number | null
  ended_at: number | null
  turn_end_reason: string | null
  attempt_count: number
  next_attempt_at: number
  last_error: string | null
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function message(row: MessageRow): StoredMessage {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    senderSessionId: row.sender_session_id,
    targetSessionId: row.target_session_id,
    content: JSON.parse(row.content) as unknown[],
    contentHash: row.content_hash,
    storedAt: row.stored_at,
    deliveryState: row.delivery_state,
    attemptCount: row.attempt_count,
    nextAttemptAt: row.next_attempt_at,
    ...row.reply_to === null ? {} : { replyTo: row.reply_to },
    ...row.queued_at === null ? {} : { queuedAt: row.queued_at },
    ...row.accepted_at === null ? {} : { acceptedAt: row.accepted_at },
    ...row.presented_at === null ? {} : { modelPresentedAt: row.presented_at },
    ...row.target_event_seq === null ? {} : { targetEventSeq: row.target_event_seq },
    ...row.request_ref === null ? {} : { requestRef: row.request_ref },
    ...row.turn === null ? {} : { turn: row.turn },
    ...row.step === null ? {} : { step: row.step },
    ...row.ended_at === null ? {} : { endedAt: row.ended_at },
    ...row.turn_end_reason === null ? {} : { turnEndReason: row.turn_end_reason },
    ...row.last_error === null ? {} : { lastError: JSON.parse(row.last_error) as DeliveryError },
  }
}

/** Durable message identity, per-peer ordering, and delivery evidence. */
export class CommunicationStore {
  private readonly db: DatabaseSync

  constructor(readonly stateDir: string) {
    mkdirSync(stateDir, { recursive: true, mode: 0o700 })
    this.db = new DatabaseSync(join(stateDir, 'communication.sqlite'))
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        row_number INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        conversation_id TEXT NOT NULL,
        sender_session_id TEXT NOT NULL,
        target_session_id TEXT NOT NULL,
        content TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        reply_to TEXT REFERENCES messages(id),
        stored_at INTEGER NOT NULL,
        delivery_state TEXT NOT NULL CHECK(delivery_state IN ('stored','queued','accepted','unknown')),
        queued_at INTEGER,
        accepted_at INTEGER,
        presented_at INTEGER,
        target_event_seq INTEGER,
        request_ref TEXT,
        turn INTEGER,
        step INTEGER,
        ended_at INTEGER,
        turn_end_reason TEXT,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL,
        last_error TEXT
      );
      CREATE TABLE IF NOT EXISTS message_keys (
        sender_session_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('idempotency','call')),
        value TEXT NOT NULL,
        message_id TEXT NOT NULL REFERENCES messages(id),
        PRIMARY KEY(sender_session_id,kind,value)
      );
      CREATE TABLE IF NOT EXISTS delivery_events (
        event_number INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id TEXT NOT NULL REFERENCES messages(id),
        kind TEXT NOT NULL,
        occurred_at INTEGER NOT NULL,
        details TEXT NOT NULL,
        evidence_hash TEXT NOT NULL,
        UNIQUE(message_id,kind,evidence_hash)
      );
      CREATE INDEX IF NOT EXISTS messages_outbox ON messages(accepted_at,next_attempt_at,row_number);
      CREATE INDEX IF NOT EXISTS messages_peer_order ON messages(sender_session_id,target_session_id,row_number);
    `)
  }

  close(): void { this.db.close() }

  private transaction<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = operation()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  private row(id: string): MessageRow | undefined {
    return this.db.prepare('SELECT * FROM messages WHERE id=?').get(id) as MessageRow | undefined
  }

  get(id: string): StoredMessage | undefined {
    const row = this.row(id)
    return row === undefined ? undefined : message(row)
  }

  private require(id: string): MessageRow {
    const row = this.row(id)
    if (row === undefined) throw new CommunicationError('MESSAGE_NOT_FOUND', '通讯消息不存在')
    return row
  }

  private evidence(id: string, kind: string, time: number, details: unknown): void {
    this.db.prepare(`INSERT OR IGNORE INTO delivery_events(message_id,kind,occurred_at,details,evidence_hash)
      VALUES (?,?,?,?,?)`).run(id, kind, time, JSON.stringify(details), digest(details))
  }

  save(input: SaveMessage): { message: StoredMessage; idempotentReplay: boolean } {
    if (!input.senderSessionId || !input.targetSessionId || !Array.isArray(input.content) || input.content.length === 0) {
      throw new CommunicationError('INVALID_ARGUMENT', '发送者、接收者和消息内容不能为空')
    }
    const content = JSON.stringify(input.content)
    const requestHash = digest({
      targetSessionId: input.targetSessionId,
      content: input.content,
      conversationId: input.conversationId ?? null,
      replyTo: input.replyTo ?? null,
    })
    const keys = [
      ...input.idempotencyKey === undefined ? [] : [{ kind: 'idempotency', value: input.idempotencyKey }],
      ...input.callIdentity === undefined ? [] : [{ kind: 'call', value: input.callIdentity }],
    ]
    if (keys.some(key => key.value.length === 0)) {
      throw new CommunicationError('INVALID_ARGUMENT', '幂等身份不能为空')
    }
    return this.transaction(() => {
      const previous = keys.flatMap(key => {
        const row = this.db.prepare(`SELECT m.* FROM messages m JOIN message_keys k ON k.message_id=m.id
          WHERE k.sender_session_id=? AND k.kind=? AND k.value=?`)
          .get(input.senderSessionId, key.kind, key.value) as MessageRow | undefined
        return row === undefined ? [] : [row]
      })
      let existing = previous[0]
      if (previous.some(row => row.id !== existing?.id || row.request_hash !== requestHash)) {
        throw new CommunicationError('IDEMPOTENCY_CONFLICT', '相同发送身份对应了不同的通讯内容')
      }
      if (existing !== undefined && existing.request_hash !== requestHash) {
        throw new CommunicationError('IDEMPOTENCY_CONFLICT', '相同发送身份对应了不同的通讯内容')
      }
      if (existing === undefined) {
        if (input.maxPending !== undefined) {
          const pending = this.db.prepare('SELECT COUNT(*) AS count FROM messages WHERE accepted_at IS NULL').get() as { count: number }
          if (pending.count >= input.maxPending) {
            throw new CommunicationError('CAPACITY_REACHED', '待投递容量已满，请稍后重试', true)
          }
        }
        const original = input.replyTo === undefined ? undefined : this.row(input.replyTo)
        if (input.replyTo !== undefined && original === undefined) {
          throw new CommunicationError('REFERENCE_NOT_VISIBLE', '回复引用的消息不存在')
        }
        if (original !== undefined && input.conversationId !== undefined && input.conversationId !== original.conversation_id) {
          throw new CommunicationError('INVALID_ARGUMENT', '回复引用与讨论身份不一致')
        }
        const id = `msg_${randomUUID()}`
        const now = Date.now()
        const conversationId = input.conversationId ?? original?.conversation_id ?? `conversation_${randomUUID()}`
        this.db.prepare(`INSERT INTO messages (
          id,conversation_id,sender_session_id,target_session_id,content,content_hash,request_hash,reply_to,
          stored_at,delivery_state,next_attempt_at
        ) VALUES (?,?,?,?,?,?,?,?,?,'stored',?)`).run(
          id, conversationId, input.senderSessionId, input.targetSessionId, content, digest(input.content),
          requestHash, input.replyTo ?? null, now, now,
        )
        this.evidence(id, 'stored', now, { senderSessionId: input.senderSessionId, targetSessionId: input.targetSessionId })
        existing = this.require(id)
      }
      for (const key of keys) {
        this.db.prepare('INSERT OR IGNORE INTO message_keys(sender_session_id,kind,value,message_id) VALUES (?,?,?,?)')
          .run(input.senderSessionId, key.kind, key.value, existing.id)
      }
      return { message: message(existing), idempotentReplay: previous.length > 0 }
    })
  }

  /** An earlier unaccepted message blocks only its own sender-to-target lane. */
  pending(now = Date.now(), limit = 20): StoredMessage[] {
    return (this.db.prepare(`SELECT m.* FROM messages m
      WHERE m.accepted_at IS NULL AND m.next_attempt_at <= ?
      AND NOT EXISTS (
        SELECT 1 FROM messages prior
        WHERE prior.sender_session_id=m.sender_session_id AND prior.target_session_id=m.target_session_id
          AND prior.row_number<m.row_number AND prior.accepted_at IS NULL
      )
      ORDER BY m.row_number LIMIT ?`).all(now, limit) as unknown as MessageRow[]).map(message)
  }

  nextWakeAt(): number | undefined {
    const row = this.db.prepare(`SELECT MIN(m.next_attempt_at) AS time FROM messages m
      WHERE m.accepted_at IS NULL AND NOT EXISTS (
        SELECT 1 FROM messages prior WHERE prior.sender_session_id=m.sender_session_id
        AND prior.target_session_id=m.target_session_id AND prior.row_number<m.row_number AND prior.accepted_at IS NULL
      )`).get() as { time: number | null }
    return row.time ?? undefined
  }

  recordQueued(id: string, time = Date.now(), nextCheck = time): void {
    this.transaction(() => {
      this.require(id)
      this.db.prepare(`UPDATE messages SET queued_at=COALESCE(queued_at,?),
        delivery_state=CASE WHEN accepted_at IS NULL THEN 'queued' ELSE 'accepted' END,
        next_attempt_at=? WHERE id=?`).run(time, nextCheck, id)
      this.evidence(id, 'queued', time, {})
    })
  }

  recordAccepted(id: string, eventSeq: number, time = Date.now()): void {
    this.transaction(() => {
      const row = this.require(id)
      if (row.target_event_seq !== null && row.target_event_seq !== eventSeq) {
        this.evidence(id, 'additional-acceptance', time, { eventSeq })
        return
      }
      this.db.prepare(`UPDATE messages SET accepted_at=COALESCE(accepted_at,?),target_event_seq=COALESCE(target_event_seq,?),
        delivery_state='accepted',last_error=NULL WHERE id=?`).run(time, eventSeq, id)
      this.evidence(id, 'accepted', time, { eventSeq })
    })
  }

  recordPresented(id: string, input: { requestRef?: string; turn?: number; step?: number; time?: number }): void {
    this.transaction(() => {
      this.require(id)
      const time = input.time ?? Date.now()
      this.db.prepare(`UPDATE messages SET presented_at=COALESCE(presented_at,?),request_ref=COALESCE(request_ref,?),
        turn=COALESCE(turn,?),step=COALESCE(step,?) WHERE id=?`)
        .run(time, input.requestRef ?? null, input.turn ?? null, input.step ?? null, id)
      this.evidence(id, 'model-presented', time, {
        requestRef: input.requestRef ?? null, turn: input.turn ?? null, step: input.step ?? null,
      })
    })
  }

  recordTurnEnd(id: string, input: { turn: number; time?: number; reason: string }): void {
    this.transaction(() => {
      const row = this.require(id)
      const time = input.time ?? Date.now()
      if (row.turn === null || row.turn === input.turn) {
        this.db.prepare(`UPDATE messages SET turn=COALESCE(turn,?),ended_at=COALESCE(ended_at,?),
          turn_end_reason=COALESCE(turn_end_reason,?) WHERE id=?`).run(input.turn, time, input.reason, id)
      }
      this.evidence(id, 'turn-ended', time, { turn: input.turn, reason: input.reason })
    })
  }

  recordFailure(id: string, error: DeliveryError, nextAttemptAt: number): void {
    this.transaction(() => {
      const row = this.require(id)
      const now = Date.now()
      this.db.prepare(`UPDATE messages SET attempt_count=attempt_count+1,last_error=?,
        next_attempt_at=?,delivery_state=CASE WHEN accepted_at IS NULL THEN 'unknown' ELSE 'accepted' END WHERE id=?`)
        .run(row.accepted_at === null ? JSON.stringify(error) : null, nextAttemptAt, id)
      this.evidence(id, 'delivery-failed', now, { error, attempt: row.attempt_count + 1, nextAttemptAt })
    })
  }

  events(id: string): Array<{ kind: string; occurredAt: number; details: unknown }> {
    this.require(id)
    return (this.db.prepare(`SELECT kind,occurred_at,details FROM delivery_events WHERE message_id=? ORDER BY event_number`)
      .all(id) as Array<{ kind: string; occurred_at: number; details: string }>)
      .map(row => ({ kind: row.kind, occurredAt: row.occurred_at, details: JSON.parse(row.details) as unknown }))
  }

  replies(id: string): StoredMessage[] {
    this.require(id)
    return (this.db.prepare('SELECT * FROM messages WHERE reply_to=? ORDER BY row_number').all(id) as unknown as MessageRow[]).map(message)
  }
}

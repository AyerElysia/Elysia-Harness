import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import { afterAll, describe, expect, it } from 'vitest'
import { MAIN_SOURCE_INSTANCE, MAIN_SOURCE_KIND, batchContent, observationFromMainEvent } from '../src/model.ts'
import { BATCH_ATTEMPTS_EXHAUSTED, RouterStore } from '../src/store.ts'

const home = mkdtempSync(join(tmpdir(), 'elysia-router-store-'))
afterAll(() => rmSync(home, { recursive: true, force: true }))

function input(seq: number, text: string, source: object = { kind: 'user' }): SessionEvent {
  return {
    type: 'user/message', seq: SessionSeq(seq), time: 1000 + seq,
    data: createUserMessage({ content: [{ type: 'text', text }], source: source as never }),
  } as SessionEvent
}

function event(seq: number, type: string, data: object): SessionEvent {
  return { type, seq: SessionSeq(seq), time: 1000 + seq, data } as SessionEvent
}

describe('durable Router store', () => {
  it('retains input, filters framework context, deduplicates, and completes native turns', () => {
    const store = new RouterStore(join(home, 'flow'))
    try {
      expect(store.recordEvent(input(0, 'framework', { kind: 'runtime-context' }))).toBe(true)
      expect(store.recordEvent(input(1, '第一条'))).toBe(true)
      expect(store.recordEvent(input(1, '第一条'))).toBe(false)
      expect(store.recordEvent(input(2, '第二条'))).toBe(true)
      expect(store.health().observations).toBe(2)
      expect(store.formBatches(20, 65536)).toBe(1)
      const batch = store.nextBatch()!
      expect(batch.observations.map(item => item.eventSeq)).toEqual([1, 2])
      store.markPresenting(batch.id)
      store.markAccepted(batch.id, 50, 2000)
      store.markPresented(batch.id, 1, 1, 2001)
      store.markCompleted(batch.id, 1, 3000)
      expect(store.getBatch(batch.id)).toMatchObject({
        state: 'decided', sessionSeq: 50, acceptedAt: 2000, presentedTurn: 1, presentedStep: 1,
        completedTurn: 1, completedAt: 3000,
      })
      expect(store.getBatch(batch.id)?.observations.every(item => item.reviewState === 'reviewed')).toBe(true)
      expect(store.health().pendingObservations).toBe(0)
      expect(store.health().completedBatches).toBe(1)
      expect(store.nextBatch()).toBeUndefined()
    } finally { store.close() }
  })

  it('keeps independent source identities, cursors, and observations across reopen', () => {
    const dir = join(home, 'restart')
    const store = new RouterStore(dir)
    store.recordEvent(input(0, '重启前'))
    store.recordObservation({
      source: { kind: 'email', instance: 'personal', eventId: 'message-1' }, kind: 'external_event',
      occurredAt: 5000, payload: { subject: '邮件原文' }, content: [{ type: 'text', text: '邮件正文' }],
      threadRefs: ['email:personal:message-1'], visibilityRef: 'email:personal',
    }, 9)
    store.close()
    const reopened = new RouterStore(dir)
    try {
      expect(reopened.sourceCursor()).toBe(0)
      expect(reopened.sourceCursor('email', 'personal')).toBe(9)
      expect(reopened.health().observations).toBe(2)
      expect(reopened.recordEvent(input(0, '重启前'))).toBe(false)
      expect(reopened.recordObservation({
        source: { kind: 'email', instance: 'personal', eventId: 'message-1' }, kind: 'external_event',
        occurredAt: 5000, payload: { subject: '邮件原文' }, content: [{ type: 'text', text: '邮件正文' }],
        threadRefs: ['email:personal:message-1'], visibilityRef: 'email:personal',
      })).toBe(false)
      expect(reopened.listObservations({ thread: 'email:personal:message-1' })).toHaveLength(1)
      expect(reopened.formBatches(20, 65536)).toBe(1)
      expect(reopened.nextBatch()!.observations.map(item => item.source.kind)).toEqual([MAIN_SOURCE_KIND, 'email'])
    } finally { reopened.close() }
  })

  it('projects all four main surface event kinds without hidden reasoning or framework prompts', () => {
    const store = new RouterStore(join(home, 'surface'))
    try {
      store.recordEvent(input(0, '系统框架', { kind: 'agent-instructions' }))
      store.recordEvent(input(1, '渠道 kook ｜ 会话 kook:direct:42 ｜ 消息id m1\n你好', { kind: 'user', elysiaIngress: 'platform' }))
      store.recordEvent(event(2, 'assistant/message', {
        turn: 3, step: 1, interrupted: false,
        message: { id: 'assistant-1', source: { provider: 'mock', model: 'fixture' }, content: [
          { type: 'reasoning', text: '不应进入表界' }, { type: 'text', text: '可见回复' },
        ] },
      }))
      store.recordEvent(event(3, 'tool/call', {
        turn: 3, step: 2, callId: 'call-1', name: 'send_text',
        arguments: JSON.stringify({ channel: 'kook', conversation: 'kook:direct:42', content: '可见回复' }),
      }))
      store.recordEvent(event(4, 'tool/result', {
        message: { toolCallId: 'call-1', isError: false, content: [{ type: 'text', text: '发送成功' }] },
      }))
      expect(store.health().observations).toBe(4)
      const all = store.listObservations()
      expect(all.map(item => item.kind)).toEqual(['external_input', 'conscious_output', 'conscious_tool_call', 'tool_result'])
      expect(JSON.stringify(all)).not.toContain('不应进入表界')
      expect(JSON.stringify(all)).not.toContain('系统框架')
      expect(all[2]?.threadRefs).toEqual(['kook:direct:42'])
      expect(all[3]).toMatchObject({ turn: 3, step: 2, threadRefs: ['kook:direct:42'], correlationRefs: [all[2]!.id] })
    } finally { store.close() }
  })

  it('retains internal communication turns without creating another Router batch after restart', () => {
    const dir = join(home, 'internal-turn-restart')
    let store = new RouterStore(dir)
    store.recordEvent(event(0, 'turn/start', { turn: 8 }))
    store.recordEvent(input(1, '内部消息材料', { kind: 'elysia-session-communication', messageId: 'msg-one' }))
    store.close()
    store = new RouterStore(dir)
    try {
      store.recordEvent(event(2, 'assistant/message', {
        turn: 8, step: 1, message: {
          id: 'internal-answer', source: { provider: 'mock', model: 'fixture' },
          content: [{ type: 'text', text: '内部回复' }],
        },
      }))
      store.recordEvent(event(3, 'tool/call', {
        turn: 8, step: 1, callId: 'internal-file-call', name: 'read', arguments: '{"file_path":"note.md"}',
      }))
      store.recordEvent(event(4, 'tool/result', {
        message: { toolCallId: 'internal-file-call', content: [{ type: 'text', text: '原有笔记' }] },
      }))
      store.recordEvent(event(5, 'turn/end', { turn: 8, reason: { kind: 'completed' } }))
      expect(store.listObservations()).toHaveLength(4)
      expect(store.listObservations().every(item => item.reviewState === 'reviewed')).toBe(true)
      expect(store.formBatches(20, 65536)).toBe(0)
      expect(store.sourceCursor()).toBe(5)

      store.recordEvent(event(6, 'turn/start', { turn: 9 }))
      store.recordEvent(input(7, '新的 KOOK 输入', { kind: 'user', elysiaIngress: 'platform' }))
      store.recordEvent(event(8, 'assistant/message', {
        turn: 9, step: 1, message: {
          id: 'external-answer', source: { provider: 'mock', model: 'fixture' },
          content: [{ type: 'text', text: '对新输入的回复' }],
        },
      }))
      expect(store.formBatches(20, 65536)).toBe(1)
      expect(store.nextBatch()?.observations.map(item => item.source.eventId)).toEqual(['7', '8'])
    } finally { store.close() }
  })

  it('keeps external input and subsequent work when it arrives within an internal turn', () => {
    const store = new RouterStore(join(home, 'mixed-turn'))
    try {
      store.recordEvent(event(0, 'turn/start', { turn: 3 }))
      store.recordEvent(input(1, '来自记忆的内部消息', { kind: 'elysia-session-communication' }))
      store.recordEvent(event(2, 'tool/call', {
        turn: 3, step: 1, callId: 'before-external', name: 'read', arguments: '{"file_path":"old.md"}',
      }))
      store.recordEvent(input(3, '真实的新外界输入', { kind: 'user', elysiaIngress: 'platform' }))
      store.recordEvent(event(4, 'tool/result', {
        message: { toolCallId: 'before-external', content: [{ type: 'text', text: '内部读取的迟到结果' }] },
      }))
      store.recordEvent(event(5, 'assistant/message', {
        turn: 3, step: 2, message: {
          id: 'mixed-answer', source: { provider: 'mock', model: 'fixture' },
          content: [{ type: 'text', text: '现在处理外界输入' }],
        },
      }))
      store.recordEvent(event(6, 'tool/call', {
        turn: 3, step: 2, callId: 'after-external', name: 'send_text',
        arguments: '{"channel":"kook","conversation":"kook:direct:42","content":"收到"}',
      }))
      store.recordEvent(event(7, 'tool/result', {
        message: { toolCallId: 'after-external', content: [{ type: 'text', text: '已发送' }] },
      }))
      expect(store.formBatches(20, 65536)).toBe(1)
      expect(store.nextBatch()?.observations.map(item => item.source.eventId)).toEqual(['3', '5', '6', '7'])
      expect(store.listObservations().filter(item => item.reviewState === 'reviewed').map(item => item.source.eventId))
        .toEqual(['1', '2', '4'])
    } finally { store.close() }
  })

  it('records direct communication tools without re-presenting returned history on ordinary turns', () => {
    const store = new RouterStore(join(home, 'communication-tools'))
    try {
      store.recordEvent(event(0, 'turn/start', { turn: 2 }))
      store.recordEvent(input(1, '请核对已有记录'))
      for (const [index, name] of ['session_list', 'session_read', 'session_send'].entries()) {
        store.recordEvent(event(2 + index * 2, 'tool/call', {
          turn: 2, step: index + 1, callId: 'communication-' + index, name, arguments: '{}',
        }))
        store.recordEvent(event(3 + index * 2, 'tool/result', {
          message: { toolCallId: 'communication-' + index, content: [{ type: 'text', text: '已有历史或通讯收据' }] },
        }))
      }
      store.recordEvent(input(8, '内部回复到达', { kind: 'elysia-session-communication' }))
      store.recordEvent(event(9, 'assistant/message', {
        turn: 2, step: 4, message: {
          id: 'ordinary-answer', source: { provider: 'mock', model: 'fixture' },
          content: [{ type: 'text', text: '原用户请求的正常回复' }],
        },
      }))
      expect(store.formBatches(20, 65536)).toBe(1)
      expect(store.nextBatch()?.observations.map(item => item.source.eventId)).toEqual(['1', '9'])
      expect(store.listObservations().filter(item => item.reviewState === 'reviewed')).toHaveLength(7)
    } finally { store.close() }
  })

  it('keeps a late communication result internal across both a new turn and reopen', () => {
    const dir = join(home, 'late-communication-result')
    let store = new RouterStore(dir)
    store.recordEvent(event(0, 'turn/start', { turn: 1 }))
    store.recordEvent(input(1, '普通用户输入'))
    store.recordEvent(event(2, 'tool/call', {
      turn: 1, step: 1, callId: 'late-read', name: 'session_read', arguments: '{"target":"memory"}',
    }))
    store.recordEvent(event(3, 'turn/end', { turn: 1, reason: { kind: 'error' } }))
    store.recordEvent(event(4, 'turn/start', { turn: 2 }))
    store.recordEvent(input(5, '下一条外部输入'))
    store.close()
    store = new RouterStore(dir)
    try {
      store.recordEvent(event(6, 'tool/result', {
        message: { toolCallId: 'late-read', content: [{ type: 'text', text: '迟到的历史查询结果' }] },
      }))
      expect(store.listObservations().find(item => item.source.eventId === '6'))
        .toMatchObject({ turn: 1, reviewState: 'reviewed' })
      expect(store.formBatches(20, 65536)).toBe(1)
      expect(store.nextBatch()?.observations.map(item => item.source.eventId)).toEqual(['1', '5'])
      expect(store.sourceCursor()).toBe(6)
    } finally { store.close() }
  })

  it('bounds large projections while retaining complete observations after completion', () => {
    const store = new RouterStore(join(home, 'continuation'))
    try {
      const original = '爱莉'.repeat(2000)
      store.recordEvent(input(1, original))
      expect(store.formBatches(20, 512)).toBe(1)
      const batch = store.nextBatch()!
      const projected = batch.observations[0]!
      expect(projected.projectionComplete).toBe(false)
      expect(Buffer.byteLength(JSON.stringify(projected.projectedContent))).toBeLessThanOrEqual(512)
      expect(JSON.stringify(batchContent(batch))).toContain(`observation/${projected.id}`)
      expect(store.getObservation(projected.id)?.content).toEqual([{ type: 'text', text: original }])
      store.markPresenting(batch.id)
      store.markCompleted(batch.id, 1, 3000)
      const historical = store.getObservation(projected.id)!
      expect(historical.reviewState).toBe('reviewed')
      expect(historical.content).toEqual([{ type: 'text', text: original }])
      expect(store.getBatch(batch.id)?.observations[0]?.projectionComplete).toBe(false)
    } finally { store.close() }
  })

  it('migrates a legacy database without deleting observations or delivery history', () => {
    const dir = join(home, 'migration')
    mkdirSync(dir, { recursive: true })
    const db = new DatabaseSync(join(dir, 'router.sqlite'))
    db.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE observations (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, event_seq INTEGER NOT NULL UNIQUE,
        event_time INTEGER NOT NULL, source_kind TEXT NOT NULL, content_hash TEXT NOT NULL, payload TEXT NOT NULL,
        routing_state TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE batches (id TEXT PRIMARY KEY, state TEXT NOT NULL, previous_batch_id TEXT REFERENCES batches(id),
        successor_batch_id TEXT REFERENCES batches(id), attempt_count INTEGER NOT NULL DEFAULT 0,
        available_at INTEGER NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE batch_observations (batch_id TEXT NOT NULL REFERENCES batches(id), observation_id TEXT NOT NULL REFERENCES observations(id),
        position INTEGER NOT NULL, PRIMARY KEY(batch_id, observation_id));
      CREATE TABLE decisions (id TEXT PRIMARY KEY, batch_id TEXT NOT NULL UNIQUE REFERENCES batches(id), action TEXT NOT NULL,
        reason TEXT NOT NULL, not_before INTEGER, request_hash TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE runtime_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `)
    const payload = JSON.stringify({ content: [{ type: 'text', text: '旧观察' }], source: { kind: 'user' } })
    db.prepare('INSERT INTO observations VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run('obs_legacy', 'elysia-conscious-mind', 7, 1007, 'user', 'legacy-hash', payload, 'closed', 2000)
    db.prepare('INSERT INTO batches(id, state, attempt_count, available_at, created_at) VALUES (?, ?, ?, ?, ?)')
      .run('batch_legacy', 'decided', 1, 2000, 2000)
    db.prepare('INSERT INTO batch_observations VALUES (?, ?, ?)').run('batch_legacy', 'obs_legacy', 0)
    db.prepare('INSERT INTO decisions VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('decision_legacy', 'batch_legacy', 'ignore', '旧决定', null, 'legacy-request', 2001)
    db.prepare('INSERT INTO runtime_state VALUES (?, ?)').run('source_cursor', '7')
    db.close()
    const migrated = new RouterStore(dir)
    try {
      expect(migrated.sourceCursor()).toBe(7)
      expect(migrated.getObservation('obs_legacy')).toMatchObject({
        source: { kind: MAIN_SOURCE_KIND, instance: MAIN_SOURCE_INSTANCE, eventId: '7' },
        reviewState: 'reviewed', content: [{ type: 'text', text: '旧观察' }],
      })
      expect(migrated.getBatch('batch_legacy')).toMatchObject({ state: 'decided' })
      const history = new DatabaseSync(join(dir, 'router.sqlite'), { readOnly: true })
      try {
        expect(history.prepare('SELECT action, reason FROM decisions WHERE batch_id = ?').get('batch_legacy'))
          .toEqual({ action: 'ignore', reason: '旧决定' })
      } finally { history.close() }
      migrated.markAccepted('batch_legacy', 99, 3000)
      migrated.markCompleted('batch_legacy', 4, 3001)
      expect(migrated.getBatch('batch_legacy')).toMatchObject({ sessionSeq: 99, acceptedAt: 3000, completedTurn: 4 })
    } finally { migrated.close() }
  })

  it('persists the trigger threshold and resumes the exact multi-Batch group', () => {
    const dir = join(home, 'trigger-groups')
    let store = new RouterStore(dir, 3)
    for (const seq of [1, 2, 3]) {
      store.recordEvent(input(seq, `第 ${seq} 批`))
      expect(store.formBatches(20, 65536)).toBe(1)
      if (seq < 3) expect(store.nextBatch()).toBeUndefined()
    }
    const grouped = store.nextBatch()!
    expect(grouped.batchIds).toHaveLength(3)
    expect(grouped.observations.map(item => item.eventSeq)).toEqual([1, 2, 3])
    expect(JSON.stringify(batchContent(grouped))).toContain(`batch_ids: ${grouped.batchIds.join(', ')}`)
    store.markPresenting(grouped.id)
    store.markAccepted(grouped.id, 50, 2000)
    store.markPresented(grouped.id, 1, 1, 2001)
    const originalIds = [...grouped.batchIds]
    store.close()

    store = new RouterStore(dir, 1)
    try {
      expect(store.triggerBatchCount()).toBe(3)
      const resumed = store.nextBatch()!
      expect(resumed.id).toBe(grouped.id)
      expect(resumed.batchIds).toEqual(originalIds)
      expect(resumed.observations.map(item => item.eventSeq)).toEqual([1, 2, 3])
      expect(resumed.state).toBe('presented')
      store.markCompleted(resumed.id, 1, 3000)
      expect(originalIds.map(id => store.getBatch(id)?.state)).toEqual(['decided', 'decided', 'decided'])
      expect(store.health()).toMatchObject({ pendingObservations: 0, completedBatches: 3, triggerBatchCount: 3 })
      expect(store.nextBatch()).toBeUndefined()
      expect(() => store.setTriggerBatchCount(0)).toThrow('正整数')
    } finally { store.close() }
  })

  it('retires an exhausted Batch with a queryable ignore decision', () => {
    const store = new RouterStore(join(home, 'batch-budget'))
    try {
      store.recordEvent(input(1, '需要研判但会永久失败的材料'))
      expect(store.formBatches(20, 65536)).toBe(1)
      const batch = store.nextBatch()!
      store.markPresenting(batch.id)
      store.markPresenting(batch.id)
      expect(store.batchAttempts(batch.id)).toBe(2)
      expect(store.health()).toMatchObject({ readyBatches: 1, failedBatches: 0, pendingObservations: 1 })

      store.abandonBatch(batch.id, BATCH_ATTEMPTS_EXHAUSTED)

      expect(store.getBatch(batch.id)).toMatchObject({ state: 'decided' })
      expect(store.decision(batch.id)).toEqual({ action: 'ignore', reason: BATCH_ATTEMPTS_EXHAUSTED })
      expect(store.nextBatch()).toBeUndefined()
      expect(store.health()).toMatchObject({ readyBatches: 0, pendingObservations: 0, failedBatches: 1 })
      // 重复退役不能覆盖已经登记的真实决定。
      store.abandonBatch(batch.id, 'ANOTHER_REASON')
      expect(store.decision(batch.id)?.reason).toBe(BATCH_ATTEMPTS_EXHAUSTED)
      expect(store.health().failedBatches).toBe(1)
    } finally { store.close() }
  })
})

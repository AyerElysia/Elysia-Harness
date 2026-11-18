import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { ReadError, redactVisible, SessionReader } from '../src/read.ts'

const participants = [
  { alias: 'main', sessionId: 'elysia-conscious-mind', name: '主意识', role: 'main' },
  { alias: 'router', sessionId: 'elysia-subconscious-router', name: '中枢', role: 'router' },
  { alias: 'memory', sessionId: 'elysia-subconscious-memory', name: '记忆', role: 'memory' },
]

function user(seq: number, text: string) {
  return { seq, time: 1700000000000 + seq, type: 'user/message', data: {
    content: [{ type: 'text', text }], source: { kind: 'user' }, id: 'user-' + seq,
  } }
}

function fixture(initial = [user(0, 'first')]) {
  const events: Record<string, unknown>[] = [...initial]
  const get = vi.fn(() => undefined)
  const readSession = vi.fn(async () => ({ session: { id: participants[0]!.sessionId, cwd: '/main' }, events: structuredClone(events) }))
  const listSessions = vi.fn(async () => participants.map(item => ({ header: { id: item.sessionId, cwd: '/' + item.alias }, live: false, persisted: true })))
  const ctx = { agents: { get }, sessionQuery: { readSession, listSessions } } as unknown as Context
  const reader = new SessionReader(ctx, participants)
  return { reader, events, get, readSession, listSessions }
}

describe('registered Session reads', () => {
  it('reads a different-workspace peer without activating it and rejects unregistered callers and targets', async () => {
    const f = fixture()
    const page = await f.reader.read(participants[2]!.sessionId, { target: 'main' })
    expect(page.events).toHaveLength(1)
    expect(f.readSession).toHaveBeenCalledWith(participants[0]!.sessionId)
    expect(f.get).not.toHaveBeenCalled()
    await expect(f.reader.read('outsider', { target: 'main' })).rejects.toMatchObject({ code: 'CALLER_UNREGISTERED' })
    await expect(f.reader.read(participants[2]!.sessionId, { target: 'arbitrary-id' })).rejects.toMatchObject({ code: 'TARGET_NOT_FOUND' })
    expect(f.readSession).toHaveBeenCalledTimes(1)
    const list = await f.reader.list(participants[0]!.sessionId)
    expect(list.participants).toHaveLength(3)
    expect(list.participants.every(item => item.availability === 'offline' && item.can_read)).toBe(true)
  })

  it('paginates the participant directory and binds its cursor to the caller', async () => {
    const f = fixture()
    const first = await f.reader.list(participants[0]!.sessionId, { limit: 1 })
    const second = await f.reader.list(participants[0]!.sessionId, { limit: 1, cursor: first.next_cursor! })
    expect(first.participants[0]!.alias).toBe('main')
    expect(second.participants[0]!.alias).toBe('router')
    expect(second.as_of).toBe(first.as_of)
    await expect(f.reader.list(participants[2]!.sessionId, { limit: 1, cursor: first.next_cursor! }))
      .rejects.toMatchObject({ code: 'CURSOR_INVALID' })
  })

  it('keeps visible assistant text and tool records while excluding reasoning, providers and secrets', async () => {
    const f = fixture()
    f.events.push(
      { seq: 1, time: 1700000000001, type: 'system/message', data: { content: [{ type: 'text', text: 'PRIVATE SYSTEM PROMPT' }] } },
      { seq: 2, time: 1700000000002, type: 'assistant/message', data: { turn: 1, step: 1, message: {
        id: 'a1', source: { kind: 'model', replayState: 'PRIVATE PROVIDER STATE' },
        content: [{ type: 'reasoning', text: 'HIDDEN CHAIN' }, { type: 'text', text: 'visible reply' }],
      }, stream: 'RAW STREAM' } },
      { seq: 3, time: 1700000000003, type: 'tool/call', data: { turn: 1, step: 1, callId: 'c1', name: 'web_fetch', arguments: '{"url":"https://example.invalid/","api_key":"secret-key"}' } },
      { seq: 4, time: 1700000000004, type: 'tool/result', data: { turn: 1, step: 1, message: {
        toolCallId: 'c1', content: [{ type: 'text', text: 'Authorization: Bearer private-token\npublic result' }],
      }, meta: { secret: 'PRIVATE META' } } },
      { seq: 5, time: 1700000000005, type: 'tool/call', data: { callId: 'c2', name: 'read', arguments: '{"file_path":"/private/.env"}' } },
      { seq: 6, time: 1700000000006, type: 'tool/result', data: { message: { toolCallId: 'c2', content: [{ type: 'text', text: 'OPAQUE UNLABELED SECRET' }] } } },
    )
    const page = await f.reader.read(participants[2]!.sessionId, { target: 'main' })
    const text = JSON.stringify(page)
    expect(text).toContain('visible reply')
    expect(text).toContain('web_fetch')
    expect(text).toContain('public result')
    for (const hidden of ['PRIVATE SYSTEM PROMPT', 'PRIVATE PROVIDER STATE', 'HIDDEN CHAIN', 'RAW STREAM', 'secret-key', 'private-token', 'PRIVATE META', 'OPAQUE UNLABELED SECRET']) {
      expect(text).not.toContain(hidden)
    }
    expect(text).toContain('[redacted]')
    expect(text).toContain('sensitive tool result omitted')
    const searched = await f.reader.read(participants[2]!.sessionId, { target: 'main', view: 'search', query: 'HIDDEN CHAIN' })
    expect(searched.events).toEqual([])
  })

  it('pages one frozen cut while the target receives new events and binds cursors to reader and query', async () => {
    const f = fixture([user(0, 'zero'), user(1, 'one'), user(2, 'two'), user(3, 'three'), user(4, 'four')])
    const first = await f.reader.read(participants[2]!.sessionId, { target: 'main', limit: 2 })
    expect(first.events?.map(event => event.event_seq)).toEqual([3, 4])
    expect(first.as_of_seq).toBe(4)
    f.events.push(user(5, 'arrived after snapshot'))
    const cursor = first.next_cursor!
    const second = await f.reader.read(participants[2]!.sessionId, { target: 'main', limit: 2, cursor })
    expect(second.events?.map(event => event.event_seq)).toEqual([1, 2])
    expect(second.as_of_seq).toBe(4)
    expect(f.readSession).toHaveBeenCalledTimes(1)
    await expect(f.reader.read(participants[1]!.sessionId, { target: 'main', limit: 2, cursor })).rejects.toMatchObject({ code: 'CURSOR_INVALID' })
    await expect(f.reader.read(participants[2]!.sessionId, { target: 'main', limit: 3, cursor })).rejects.toMatchObject({ code: 'CURSOR_INVALID' })
  })

  it('bounds large records and offers complete fixed-cut continuation without losing characters', async () => {
    const text = '引号"和反斜线\\。'.repeat(10000)
    const f = fixture([user(0, text)])
    let cursor: string | undefined
    let assembled = ''
    let count = 0
    do {
      const page = await f.reader.read(participants[2]!.sessionId, { target: 'main', view: 'event', event_seq: 0, ...cursor === undefined ? {} : { cursor } })
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(16 * 1024)
      const content = page.events![0]!.content as { format: string; text: string }
      expect(content.format).toBe('json-fragment')
      assembled += content.text
      cursor = page.next_cursor
      count++
    } while (cursor !== undefined && count < 200)
    expect(count).toBeGreaterThan(1)
    expect(cursor).toBeUndefined()
    expect(JSON.parse(assembled)).toEqual([{ type: 'text', text }])
    expect(f.readSession).toHaveBeenCalledTimes(1)
  })

  it('requires explicit valid ranges and exposes only visible exact events', async () => {
    const f = fixture()
    await expect(f.reader.read(participants[0]!.sessionId, { target: 'main', view: 'event' })).rejects.toBeInstanceOf(ReadError)
    await expect(f.reader.read(participants[0]!.sessionId, { target: 'main', seq_from: 4, seq_to: 1 })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    await expect(f.reader.read(participants[0]!.sessionId, { target: 'main', view: 'search', query: '' })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    const exact = await f.reader.read(participants[0]!.sessionId, { target: 'main', view: 'event', event_seq: 0 })
    expect(exact.events![0]!.event_seq).toBe(0)
    expect(redactVisible({ credentials: { x: 'secret' }, value: 'public' })).toEqual({ credentials: '[redacted]', value: 'public' })
  })
})

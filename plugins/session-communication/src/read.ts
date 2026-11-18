import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-session-query'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { Participant } from './types.ts'

const EVENT_TYPES = ['user/message', 'assistant/message', 'tool/call', 'tool/result'] as const
type VisibleEventType = typeof EVENT_TYPES[number]
const FRAMEWORK_SOURCES = new Set(['agent-instructions', 'runtime-context', 'time-context', 'elysia-calendar-context'])
const PRIVATE_KEYS = /^(?:password|passwd|secret|client_secret|api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|cookie|set-cookie|private[_-]?key|credentials)$/i
const PRIVATE_TOOL = /(?:credential|password|secret|token|api[_-]?key|login|authenticate|authorization)/i
const PRIVATE_PATH = /(?:^|[/\\])(?:\.env(?:\.[^/\\]*)?|\.credentials[^/\\]*|id_(?:rsa|ed25519)|[^/\\]*\.pem)(?:$|["'\s,])/i
const OUTPUT_BYTES = 16 * 1024
const MAX_SNAPSHOTS = 64
const SNAPSHOT_TTL_MS = 10 * 60 * 1000

export interface SessionListArgs {
  query?: string
  limit?: number
  cursor?: string
}

export interface SessionReadArgs {
  target: string
  view?: 'info' | 'history' | 'event' | 'search' | 'message'
  message_id?: string
  event_seq?: number
  seq_from?: number
  seq_to?: number
  event_types?: VisibleEventType[]
  query?: string
  limit?: number
  cursor?: string
}

export interface DirectoryParticipant {
  alias: string
  session_id: string
  name: string
  role: string
  availability: string
  running?: boolean
  can_send: boolean
  can_read: boolean
}

interface DirectoryPage {
  caller: string
  signature: string
  createdAt: number
  participants: DirectoryParticipant[]
  index: number
}

export interface SessionListResult {
  participants: DirectoryParticipant[]
  as_of: string
  next_cursor?: string
}

interface RawEvent {
  seq: number
  time: number
  type: string
  data: Record<string, unknown>
}

export interface ProjectedEvent {
  session_id: string
  event_seq: number
  event_type: VisibleEventType
  occurred_at: string
  turn?: number
  step?: number
  message_id?: string
  call_id?: string
  source?: unknown
  content: unknown
  complete: boolean
  continuation?: string
}

interface ReadSnapshot {
  caller: string
  target: string
  signature: string
  createdAt: number
  asOfSeq: number
  events: ProjectedEvent[]
}

interface Cursor {
  snapshot: ReadSnapshot
  index: number
  offset: number
}

export class ReadError extends Error {
  constructor(readonly code: string, message: string, readonly retryable = false) {
    super(message)
    this.name = 'ReadError'
  }
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function cleanText(text: string): string {
  return text
    .replace(/-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z ]+ )?PRIVATE KEY-----/g, '[redacted private key]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [redacted]')
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd|authorization|cookie|private[_-]?key)\s*["']?\s*[:=]\s*)(?:"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|[^\s,;}\]]+)/gi, '$1[redacted]')
    .replace(/([?&](?:token|key|secret|password|signature)=)[^&#\s"']+/gi, '$1[redacted]')
}

/** Restrict records to visible, redacted fields before caching or searching. */
export function redactVisible(value: unknown): unknown {
  if (typeof value === 'string') return cleanText(value)
  if (Array.isArray(value)) return value.map(redactVisible)
  if (typeof value !== 'object' || value === null) return value
  return Object.fromEntries(Object.entries(value).flatMap(([key, item]) => {
    if (/^(?:reasoning|replayState|providerData|rawStream|rawResponse|stream)$/i.test(key)) return []
    return [[key, PRIVATE_KEYS.test(key) ? '[redacted]' : redactVisible(item)]]
  }))
}

function visibleContent(value: unknown): unknown[] {
  if (!Array.isArray(value)) return []
  return value.flatMap<unknown>(item => {
    const block = record(item)
    if (block.type === 'text' && typeof block.text === 'string') {
      return [{ type: 'text', text: cleanText(block.text) }]
    }
    if (block.type === 'image' || block.type === 'file') {
      const attachment = record(block.attachment)
      return [{
        type: block.type,
        attachment: redactVisible(Object.fromEntries(
          ['attachmentId', 'mediaType', 'bytes', 'width', 'height', 'name'].flatMap(key =>
            attachment[key] === undefined ? [] : [[key, attachment[key]]]),
        )),
      }]
    }
    return []
  })
}

function projectEvent(sessionId: string, event: RawEvent, sensitiveCalls: Set<string>): ProjectedEvent | undefined {
  if (!EVENT_TYPES.includes(event.type as VisibleEventType)) return undefined
  const data = event.data
  const message = event.type === 'user/message' ? data : record(data.message)
  const source = record(message.source)
  if (event.type === 'user/message' && FRAMEWORK_SOURCES.has(String(source.kind))) return undefined
  let content: unknown
  let callId: string | undefined
  if (event.type === 'tool/call') {
    callId = typeof data.callId === 'string' ? data.callId : undefined
    const sensitive = PRIVATE_TOOL.test(String(data.name)) || PRIVATE_PATH.test(String(data.arguments))
    if (sensitive && callId !== undefined) sensitiveCalls.add(callId)
    let args: unknown = data.arguments
    if (typeof args === 'string') {
      try { args = JSON.parse(args) } catch { /* A malformed call remains visible as redacted text. */ }
    }
    content = { name: data.name, arguments: sensitive ? '[sensitive tool arguments omitted]' : redactVisible(args) }
  } else if (event.type === 'tool/result') {
    callId = typeof message.toolCallId === 'string' ? message.toolCallId : undefined
    content = {
      is_error: message.isError === true,
      content: callId !== undefined && sensitiveCalls.has(callId)
        ? [{ type: 'text', text: '[sensitive tool result omitted]' }]
        : visibleContent(message.content),
    }
  } else {
    content = visibleContent(message.content)
    if ((content as unknown[]).length === 0) return undefined
  }
  return {
    session_id: sessionId,
    event_seq: event.seq,
    event_type: event.type as VisibleEventType,
    occurred_at: new Date(event.time).toISOString(),
    ...typeof data.turn === 'number' ? { turn: data.turn } : {},
    ...typeof data.step === 'number' ? { step: data.step } : {},
    ...typeof message.id === 'string' ? { message_id: message.id } : {},
    ...callId === undefined ? {} : { call_id: callId },
    ...typeof source.kind !== 'string' ? {} : {
      source: redactVisible(Object.fromEntries(
        ['kind', 'form', 'senderSessionId', 'targetSessionId', 'messageId', 'conversationId', 'replyTo', 'channel', 'conversation', 'rpcId', 'clientTimeZone']
          .flatMap(key => typeof source[key] === 'string' ? [[key, source[key]]] : []),
      )),
    },
    content,
    complete: true,
  }
}

function pageLimit(limit = 20): number {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
    throw new ReadError('INVALID_ARGUMENT', 'limit must be an integer from 1 through 50')
  }
  return limit
}

function integer(name: string, value: number | undefined): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
    throw new ReadError('INVALID_ARGUMENT', name + ' must be a non-negative integer')
  }
}

function signature(args: SessionReadArgs, target: string): string {
  return JSON.stringify({
    target, view: args.view ?? 'history', event_seq: args.event_seq,
    seq_from: args.seq_from, seq_to: args.seq_to,
    event_types: args.event_types?.toSorted(), query: args.query,
    limit: pageLimit(args.limit),
  })
}

export class SessionReader {
  private readonly cursors = new Map<string, Cursor>()
  private readonly directoryCursors = new Map<string, DirectoryPage>()
  private readonly participants: readonly Participant[]

  constructor(private readonly ctx: Context, participants: readonly Participant[]) {
    this.participants = participants.map(item => ({ ...item }))
  }

  private caller(callerId: string): void {
    if (!this.participants.some(item => item.sessionId === callerId && item.enabled !== false)) {
      throw new ReadError('CALLER_UNREGISTERED', 'Calling Session is not an enabled participant')
    }
  }

  private participant(target: string): Participant {
    const found = this.participants.find(item => item.alias === target || item.sessionId === target)
    if (found === undefined) throw new ReadError('TARGET_NOT_FOUND', 'Target Session is not registered')
    if (found.enabled === false) throw new ReadError('TARGET_DISABLED', 'Target Session is disabled')
    return found
  }

  private async records(signal?: AbortSignal) {
    signal?.throwIfAborted()
    const records = await this.ctx.sessionQuery.listSessions(signal)
    signal?.throwIfAborted()
    return records
  }

  async list(callerId: string, args: SessionListArgs = {}, signal?: AbortSignal): Promise<SessionListResult> {
    this.caller(callerId)
    const limit = pageLimit(args.limit)
    const query = args.query?.trim().toLocaleLowerCase()
    const signature = JSON.stringify({ query, limit })
    let page: DirectoryPage
    if (args.cursor !== undefined) {
      const found = this.directoryCursors.get(args.cursor)
      if (found === undefined || Date.now() - found.createdAt > SNAPSHOT_TTL_MS
        || found.caller !== callerId || found.signature !== signature) {
        throw new ReadError('CURSOR_INVALID', 'Directory cursor expired or does not match this caller and query')
      }
      page = found
    } else {
      const records = await this.records(signal)
      const matches = this.participants.filter(item => !query || (item.alias + ' ' + item.name).toLocaleLowerCase().includes(query))
      page = {
        caller: callerId, signature, createdAt: Date.now(), index: 0,
        participants: matches.map(item => {
          const agent = this.ctx.agents.get(item.sessionId as SessionId)
          const exists = records.some(row => row.header.id === item.sessionId)
          return {
            alias: item.alias, session_id: item.sessionId, name: item.name, role: item.role,
            availability: item.enabled === false ? 'disabled' : agent !== undefined ? 'online' : exists ? 'offline' : 'unknown',
            ...agent === undefined ? {} : { running: agent.status === 'running' },
            can_send: item.enabled !== false, can_read: item.enabled !== false,
          }
        }),
      }
    }
    const index = page.index + limit
    let next: string | undefined
    if (index < page.participants.length) {
      for (const [token, saved] of this.directoryCursors) {
        if (Date.now() - saved.createdAt > SNAPSHOT_TTL_MS) this.directoryCursors.delete(token)
      }
      while (this.directoryCursors.size >= MAX_SNAPSHOTS) this.directoryCursors.delete(this.directoryCursors.keys().next().value!)
      next = randomUUID()
      this.directoryCursors.set(next, { ...page, index })
    }
    return {
      participants: page.participants.slice(page.index, index),
      as_of: new Date(page.createdAt).toISOString(),
      ...next === undefined ? {} : { next_cursor: next },
    }
  }

  private save(cursor: Cursor): string {
    const now = Date.now()
    for (const [key, item] of this.cursors) {
      if (now - item.snapshot.createdAt > SNAPSHOT_TTL_MS) this.cursors.delete(key)
    }
    while (this.cursors.size >= MAX_SNAPSHOTS) this.cursors.delete(this.cursors.keys().next().value!)
    const token = randomUUID()
    this.cursors.set(token, cursor)
    return token
  }

  async read(callerId: string, args: SessionReadArgs, signal?: AbortSignal) {
    this.caller(callerId)
    const target = this.participant(args.target)
    const view = args.view ?? 'history'
    if (!['info', 'history', 'event', 'search'].includes(view)) throw new ReadError('INVALID_ARGUMENT', 'Unsupported history view')
    const limit = pageLimit(args.limit)
    for (const [name, value] of [['event_seq', args.event_seq], ['seq_from', args.seq_from], ['seq_to', args.seq_to]] as const) integer(name, value)
    if (args.seq_from !== undefined && args.seq_to !== undefined && args.seq_to < args.seq_from) throw new ReadError('INVALID_ARGUMENT', 'seq_to precedes seq_from')
    if (args.event_types?.some(item => !EVENT_TYPES.includes(item))) throw new ReadError('INVALID_ARGUMENT', 'Unsupported event type')
    if (args.message_id !== undefined) throw new ReadError('INVALID_ARGUMENT', 'message_id is only valid for message view')
    if (view !== 'event' && args.event_seq !== undefined) throw new ReadError('INVALID_ARGUMENT', 'event_seq is only valid for event view')
    if (view !== 'search' && args.query !== undefined) throw new ReadError('INVALID_ARGUMENT', 'query is only valid for search view')
    if (view === 'event' && (args.event_seq === undefined || args.seq_from !== undefined || args.seq_to !== undefined || args.event_types !== undefined)) {
      throw new ReadError('INVALID_ARGUMENT', 'event view requires event_seq and accepts no range or type filter')
    }
    if (view === 'search' && !args.query?.trim()) throw new ReadError('INVALID_ARGUMENT', 'search view requires query')
    if (view === 'info') {
      if (args.cursor !== undefined || args.seq_from !== undefined || args.seq_to !== undefined || args.event_types !== undefined || args.limit !== undefined) {
        throw new ReadError('INVALID_ARGUMENT', 'info accepts no event or pagination parameters')
      }
      const listed = await this.list(callerId, {}, signal)
      const info = listed.participants.find(item => item.session_id === target.sessionId)
      return { target_session_id: target.sessionId, view, as_of: listed.as_of, info }
    }
    const fingerprint = signature(args, target.sessionId)
    let state: Cursor
    if (args.cursor !== undefined) {
      const found = this.cursors.get(args.cursor)
      if (found === undefined || Date.now() - found.snapshot.createdAt > SNAPSHOT_TTL_MS
        || found.snapshot.caller !== callerId || found.snapshot.signature !== fingerprint) {
        throw new ReadError('CURSOR_INVALID', 'Cursor expired or does not match this reader and query')
      }
      state = found
    } else {
      signal?.throwIfAborted()
      const log = await this.ctx.sessionQuery.readSession(target.sessionId as SessionId)
      signal?.throwIfAborted()
      const sensitiveCalls = new Set<string>()
      const projected = (log.events as unknown as RawEvent[]).flatMap(event => {
        const item = projectEvent(target.sessionId, event, sensitiveCalls)
        return item === undefined ? [] : [item]
      })
      const text = args.query?.trim().toLocaleLowerCase()
      let events = projected.filter(event =>
        (view !== 'event' || event.event_seq === args.event_seq)
        && (args.seq_from === undefined || event.event_seq >= args.seq_from)
        && (args.seq_to === undefined || event.event_seq <= args.seq_to)
        && (args.event_types === undefined || args.event_types.includes(event.event_type))
        && (view !== 'search' || JSON.stringify(event.content).toLocaleLowerCase().includes(text!)))
      if (view === 'event' && events.length === 0) throw new ReadError('CONTENT_UNAVAILABLE', 'Event is absent or has no visible communication projection')
      // Newest pages first, but each returned page remains in chronological order.
      if (view !== 'event') {
        const pages: ProjectedEvent[] = []
        for (let end = events.length; end > 0; end -= limit) pages.push(...events.slice(Math.max(0, end - limit), end))
        events = pages
      }
      const snapshot = {
        caller: callerId, target: target.sessionId, signature: fingerprint,
        createdAt: Date.now(), asOfSeq: log.events.at(-1)?.seq ?? -1, events,
      }
      state = { snapshot, index: 0, offset: 0 }
    }
    const { snapshot } = state
    const result: ProjectedEvent[] = []
    let index = state.index
    let offset = state.offset
    let budget = OUTPUT_BYTES - 1536
    let continuation: string | undefined
    const pageEnd = Math.min(snapshot.events.length, (Math.floor(index / limit) + 1) * limit)
    while (index < pageEnd && result.length < limit) {
      signal?.throwIfAborted()
      const event = snapshot.events[index]!
      const serialized = JSON.stringify(event.content)
      const metadata = { ...event, content: undefined }
      const metadataBytes = Buffer.byteLength(JSON.stringify(metadata))
      const available = Math.max(0, budget - metadataBytes - 256)
      if (available < 256 && result.length > 0) break
      let end = offset
      let bytes = 0
      for (const char of serialized.slice(offset)) {
        const size = Buffer.byteLength(JSON.stringify(char)) - 2
        if (bytes + size > available) break
        bytes += size
        end += char.length
      }
      if (end < serialized.length || offset > 0) {
        const complete = end === serialized.length
        const next = { snapshot, index: complete ? index + 1 : index, offset: complete ? 0 : end }
        continuation = this.save(next)
        result.push({
          ...event, content: { format: 'json-fragment', offset, text: serialized.slice(offset, end) },
          complete, ...continuation === undefined ? {} : { continuation },
        })
        index = next.index
        offset = next.offset
        break
      }
      result.push(event)
      budget -= metadataBytes + bytes + 128
      index++
      offset = 0
    }
    const more = index < snapshot.events.length
    return {
      target_session_id: target.sessionId, view,
      as_of: new Date(snapshot.createdAt).toISOString(), as_of_seq: snapshot.asOfSeq,
      events: result,
      ...more ? { next_cursor: continuation ?? this.save({ snapshot, index, offset }) } : {},
    }
  }
}

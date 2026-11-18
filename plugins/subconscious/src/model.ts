import { createHash } from 'node:crypto'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ContentBlock, ContextFormed, UserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'elysia-subconscious-router': { kind: 'elysia-subconscious-router'; batchId?: string; reportId?: string } & ContextFormed
  }
}

export const ROUTER_SESSION_ID = brandString<SessionId>('elysia-subconscious-router')
export const MAIN_SESSION_ID = brandString<SessionId>('elysia-conscious-mind')
export const ROUTER_SESSION_CWD = '/home/ayerelysia/Elysia/Data/workspace/subconscious/router'
export const MAIN_SOURCE_KIND = 'conscious_session'
export const MAIN_SOURCE_INSTANCE = 'elysia-conscious-mind'
export const routerMessageSource = (batchId: string) => ({ kind: 'elysia-subconscious-router', form: 'relay', batchId }) as const
export const routerReportSource = (reportId: string) => ({ kind: 'elysia-subconscious-router', form: 'relay', reportId }) as const

const frameworkSources = new Set([
  'agent-instructions',
  'runtime-context',
  'time-context',
  'elysia-calendar-context',
])

export type MainSessionEvent = SessionEvent
export type MainInputEvent = SessionEvent<'user/message'>
export type ObservationKind = 'external_input' | 'conscious_input' | 'conscious_output' | 'conscious_tool_call' | 'tool_result' | 'external_event'
export type ReviewState = 'pending' | 'in_batch' | 'deferred' | 'reviewed'

export interface ObservationSource {
  kind: string
  instance: string
  eventId: string
}

export interface ObservationDraft {
  source: ObservationSource
  kind: ObservationKind
  occurredAt: number
  payload: unknown
  content: ContentBlock[]
  actor?: string
  threadRefs: string[]
  correlationRefs?: string[]
  consciousSessionId?: string
  visibilityRef: string
  turn?: number
  step?: number
  callId?: string
}

export interface Observation {
  id: string
  source: ObservationSource
  ingestSeq: number
  kind: ObservationKind
  eventTime: number
  recordedAt: number
  contentHash: string
  payload: string
  content: ContentBlock[]
  threadRefs: string[]
  correlationRefs: string[]
  visibilityRef: string
  reviewState: ReviewState
  sessionId?: string
  eventSeq?: number
  actor?: string
  turn?: number
  step?: number
  callId?: string
  projectedContent?: ContentBlock[]
  projectionComplete?: boolean
}

export interface RouterBatch {
  /** Stable trigger identity: the first member Batch ID. */
  id: string
  /** Every ordinary Batch merged into this single Router turn, in delivery order. */
  batchIds: string[]
  state: 'ready' | 'presenting' | 'presented' | 'decided' | 'deferred'
  previousBatchId?: string
  successorBatchId?: string
  attemptCount: number
  availableAt: number
  createdAt: number
  sessionSeq?: number
  acceptedAt?: number
  presentedTurn?: number
  presentedStep?: number
  presentedAt?: number
  completedTurn?: number
  completedAt?: number
  observations: Observation[]
}

export function isExternalInput(event: SessionEvent): event is MainInputEvent {
  if (event.type !== 'user/message') return false
  if (frameworkSources.has(event.data.source.kind)) return false
  const form = 'form' in event.data.source ? event.data.source.form : undefined
  if (form === 'instructions' || form === 'catalog' || form === 'snapshot') return false
  return event.data.content.some(block => {
    if (block.type === 'text') return block.text.length > 0
    return block.type === 'image' || block.type === 'file'
  })
}

export function observationIdentity(source: ObservationSource): string {
  const digest = createHash('sha256').update(`${source.kind}\0${source.instance}\0${source.eventId}`).digest('hex').slice(0, 24)
  return `obs_${digest}`
}

export function payloadHash(payload: unknown, content: ContentBlock[]): string {
  return createHash('sha256').update(JSON.stringify({ payload, content })).digest('hex')
}

function threadName(channel: string, conversation: string): string {
  const cleanChannel = channel.trim()
  const cleanConversation = conversation.trim()
  if (!cleanChannel || !cleanConversation) return `conscious:${MAIN_SESSION_ID}`
  return cleanConversation.startsWith(`${cleanChannel}:`) ? cleanConversation : `${cleanChannel}:${cleanConversation}`
}

export function threadOfUserMessage(message: UserMessage): string {
  for (const block of message.content) {
    if (block.type !== 'text') continue
    const match = block.text.match(/渠道\s+([^\s｜]+)\s*｜\s*会话\s+([^｜\r\n]+)/u)
    if (match) return threadName(match[1]!, match[2]!)
  }
  return `conscious:${MAIN_SESSION_ID}`
}

export function threadOfToolCall(name: string, rawArguments: string): string | undefined {
  if (name !== 'send_text' && name !== 'send_voice' && name !== 'send_file') return undefined
  try {
    const args = JSON.parse(rawArguments) as { channel?: unknown; conversation?: unknown }
    if (typeof args.channel !== 'string' || typeof args.conversation !== 'string') return undefined
    return threadName(args.channel, args.conversation)
  } catch {
    return undefined
  }
}

function mainSource(event: SessionEvent): ObservationSource {
  return { kind: MAIN_SOURCE_KIND, instance: MAIN_SOURCE_INSTANCE, eventId: String(event.seq) }
}

function sourceEventCorrelations(event: SessionEvent): string[] {
  if (!('sourceEventSeqs' in event) || event.sourceEventSeqs === undefined) return []
  return event.sourceEventSeqs.map(seq => observationIdentity({ ...mainSource(event), eventId: String(seq) }))
}

/** Project only real surface facts; omit provider replay state and hidden reasoning streams. */
export function observationFromMainEvent(event: MainSessionEvent): ObservationDraft | undefined {
  const base = {
    source: mainSource(event), occurredAt: event.time, consciousSessionId: String(MAIN_SESSION_ID),
    correlationRefs: sourceEventCorrelations(event),
  }
  if (event.type === 'user/message') {
    if (!isExternalInput(event)) return undefined
    const thread = threadOfUserMessage(event.data)
    const external = event.data.source.kind === 'user'
    return {
      ...base, kind: external ? 'external_input' : 'conscious_input', payload: event.data,
      content: [...event.data.content].map(block => structuredClone(block)), threadRefs: [thread], visibilityRef: thread,
    }
  }
  if (event.type === 'assistant/message') {
    const content = event.data.message.content.filter(block => block.type === 'text' || block.type === 'image' || block.type === 'file')
    if (content.length === 0) return undefined
    const thread = `conscious:${MAIN_SESSION_ID}`
    return {
      ...base, kind: 'conscious_output', content: structuredClone(content), threadRefs: [thread], visibilityRef: thread,
      turn: event.data.turn, step: event.data.step,
      payload: {
        messageId: event.data.message.id, provider: event.data.message.source.provider,
        model: event.data.message.source.model, interrupted: event.data.interrupted === true,
      },
    }
  }
  if (event.type === 'tool/call') {
    const thread = threadOfToolCall(event.data.name, event.data.arguments)
    const fallback = `conscious:${MAIN_SESSION_ID}`
    return {
      ...base, kind: 'conscious_tool_call', turn: event.data.turn, step: event.data.step, callId: String(event.data.callId),
      payload: event.data, threadRefs: [thread ?? fallback], visibilityRef: thread ?? fallback,
      content: [{ type: 'text', text: `[tool/call] ${event.data.name}\n${event.data.arguments}` }],
    }
  }
  if (event.type === 'tool/result') {
    const thread = `conscious:${MAIN_SESSION_ID}`
    return {
      ...base, kind: 'tool_result',
      callId: String(event.data.message.toolCallId), threadRefs: [thread], visibilityRef: thread,
      content: [...event.data.message.content].map(block => structuredClone(block)),
      payload: {
        toolCallId: event.data.message.toolCallId, isError: event.data.message.isError === true,
        ...event.data.error === undefined ? {} : { error: event.data.error },
      },
    }
  }
  return undefined
}

/** Include the exact admitted projection; historical re-presentation is a host responsibility. */
export function batchContent(batch: RouterBatch): ContentBlock[] {
  const content: ContentBlock[] = [{
    type: 'text',
    text: `[subconscious.batch]\nbatch_id: ${batch.id}\nbatch_ids: ${batch.batchIds.join(', ')}\nobservations: ${batch.observations.length}`,
  }]
  for (const observation of batch.observations) {
    const complete = observation.projectionComplete !== false
    content.push({
      type: 'text',
      text: `\n\n[observation/${observation.id}]\nkind: ${observation.kind}\nsource: ${observation.source.kind}/${observation.source.instance}\nsource_event: ${observation.source.eventId}\ningest_seq: ${observation.ingestSeq}\nthread: ${observation.threadRefs.join(', ')}\noccurred_at: ${new Date(observation.eventTime).toISOString()}\ncomplete: ${complete}`,
    })
    content.push(...structuredClone(observation.projectedContent ?? observation.content))
  }
  return content
}

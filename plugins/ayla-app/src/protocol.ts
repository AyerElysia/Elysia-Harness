/**
 * Ayla bridge frames. One JSON text frame per WebSocket message in each
 * direction; every frame carries 'v' and 'type'.
 *
 * Frame objects use the wire field names verbatim, so a builder result can be
 * written straight to the socket and a parsed frame read without a mapping
 * layer. Ayla owns this protocol (REQUIREMENTS.zh.md §7); this module
 * implements it.
 * @module @elysia/ayla-app/protocol
 */

import type { AylaConversation } from './conversation.ts'

/** The only protocol version this plugin speaks. */
export const PROTOCOL_VERSION = 1

/** Largest accepted frame, in UTF-8 bytes. A larger frame drops the connection. */
export const MAX_FRAME_BYTES = 1024 * 1024

/** Largest single text message, in UTF-8 bytes; a longer message is not deliverable. */
export const MAX_TEXT_BYTES = 32 * 1024

/** Ayla conversation kinds, spelled exactly as the backend spells them. */
export type AylaConversationType = 'private' | 'group'

/** One part of an inbound message, in the order Ayla sent it. */
export type AylaInboundPart =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image'; readonly media_id: string; readonly media_type: string }

/** An inbound message as Ayla serializes it. Images carry no bytes, only a media id. */
export interface InboundMessagePayload {
  readonly id: string
  readonly conversation_id: string
  readonly conversation_type: AylaConversationType
  readonly sender_id: string
  readonly sender_name: string
  readonly sent_at: string
  readonly parts: readonly AylaInboundPart[]
}

/** A user message awaiting delivery. Its seq orders delivery and carries the ack. */
export interface InboundFrame {
  readonly v: 1
  readonly type: 'inbound'
  readonly seq: number
  readonly message: InboundMessagePayload
}

/** One text reply addressed to a conversation. */
export interface ReplyFrame {
  readonly v: 1
  readonly type: 'reply'
  readonly client_message_id: string
  readonly conversation_id: string
  readonly conversation_type: AylaConversationType
  readonly content: string
  readonly reply_to: string | null
}

/** Confirms that every message up to and including seq was handled. */
export interface AckFrame {
  readonly v: 1
  readonly type: 'ack'
  readonly seq: number
}

/** Asks Ayla to redeliver from seq + 1. */
export interface ResumeFrame {
  readonly v: 1
  readonly type: 'resume'
  readonly seq: number
}

/** Keepalive probe. */
export interface PingFrame {
  readonly v: 1
  readonly type: 'ping'
}

/** Keepalive answer. */
export interface PongFrame {
  readonly v: 1
  readonly type: 'pong'
}

/**
 * Ayla refused a frame. 'client_message_id' is absent when the refusal names
 * no send; otherwise it names the send that failed.
 */
export interface ErrorFrame {
  readonly v: 1
  readonly type: 'error'
  readonly client_message_id?: string
  readonly code: string
  readonly detail: string
}

/**
 * Ayla accepted a reply and stored it. 'seq' is the channel sequence the
 * stored message occupies, present when the backend already assigned one.
 */
export interface SentFrame {
  readonly v: 1
  readonly type: 'sent'
  readonly client_message_id: string
  readonly message_id: string
  readonly seq?: number
}

/** Every frame this plugin can read or write. */
export type Frame =
  | InboundFrame
  | ReplyFrame
  | AckFrame
  | ResumeFrame
  | PingFrame
  | PongFrame
  | ErrorFrame
  | SentFrame

/** Input for {@link buildReply}. */
export interface ReplyInput {
  /** Unique per send attempt; Ayla derives its idempotency key from it. */
  clientMessageId: string
  /** The conversation the reply belongs to. */
  conversation: AylaConversation
  /** Already-split message body. */
  content: string
  /** Ayla message id being answered, when the reply quotes one. */
  replyTo?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** A positive, exactly representable integer, as every sequence number must be. */
function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function readConversationType(value: unknown): AylaConversationType | undefined {
  if (value === 'private' || value === 'group') return value
  return undefined
}

function parsePart(value: unknown): AylaInboundPart | undefined {
  if (!isRecord(value)) return undefined
  if (value.type === 'text') {
    return typeof value.text === 'string' ? { type: 'text', text: value.text } : undefined
  }
  if (value.type === 'image') {
    if (!isNonEmptyString(value.media_id) || !isNonEmptyString(value.media_type)) return undefined
    return { type: 'image', media_id: value.media_id, media_type: value.media_type }
  }
  // voice, file, video, emoji, mixed, share: the plugin cannot present them, so
  // the whole message is rejected rather than narrowed to the parts it can show.
  return undefined
}

function textBytes(parts: readonly AylaInboundPart[]): number {
  let total = 0
  for (const part of parts) {
    if (part.type === 'text') total += Buffer.byteLength(part.text, 'utf8')
  }
  return total
}

function parseInbound(frame: Record<string, unknown>): InboundFrame | undefined {
  if (!isPositiveInteger(frame.seq)) return undefined
  const message = frame.message
  if (!isRecord(message)) return undefined
  const { id, conversation_id, sender_id, sender_name, sent_at } = message
  if (!isNonEmptyString(id) || !isNonEmptyString(conversation_id)) return undefined
  if (!isNonEmptyString(sender_id) || typeof sender_name !== 'string') return undefined
  if (!isNonEmptyString(sent_at)) return undefined
  const conversationType = readConversationType(message.conversation_type)
  if (conversationType === undefined) return undefined
  const rawParts = message.parts
  if (!Array.isArray(rawParts) || rawParts.length === 0) return undefined
  const parts: AylaInboundPart[] = []
  for (const raw of rawParts) {
    const part = parsePart(raw)
    if (part === undefined) return undefined
    parts.push(part)
  }
  if (textBytes(parts) > MAX_TEXT_BYTES) return undefined
  return {
    v: 1,
    type: 'inbound',
    seq: frame.seq,
    message: {
      id,
      conversation_id,
      conversation_type: conversationType,
      sender_id,
      sender_name,
      sent_at,
      parts,
    },
  }
}

function parseError(frame: Record<string, unknown>): ErrorFrame | undefined {
  if (!isNonEmptyString(frame.code)) return undefined
  const detail = typeof frame.detail === 'string' ? frame.detail : ''
  const clientMessageId = frame.client_message_id
  if (clientMessageId !== undefined && typeof clientMessageId !== 'string') return undefined
  return {
    v: 1,
    type: 'error',
    ...clientMessageId === undefined ? {} : { client_message_id: clientMessageId },
    code: frame.code,
    detail,
  }
}

function parseSent(frame: Record<string, unknown>): SentFrame | undefined {
  if (!isNonEmptyString(frame.client_message_id)) return undefined
  if (!isNonEmptyString(frame.message_id)) return undefined
  const seq = frame.seq
  if (seq !== undefined && !isPositiveInteger(seq)) return undefined
  return {
    v: 1,
    type: 'sent',
    client_message_id: frame.client_message_id,
    message_id: frame.message_id,
    ...seq === undefined ? {} : { seq },
  }
}

function parseSeqFrame(frame: Record<string, unknown>, type: 'ack' | 'resume'): AckFrame | ResumeFrame | undefined {
  if (!isPositiveInteger(frame.seq)) return undefined
  return type === 'ack' ? { v: 1, type: 'ack', seq: frame.seq } : { v: 1, type: 'resume', seq: frame.seq }
}

/**
 * Read one WebSocket text frame.
 *
 * Returns undefined for everything the plugin must not act on: a frame above
 * {@link MAX_FRAME_BYTES}, invalid JSON, a version other than
 * {@link PROTOCOL_VERSION}, an unknown frame type, an unknown
 * 'parts[].type', a missing or mistyped field, or text above
 * {@link MAX_TEXT_BYTES}. A message frame is never reduced to the parts that
 * happen to be understood.
 * @param raw - the frame text.
 * @returns the frame, or undefined when it must not be interpreted.
 */
export function parseFrame(raw: string): Frame | undefined {
  if (typeof raw !== 'string') return undefined
  if (Buffer.byteLength(raw, 'utf8') > MAX_FRAME_BYTES) return undefined
  let decoded: unknown
  try {
    decoded = JSON.parse(raw)
  } catch {
    // Not JSON: the peer is not speaking this protocol.
    return undefined
  }
  if (!isRecord(decoded)) return undefined
  if (decoded.v !== PROTOCOL_VERSION) return undefined
  switch (decoded.type) {
    case 'inbound':
      return parseInbound(decoded)
    case 'ack':
    case 'resume':
      return parseSeqFrame(decoded, decoded.type)
    case 'ping':
      return { v: 1, type: 'ping' }
    case 'pong':
      return { v: 1, type: 'pong' }
    case 'error':
      return parseError(decoded)
    case 'sent':
      return parseSent(decoded)
    default:
      return undefined
  }
}

/**
 * Build a reply frame. The conversation type is taken from the conversation
 * id, which keeps a private reply from being delivered as a group message.
 * @param input - conversation, body, and quote target.
 * @returns the frame to write.
 */
export function buildReply(input: ReplyInput): ReplyFrame {
  if (input.clientMessageId.trim().length === 0) throw new Error('client_message_id 不能为空')
  if (input.content.trim().length === 0) throw new Error('reply 正文不能为空')
  if (Buffer.byteLength(input.content, 'utf8') > MAX_TEXT_BYTES) {
    throw new Error('reply 正文超过 ' + String(MAX_TEXT_BYTES) + ' 字节')
  }
  return {
    v: 1,
    type: 'reply',
    client_message_id: input.clientMessageId,
    conversation_id: input.conversation.id,
    conversation_type: input.conversation.kind,
    content: input.content,
    reply_to: input.replyTo ?? null,
  }
}

/**
 * Build the ack for a handled message.
 * @param seq - highest handled sequence number.
 * @returns the frame to write.
 */
export function buildAck(seq: number): AckFrame {
  if (!isPositiveInteger(seq)) throw new Error('ack seq 必须是正整数: ' + String(seq))
  return { v: 1, type: 'ack', seq }
}

/**
 * Build the resume request sent after a reconnect.
 * @param seq - last sequence number already acked; Ayla redelivers from seq + 1.
 * @returns the frame to write.
 */
export function buildResume(seq: number): ResumeFrame {
  if (!Number.isSafeInteger(seq) || seq < 0) throw new Error('resume seq 必须是非负整数: ' + String(seq))
  return { v: 1, type: 'resume', seq }
}

/**
 * Build a keepalive probe.
 * @returns the frame to write.
 */
export function buildPing(): PingFrame {
  return { v: 1, type: 'ping' }
}

/**
 * Build the answer to a peer keepalive probe.
 * @returns the frame to write.
 */
export function buildPong(): PongFrame {
  return { v: 1, type: 'pong' }
}

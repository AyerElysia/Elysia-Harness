/**
 * Text and image sources extracted from one KOOK message event.
 * @module @elysia/kook-bot/inbound
 */

import { formatKookConversation, type KookConversation } from './conversation.ts'

/** A channel-owned source part. Images still need download and DSH admission. */
export type KookInboundSourcePart =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image'; readonly url: string }

/** One accepted KOOK event before its image sources are downloaded. */
export interface KookInboundEvent {
  channel: 'kook'
  conversation: string
  target: KookConversation
  messageId: string
  senderId: string
  senderName: string
  content: readonly KookInboundSourcePart[]
}

/** Legacy text-only view used by direct-message history helpers. */
export interface KookInboundText extends Omit<KookInboundEvent, 'content'> {
  text: string
}

interface KookEvent {
  channel_type?: string
  type?: number
  content?: string
  msg_id?: string
  author_id?: string
  target_id?: string
  extra?: { author?: { username?: string; bot?: boolean } }
}

/** Map one REST direct-message row onto the gateway PERSON event shape. */
export function kookDirectMessageEvent(message: Record<string, unknown>, userId: string): KookEvent {
  const author = message.author !== null && typeof message.author === 'object'
    ? message.author as { id?: unknown; username?: unknown; bot?: unknown }
    : {}
  return {
    channel_type: 'PERSON',
    type: Number(message.type ?? 1),
    target_id: userId,
    author_id: String(message.author_id ?? author.id ?? ''),
    content: String(message.content ?? ''),
    msg_id: String(message.id ?? message.msg_id ?? ''),
    extra: {
      author: {
        ...author.username === undefined ? {} : { username: String(author.username) },
        bot: author.bot === true,
      },
    },
  }
}

/** Accept one user text, KMarkdown, or image event. Other events are ignored. */
export function kookInboundEvent(raw: unknown, selfId: string): KookInboundEvent | undefined {
  if (raw === null || typeof raw !== 'object') return undefined
  const event = raw as KookEvent
  if (event.type !== 1 && event.type !== 2 && event.type !== 9) return undefined
  if (event.extra?.author?.bot === true) return undefined
  const senderId = String(event.author_id ?? '').trim()
  if (senderId.length === 0 || senderId === selfId) return undefined
  const value = String(event.content ?? '').trim()
  if (value.length === 0) return undefined
  const messageId = String(event.msg_id ?? '').trim()
  if (messageId.length === 0) return undefined
  const target: KookConversation = event.channel_type === 'PERSON'
    ? { kind: 'direct', userId: senderId }
    : { kind: 'channel', channelId: String(event.target_id ?? '').trim() }
  return {
    channel: 'kook',
    conversation: formatKookConversation(target),
    target,
    messageId,
    senderId,
    senderName: event.extra?.author?.username?.trim() || senderId,
    content: [event.type === 2
      ? { type: 'image', url: value }
      : { type: 'text', text: value }],
  }
}

/** Keep only a text message for the legacy latest-direct-text API. */
export function kookInboundText(raw: unknown, selfId: string): KookInboundText | undefined {
  const event = kookInboundEvent(raw, selfId)
  const first = event?.content[0]
  if (event === undefined || first?.type !== 'text') return undefined
  const { content: _content, ...metadata } = event
  return { ...metadata, text: first.text }
}

/**
 * Text extracted from one Feishu message event.
 * @module @elysia/feishu-app/inbound
 */

import { formatFeishuConversation, type FeishuConversation } from './conversation.ts'

/** One inbound Feishu text message. */
export interface FeishuInboundText {
  channel: 'feishu'
  conversation: string
  target: FeishuConversation
  messageId: string
  senderId: string
  text: string
}

interface FeishuEvent {
  header?: { event_type?: string }
  event?: {
    sender?: { sender_type?: string; sender_id?: { open_id?: string } }
    message?: { message_id?: string; chat_id?: string; chat_type?: string; message_type?: string; content?: string }
  }
}

/**
 * Keep a user text message. Bot echoes, non-text, and empty text return undefined.
 * @param raw - an im.message.receive_v1 event.
 * @param selfOpenId - this app's open_id, when already known.
 * @returns the text, or undefined when this event is not a user text message.
 */
function asFeishuEvent(raw: object): FeishuEvent {
  const record = raw as FeishuEvent & { message?: NonNullable<FeishuEvent['event']>['message']; sender?: NonNullable<FeishuEvent['event']>['sender'] }
  if (record.event?.message !== undefined) return record
  if (record.message !== undefined) {
    return {
      header: { event_type: 'im.message.receive_v1' },
      event: { ...record.sender === undefined ? {} : { sender: record.sender }, message: record.message },
    }
  }
  return record
}

export function feishuInboundText(raw: unknown, selfOpenId = ''): FeishuInboundText | undefined {
  if (raw === null || typeof raw !== 'object') return undefined
  const event = asFeishuEvent(raw)
  if (event.header?.event_type !== undefined && event.header.event_type !== 'im.message.receive_v1') return undefined
  const message = event.event?.message
  const sender = event.event?.sender
  if (message?.message_type !== 'text') return undefined
  if (sender?.sender_type === 'app') return undefined
  const senderId = sender?.sender_id?.open_id?.trim() ?? ''
  if (senderId.length === 0 || senderId === selfOpenId) return undefined
  let text = ''
  try {
    const content = JSON.parse(message.content ?? '') as { text?: unknown }
    text = typeof content.text === 'string' ? content.text.trim() : ''
  } catch {
    return undefined
  }
  if (text.length === 0) return undefined
  const messageId = message.message_id?.trim() ?? ''
  if (messageId.length === 0) return undefined
  const chatType = message.chat_type ?? 'p2p'
  const target: FeishuConversation = chatType === 'p2p'
    ? { kind: 'private', openId: senderId }
    : { kind: 'chat', chatId: message.chat_id?.trim() ?? '' }
  if (target.kind === 'chat' && !target.chatId.startsWith('oc_')) return undefined
  return {
    channel: 'feishu',
    conversation: formatFeishuConversation(target),
    target,
    messageId,
    senderId,
    text,
  }
}

/**
 * One admitted inbound event, whatever channel it came from. Image bytes have
 * already been durably admitted through DSH before an event enters pending.
 * @module @elysia/conscious-mind/inbound
 */

import type { ImageAttachmentRef, PromptContentPart } from '@deepseek-ai/dsh-attachment'

/** Channel-owned content before download and DSH attachment admission. */
export type InboundEventInputContent = PromptContentPart

/** Metadata and downloaded content presented for DSH attachment admission. */
export interface InboundEventInput {
  /** Outbound channel name, such as `qq` or `feishu`. */
  channel: string
  /** Window id. Replies copy this into `conversation`. */
  conversation: string
  /** Platform message id. Empty when the channel has none. */
  messageId: string
  /** Sender id on that channel. */
  senderId: string
  /** Sender display name. Empty when the channel omitted it. */
  senderName: string
  /** Text and encoded images in their original platform order. */
  content: readonly InboundEventInputContent[]
}

/** Durable text or image content retained by pending and the session. */
export type InboundContentPart =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image'; readonly attachment: ImageAttachmentRef }

/** One fully admitted event waiting in the conscious mind's pending queue. */
export interface InboundEvent {
  channel: string
  conversation: string
  messageId: string
  senderId: string
  senderName: string
  content: readonly InboundContentPart[]
}

/** Text retained for logs and the legacy standalone text-only turn. */
export function inboundEventText(message: InboundEvent): string {
  return message.content
    .filter(part => part.type === 'text')
    .map(part => part.text)
    .join('')
}

/**
 * Text that arrived from NapCat and should enter the conscious-mind session.
 * @module @elysia/qq-napcat/inbound
 */

import type { QqConversation } from './conversation.ts'

/** One inbound QQ text message, after OneBot segments are reduced to plain text. */
export interface QqInboundText {
  /** Always `qq`, the send_text channel name. */
  channel: 'qq'
  /** Window id. A later send_text call copies this into `conversation`. */
  conversation: string
  /** Parsed window. Same fact as `conversation`. */
  target: QqConversation
  /** OneBot message_id, used as send_text `reply_to`. */
  messageId: string
  /** Sender QQ id. The bot's own echo is not emitted. */
  senderId: string
  /** Sender display name. Empty when NapCat omitted it. */
  senderName: string
  /** Plain text of this message. Non-text segments are left out of this field. */
  text: string
}

/**
 * Feishu conversation ids used by send_text.
 * @module @elysia/feishu-app/conversation
 */

/** One Feishu window send_text can address. */
export type FeishuConversation =
  | { kind: 'private'; openId: string }
  | { kind: 'chat'; chatId: string }

const PRIVATE_PREFIX = 'feishu:private:'
const CHAT_PREFIX = 'feishu:chat:'

function openId(value: string): string {
  const id = value.trim()
  if (!/^ou_[A-Za-z0-9]+$/u.test(id)) throw new Error('open_id 必须以 ou_ 开头')
  return id
}

function chatId(value: string): string {
  const id = value.trim()
  if (!/^oc_[A-Za-z0-9]+$/u.test(id)) throw new Error('chat_id 必须以 oc_ 开头')
  return id
}

/**
 * Build the conversation id for one Feishu window.
 * @param target - private user or chat.
 * @returns the id send_text copies into `conversation`.
 */
export function formatFeishuConversation(target: FeishuConversation): string {
  if (target.kind === 'private') return `${PRIVATE_PREFIX}${openId(target.openId)}`
  return `${CHAT_PREFIX}${chatId(target.chatId)}`
}

/**
 * Read a conversation id back into a Feishu window.
 * @param conversation - value from an inbound message or a send_text call.
 * @returns the window.
 */
export function parseFeishuConversation(conversation: string): FeishuConversation {
  const value = conversation.trim()
  if (value.startsWith(PRIVATE_PREFIX)) {
    return { kind: 'private', openId: openId(value.slice(PRIVATE_PREFIX.length)) }
  }
  if (value.startsWith(CHAT_PREFIX)) {
    return { kind: 'chat', chatId: chatId(value.slice(CHAT_PREFIX.length)) }
  }
  throw new Error(`无法识别的飞书会话: ${value}`)
}

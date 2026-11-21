/**
 * QQ conversation ids used by send_text.
 *
 * A channel name alone is the platform. The conversation id selects one window:
 * a private chat with one user, or one group.
 * @module @elysia/qq-napcat/conversation
 */

/** One QQ window send_text can address. */
export type QqConversation =
  | { kind: 'private'; userId: string }
  | { kind: 'group'; groupId: string }

const PRIVATE_PREFIX = 'qq:private:'
const GROUP_PREFIX = 'qq:group:'

function numericId(value: string, label: string): string {
  const id = value.trim()
  if (!/^[1-9][0-9]*$/u.test(id)) {
    throw new Error(`${label} 必须是正整数字符串`)
  }
  return id
}

/**
 * Build the conversation id for one QQ window.
 * @param target - private user or group.
 * @returns the id send_text copies into `conversation`.
 */
export function formatQqConversation(target: QqConversation): string {
  if (target.kind === 'private') return `${PRIVATE_PREFIX}${numericId(target.userId, 'userId')}`
  return `${GROUP_PREFIX}${numericId(target.groupId, 'groupId')}`
}

/**
 * Read a conversation id back into a QQ window.
 * @param conversation - value from an inbound message or a send_text call.
 * @returns the window. An unknown shape throws; it is not treated as another channel.
 */
export function parseQqConversation(conversation: string): QqConversation {
  const value = conversation.trim()
  if (value.startsWith(PRIVATE_PREFIX)) {
    return { kind: 'private', userId: numericId(value.slice(PRIVATE_PREFIX.length), 'userId') }
  }
  if (value.startsWith(GROUP_PREFIX)) {
    return { kind: 'group', groupId: numericId(value.slice(GROUP_PREFIX.length), 'groupId') }
  }
  throw new Error(`无法识别的 QQ 会话: ${value}`)
}

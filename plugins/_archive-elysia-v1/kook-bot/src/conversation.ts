/**
 * KOOK conversation ids used by send_text.
 * @module @elysia/kook-bot/conversation
 */

/** One KOOK window send_text can address. */
export type KookConversation =
  | { kind: 'direct'; userId: string }
  | { kind: 'channel'; channelId: string }

const DIRECT_PREFIX = 'kook:direct:'
const CHANNEL_PREFIX = 'kook:channel:'

function snowflake(value: string, label: string): string {
  const id = value.trim()
  if (!/^[1-9][0-9]*$/u.test(id)) throw new Error(`${label} 必须是正整数字符串`)
  return id
}

/**
 * Build the conversation id for one KOOK window.
 * @param target - direct user or channel.
 * @returns the id send_text copies into `conversation`.
 */
export function formatKookConversation(target: KookConversation): string {
  if (target.kind === 'direct') return `${DIRECT_PREFIX}${snowflake(target.userId, 'userId')}`
  return `${CHANNEL_PREFIX}${snowflake(target.channelId, 'channelId')}`
}

/**
 * Read a conversation id back into a KOOK window.
 * @param conversation - value from an inbound message or a send_text call.
 * @returns the window.
 */
export function parseKookConversation(conversation: string): KookConversation {
  const value = conversation.trim()
  if (value.startsWith(DIRECT_PREFIX)) {
    return { kind: 'direct', userId: snowflake(value.slice(DIRECT_PREFIX.length), 'userId') }
  }
  if (value.startsWith(CHANNEL_PREFIX)) {
    return { kind: 'channel', channelId: snowflake(value.slice(CHANNEL_PREFIX.length), 'channelId') }
  }
  throw new Error(`无法识别的 KOOK 会话: ${value}`)
}

/**
 * Ayla conversation ids used by send_text, with the same `channel:kind:id`
 * spelling the KOOK and QQ channels use.
 * @module @elysia/ayla-app/conversation
 */

/** One Ayla window a reply can address. */
export type AylaConversation =
  | { kind: 'private'; id: string }
  | { kind: 'group'; id: string }

const PRIVATE_PREFIX = 'ayla:private:'
const GROUP_PREFIX = 'ayla:group:'

/**
 * Read one Ayla conversation id, which is a positive decimal string in the
 * backend's `Message.conversation_id`.
 * @param value - candidate id.
 * @param label - field name used in the error message.
 * @returns the trimmed id.
 */
function conversationId(value: string, label: string): string {
  const id = value.trim()
  if (!/^[1-9][0-9]*$/u.test(id)) throw new Error(`${label} 必须是正整数字符串: ${JSON.stringify(value)}`)
  return id
}

/**
 * Build the DSH conversation id for one Ayla window.
 * @param target - private or group conversation.
 * @returns the id a reply copies into `conversation`.
 */
export function formatAylaConversation(target: AylaConversation): string {
  const id = conversationId(target.id, target.kind === 'private' ? 'private id' : 'group id')
  return target.kind === 'private' ? `${PRIVATE_PREFIX}${id}` : `${GROUP_PREFIX}${id}`
}

/**
 * Read a DSH conversation id back into an Ayla window.
 *
 * An unrecognized id throws instead of falling back to a default window: a
 * reply sent to a guessed conversation would reach the wrong chat.
 * @param conversation - value from an inbound message or a send_text call.
 * @returns the window.
 */
export function parseAylaConversation(conversation: string): AylaConversation {
  const value = conversation.trim()
  if (value.startsWith(PRIVATE_PREFIX)) {
    return { kind: 'private', id: conversationId(value.slice(PRIVATE_PREFIX.length), 'private id') }
  }
  if (value.startsWith(GROUP_PREFIX)) {
    return { kind: 'group', id: conversationId(value.slice(GROUP_PREFIX.length), 'group id') }
  }
  throw new Error(`无法识别的 Ayla 会话: ${JSON.stringify(conversation)}`)
}

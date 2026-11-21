/**
 * Read a send_text tool call out of one chat-completion message.
 * @module @elysia/conscious-mind/reply-args
 */

/** The piece of a completion message this loop understands. */
export interface ModelToolMessage {
  content?: unknown
  tool_calls?: { function?: { arguments?: unknown } }[]
}

/** Arguments taken from one tool call, plus the raw text that carried them. */
export interface ReadToolArguments {
  args: Record<string, unknown>
  raw: string
}

/**
 * Read tool arguments whether the provider sent a JSON string or an object.
 * A missing or unreadable call becomes an empty argument object.
 * @param message - the first choice message, when the provider returned one.
 * @returns the argument object and the raw argument text.
 */
export function readToolArguments(message: ModelToolMessage | undefined): ReadToolArguments {
  const call = message?.tool_calls?.[0]?.function?.arguments
  if (call !== null && typeof call === 'object') {
    return { args: call as Record<string, unknown>, raw: JSON.stringify(call) }
  }
  const raw = typeof call === 'string' ? call : ''
  if (raw.trim().length === 0) return { args: {}, raw }
  try {
    const parsed = JSON.parse(raw) as unknown
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { args: parsed as Record<string, unknown>, raw }
    }
  } catch {
    return { args: {}, raw }
  }
  return { args: {}, raw }
}

/**
 * The words the tool would actually send.
 * @param args - parsed send_text arguments.
 * @returns `content` when it is a string, otherwise an empty string.
 */
export function outboundContent(args: Record<string, unknown>): string {
  return typeof args.content === 'string' ? args.content : ''
}

const TOOL_MARKUP = /string="true"|<\/?parameter\b|<tool_call\b|<invoke\b/iu

/**
 * Keep only a reply a person should see. Tool-parameter debris and a lone
 * ASCII letter are not a reply.
 * @param content - the content field from a tool call.
 * @returns the trimmed words, or undefined when they must not be sent.
 */
export function spokenReply(content: string): string | undefined {
  const text = content.trim()
  if (text.length === 0) return undefined
  if (TOOL_MARKUP.test(text)) return undefined
  if (/^[A-Za-z]$/u.test(text)) return undefined
  return text
}

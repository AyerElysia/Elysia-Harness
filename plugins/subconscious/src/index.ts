import type { Context } from '@deepseek-ai/cordis'

export const name = 'elysia-subconscious'

/**
 * Reserve the multi-session subconscious host without starting runtime work.
 * Session, prompt, heartbeat, rest, and memory contracts live in the documents.
 */
export function apply(_ctx: Context): void {
  // Intentionally empty: no sessions, timers, subscriptions, storage, or tools.
}

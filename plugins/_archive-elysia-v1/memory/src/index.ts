import type { Context } from '@deepseek-ai/cordis'

export const name = 'elysia-memory'

/**
 * Reserve the engineering boundary for Elysia's self-organized memory.
 * Runtime work requires a separately agreed implementation of REQUIREMENTS.zh.md.
 */
export function apply(_ctx: Context): void {
  // Intentionally empty: no sessions, timers, subscriptions, tools, or storage.
}

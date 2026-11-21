import type { Context } from '@deepseek-ai/cordis'

export const name = 'elysia-proactive-system'

/**
 * Reserve the proactive-system plugin boundary without starting runtime work.
 * The asynchronous opportunity lifecycle is specified in REQUIREMENTS.zh.md.
 */
export function apply(_ctx: Context): void {
  // Intentionally empty: no timers, sessions, model calls, storage, or tools.
}

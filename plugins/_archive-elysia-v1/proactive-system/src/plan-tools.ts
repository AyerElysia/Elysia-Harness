/**
 * Agent-scoped access to DSH's native reminder tools.
 * Native registration and execution stay intact; usage guidance is model context.
 */
import type { Context } from '@deepseek-ai/cordis'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import type {} from '@deepseek-ai/dsh-system-prompt'
import * as NativePlanTools from '@deepseek-ai/dsh-tool-schedule'
import type {} from '@deepseek-ai/dsh-tools'
import { PLAN_GUIDANCE } from './plan-guidance.ts'

export const name = 'elysia-plan-tools'
export const inject = ['tools', 'systemPrompt']

/** Mount only inside the owning Agent's scope, including before Host readiness. */
export async function apply(ctx: Context): Promise<void> {
  const owner = scopeOf(ctx)
  if (owner === undefined) {
    throw new Error('elysia-plan-tools requires an Agent-scoped context')
  }
  await ctx.plugin(NativePlanTools)
  // Complete system prompts discard additional sections, and the assembly
  // waterfall no longer owns tool schemas. Required context preserves both.
  ctx.systemPrompt.context({
    name: 'elysia:plan-guidance',
    order: 250,
    required: true,
    interpolate: false,
    // Child scopes can inherit this provider. Do not describe tools before
    // the native Schedule service has made them available in the exact owner.
    text: ({ scope }) => scope === owner && ctx.tools.get('schedule_create', owner) !== undefined
      ? PLAN_GUIDANCE
      : '',
  })
}

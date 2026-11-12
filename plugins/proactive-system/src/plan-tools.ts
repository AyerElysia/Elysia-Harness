/**
 * Agent-scoped access to DSH's native reminder tools.
 * Native registration and execution stay intact; usage guidance is assembly-only.
 */
import type { Context } from '@deepseek-ai/cordis'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import type {} from '@deepseek-ai/dsh-system-prompt'
import * as NativePlanTools from '@deepseek-ai/dsh-tool-schedule'
import { PLAN_TOOL_GUIDANCE } from './plan-guidance.ts'

export const name = 'elysia-plan-tools'
export const inject = ['tools', 'systemPrompt']

/** Mount only inside the owning Agent's scope, including before Host readiness. */
export async function apply(ctx: Context): Promise<void> {
  const owner = scopeOf(ctx)
  if (owner === undefined) {
    throw new Error('elysia-plan-tools requires an Agent-scoped context')
  }
  await ctx.plugin(NativePlanTools)
  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const assembled = await next()
    // Scoped listeners also receive descendant events; only describe this owner.
    if (context.scope !== owner) return assembled
    return {
      ...assembled,
      tools: assembled.tools.map(tool => {
        const guidance = PLAN_TOOL_GUIDANCE.get(tool.name)
        return guidance === undefined ? tool : {
          ...tool,
          description: `${tool.description}\n\n${guidance}`,
        }
      }),
    }
  })
}

/**
 * Native compaction for every live and future Agent Session.
 * @module @elysia/session-compaction
 */

import type { Context, Fiber } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import * as CommandCompact from '@deepseek-ai/dsh-command-compact'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-compaction'
import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic'

export const name = 'elysia-session-compaction'
export const inject = ['agents']

/**
 * Fill only missing capabilities. In particular, the conscious mind's existing
 * `auto: false` engine remains manual, while Sessions without an engine gain
 * pressure compaction and context-overflow recovery.
 */
export async function apply(ctx: Context): Promise<void> {
  const owned = new Map<Agent, Fiber>()
  const pending = new Map<Agent, Promise<void>>()

  const sync = (agent: Agent): Promise<void> => {
    if (owned.has(agent)) return Promise.resolve()
    const existing = pending.get(agent)
    if (existing !== undefined) return existing

    const operation = (async () => {
      const fiber = await agent.ctx.plugin({
        name: 'elysia-session-compaction-agent',
        inject: ['commands'],
        apply: async (agentCtx: Context) => {
          if (agentCtx.get('compaction') === undefined) {
            await agentCtx.plugin(BasicCompactionEngine, { auto: true })
          }
          if (agentCtx.commands.find(agent, 'compact') === undefined) {
            await agentCtx.plugin(CommandCompact)
          }
        },
      })
      owned.set(agent, fiber)
      agent.ctx.effect(() => () => {
        if (owned.get(agent) === fiber) owned.delete(agent)
      }, 'elysia-session-compaction.agent-cleanup')
    })().finally(() => { pending.delete(agent) })

    pending.set(agent, operation)
    return operation
  }

  ctx.on('agent/created', async ({ agent }) => {
    await sync(agent)
    return undefined
  })
  ctx.effect(() => async () => {
    await Promise.all([...owned.values()].map(fiber => fiber.dispose()))
  }, 'elysia-session-compaction.agents')
  await Promise.all(ctx.agents.list().map(sync))
}

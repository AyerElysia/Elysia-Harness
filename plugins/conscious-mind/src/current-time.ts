/** Scoped native clock plus independently sampled calendar facts. */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { createUserMessage, type ContextFormed } from '@deepseek-ai/dsh-llm'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import * as NativeTimeContext from '@deepseek-ai/dsh-time-context'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'elysia-calendar-context': { kind: 'elysia-calendar-context' } & ContextFormed
  }
}

export const name = 'elysia-current-time'
export const inject = ['agents', 'sessionProjections']

/** Explicit fallback zone; the native plugin validates the IANA identifier. */
export interface Config {
  timeZone: string
}

export const Config: z<Config> = z.object({ timeZone: z.string().required() })

/** Sample each actual step; no timer and no change to native browser-zone selection. */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const owner = scopeOf(ctx)
  if (owner === undefined) throw new Error('elysia-current-time requires an Agent-scoped context')
  await ctx.plugin(NativeTimeContext, { timeZone: config.timeZone, refreshIntervalMs: 0 })
  const calendar = new Intl.DateTimeFormat('zh-CN', {
    timeZone: config.timeZone, calendar: 'gregory', numberingSystem: 'latn',
    year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'long',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    timeZoneName: 'longOffset',
  })
  const timeZone = calendar.resolvedOptions().timeZone
  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    const decision = await next()
    // Scoped events also reach ancestor listeners; this supplement belongs only to its exact owner.
    if (agent !== owner || decision.kind === 'reject' || signal.aborted) return decision
    const sampledAt = Date.now()
    const parts = new Map(calendar.formatToParts(sampledAt).map(part => [part.type, part.value]))
    const text = `配置时区的系统日历事实：日期 ${parts.get('year')}-${parts.get('month')}-${parts.get('day')}；${parts.get('weekday')}；时间 ${parts.get('hour')}:${parts.get('minute')}:${parts.get('second')}；时区 ${timeZone}；UTC 偏移 ${parts.get('timeZoneName')}。\n`
      + `本条日历事实的独立采样时刻（UTC ISO）：${new Date(sampledAt).toISOString()}。\n`
      + '本条按配置时区计算，与原生 time-context 各自独立采样；不改变原生浏览器时区选择。'
    return {
      ...decision,
      messages: [...decision.messages, createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'elysia-calendar-context', form: 'snapshot', sections: [{ name: 'elysia-calendar-context', text }] },
      })],
    }
  }, { prepend: true })
}

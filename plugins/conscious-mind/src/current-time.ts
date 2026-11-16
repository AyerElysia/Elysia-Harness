/** One minimal configured-zone clock for each of Elysia's actual turns. */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type ContextFormed } from '@deepseek-ai/dsh-llm'
import { scopeOf } from '@deepseek-ai/dsh-scope'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'elysia-calendar-context': { kind: 'elysia-calendar-context' } & ContextFormed
  }
}

export const name = 'elysia-current-time'
export const inject = ['agents']

/** The single IANA zone used for Elysia's minimal clock. */
export interface Config {
  timeZone: string
}

export const Config: z<Config> = z.object({ timeZone: z.string().required() })

/** Retire all earlier Elysia/native clocks from the visible surface, preserving history. */
function clearVisibleClocks(agent: Agent): void {
  for (const seq of [...agent.session.surface.nodes]) {
    const event = agent.session.eventAt(seq)
    if (event?.type !== 'user/message'
      || !['time-context', 'elysia-calendar-context'].includes(event.data.source.kind)
      || event.data.content.length === 0) continue
    agent.session.append('user/message', createUserMessage({
      content: [], source: event.data.source,
    }), {
      surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq },
      sourceEventSeqs: [seq],
    })
  }
}

/** Sample once per actual turn; tool steps reuse it without another injection. */
export function apply(ctx: Context, config: Config): void {
  const owner = scopeOf(ctx)
  if (owner === undefined) throw new Error('elysia-current-time requires an Agent-scoped context')
  let calendar: Intl.DateTimeFormat
  try {
    calendar = new Intl.DateTimeFormat('zh-CN', {
      timeZone: config.timeZone, calendar: 'gregory', numberingSystem: 'latn',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    })
  } catch (error) {
    throw new Error(`invalid IANA timeZone: ${config.timeZone}`, { cause: error })
  }
  let injectedTurn: number | undefined
  clearVisibleClocks(owner)
  ctx.effect(() => () => clearVisibleClocks(owner))
  ctx.on('agent/pre-step', async ({ agent, turn, signal }, next) => {
    const decision = await next()
    // Scoped events also reach ancestor listeners; this clock belongs only to its exact owner.
    if (agent !== owner || decision.kind === 'reject' || signal.aborted || injectedTurn === turn) return decision
    clearVisibleClocks(agent)
    const parts = new Map(calendar.formatToParts(Date.now()).map(part => [part.type, part.value]))
    const text = `${parts.get('year')}/${parts.get('month')}/${parts.get('day')} ${parts.get('hour')}:${parts.get('minute')}`
    injectedTurn = turn
    return {
      ...decision,
      messages: [...decision.messages, createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'elysia-calendar-context', form: 'snapshot', sections: [{ name: 'elysia-calendar-context', text }] },
      })],
    }
  }, { prepend: true })
}

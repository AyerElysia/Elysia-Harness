import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionSeq } from '@deepseek-ai/dsh-session'

/** Attached by the trusted channel ingress. Keep kind=user for DSH rendering. */
export const platformMessageSource = { kind: 'user', elysiaIngress: 'platform' } as const

/** Inspect only messages admitted into the active native turn. */
export function hasLocalDialogueInput(agent: Pick<Agent, 'session'>): boolean {
  const { session } = agent
  let local = false
  for (let seq = Number(session.seq) - 1; seq >= 0; seq--) {
    const event = session.eventAt(seq as SessionSeq)
    if (event?.type === 'turn/end') return false
    if (event?.type === 'turn/start') return local
    if (event?.type !== 'user/message') continue
    const source = event.data.source
    if (source.kind === 'user' && (!('elysiaIngress' in source) || source.elysiaIngress !== 'platform')) local = true
  }
  return false
}

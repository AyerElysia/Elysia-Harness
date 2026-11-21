/** Reserve the dedicated voice identity without wrapping or replacing any Agent factory. */
import type { Context } from '@deepseek-ai/cordis'
import { VoiceAgent, VOICE_SESSION_ID } from './session.ts'

export const VOICE_OWNERSHIP_REJECTED = 'voice_session_ownership_reserved'

/** Safe fixed refusal; never includes Session text, a prompt, or provider data. */
export class VoiceSessionOwnershipError extends Error {
  readonly code = VOICE_OWNERSHIP_REJECTED
  constructor() { super(VOICE_OWNERSHIP_REJECTED); this.name = 'VoiceSessionOwnershipError' }
}

/** A real voice driver must also belong to this particular plugin lifecycle. */
function ownedBy(agent: VoiceAgent, owner: Context): boolean {
  let current = agent.ctx.fiber
  while (true) {
    if (current === owner.fiber) return true
    const parent = current.parent.fiber
    if (parent === current) return false
    current = parent
  }
}

/**
 * Reject generic create/resume/promotion of only this reserved identity at the
 * public serial publication boundary. The native factory owns rollback; no
 * Agent, Session, metadata, or factory is mutated by this listener.
 * @returns The ordinary event disposer; owner unload removes it automatically.
 */
export function mountVoiceOwnership(ctx: Context): () => void {
  return ctx.on('agent/created', ({ agent }) => {
    if (agent.id !== VOICE_SESSION_ID) return
    if (agent instanceof VoiceAgent && ownedBy(agent, ctx)) return
    throw new VoiceSessionOwnershipError()
  }, { prepend: true })
}

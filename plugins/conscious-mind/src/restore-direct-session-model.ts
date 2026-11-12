/** Restore the native persisted route while a direct owner's resumed Agent is still private. */
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'

interface PendingModelSelection {
  provider: string
  model: string
  reasoningEffort?: string
}

interface NativeModelSelectionProjection {
  stateOf(
    session: Agent['session'],
    key: 'modelSelection',
  ): { pending: PendingModelSelection | null } | undefined
}

/**
 * Use the same pending selection and request header as the Web controller.
 * Direct owners call this only from resume setup, before publication. Later
 * Web selections keep their own native request handling and change notices.
 */
export function restoreDirectSessionModel(agent: Agent, ownerSessionId: Agent['id']): void {
  if (agent.id !== ownerSessionId || agent.session.id !== ownerSessionId) return

  const projections = agent.ctx.get('sessionProjections') as NativeModelSelectionProjection | undefined
  const pending = projections?.stateOf(agent.session, 'modelSelection')?.pending
  const header = agent.session.requestHeader()
  const selected = pending ?? header?.config
  if (selected === undefined) return

  agent.options.provider = selected.provider
  agent.options.model = selected.model
  const effort = pending != null
    ? pending.reasoningEffort
    : header?.adapterDefaults?.reasoningEffort === true ? undefined : header?.config.reasoningEffort
  // Native AgentLoop may inherit an old explicit effort on the same route
  // when the pending selection omits it. Native UI selection handles resets.
  if (effort === undefined) delete agent.options.reasoningEffort
  else agent.options.reasoningEffort = ReasoningEffortId(effort)
}

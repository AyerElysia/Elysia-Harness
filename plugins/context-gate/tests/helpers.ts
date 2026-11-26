/**
 * Test harness pieces shared by the Host behavior specs: a structural Agent
 * for the pre-step waterfall, and one synthetic pre-step that commits what the
 * gate injected the way the real loop commits an admitted message.
 */
import { Context } from '@deepseek-ai/cordis'
import { agentEvents, type Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { unsupportedInbox, unsupportedModel } from '@deepseek-ai/dsh-agent-loop-testkit'

/** Signal used by the synthetic steps. */
export const SIGNAL = new AbortController().signal

/** What one synthetic pre-step decided. */
export interface StepResult {
  /** Messages the gate appended after the proposed message. */
  readonly injected: readonly UserMessage[]
}

/**
 * Build a structurally complete Agent around one session.
 * @param session - live session the Agent drives.
 * @param status - lifecycle state used by the wake scheduler.
 * @param followup - wake sink; tests record the follow-up message.
 * @returns the Agent and the mutable status holder.
 */
export function testAgent(
  session: Session,
  followup: (message: UserMessage) => void = () => {},
): { readonly agent: Agent; status: { value: 'idle' | 'running' } } {
  const status: { value: 'idle' | 'running' } = { value: 'idle' }
  const agent: Agent = {
    id: session.id,
    options: {},
    session,
    model: unsupportedModel(),
    inbox: unsupportedInbox(),
    get status() { return status.value },
    ctx: new Context(),
    send: () => {},
    followup,
    steer: () => {},
    inject: () => { throw new Error('the test agent does not accept pending context') },
    cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
  return { agent, status }
}

/**
 * Run the real pre-step waterfall and append the gate's snapshot to the surface.
 * @param ctx - Host context whose global gate listener is attached.
 * @param agent - Agent proposing the step.
 * @param step - step number inside the synthetic turn.
 * @returns the messages the gate injected after the proposed message.
 */
export async function firePreStep(ctx: Context, agent: Agent, step = 1): Promise<StepResult> {
  const proposed = createUserMessage({ content: [{ type: 'text', text: `step ${String(step)}` }], source: { kind: 'user' } })
  const decision = await agentEvents(ctx, agent).waterfall(
    'agent/pre-step',
    {
      modelSelection: { provider: 'mock', model: 'mock' },
      messages: [proposed],
      turn: 1,
      step,
      signal: SIGNAL,
    },
    () => Promise.resolve({ kind: 'enter' as const, messages: [proposed] }),
  )
  if (decision.kind !== 'enter') throw new Error('the gate rejected the synthetic step')
  const injected = decision.messages.filter(message => message !== proposed)
  for (const message of injected) {
    agent.session.append('user/message', message, { surfaceOp: 'append' })
  }
  return { injected }
}

/**
 * Extract the text blocks of one user message.
 * @param message - message to read.
 * @returns the concatenated text blocks.
 */
export function textOf(message: UserMessage): string {
  return message.content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map(block => block.text)
    .join('\n')
}

/** One fresh session for a structural Agent. */
export function newSession(id = 's1'): Session {
  return Session.create(SessionId(id))
}

/** Wait for real timers (the batching tests exercise the real scheduler). */
export async function sleep(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms))
}
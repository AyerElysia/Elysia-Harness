/** Read-only audio mirror of an exact, ordinary main Agent turn. */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { MAX_SPOKEN_LENGTH } from './bridge.ts'

export interface MainVoicePoll { seq: number; text: string; done: boolean }
export interface MainVoiceReply {
  readonly done: boolean
  poll(seq: number): MainVoicePoll
  detach(): void
}

const frameworkContext = new Set(['runtime-context', 'agent-instructions', 'time-context', 'elysia-calendar-context'])

/** Queue exactly as the owner Web prompt does, against an already live Agent. */
export function submitMainVoice(ctx: Context, agent: Agent, text: string): MainVoiceReply {
  const source = { kind: 'user' as const, rpcId: 'voice-' + randomUUID() }
  const message = createUserMessage({ content: [{ type: 'text', text }], source })
  const dispose: (() => void)[] = []
  let currentTurn: number | undefined
  let target: number | undefined
  let hasOtherInput = false
  let admitted = false
  let answer = ''
  let done = false
  let spoken = ''
  function finish(body = ''): void {
    if (done) return
    done = true
    spoken = body
    for (const stop of dispose.splice(0)) stop()
  }
  dispose.push(ctx.on('agent/inbox/claimed', ({ agent: subject, message: claimed, turn }) => {
    if (subject !== agent || done || currentTurn !== turn) return
    if (claimed.id === message.id) target = turn
    else hasOtherInput = true
  }))
  dispose.push(ctx.on('agent/inbox/discarded', ({ agent: subject, message: discarded }) => {
    if (subject === agent && discarded.id === message.id) finish()
  }))
  dispose.push(ctx.on('agent/disposed', ({ agent: subject }) => { if (subject === agent) finish() }))
  dispose.push(ctx.on('session/event', (session, event) => {
    if (session !== agent.session || done) return
    if (event.type === 'turn/start') {
      currentTurn = event.data.turn
      hasOtherInput = false
      return
    }
    if (event.type === 'user/message' && currentTurn !== undefined) {
      if (event.data.id === message.id) {
        target = currentTurn
        admitted = true
      } else if (!frameworkContext.has(event.data.source.kind)) {
        hasOtherInput = true
      }
      return
    }
    if (event.type === 'turn/end') {
      currentTurn = undefined
      if (event.data.turn === target) finish(admitted && !hasOtherInput && event.data.reason.kind === 'completed' ? answer : '')
      return
    }
    if (target === undefined || currentTurn !== target) return
    if (event.type === 'step/start' && event.data.turn === target) answer = ''
    if (event.type === 'assistant/message' && event.data.turn === target) {
      const { content } = event.data.message
      if (event.data.interrupted || content.some(block => block.type === 'tool-call')) return
      const plain = content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n').trim()
      // Do not split a surrogate pair, and do not change the durable response.
      answer = plain.slice(0, MAX_SPOKEN_LENGTH).replace(/[\uD800-\uDBFF]$/u, '')
    }
  }))
  try { agent.followup(message) }
  catch (error) { finish(); throw error }
  return {
    get done() { return done },
    poll(seq) { return { seq: Math.max(seq, spoken.length), text: spoken.slice(seq), done } },
    detach() { finish(); spoken = '' },
  }
}

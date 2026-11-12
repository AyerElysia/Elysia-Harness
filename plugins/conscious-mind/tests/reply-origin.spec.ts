import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { describe, expect, it } from 'vitest'
import { hasLocalDialogueInput, platformMessageSource } from '../src/reply-origin.ts'

function user(source: Parameters<typeof createUserMessage>[0]['source']) {
  return { type: 'user/message', data: createUserMessage({ content: [{ type: 'text', text: 'fixture' }], source }) }
}

function hasLocal(...events: unknown[]): boolean {
  return hasLocalDialogueInput({ session: { seq: events.length, eventAt: (seq: number) => events[seq] } } as Pick<Agent, 'session'>)
}

const turnStart = { type: 'turn/start' }
const turnEnd = { type: 'turn/end' }
const tool = { type: 'tool/call' }

describe('native main dialogue routing', () => {
  it('classifies Web text and the current call transcript as local even after a tool step', () => {
    for (const rpcId of ['web-request', 'voice-transcript']) {
      expect(hasLocal(turnStart, user({ kind: 'user', rpcId }), tool)).toBe(true)
    }
  })

  it('keeps trusted platform provenance on the native user message', () => {
    const input = user(platformMessageSource)
    expect(input.data.source).toEqual({ kind: 'user', elysiaIngress: 'platform' })
    expect(hasLocal(turnStart, input, tool)).toBe(false)
  })

  it('treats a mixed active turn as local and ignores a completed local turn', () => {
    const local = user({ kind: 'user', rpcId: 'web-request' })
    const external = user(platformMessageSource)
    expect(hasLocal(turnStart, external, tool, local, tool)).toBe(true)
    expect(hasLocal(turnStart, local, turnEnd, turnStart, external, tool)).toBe(false)
    expect(hasLocal(turnStart, local, turnEnd)).toBe(false)
  })
})

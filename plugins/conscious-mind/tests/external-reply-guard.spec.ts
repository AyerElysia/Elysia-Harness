import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { describe, expect, it, vi } from 'vitest'
import { hasExternalReplyToolChoice, installExternalReplyGuard } from '../src/external-reply-guard.ts'
import { platformMessageSource } from '../src/reply-origin.ts'

const turnStart = { type: 'turn/start' }
const turnEnd = { type: 'turn/end' }
const assistant = { type: 'assistant/message' }

function user(source: Parameters<typeof createUserMessage>[0]['source']) {
  return { type: 'user/message', data: createUserMessage({ content: [{ type: 'text', text: 'fixture' }], source }) }
}

function tool(name: string, id: string, isError = false) {
  const callId = ToolCallId(id)
  return [
    { type: 'tool/call', data: { name, callId } },
    { type: 'tool/result', data: { message: { toolCallId: callId, isError } } },
  ]
}

function fixture(...events: unknown[]) {
  const agent = {
    session: { seq: events.length, eventAt: (seq: number) => events[seq] },
    steer: vi.fn(),
  } as unknown as Agent
  return { agent, steer: agent.steer as ReturnType<typeof vi.fn> }
}

function guard() {
  let listener: ((payload: { agent: Agent; turn: number; signal: AbortSignal }) => void) | undefined
  const dispose = vi.fn()
  const ctx = { on: vi.fn((_name, callback) => { listener = callback; return dispose }) } as unknown as Context
  expect(installExternalReplyGuard(ctx)).toBe(dispose)
  return async (agent: Agent, turn = 1) => {
    await listener?.({ agent, turn, signal: new AbortController().signal })
  }
}

describe('external reply tool choice', () => {
  it('recognizes either send tool and pass, including failed delivery attempts', () => {
    for (const name of ['send_text', 'send_voice', 'pass']) {
      const { agent } = fixture(turnStart, user(platformMessageSource), ...tool(name, `call-${name}`), assistant)
      expect(hasExternalReplyToolChoice(agent)).toBe(true)
    }
    const failed = fixture(turnStart, ...tool('send_text', 'failed', true), assistant)
    expect(hasExternalReplyToolChoice(failed.agent)).toBe(true)
  })

  it('ignores unrelated tools and completed turns', () => {
    expect(hasExternalReplyToolChoice(fixture(turnStart, ...tool('read', 'read-1'), assistant).agent)).toBe(false)
    expect(hasExternalReplyToolChoice(fixture(turnStart, ...tool('pass', 'pass-1'), turnEnd).agent)).toBe(false)
  })
})

describe('external reply turn guard', () => {
  it('reminds a platform-only text turn once inside the same native turn', async () => {
    const { agent, steer } = fixture(turnStart, user(platformMessageSource), assistant)
    const stopping = guard()
    await stopping(agent)
    expect(steer).toHaveBeenCalledOnce()
    const correction = steer.mock.calls[0]?.[0]
    expect(JSON.stringify(correction)).toContain('send_text、send_voice 或 pass')
    expect(correction.source.kind).toBe('elysia-external-reply-guard')
    await stopping(agent)
    expect(steer).toHaveBeenCalledOnce()
  })

  it.each(['send_text', 'send_voice', 'pass'])('accepts %s without a correction', async name => {
    const { agent, steer } = fixture(turnStart, user(platformMessageSource), ...tool(name, `call-${name}`), assistant)
    await guard()(agent)
    expect(steer).not.toHaveBeenCalled()
  })

  it('requires a choice for mixed input without blocking the later local text', async () => {
    const mixed = fixture(turnStart, user(platformMessageSource), user({ kind: 'user', rpcId: 'web-request' }), assistant)
    await guard()(mixed.agent)
    expect(mixed.steer).toHaveBeenCalledOnce()
    expect(JSON.stringify(mixed.steer.mock.calls[0]?.[0])).toContain('继续用正文回应 DSH')

    const answered = fixture(turnStart, user(platformMessageSource), user({ kind: 'user', rpcId: 'web-request' }),
      ...tool('send_text', 'mixed-send'), assistant)
    await guard()(answered.agent)
    expect(answered.steer).not.toHaveBeenCalled()
  })

  it('does not confuse local, historical platform, or internal inputs with a current platform turn', async () => {
    for (const events of [
      [turnStart, user({ kind: 'user', rpcId: 'web-request' }), assistant],
      [turnStart, user(platformMessageSource), turnEnd, turnStart, user({ kind: 'user', rpcId: 'web-request' }), assistant],
      [turnStart, user({ kind: 'schedule', form: 'notice', summary: 'fixture' }), assistant],
    ]) {
      const { agent, steer } = fixture(...events)
      await guard()(agent)
      expect(steer).not.toHaveBeenCalled()
    }
  })
})

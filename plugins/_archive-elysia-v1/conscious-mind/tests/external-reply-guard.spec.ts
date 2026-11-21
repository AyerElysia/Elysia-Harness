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

/** Persisted result content: one text block whose JSON is the tool value. */
function content(value: unknown) {
  return [{ type: 'text', text: JSON.stringify(value) }]
}

/** The result value a reply tool returns after it actually delivered. */
function delivered(name: string) {
  if (name === 'send_text') return content({ sent: [{ index: 0, text: 'fixture', messageId: 'm-1' }] })
  if (name === 'send_voice') return content({ status: 'sent', messageId: 'm-1' })
  return content({ passed: true, reason: 'fixture' })
}

function tool(name: string, id: string, isError = false, body = delivered(name)) {
  const callId = ToolCallId(id)
  return [
    { type: 'tool/call', data: { name, callId } },
    { type: 'tool/result', data: { message: { toolCallId: callId, isError, content: body } } },
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
  it('recognizes either send tool and pass as an explicit choice', () => {
    for (const name of ['send_text', 'send_voice', 'pass']) {
      const { agent } = fixture(turnStart, user(platformMessageSource), ...tool(name, `call-${name}`), assistant)
      expect(hasExternalReplyToolChoice(agent)).toBe(true)
    }
  })

  it('does not count a failed delivery attempt as a choice', () => {
    const failed = fixture(turnStart,
      ...tool('send_text', 'refused', true, [{ type: 'text', text: 'Error: 外发未获本次确认，未发送。' }]),
      assistant)
    expect(hasExternalReplyToolChoice(failed.agent)).toBe(false)
  })

  it('counts a send_text result only when at least one segment was sent', () => {
    const partial = fixture(turnStart,
      ...tool('send_text', 'partial', false, content({ sent: [{ index: 0, text: '第一段' }], stoppedAt: 1, error: '第二段发送失败' })),
      assistant)
    expect(hasExternalReplyToolChoice(partial.agent)).toBe(true)

    for (const value of [{ sent: [], error: '渠道未登记: qq' }, { sent: [], stoppedAt: 0, error: '投递状态未知' }]) {
      const dropped = fixture(turnStart, ...tool('send_text', 'dropped', false, content(value)), assistant)
      expect(hasExternalReplyToolChoice(dropped.agent)).toBe(false)
    }
  })

  it('keeps a send_text choice standing when its result content cannot be read', () => {
    const pruned = fixture(turnStart, ...tool('send_text', 'pruned', false, [{ type: 'text', text: '[pruned tool result]' }]), assistant)
    expect(hasExternalReplyToolChoice(pruned.agent)).toBe(true)
    const missing = fixture(turnStart, ...tool('send_text', 'missing', false, []), assistant)
    expect(hasExternalReplyToolChoice(missing.agent)).toBe(true)
  })

  it('counts an errored reply result as no choice whatever its content says', () => {
    const errored = fixture(turnStart,
      ...tool('send_text', 'errored', true, content({ sent: [{ index: 0, text: '部分' }], error: '投递状态未知' })),
      assistant)
    expect(hasExternalReplyToolChoice(errored.agent)).toBe(false)
  })

  it.each([
    { status: 'sent', chosen: true },
    { status: 'unknown', chosen: true },
    { status: 'synthesis-failed', chosen: false },
    { status: 'send-failed', chosen: false },
  ])('treats send_voice status $status as chosen: $chosen', ({ status, chosen }) => {
    const { agent } = fixture(turnStart,
      ...tool('send_voice', `voice-${status}`, false, content({ status, ...(chosen ? {} : { error: 'fixture failure' }) })),
      assistant)
    expect(hasExternalReplyToolChoice(agent)).toBe(chosen)
  })

  it('accepts a delivered send after an earlier failure and keeps counting after a later failure', () => {
    const retried = fixture(turnStart, ...tool('send_text', 'refused', true), ...tool('send_text', 'delivered'), assistant)
    expect(hasExternalReplyToolChoice(retried.agent)).toBe(true)
    const durable = fixture(turnStart, ...tool('send_text', 'delivered'), ...tool('send_text', 'refused-retry', true), assistant)
    expect(hasExternalReplyToolChoice(durable.agent)).toBe(true)
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

  it('reminds again after a refused send and accepts the delivered retry', async () => {
    const refused = fixture(turnStart, user(platformMessageSource), ...tool('send_text', 'refused', true), assistant)
    await guard()(refused.agent)
    expect(refused.steer).toHaveBeenCalledOnce()

    const retried = fixture(turnStart, user(platformMessageSource), ...tool('send_text', 'refused', true),
      ...tool('send_text', 'delivered'), assistant)
    await guard()(retried.agent)
    expect(retried.steer).not.toHaveBeenCalled()
  })

  it('reminds only once when every delivery attempt in the turn fails', async () => {
    const { agent, steer } = fixture(turnStart, user(platformMessageSource),
      ...tool('send_text', 'refused-1', true), ...tool('send_voice', 'refused-2', true), assistant)
    const stopping = guard()
    await stopping(agent)
    await stopping(agent)
    expect(steer).toHaveBeenCalledOnce()
  })

  it('reminds after a channel-level send failure and accepts a partial delivery', async () => {
    const dropped = fixture(turnStart, user(platformMessageSource),
      ...tool('send_text', 'dropped', false, content({ sent: [], error: '渠道未登记: qq' })), assistant)
    await guard()(dropped.agent)
    expect(dropped.steer).toHaveBeenCalledOnce()

    const partial = fixture(turnStart, user(platformMessageSource),
      ...tool('send_text', 'partial', false, content({ sent: [{ index: 0, text: '第一段' }], stoppedAt: 1, error: '第二段发送失败' })),
      assistant)
    await guard()(partial.agent)
    expect(partial.steer).not.toHaveBeenCalled()
  })

  it('reminds after a failed voice synthesis and accepts an unknown delivery', async () => {
    const failed = fixture(turnStart, user(platformMessageSource),
      ...tool('send_voice', 'voice-failed', false, content({ status: 'synthesis-failed', error: 'BreezeTTS 返回空音频' })), assistant)
    await guard()(failed.agent)
    expect(failed.steer).toHaveBeenCalledOnce()

    const unknown = fixture(turnStart, user(platformMessageSource),
      ...tool('send_voice', 'voice-unknown', false, content({ status: 'unknown', error: '投递状态未知' })), assistant)
    await guard()(unknown.agent)
    expect(unknown.steer).not.toHaveBeenCalled()
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

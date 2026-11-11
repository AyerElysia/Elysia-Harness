import { describe, expect, it, vi } from 'vitest'
import { createAssistantMessage } from '@deepseek-ai/dsh-llm'
const fixtures = vi.hoisted(() => ({ agent: undefined as unknown, say: vi.fn(async (_text: string, ..._args: unknown[]) => ''), turnStarted: vi.fn(), turnEnded: vi.fn() }))
vi.mock('@deepseek-ai/dsh-scope', () => ({ scopeOf: () => fixtures.agent }))
vi.mock('../src/dsh/runtime', () => ({
  asr: {}, cookie: vi.fn(), currentMoods: () => ['talk'], dm: {}, hooks: { log: vi.fn() }, library: {}, markAgentReady: vi.fn(), settings: {},
  show: { isOnAir: true, say: fixtures.say, turnStarted: fixtures.turnStarted, turnEnded: fixtures.turnEnded, stage: { broadcast: vi.fn() } }, social: {}, videos: {},
}))
import { apply, WRITE_ACTIONS } from '../src/dsh/agent'

function harness(allowedWriteActions: string[] = []) {
  const names: string[] = []
  let listener: ((session: { id: string }, event: unknown) => void) | undefined
  fixtures.agent = { id: 'elysia-livestream', session: { seq: 0 } }
  const ctx = {
    tools: { register: (tool: { name: string }) => { names.push(tool.name); return () => {} } },
    effect: (start: () => unknown) => start(),
    on: (_name: string, callback: typeof listener) => { listener = callback; return () => {} },
  }
  apply(ctx as never, { allowedWriteActions })
  return { names, dispatch: (id: string, event: unknown) => listener?.({ id }, event) }
}
describe('Elysia scoped livestream capabilities and output', () => {
  it('exposes reading and playback while requiring an explicit allowlist for every platform write', () => {
    const h = harness()
    expect(h.names).toContain('watch_video')
    expect(h.names).toContain('play_video')
    expect(h.names).toContain('read_livestream_event')
    expect(h.names).toContain('pass')
    for (const name of WRITE_ACTIONS) expect(h.names).not.toContain(name)
    const granted = harness(['send_dm'])
    expect(granted.names).toContain('send_dm')
    expect(granted.names).not.toContain('post_comment')
    expect(granted.names).not.toContain('game_side')
  })
  it('checks the exact session before event content or sequence, and voices target output once', async () => {
    fixtures.say.mockClear()
    const h = harness()
    const touch = vi.fn()
    h.dispatch('elysia-conscious-mind', { get seq() { touch(); throw new Error('private') }, get data() { touch(); throw new Error('private') } })
    expect(touch).not.toHaveBeenCalled()
    const event = { seq: 2, type: 'assistant/message', time: 1, data: { message: createAssistantMessage({ source: { provider: 'fixture', model: 'fixture' }, content: [{ type: 'text', text: 'public fixture' }] }) } }
    h.dispatch('elysia-livestream', event)
    h.dispatch('elysia-livestream', event)
    await Promise.resolve()
    expect(fixtures.say).toHaveBeenCalledTimes(1)
    expect(fixtures.say.mock.calls[0]?.[0]).toBe('public fixture')
  })
  it('does not mount these capabilities in an ordinary session scope', () => {
    fixtures.agent = { id: 'ordinary-session' }
    expect(() => apply({} as never)).toThrow('exact fixed agent')
  })
})

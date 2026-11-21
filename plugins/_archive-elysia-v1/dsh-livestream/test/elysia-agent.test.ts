import type { Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const fixtures = vi.hoisted(() => ({
  agent: undefined as Agent | undefined, onAir: true,
  runLiveSpeech: vi.fn(), broadcast: vi.fn(), turnStarted: vi.fn(), turnEnded: vi.fn(),
}))
vi.mock('@deepseek-ai/dsh-scope', () => ({ scopeOf: () => fixtures.agent }))
vi.mock('../src/dsh/runtime', () => ({
  asr: {}, cookie: vi.fn(), currentMoods: () => ['talk', 'laugh'], dm: {}, hooks: { log: vi.fn() },
  library: {}, markAgentReady: vi.fn(), settings: {},
  show: {
    get isOnAir() { return fixtures.onAir },
    turnStarted: fixtures.turnStarted, turnEnded: fixtures.turnEnded, stage: { broadcast: fixtures.broadcast },
  },
  social: {}, videos: {},
}))
vi.mock('../src/dsh/session', () => ({
  LIVESTREAM_SESSION_ID: 'elysia-livestream', readJournal: vi.fn(), runLiveSpeech: fixtures.runLiveSpeech,
}))
import { apply, WRITE_ACTIONS } from '../src/dsh/agent'

function harness(allowedWriteActions: string[] = []) {
  const tools = new Map<string, ToolDefinition>()
  let listener: ((session: { id: string }, event: unknown) => void) | undefined
  let guidance: ((context: { agent: Agent }) => string) | undefined
  const agent = { id: 'elysia-livestream', session: { seq: 0 } } as unknown as Agent
  fixtures.agent = agent
  const ctx = {
    tools: { register: (tool: ToolDefinition) => { tools.set(tool.name, tool); return () => tools.delete(tool.name) } },
    systemPrompt: { context: ({ text }: { text: typeof guidance }) => { guidance = text; return () => {} } },
    effect: (start: () => unknown) => start(),
    on: (_name: string, callback: typeof listener) => { listener = callback; return () => {} },
  }
  apply(ctx as never, { allowedWriteActions })
  const exec = { agent, signal: new AbortController().signal, callId: ToolCallId('fixture-call') } as ToolRunContext
  return { ctx, agent, tools, exec, guidance, dispatch: (id: string, event: unknown) => listener?.({ id }, event) }
}

beforeEach(() => {
  fixtures.onAir = true
  vi.clearAllMocks()
})

describe('Elysia scoped livestream capabilities and output', () => {
  it('registers explicit speech while keeping private mail and ungranted platform writes unavailable', () => {
    const h = harness()
    expect([...h.tools.keys()]).toEqual(expect.arrayContaining(['watch_video', 'play_video', 'read_livestream_event', 'live_say', 'pass']))
    expect(h.tools.has('check_inbox')).toBe(false)
    expect(h.tools.has('read_dm')).toBe(false)
    for (const name of WRITE_ACTIONS) expect(h.tools.has(name)).toBe(false)
    const granted = harness(['send_dm'])
    expect(granted.tools.has('send_dm')).toBe(true)
    expect(granted.tools.has('post_comment')).toBe(false)
    expect(granted.tools.has('game_side')).toBe(false)
  })

  it('checks the fixed session before event access and keeps accounting without reading assistant prose', () => {
    const h = harness()
    const touched = vi.fn()
    h.dispatch('elysia-conscious-mind', {
      get seq() { touched(); throw new Error('foreign sequence') },
      get data() { touched(); throw new Error('foreign body') },
    })
    const event = {
      seq: 2, type: 'assistant/message', time: 1,
      data: { message: {
        source: { provider: 'fixture', model: 'fixture' },
        get content() { touched(); throw new Error('assistant prose is not a speech request') },
      }, usage: { totalTokens: 8 } },
    }
    h.dispatch('elysia-livestream', { seq: 1, type: 'turn/start' })
    h.dispatch('elysia-livestream', event)
    h.dispatch('elysia-livestream', event)
    h.dispatch('elysia-livestream', { seq: 3, type: 'turn/end' })
    expect(touched).not.toHaveBeenCalled()
    expect(fixtures.turnStarted).toHaveBeenCalledExactlyOnceWith('elysia-livestream')
    expect(fixtures.turnEnded).toHaveBeenCalledExactlyOnceWith('elysia-livestream')
    expect(fixtures.broadcast).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ type: 'usage', turn: 8 }))
    expect(fixtures.runLiveSpeech).not.toHaveBeenCalled()
  })

  it('supplies live-only guidance for the exact owner while on air', () => {
    const h = harness()
    expect(h.guidance?.({ agent: h.agent })).toMatch(/开场.*谢幕.*live_say/)
    expect(h.guidance?.({ agent: { id: 'ordinary' } as Agent })).toBe('')
    fixtures.onAir = false
    expect(h.guidance?.({ agent: h.agent })).toBe('')
  })

  it('delivers only an explicit tool call with the exact native caller and returns its playback outcome', async () => {
    const h = harness()
    const tool = h.tools.get('live_say')!
    const receipt = { id: 'fixture-speech', state: 'timeout', detail: 'playback-timeout' }
    fixtures.runLiveSpeech.mockResolvedValueOnce(receipt)
    const refs = ['fixture-ref-1', 'fixture-ref-2']
    const result = await tool.execute({
      text: ' [笑] 公开测试 ', reply_to: refs, stage_mood: 'laugh', expression_instruction: ' 慢一点 ',
    }, h.exec)
    expect(result).toEqual(receipt)
    expect(fixtures.runLiveSpeech).toHaveBeenCalledExactlyOnceWith(h.ctx, h.agent.session, h.exec.callId, {
      text: '[笑] 公开测试', replyTo: refs, stageMood: 'laugh', expressionInstruction: '慢一点',
    }, h.exec.signal)
  })

  it('refuses foreign callers, malformed options and off-air actions before delivery', async () => {
    const h = harness()
    const tool = h.tools.get('live_say')!
    await expect(tool.execute({ text: 'fixture' }, { ...h.exec, agent: undefined })).rejects.toThrow('固定直播会话')
    await expect(tool.execute({ text: 'fixture', stage_mood: 'unknown' }, h.exec)).rejects.toThrow('舞台未配置表情')
    await expect(tool.execute({ text: 'fixture', reply_to: ['a', 'a'] }, h.exec)).rejects.toThrow('不同的本场事件引用')
    await expect(tool.execute({ text: 'fixture', reply_to: [] }, h.exec)).rejects.toThrow('不同的本场事件引用')
    await expect(tool.execute({ text: 'fixture', expression_instruction: 'x'.repeat(1001) }, h.exec)).rejects.toThrow('1000')
    fixtures.onAir = false
    await expect(tool.execute({ text: 'fixture' }, h.exec)).rejects.toThrow('主播回应尚未开启')
    expect(fixtures.runLiveSpeech).not.toHaveBeenCalled()
  })

  it('does not mount these capabilities in an ordinary session scope', () => {
    fixtures.agent = { id: 'ordinary-session' } as Agent
    expect(() => apply({} as never)).toThrow('exact fixed agent')
  })
})

import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { bindScopeParent, createScope, type Scope } from '@deepseek-ai/dsh-scope'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import UserQuestionService, { type AskUserQuestionAnswer, type AskUserQuestionRequest } from '@deepseek-ai/dsh-user-questions'
import { expect, it, onTestFinished, vi } from 'vitest'
import { installLocalSendConfirmation } from '../src/local-send-confirmation.ts'
import { OutboundText, OutboundVoice } from '../src/outbound.ts'
import { defineSendTextTool } from '../src/send-text.ts'
import { defineSendVoiceTool } from '../src/send-voice.ts'

const address = { channel: 'kook', conversation: 'room:fixture' }
const textArgs = { ...address, content: '公开测试', thought: '测试', mood: '', decision: '', expected_response: '' }
const voiceArgs = { ...address, text: '公开语音测试', expression_instruction: '轻声' }

function answer(request: AskUserQuestionRequest, selected = ['确认发送']): AskUserQuestionAnswer {
  return { answers: [{ id: request.questions[0]!.id, selected }] }
}

async function fixture() {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(UserQuestionService)
  const outboundText = new OutboundText(ctx)
  const outboundVoice = new OutboundVoice(ctx)
  const text = vi.fn(async () => ({ messageId: 'test-text' }))
  const voice = vi.fn(async () => ({ messageId: 'test-voice' }))
  const synthesize = vi.fn(async () => ({ audio: Uint8Array.of(1), mediaType: 'audio/wav' as const }))
  outboundText.register('kook', text)
  outboundVoice.register('kook', voice)
  ctx.tools.register(defineSendTextTool(outboundText))
  ctx.tools.register(defineSendVoiceTool(outboundVoice, { synthesize }))

  async function mint(id: string, parent?: Agent) {
    const agentId = id as Agent['id']
    const key = { id: agentId, session: { id: agentId } } as Agent
    let scope!: Scope
    await ctx.plugin(Object.assign((inner: Context) => { scope = createScope(inner, key) }, { inject: ['tools'] }))
    Object.defineProperty(key, 'ctx', { value: scope.ctx })
    if (parent) bindScopeParent(key, parent)
    return key
  }
  const agent = await mint('local')
  const removeAgent = ctx.agents.enter(agent, undefined)
  onTestFinished(removeAgent)
  let local = true
  const remove = installLocalSendConfirmation(agent.ctx, () => local)
  const ask = vi.fn((request: AskUserQuestionRequest): Promise<AskUserQuestionAnswer> => Promise.resolve(answer(request)))
  ctx.on('user-questions/request', request => ask(request))
  const run = (name: 'send_text' | 'send_voice', args: unknown, subject = agent, signal = new AbortController().signal) =>
    ctx.tools.execute({ name, arguments: args, agent: subject, signal, callId: ToolCallId('same-call-id') })
  return { agent, mint, remove, run, ask, text, voice, synthesize, setNonLocal: () => { local = false } }
}

it('blocks ordinary local text and voice without a confirmation prompt', async () => {
  const f = await fixture()
  for (const [name, args] of [['send_text', textArgs], ['send_voice', voiceArgs]] as const) {
    expect(await f.run(name, args)).toMatchObject({ isError: true, error: { message: expect.stringContaining('会话正文') } })
  }
  expect(f.ask).not.toHaveBeenCalled()
  expect(f.text).not.toHaveBeenCalled()
  expect(f.voice).not.toHaveBeenCalled()
  expect(f.synthesize).not.toHaveBeenCalled()
})

it('displays the exact normalized target and body and only permits the approved native execution', async () => {
  const f = await fixture()
  const consent = Promise.withResolvers<AskUserQuestionAnswer>()
  const displayed = Promise.withResolvers<AskUserQuestionRequest>()
  f.ask.mockImplementationOnce(request => { displayed.resolve(request); return consent.promise })
  const args = { ...textArgs, explicit_request: true, content: '  第一段 \r\n\n……\n~~~~ 第二段', reply_to: 'fixture-quote' }
  const pending = f.run('send_text', args)
  const request = await displayed.promise
  const question = request.questions[0]!
  expect(question.detail).toContain('渠道：kook\n会话：room:fixture\n引用消息：fixture-quote')
  expect(question.detail).toContain('~~~~~text\n第一段\n~~~~ 第二段\n~~~~~')
  expect(question.detail).not.toContain('……')
  expect(f.text).not.toHaveBeenCalled()
  consent.resolve(answer(request))
  expect((await pending).isError).toBe(false)
  expect(f.text.mock.calls).toEqual([
    [{ conversation: 'room:fixture', text: '第一段', replyTo: 'fixture-quote' }],
    [{ conversation: 'room:fixture', text: '~~~~ 第二段' }],
  ])

  f.ask.mockResolvedValueOnce(answer(request))
  expect((await f.run('send_text', args)).isError).toBe(true)
  expect(f.text).toHaveBeenCalledTimes(2)
})

it('does not ask about an invalid target or accept a negative or ambiguous answer', async () => {
  const f = await fixture()
  const explicit = { ...textArgs, explicit_request: true }
  expect((await f.run('send_text', { ...explicit, channel: 'unregistered' })).isError).toBe(true)
  expect((await f.run('send_text', { ...explicit, conversation: '  ' })).isError).toBe(true)
  expect(f.ask).not.toHaveBeenCalled()
  f.ask.mockImplementationOnce(async request => answer(request, ['取消']))
  expect((await f.run('send_text', explicit)).isError).toBe(true)
  f.ask.mockImplementationOnce(async request => answer(request, ['确认发送', '取消']))
  expect((await f.run('send_text', explicit)).isError).toBe(true)
  expect(f.text).not.toHaveBeenCalled()
})

it('keeps the final guard if another policy bypasses the confirmation listener', async () => {
  const f = await fixture()
  f.agent.ctx.on('tools/pre-execute', async () => ({ kind: 'allow' }), { prepend: true })
  expect((await f.run('send_text', { ...textArgs, explicit_request: true })).isError).toBe(true)
  expect(f.ask).not.toHaveBeenCalled()
  expect(f.text).not.toHaveBeenCalled()
})

it.each(['caller', 'dispose'] as const)('ignores a late confirmation after %s cancellation', async (source) => {
  const f = await fixture()
  const controller = new AbortController()
  const displayed = Promise.withResolvers<AskUserQuestionRequest>()
  const consent = Promise.withResolvers<AskUserQuestionAnswer>()
  f.ask.mockImplementationOnce(request => { displayed.resolve(request); return consent.promise })
  const pending = f.run('send_voice', { ...voiceArgs, explicit_request: true }, f.agent, controller.signal)
  const request = await displayed.promise
  expect(request.questions[0]!.detail).toContain('公开语音测试')
  expect(f.synthesize).not.toHaveBeenCalled()
  if (source === 'caller') controller.abort()
  else f.remove()
  expect(request.signal?.aborted).toBe(true)
  consent.resolve(answer(request))
  expect((await pending).isError).toBe(true)
  expect(f.synthesize).not.toHaveBeenCalled()
  expect(f.voice).not.toHaveBeenCalled()
})

it('preserves non-local, unrelated and descendant Agent sends and uninstalls cleanly', async () => {
  const f = await fixture()
  const other = await f.mint('other')
  const child = await f.mint('child', f.agent)
  expect((await f.run('send_text', textArgs, other)).isError).toBe(false)
  expect((await f.run('send_text', textArgs, child)).isError).toBe(false)
  f.setNonLocal()
  expect((await f.run('send_voice', voiceArgs)).isError).toBe(false)
  expect(f.ask).not.toHaveBeenCalled()
  expect(f.text).toHaveBeenCalledTimes(2)
  expect(f.voice).toHaveBeenCalledOnce()
  f.remove()
  expect((await f.run('send_text', textArgs)).isError).toBe(false)
})

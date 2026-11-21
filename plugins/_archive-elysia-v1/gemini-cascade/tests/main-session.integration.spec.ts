import { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, createUserMessage, type GenerateOptions, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it, onTestFinished } from 'vitest'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '../../../dsh/packages/test-support/agent-loop-testkit/src/index.ts'
import { submitMainVoice } from '../src/main-session.ts'

function gate() {
  return { entered: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() }
}

type Script = { readonly text: string; readonly pause?: ReturnType<typeof gate> }

class RecordingAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  constructor(private readonly script: readonly Script[]) { super() }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const reply = this.script[this.requests.length]
    this.requests.push(options)
    if (!reply) throw new Error('Unexpected test model request')
    reply.pause?.entered.resolve()
    await reply.pause?.release.promise
    options.signal?.throwIfAborted()
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: reply.text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: reply.text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

async function fixture(script: readonly Script[]) {
  const ctx = new Context()
  onTestFinished(async () => {
    for (const step of script) step.pause?.release.resolve()
    await ctx.fiber.dispose()
  })
  await mountAgentLoopTestDependencies(ctx)
  const harness = await mountAgentLoopTestHarness(ctx)
  const adapter = new RecordingAdapter(script)
  ctx.llm.registerAdapter(['fixture'], adapter)
  const id = SessionId('elysia-conscious-mind')
  const agent = await harness.create(id, { provider: 'fixture', model: 'fixture' })
  return { ctx, adapter, id, agent }
}

function typed(text: string) {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

function readOutput(reply: ReturnType<typeof submitMainVoice>) {
  let seq = 0
  let text = ''
  for (let i = 0; i < 20; i++) {
    const page = reply.poll(seq)
    text += page.text
    if (page.done || page.seq === seq) return { text, done: page.done }
    seq = page.seq
  }
  throw new Error('The test reply cursor did not settle')
}

describe('main voice with the native DSH agent loop', () => {
  it('keeps typed and spoken turns in the same history without voicing a queued background reply', async () => {
    const background = gate()
    const voice = gate()
    const { ctx, agent, adapter, id } = await fixture([
      { text: 'first typed reply' },
      { text: 'private background reply', pause: background },
      { text: 'spoken reply', pause: voice },
      { text: 'last typed reply' },
    ])
    agent.followup(typed('typed nonce: meadow'))
    await agent.whenIdle()
    agent.followup(typed('separate background input'))
    await background.entered.promise

    const reply = submitMainVoice(ctx, agent, 'voice nonce: starlight')
    expect(readOutput(reply)).toEqual({ text: '', done: false })
    background.release.resolve()
    await voice.entered.promise

    expect(readOutput(reply)).toEqual({ text: '', done: false })
    const userMessagesBeforeReply = agent.session.snapshotEvents().filter(event => event.type === 'user/message')
    const voiceMessages = userMessagesBeforeReply.filter(event => event.data.content.some(block =>
      block.type === 'text' && block.text === 'voice nonce: starlight'))
    expect(voiceMessages).toHaveLength(1)
    expect(voiceMessages[0]?.data.source).toMatchObject({ kind: 'user', rpcId: expect.any(String) })
    expect(JSON.stringify(adapter.requests[2]?.messages)).toContain('typed nonce: meadow')

    voice.release.resolve()
    await agent.whenIdle()
    expect(readOutput(reply)).toEqual({ text: 'spoken reply', done: true })

    agent.followup(typed('now continue typing'))
    await agent.whenIdle()
    const finalModelHistory = JSON.stringify(adapter.requests[3]?.messages)
    expect(finalModelHistory).toContain('typed nonce: meadow')
    expect(finalModelHistory).toContain('voice nonce: starlight')
    expect(finalModelHistory).toContain('spoken reply')
    expect(finalModelHistory).toContain('now continue typing')
    expect(adapter.requests.map(request => request.sessionId)).toEqual([id, id, id, id])
    expect(ctx.agents.get(id)).toBe(agent)
    expect(readOutput(reply)).toEqual({ text: 'spoken reply', done: true })
  })

  it('detaches audio on barge-in without aborting the native turn or losing its reply', async () => {
    const voice = gate()
    const { ctx, agent, adapter } = await fixture([
      { text: 'reply that remains in the chat', pause: voice },
      { text: 'next native reply' },
    ])
    const reply = submitMainVoice(ctx, agent, 'voice input before barge-in')
    await voice.entered.promise
    reply.detach()
    expect(readOutput(reply)).toEqual({ text: '', done: true })
    expect(adapter.requests[0]?.signal?.aborted).toBe(false)

    agent.followup(typed('next native input'))
    voice.release.resolve()
    await agent.whenIdle()

    expect(adapter.requests[0]?.signal?.aborted).toBe(false)
    const ends = agent.session.snapshotEvents().filter(event => event.type === 'turn/end')
    expect(ends.map(event => event.data.reason.kind)).toEqual(['completed', 'completed'])
    expect(JSON.stringify(adapter.requests[1]?.messages)).toContain('reply that remains in the chat')
    expect(readOutput(reply)).toEqual({ text: '', done: true })
  })

  it.each(['before voice claim', 'during voice generation'] as const)(
    'keeps a reply text-only when another input is admitted %s in the same turn',
    async position => {
      const voice = gate()
      const { ctx, agent, adapter } = await fixture([
        { text: 'mixed turn candidate', pause: voice },
        { text: 'reply after unrelated steering' },
      ])
      const unrelated = typed('unrelated input in the same turn')
      if (position === 'before voice claim') agent.inject(unrelated)
      const reply = submitMainVoice(ctx, agent, 'turn that should remain text-only')
      await voice.entered.promise
      if (position === 'during voice generation') agent.steer(unrelated)
      voice.release.resolve()
      await agent.whenIdle()

      expect(readOutput(reply)).toEqual({ text: '', done: true })
      const log = agent.session.snapshotEvents()
      expect(log.filter(event => event.type === 'turn/start')).toHaveLength(1)
      expect(log.some(event => event.type === 'assistant/message' && event.data.message.content.some(block =>
        block.type === 'text' && block.text === 'mixed turn candidate'))).toBe(true)
      const finalModelInput = JSON.stringify(adapter.requests.at(-1)?.messages)
      expect(finalModelInput).toContain('unrelated input in the same turn')
      expect(finalModelInput).toContain('turn that should remain text-only')
    },
  )
})

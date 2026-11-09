import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { expect, it, onTestFinished } from 'vitest'
import { MAIN_SESSION_ID, isolateMainAgentContext } from '../src/main-session.ts'
import * as StandingPrompt from '../src/standing-prompts.ts'

class RecordingAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'done' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } }
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

it('keeps historical and newly injected DSH context out of the real agent request', async () => {
  const home = await mkdtemp(join(tmpdir(), 'elysia-context-request-'))
  const prompts = join(home, 'standing-prompts')
  await mkdir(prompts)
  await writeFile(join(prompts, 'SOUL.md'), 'Elysia only')
  const ctx = new Context()
  onTestFinished(async () => {
    await ctx.fiber.dispose()
    await rm(home, { recursive: true, force: true })
  })
  await mountAgentLoopTestDependencies(ctx)
  ctx.systemPrompt.context({ name: 'test:dsh-runtime', order: 100, text: 'runtime pollution' })
  ctx.on('agent/pre-step', async (_payload, next) => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    return {
      ...decision,
      messages: [...decision.messages, createUserMessage({
        content: [{ type: 'text', text: 'new AGENTS.md pollution' }],
        source: { kind: 'agent-instructions' } as never,
      })],
    }
  })
  await mountAgentLoopTestHarness(ctx)
  const adapter = new RecordingAdapter()
  ctx.llm.registerAdapter(['mock'], adapter)
  const handle = await ctx.agents.create({
    sessionId: MAIN_SESSION_ID,
    agentOptions: { provider: 'mock', model: 'mock' },
    meta: { cwd: home },
    setup: async (agentCtx, currentAgent) => {
      currentAgent.session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: 'historical runtime pollution' }],
        source: { kind: 'runtime-context' } as never,
      }), { surfaceOp: 'append' })
      await agentCtx.plugin(StandingPrompt, { baseDir: prompts, files: ['SOUL.md'] })
      isolateMainAgentContext(agentCtx, currentAgent)
    },
  })
  const agent = handle.agent
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'ordinary question' }], source: { kind: 'user' } }))
  await agent.whenIdle()

  expect(adapter.requests).toHaveLength(1)
  const serialized = JSON.stringify(adapter.requests[0]?.messages)
  expect(serialized).toContain('ordinary question')
  expect(serialized).toContain('Elysia only')
  expect(serialized).not.toContain('historical runtime pollution')
  expect(serialized).not.toContain('runtime pollution')
  expect(serialized).not.toContain('AGENTS.md')
  expect(serialized).not.toContain('Current runtime context')
})

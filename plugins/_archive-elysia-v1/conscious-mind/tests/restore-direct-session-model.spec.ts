import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { installModelSelection, type Agent } from '@deepseek-ai/dsh-agent'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { installModelSelectionProjection } from '@deepseek-ai/dsh-api-session-controller/src/model-selection-projection.ts'
import { createUserMessage, LlmAdapter, ReasoningEffortId, type GenerateOptions, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { expect, it, onTestFinished } from 'vitest'
import { restoreDirectSessionModel } from '../src/restore-direct-session-model.ts'

const defaultEffort = ReasoningEffortId('adapter-default')
const chosenEffort = ReasoningEffortId('user-choice')

class LocalAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return {
      provider, id: model, name: model,
      reasoning: {
        defaultEffort,
        efforts: [{ id: defaultEffort, name: 'Adapter default' }, { id: chosenEffort, name: 'Chosen effort' }],
      },
    }
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'Fixture response' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Fixture response' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

async function fixture(root: string, withProjection = true) {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(JsonlPersistence, { root, compression: 'none' })
  if (withProjection) installModelSelectionProjection(ctx)
  await mountAgentLoopTestHarness(ctx)
  const adapter = new LocalAdapter()
  ctx.llm.registerAdapter(['prior', 'selected', 'default'], adapter)
  return { ctx, adapter }
}

async function run(agent: Agent): Promise<void> {
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Fixture input' }], source: { kind: 'user' } }))
  await agent.whenIdle()
}

it.each([
  { id: 'elysia-conscious-mind', pending: false, sameOwner: true, projection: true, provider: 'prior', model: 'prior-model' },
  { id: 'elysia-livestream', pending: true, sameOwner: true, projection: true, provider: 'selected', model: 'selected-model' },
  { id: 'elysia-conscious-mind', pending: false, sameOwner: true, projection: false, provider: 'prior', model: 'prior-model' },
  { id: 'unrelated', pending: true, sameOwner: false, projection: true, provider: 'default', model: 'default-model' },
])('restores $id route ($provider, model projection=$projection) before its first resumed request', async test => {
  const root = await mkdtemp(join(tmpdir(), 'elysia-direct-model-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const id = SessionId(test.id)
  const ownerId = test.sameOwner ? id : SessionId('elysia-conscious-mind')
  const first = await fixture(root)
  const saved = await first.ctx.agents.create({ sessionId: id, agentOptions: { provider: 'prior', model: 'prior-model' } })
  await run(saved.agent)
  expect(saved.agent.session.requestHeader()?.adapterDefaults?.reasoningEffort).toBe(true)
  if (test.pending) {
    saved.agent.session.append('model/selection', { provider: 'selected', model: 'selected-model', reasoningEffort: chosenEffort })
  }
  await saved.dispose()
  await first.ctx.fiber.dispose()

  const { ctx, adapter } = await fixture(root, test.projection)
  const defaults = { provider: 'default', model: 'default-model' }
  const resumed = await ctx.agents.resume({
    resumeSessionId: id,
    agentOptions: { ...defaults },
    setup: (_ctx, agent) => {
      expect(ctx.agents.get(id)).toBeUndefined()
      const events = agent.session.snapshotEvents()
      restoreDirectSessionModel(agent, ownerId)
      expect(agent.session.snapshotEvents()).toEqual(events)
    },
  })
  expect(defaults).toEqual({ provider: 'default', model: 'default-model' })
  expect(resumed.agent.options).toEqual({
    provider: test.provider, model: test.model,
    ...(test.pending && test.sameOwner ? { reasoningEffort: chosenEffort } : {}),
  })
  await run(resumed.agent)
  expect(adapter.requests).toHaveLength(1)
  expect(adapter.requests[0]).toMatchObject({
    provider: test.provider, model: test.model,
    reasoningEffort: test.pending && test.sameOwner ? chosenEffort : defaultEffort,
  })

  if (test.pending && test.sameOwner) {
    installModelSelection(resumed.agent.ctx, {
      current: { provider: 'prior', model: 'ui-selected-model' }, assembled: undefined,
    })
    await run(resumed.agent)
    expect(adapter.requests[1]).toMatchObject({ provider: 'prior', model: 'ui-selected-model' })
    expect(resumed.agent.session.snapshotEvents().filter(
      event => event.type === 'user/message' && event.data.source.kind === 'model-selection',
    )).toHaveLength(1)
  }
  await resumed.dispose()
})

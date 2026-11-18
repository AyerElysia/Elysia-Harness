import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'
import * as CommandCompact from '@deepseek-ai/dsh-command-compact'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic'
import { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import { expect, it, onTestFinished } from 'vitest'
import * as SessionCompaction from '../src/index.ts'

class RecordingAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const text = options.purpose === 'compaction' ? 'session compaction summary' : 'ordinary response'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

interface Fixture {
  ctx: Context
  home: string
  adapter: RecordingAdapter
  handles: AgentHandle[]
}

async function fixture(): Promise<Fixture> {
  const home = await mkdtemp(join(tmpdir(), 'elysia-session-compaction-'))
  await mkdir(join(home, 'workspace'))
  const ctx = new Context()
  const f: Fixture = { ctx, home, adapter: new RecordingAdapter(), handles: [] }
  onTestFinished(async () => {
    for (const handle of [...f.handles].reverse()) await handle.dispose()
    await ctx.fiber.dispose()
    await rm(home, { recursive: true, force: true })
  })
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(TokenMeter)
  await ctx.plugin(LocalAttachmentStore, { dshHome: home })
  await mountAgentLoopTestHarness(ctx)
  ctx.llm.registerAdapter(['mock'], f.adapter)
  return f
}

async function createAgent(
  f: Fixture,
  id: string,
  setup?: (agentCtx: Context, agent: Agent) => Promise<void>,
): Promise<Agent> {
  const handle = await f.ctx.agents.create({
    sessionId: id,
    agentOptions: { provider: 'mock', model: 'mock' },
    meta: { cwd: f.home },
    ...setup === undefined ? {} : { setup },
  })
  f.handles.push(handle)
  return handle.agent
}

it('adds automatic compaction and /compact to future Sessions exactly once', async () => {
  const f = await fixture()
  await f.ctx.plugin(SessionCompaction)
  const agent = await createAgent(f, 'future')
  const engine = agent.ctx.get('compaction')
  const policy = (engine as BasicCompactionEngine).config
  const command = f.ctx.commands.find(agent, 'compact')

  expect(engine instanceof BasicCompactionEngine).toBe(true)
  expect(policy.auto).toBe(true)
  expect(command).toBeDefined()

  await f.ctx.serial('agent/created', { agent, source: 'startup' })
  expect((agent.ctx.get('compaction') as BasicCompactionEngine).config === policy).toBe(true)
  expect(f.ctx.commands.find(agent, 'compact')).toBe(command)
})

it('fills a Session that already existed at plugin startup and unloads cleanly', async () => {
  const f = await fixture()
  const agent = await createAgent(f, 'existing')
  expect(agent.ctx.get('compaction')).toBeUndefined()

  const plugin = await f.ctx.plugin(SessionCompaction)
  expect(agent.ctx.get('compaction') instanceof BasicCompactionEngine).toBe(true)
  expect(f.ctx.commands.find(agent, 'compact')).toBeDefined()

  await plugin.dispose()
  expect(agent.ctx.get('compaction')).toBeUndefined()
  expect(f.ctx.commands.find(agent, 'compact')).toBeUndefined()
})

it('preserves an existing manual engine and command', async () => {
  const f = await fixture()
  const agent = await createAgent(f, 'manual', async agentCtx => {
    await agentCtx.plugin(BasicCompactionEngine, { auto: false })
    await agentCtx.plugin(CommandCompact)
  })
  const engine = agent.ctx.get('compaction')
  const policy = (engine as BasicCompactionEngine).config
  const command = f.ctx.commands.find(agent, 'compact')

  await f.ctx.plugin(SessionCompaction)
  expect((agent.ctx.get('compaction') as BasicCompactionEngine).config === policy).toBe(true)
  expect(policy.auto).toBe(false)
  expect(f.ctx.commands.find(agent, 'compact')).toBe(command)
})

it('adds only the missing command when an engine already exists', async () => {
  const f = await fixture()
  const agent = await createAgent(f, 'router-like', async agentCtx => {
    await agentCtx.plugin(BasicCompactionEngine, { auto: true })
  })
  const engine = agent.ctx.get('compaction')
  const policy = (engine as BasicCompactionEngine).config
  expect(f.ctx.commands.find(agent, 'compact')).toBeUndefined()

  await f.ctx.plugin(SessionCompaction)
  expect((agent.ctx.get('compaction') as BasicCompactionEngine).config === policy).toBe(true)
  expect(f.ctx.commands.find(agent, 'compact')).toBeDefined()
})

it('executes native /compact and replays its checkpoint in an ordinary Session', async () => {
  const f = await fixture()
  await f.ctx.plugin(SessionCompaction)
  const agent = await createAgent(f, 'memory-like')

  agent.followup(createUserMessage({
    content: [{ type: 'text', text: `remember this conversation\n${'technical detail '.repeat(1000)}` }],
    source: { kind: 'user' },
  }))
  await agent.whenIdle()

  const execution = await f.ctx.commands.execute(agent, '/compact', [], new AbortController().signal)
  if (execution?.result.kind !== 'success') throw new Error(JSON.stringify(execution?.result))
  expect(execution.result.text).toMatch(/^Compacted /)
  expect(agent.session.deriveMessages().some(message => (
    message.role === 'user' && message.source.kind === 'compact-checkpoint'
  ))).toBe(true)

  agent.followup(createUserMessage({
    content: [{ type: 'text', text: 'continue after compaction' }],
    source: { kind: 'user' },
  }))
  await agent.whenIdle()
  const continuation = f.adapter.requests.at(-1)
  expect(JSON.stringify(continuation?.messages)).toContain('session compaction summary')
  expect(JSON.stringify(continuation?.messages)).toContain('continue after compaction')
  expect(f.adapter.requests.map(request => request.purpose)).toEqual([undefined, 'compaction', undefined])
})

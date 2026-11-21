import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import * as ToolFs from '@deepseek-ai/dsh-tool-fs'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { expect, it, onTestFinished } from 'vitest'
import { MAIN_SESSION_ID, composeMainAgent } from '../src/main-session.ts'

class RecordingAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const text = options.purpose === 'compaction' ? 'elysia manual summary' : 'ordinary response'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

function globalTool(name: string): ToolDefinition {
  return {
    name,
    description: `test ${name}`,
    parameters: { type: 'object', properties: {} },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value as string }],
    },
    execute: () => Promise.resolve('ok'),
  }
}

it('executes native /compact in the composed main session and replays its checkpoint', async () => {
  const home = await mkdtemp(join(tmpdir(), 'elysia-manual-compact-'))
  const prompts = join(home, 'standing-prompts')
  const workspace = join(home, 'workspace')
  await mkdir(prompts)
  await mkdir(workspace)
  await writeFile(join(prompts, 'SOUL.md'), 'Elysia only')
  const ctx = new Context()
  let handle: Awaited<ReturnType<Context['agents']['create']>> | undefined
  onTestFinished(async () => {
    await handle?.dispose()
    await ctx.fiber.dispose()
    await rm(home, { recursive: true, force: true })
  })
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(TokenMeter)
  await ctx.plugin(LocalAttachmentStore, { dshHome: home })
  await ctx.plugin(ToolFs, { read: false, readImage: true, write: false, edit: false })
  ctx.tools.register(globalTool('send_text'))
  ctx.tools.register(globalTool('send_voice'))
  await mountAgentLoopTestHarness(ctx)
  const adapter = new RecordingAdapter()
  ctx.llm.registerAdapter(['mock'], adapter)

  handle = await ctx.agents.create({
    sessionId: MAIN_SESSION_ID,
    agentOptions: { provider: 'mock', model: 'mock' },
    meta: { cwd: home },
    setup: async (agentCtx, agent) => {
      await composeMainAgent(agentCtx, {
        baseDir: prompts,
        files: ['SOUL.md'],
        required: ['SOUL.md'],
        complete: true,
        workspaceDir: workspace,
        backupDir: join(home, 'backups'),
      }, agent)
    },
  })
  const agent = handle.agent
  expect(ctx.commands.find(agent, 'compact')).toBeDefined()
  expect(adapter.requests).toHaveLength(0)

  agent.followup(createUserMessage({
    // Enough source material for DSH's useful-shrink check to accept a summary.
    content: [{ type: 'text', text: `remember this ordinary conversation\n${'technical detail '.repeat(1000)}` }],
    source: { kind: 'user' },
  }))
  await agent.whenIdle()
  expect(adapter.requests.map(request => request.purpose)).toEqual([undefined])
  expect(agent.session.snapshotEvents().some(event => event.type === 'compaction/start')).toBe(false)

  const execution = await ctx.commands.execute(agent, '/compact', [], new AbortController().signal)
  if (execution?.result.kind !== 'success') throw new Error(JSON.stringify(execution?.result))
  expect(execution.result).toMatchObject({ kind: 'success' })
  expect(execution?.result.kind === 'success' && execution.result.text).toMatch(/^Compacted /)
  const checkpoint = agent.session.snapshotEvents().find(event => (
    event.type === 'user/message' && event.data.source.kind === 'compact-checkpoint'
  ))
  expect(checkpoint).toBeDefined()
  expect(agent.session.deriveMessages().some(message => (
    message.role === 'user' && message.source.kind === 'compact-checkpoint'
  ))).toBe(true)
  expect(adapter.requests.map(request => request.purpose)).toEqual([undefined, 'compaction'])

  agent.followup(createUserMessage({
    content: [{ type: 'text', text: 'continue after compaction' }],
    source: { kind: 'user' },
  }))
  await agent.whenIdle()
  const continuation = adapter.requests.at(-1)
  expect(continuation?.purpose).toBeUndefined()
  const serialized = JSON.stringify(continuation?.messages)
  expect(serialized).toContain('elysia manual summary')
  expect(serialized).toContain('continue after compaction')
  expect(continuation?.messages.some(message => (
    message.role === 'user' && message.source.kind === 'compact-checkpoint'
  ))).toBe(true)
})

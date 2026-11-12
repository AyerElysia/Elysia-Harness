import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import { LlmAdapter, ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import * as JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import * as ToolFs from '@deepseek-ai/dsh-tool-fs'
import { defineTool } from '@deepseek-ai/dsh-tools'
import WebRuntime from '@deepseek-ai/dsh-web'
import { expect, it, onTestFinished, vi } from 'vitest'
import { MAIN_SESSION_ID, composeMainAgent } from '../src/main-session.ts'
import { platformMessageSource } from '../src/reply-origin.ts'

function call(id: string, name: string, args: object): StreamChunk[] {
  const block = { type: 'tool-call' as const, id: ToolCallId(id), name, arguments: JSON.stringify(args) }
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id: block.id, name, argumentsDelta: block.arguments },
    { type: 'block-end', index: 0, block },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

function reply(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

class LocalAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  constructor(private readonly script: StreamChunk[][]) { super() }
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }
  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const response = this.script.shift()
    // Bound the pre-fix reproduction: an unexpected continuation fails locally instead of looping.
    if (response === undefined) throw new Error('Unexpected follow-up request after the pass fixture script')
    for (const chunk of response) yield chunk
  }
}

async function fixture(script: StreamChunk[][]) {
  const home = await mkdtemp(join(tmpdir(), 'elysia-pass-completion-'))
  const ctx = new Context()
  let handle: AgentHandle | undefined
  onTestFinished(async () => {
    try { await handle?.dispose() } finally {
      try { await ctx.fiber.dispose() } finally { await rm(home, { recursive: true, force: true }) }
    }
  })
  await mkdir(join(home, 'standing-prompts'))
  await mkdir(join(home, 'workspace'))
  await writeFile(join(home, 'standing-prompts', 'SOUL.md'), 'Public isolated pass fixture; no subject material.')
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
  ctx.provide('subprocess', {} as never)
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(TokenMeter)
  await ctx.plugin(WebRuntime)
  await ctx.plugin(LocalAttachmentStore, { dshHome: home })
  await ctx.plugin(ToolFs, { read: false, readImage: true, write: false, edit: false })
  await ctx.plugin(JsonlPersistence, { root: join(home, 'sessions'), compression: 'none' })
  const sendText = vi.fn(async () => 'sent only to the isolated fixture')
  for (const name of ['send_text', 'send_voice']) {
    ctx.tools.register(defineTool({
      name, description: 'Isolated platform fixture; no real transport',
      parameters: { text: { type: 'string', required: true } },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      execute: name === 'send_text' ? sendText : async () => { throw new Error('No TTS or platform calls in this fixture') },
    }))
  }
  await mountAgentLoopTestHarness(ctx)
  const adapter = new LocalAdapter(script)
  ctx.llm.registerAdapter(['mock'], adapter)
  handle = await ctx.agents.create({
    sessionId: MAIN_SESSION_ID, agentOptions: { provider: 'mock', model: 'fixture' }, meta: { cwd: home },
    setup: agentCtx => composeMainAgent(agentCtx, {
      baseDir: join(home, 'standing-prompts'), files: ['SOUL.md'], required: ['SOUL.md'], complete: true,
      workspaceDir: join(home, 'workspace'), backupDir: join(home, 'backups'), timeZone: 'Asia/Shanghai',
    }),
  })
  return { ctx, agent: handle.agent, adapter, sendText }
}

function input(text: string) {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

it.each([
  { entry: 'platform', source: platformMessageSource, expectedSends: 1 },
  { entry: 'DSH', source: { kind: 'user', rpcId: 'local-fixture' } as const, expectedSends: 0 },
])('checks send_text in a $entry turn, then pass finishes with both clock contexts mounted', async ({ source, expectedSends }) => {
  const { ctx, agent, adapter, sendText } = await fixture([
    call('fixture-send', 'send_text', { text: 'public fixture reply' }),
    call('fixture-pass', 'pass', { reason: '  fixture finished  ' }),
  ])
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'fixture inbound' }], source }))
  await agent.whenIdle()
  expect(adapter.requests).toHaveLength(2)
  expect(sendText).toHaveBeenCalledTimes(expectedSends)
  expect(agent.status).toBe('idle')
  const events = agent.session.snapshotEvents()
  const sendResult = events.find(event => event.type === 'tool/result' && event.data.message.toolCallId === 'fixture-send')
  expect(sendResult?.type === 'tool/result' && sendResult.data.message.isError).toBe(expectedSends === 0)
  const result = events.find(event => event.type === 'tool/result' && event.data.message.toolCallId === 'fixture-pass')
  expect(result?.type === 'tool/result' && result.data.message).toMatchObject({
    isError: false, content: [{ type: 'text', text: JSON.stringify({ passed: true, reason: 'fixture finished' }) }],
  })
  const end = events.findLast(event => event.type === 'turn/end')
  expect(end?.type === 'turn/end' && end.data.reason).toEqual({ kind: 'completed' })
  for (const kind of ['time-context', 'elysia-calendar-context']) {
    expect(events.filter(event => event.type === 'user/message' && event.data.source.kind === kind)).toHaveLength(2)
    for (const request of adapter.requests) {
      expect(request.messages.some(message => message.role === 'user' && message.source?.kind === kind)).toBe(true)
    }
  }
  await ctx.sessions.flush(agent.session)
  const reader = await ctx.sessionPersistence.open(MAIN_SESSION_ID, 'read')
  try {
    const persisted = await reader.read()
    expect(persisted.events.some(event => event.type === 'tool/result' && event.data.message.toolCallId === 'fixture-pass')).toBe(true)
  } finally { await reader.close() }
  const settledSeq = agent.session.seq
  await new Promise(resolve => setTimeout(resolve, 30))
  expect(adapter.requests).toHaveLength(2)
  expect(agent.session.seq).toBe(settledSeq)
})

it('keeps and processes real steering that arrives during pass execution using the native inbox', async () => {
  const { ctx, agent, adapter } = await fixture([
    call('fixture-pass-steer', 'pass', { reason: 'fixture done before the later input' }),
    reply('public fixture late input processed'),
  ])
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  onTestFinished(() => { release.resolve() })
  ctx.on('tools/execute', async (exec, next) => {
    if (exec.agent === agent && exec.name === 'pass') {
      entered.resolve()
      await release.promise
    }
    return next()
  })
  agent.followup(input('public fixture first input'))
  await entered.promise
  const late = input('public fixture steering during pass')
  agent.steer(late)
  release.resolve()
  await agent.whenIdle()
  expect(adapter.requests).toHaveLength(2)
  expect(adapter.requests[1]?.messages).toContainEqual(late)
  expect(agent.status).toBe('idle')
  expect(agent.inbox.nextStep).toEqual([])
  const events = agent.session.snapshotEvents()
  expect(events.some(event => event.type === 'user/message' && event.data.id === late.id)).toBe(true)
  const passResult = events.find(event => event.type === 'tool/result' && event.data.message.toolCallId === 'fixture-pass-steer')
  if (passResult?.type !== 'tool/result') throw new Error('The completed pass result must be recorded before later input')
  expect(passResult.data.message.isError).toBe(false)
  expect(events.filter(event => event.type === 'turn/end')).toHaveLength(1)
})

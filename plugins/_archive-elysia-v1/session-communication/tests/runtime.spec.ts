import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '../../../dsh/packages/test-support/agent-loop-testkit/src/index.ts'
import * as JsonlPersistence from '../../../dsh/packages/session/session-persistence-jsonl/src/index.ts'
import SqliteSessionQuery from '../../../dsh/packages/session-query/session-query-sqlite/src/index.ts'
import TokenMeter from '../../../dsh/packages/llm/token-meter/src/index.ts'
import { executeModelToolFixture } from '../../../dsh/packages/test-support/tool-testkit/src/index.ts'
import * as Communication from '../src/index.ts'

const MAIN = SessionId('elysia-conscious-mind')
const MEMORY = SessionId('elysia-subconscious-memory')

function tool(id: string, name: string, args: object): StreamChunk[] {
  const call = { type: 'tool-call' as const, id: ToolCallId(id), name, arguments: JSON.stringify(args) }
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id: call.id, name, argumentsDelta: call.arguments },
    { type: 'block-end', index: 0, block: call },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

function text(body: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: body },
    { type: 'block-end', index: 0, block: { type: 'text', text: body } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

class DialogueAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  private readonly counts = new Map<string, number>()

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const id = options.sessionId ?? ''
    const step = (this.counts.get(id) ?? 0) + 1
    this.counts.set(id, step)
    let result: StreamChunk[]
    if (id === MAIN && step === 1) {
      result = tool('main-send', 'session_send', {
        target: 'memory', content: [{ type: 'text', text: '请核对主意识中的 SYNTHETIC_KOOK_FIXTURE' }],
      })
    } else if (id === MEMORY && step === 1) {
      result = tool('memory-read', 'session_read', { target: 'main', view: 'history', limit: 20 })
    } else if (id === MEMORY && step === 2) {
      const incoming = options.messages.find(message => message.role === 'user' && message.source.kind === 'elysia-session-communication')
      if (incoming?.role !== 'user' || incoming.source.kind !== 'elysia-session-communication') throw new Error('No native internal message')
      result = tool('memory-reply', 'session_send', {
        target: 'main', reply_to: incoming.source.messageId,
        content: [{ type: 'text', text: '已核对 SYNTHETIC_KOOK_FIXTURE' }],
      })
    } else {
      result = text('本次合成通讯自检完成')
    }
    for (const chunk of result) yield chunk
  }
}

async function setup() {
  const home = await mkdtemp(join(tmpdir(), 'elysia-comms-runtime-'))
  const ctx = new Context()
  onTestFinished(async () => {
    await ctx.fiber.dispose()
    await rm(home, { recursive: true, force: true })
  })
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(TokenMeter)
  await ctx.plugin(JsonlPersistence, { root: join(home, 'sessions'), compression: 'none' })
  await ctx.plugin(SqliteSessionQuery, { path: ':memory:', openAt: 'never' })
  ctx.provide('attachments', {} as never)
  ctx.provide('sessionController', {
    resolveAgent: vi.fn(async () => { throw new Error('Fixture targets are already live') }),
  } as never)
  // The memory identity is owned by the subconscious Router runtime, so this fixture
  // stands in for its published service shape instead of relying on generic resume.
  const owned = { memory: undefined as Agent | undefined, memoryCalls: 0 }
  ctx.provide('subconsciousRouter', {
    session: { ensureAgent: async () => { throw new Error('This fixture has no Router Session') } },
    memory: {
      ensureAgent: async () => {
        if (owned.memory === undefined) throw new Error('Memory fixture not created')
        owned.memoryCalls += 1
        return owned.memory
      },
    },
    store: { resting: () => false },
  } as never)
  await mountAgentLoopTestHarness(ctx)
  const adapter = new DialogueAdapter()
  ctx.llm.registerAdapter(['mock'], adapter)
  const stateDir = join(home, 'state')
  const communication = await ctx.plugin(Communication, { stateDir })
  const create = (id: ReturnType<typeof SessionId>, cwd: string) => ctx.agents.create({
    sessionId: id, agentOptions: { provider: 'mock', model: 'fixture' }, meta: { cwd },
  })
  const main = await create(MAIN, join(home, 'main'))
  const memory = await create(MEMORY, join(home, 'memory'))
  owned.memory = memory.agent
  return { ctx, home, adapter, stateDir, communication, create, main, memory, owned }
}

function receipts(stateDir: string) {
  const db = new DatabaseSync(join(stateDir, 'communication.sqlite'), { readOnly: true })
  try {
    return db.prepare('SELECT * FROM messages ORDER BY stored_at, id').all() as Record<string, unknown>[]
  } finally {
    db.close()
  }
}

describe('real Session communication runtime', () => {
  it('delivers a main/memory roundtrip with native tools and records delivery, presentation and reply evidence', async () => {
    const f = await setup()
    expect(f.ctx.tools.schemas(f.main.agent).map(item => item.name)).toEqual(expect.arrayContaining(['session_list', 'session_send', 'session_read']))
    f.main.agent.followup(createUserMessage({
      source: { kind: 'user' }, content: [{ type: 'text', text: 'SYNTHETIC_KOOK_FIXTURE' }],
    }))
    await vi.waitFor(() => {
      const rows = receipts(f.stateDir)
      expect(rows).toHaveLength(2)
      expect(rows.every(row => row.accepted_at !== null && row.presented_at !== null && typeof row.request_ref === 'string' && row.ended_at !== null)).toBe(true)
    }, { timeout: 10000 })
    await Promise.all([f.main.agent.whenIdle(), f.memory.agent.whenIdle()])
    // Memory delivery resolves through the subconscious owner, not the live registry.
    expect(f.owned.memoryCalls).toBeGreaterThan(0)
    const rows = receipts(f.stateDir)
    const request = rows.find(row => row.sender_session_id === MAIN)!
    const reply = rows.find(row => row.sender_session_id === MEMORY)!
    expect(reply.reply_to).toBe(request.id)
    expect(reply.conversation_id).toBe(request.conversation_id)
    expect(request.target_session_id).toBe(MEMORY)
    expect(reply.target_session_id).toBe(MAIN)
    expect(f.ctx.sessionController.resolveAgent).not.toHaveBeenCalled()
    const memoryLog = await f.ctx.sessionQuery.readSession(MEMORY)
    expect(memoryLog.events.some(event => event.type === 'tool/call' && event.data.name === 'session_read')).toBe(true)
    const mainLog = await f.ctx.sessionQuery.readSession(MAIN)
    expect(mainLog.events.some(event => event.type === 'user/message'
      && event.data.source.kind === 'elysia-session-communication'
      && event.data.source.messageId === reply.id)).toBe(true)
    expect(memoryLog.events.filter(event => event.type === 'tool/result').every(event => !event.data.message.isError)).toBe(true)
    expect(memoryLog.events.filter(event => event.type === 'tool/result').some(event =>
      JSON.stringify(event.data.message.content).includes('SYNTHETIC_KOOK_FIXTURE'))).toBe(true)

    const outsider = await f.create(SessionId('unregistered-fixture'), join(f.home, 'outside'))
    expect(f.ctx.tools.schemas(outsider.agent).some(item => ['session_list', 'session_send', 'session_read'].includes(item.name))).toBe(false)
    const requestCount = f.adapter.requests.length
    const before = mainLog.events.length
    const signal = new AbortController().signal
    const toolSet = await f.memory.agent.ctx.tools.resolve({
      agent: f.memory.agent, modelSelection: { provider: 'mock', model: 'fixture' }, signal,
    })
    const result = await executeModelToolFixture(f.memory.agent.ctx, {
      callId: ToolCallId('read-without-wake'), name: 'session_read',
      arguments: { target: 'main', view: 'history' }, agent: f.memory.agent, signal, toolSet,
    }).finally(() => toolSet.dispose())
    expect(result.isError).toBe(false)
    expect(JSON.stringify(result.content)).toContain('SYNTHETIC_KOOK_FIXTURE')
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(f.adapter.requests).toHaveLength(requestCount)
    expect((await f.ctx.sessionQuery.readSession(MAIN)).events).toHaveLength(before)

    // Cold native history is readable without restoring the target Agent.
    await f.main.dispose()
    expect(f.ctx.agents.get(MAIN)).toBeUndefined()
    const coldTools = await f.memory.agent.ctx.tools.resolve({
      agent: f.memory.agent, modelSelection: { provider: 'mock', model: 'fixture' }, signal,
    })
    const cold = await executeModelToolFixture(f.memory.agent.ctx, {
      callId: ToolCallId('cold-read-without-wake'), name: 'session_read',
      arguments: { target: 'main', view: 'history' }, agent: f.memory.agent, signal, toolSet: coldTools,
    }).finally(() => coldTools.dispose())
    expect(cold.isError).toBe(false)
    expect(JSON.stringify(cold.content)).toContain('SYNTHETIC_KOOK_FIXTURE')
    expect(f.ctx.agents.get(MAIN)).toBeUndefined()
    expect(f.adapter.requests).toHaveLength(requestCount)
    expect(f.ctx.sessionController.resolveAgent).not.toHaveBeenCalled()
  })

  it('keeps sent history across plugin unmount/remount without duplicating native deliveries', async () => {
    const f = await setup()
    f.main.agent.followup(createUserMessage({
      source: { kind: 'user' }, content: [{ type: 'text', text: 'SYNTHETIC_KOOK_FIXTURE' }],
    }))
    await vi.waitFor(() => expect(receipts(f.stateDir).filter(row => row.ended_at !== null)).toHaveLength(2), { timeout: 10000 })
    const initial = receipts(f.stateDir).map(row => row.id)
    const requests = f.adapter.requests.length
    await f.communication.dispose()
    expect(f.ctx.tools.schemas(f.main.agent).some(tool => tool.name === 'session_send')).toBe(false)
    const remount = await f.ctx.plugin(Communication, { stateDir: f.stateDir })
    await new Promise(resolve => setTimeout(resolve, 40))
    expect(receipts(f.stateDir).map(row => row.id)).toEqual(initial)
    expect(f.adapter.requests).toHaveLength(requests)
    expect(f.ctx.tools.schemas(f.memory.agent).some(tool => tool.name === 'session_send')).toBe(true)
    await remount.dispose()
  })
})

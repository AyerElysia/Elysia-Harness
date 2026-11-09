import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { afterAll, describe, expect, it, onTestFinished, vi } from 'vitest'
import type { InboundEvent } from '../src/inbound.ts'
import { MAIN_SESSION_CWD, MAIN_SESSION_ID, clearMainSessionDshContext, composeMainAgent, createMainSessionTurn, formatInboundBatch, isolateMainAgentContext } from '../src/main-session.ts'
import { definePassTool } from '../src/pass.ts'
import * as StandingPrompt from '../src/standing-prompts.ts'

const exec = { signal: new AbortController().signal } as ToolRunContext
const testHome = mkdtempSync(join(tmpdir(), 'elysia-main-session-'))
const promptBase = join(testHome, 'standing-prompts')
const workspace = join(testHome, 'workspace')
mkdirSync(promptBase)
mkdirSync(workspace)
afterAll(() => rmSync(testHome, { recursive: true, force: true }))
const promptConfig = {
  baseDir: promptBase,
  files: ['SOUL.md'],
  required: ['SOUL.md'],
  complete: true,
  workspaceDir: workspace,
  backupDir: join(testHome, 'backups'),
}

function compositionContext() {
  const disposers: (() => void)[] = []
  const plugin = vi.fn().mockResolvedValue({ dispose: vi.fn().mockResolvedValue(undefined) })
  const register = vi.fn().mockReturnValue(vi.fn())
  const restrict = vi.fn().mockReturnValue(vi.fn())
  const removeContextFilter = vi.fn()
  const restoreRuntimeContext = vi.fn()
  const on = vi.fn().mockReturnValue(removeContextFilter)
  const suppressRuntimeContext = vi.fn().mockReturnValue(restoreRuntimeContext)
  const ctx = {
    plugin,
    on,
    systemPrompt: { suppressRuntimeContext },
    tools: { register, restrict },
    effect(callback: () => () => void) { const dispose = callback(); disposers.push(dispose); return dispose },
  } as unknown as Context
  ;(ctx as { root: Context }).root = ctx
  return { ctx, plugin, on, register, restrict, suppressRuntimeContext, removeContextFilter, restoreRuntimeContext, dispose: () => { for (const dispose of disposers.splice(0)) dispose() } }
}

function owningContext(agents: unknown) {
  let dispose: (() => void) | undefined
  const ctx = {
    agents,
    agentDefaultModel: { currentSelection: () => ({ provider: 'test', model: 'test' }) },
    effect(callback: () => () => void) { dispose = callback() },
  } as unknown as Context
  onTestFinished(() => dispose?.())
  return ctx
}

const batch: InboundEvent[] = [
  {
    channel: 'kook',
    conversation: 'kook:direct:42',
    senderId: '7',
    senderName: 'Ayer',
    messageId: 'k1',
    content: [{ type: 'text', text: '爱莉爱莉' }],
  },
  {
    channel: 'qq',
    conversation: 'qq:private:8',
    senderId: '8',
    senderName: '',
    messageId: 'q1',
    content: [{ type: 'text', text: '也在吗' }],
  },
]

describe('conscious-mind inbound batch', () => {
  it('keeps every channel, conversation, sender, and message id in one batch', () => {
    const content = formatInboundBatch(batch)
    expect(content).toHaveLength(1)
    const text = content[0]?.type === 'text' ? content[0].text : ''
    expect(text).toContain('渠道 kook ｜ 会话 kook:direct:42 ｜ 消息id k1')
    expect(text).toContain('Ayer(7)：爱莉爱莉')
    expect(text).toContain('渠道 qq ｜ 会话 qq:private:8 ｜ 消息id q1')
    expect(text).toContain('8：也在吗')
    expect(text).not.toContain('以下来自外部渠道')
    expect(text).not.toContain('要回复就用 send_text')
    expect(text).not.toContain('也可以 pass')
  })

  it('keeps native image blocks and surrounding text in platform order', () => {
    const attachment = {
      attachmentId: AttachmentId('image-1'),
      mediaType: 'image/png',
      bytes: 8,
      width: 1,
      height: 1,
    } as const
    const content = formatInboundBatch([{
      ...batch[0]!,
      content: [
        { type: 'text', text: '先看' },
        { type: 'image', attachment },
        { type: 'text', text: '再说' },
      ],
    }])
    expect(content).toEqual([
      { type: 'text', text: '[1] 渠道 kook ｜ 会话 kook:direct:42 ｜ 消息id k1\nAyer(7)：先看' },
      { type: 'image', attachment },
      { type: 'text', text: '再说' },
    ])
    expect(JSON.stringify(content)).not.toContain('[图片]')
  })
})

describe('pass tool', () => {
  it('records silence without touching any channel', async () => {
    const tool = definePassTool()
    expect(tool.name).toBe('pass')
    expect(tool.parameters.required).toEqual(['reason'])
    await expect(tool.execute({ reason: ' 现在不想插话 ' }, exec)).resolves.toEqual({
      passed: true,
      reason: '现在不想插话',
    })
  })
})

describe('main session turn', () => {
  it('resumes or creates the fixed session, scopes tools, and waits for the agent', async () => {
    const calls: string[] = []
    const messages: unknown[] = []
    const handle = {
      agent: {
        followup(message: unknown) {
          calls.push('followup')
          messages.push(message)
        },
        async whenIdle() { calls.push('idle') },
      },
      async dispose() { calls.push('dispose') },
    }
    let setup: ((agentCtx: Context) => Promise<void>) | undefined
    let disposer: (() => void) | undefined
    const ctx = {
      logger: () => ({ info: vi.fn() }),
      effect(callback: () => () => void) { disposer = callback() },
      agentDefaultModel: {
        currentSelection: () => ({ provider: 'd1api', model: 'deepseek-v4.1-flash' }),
      },
      agents: {
        get: () => undefined,
        async resume(options: { setup: (agentCtx: Context) => Promise<void>; agentOptions: unknown }) {
          calls.push('resume')
          expect(options.agentOptions).toEqual({ provider: 'd1api', model: 'deepseek-v4.1-flash' })
          setup = options.setup
          throw new Error('no saved session')
        },
        async create(options: { sessionId: string; setup: (agentCtx: Context) => Promise<void>; agentOptions: unknown; meta: unknown }) {
          calls.push('create')
          expect(options.sessionId).toBe(MAIN_SESSION_ID)
          expect(options.agentOptions).toEqual({ provider: 'd1api', model: 'deepseek-v4.1-flash' })
          expect(options.meta).toEqual({ cwd: MAIN_SESSION_CWD })
          expect(MAIN_SESSION_CWD.startsWith('/')).toBe(true)
          setup = options.setup
          return handle
        },
      },
    } as unknown as Context
    const turn = createMainSessionTurn(ctx, promptConfig)
    expect(calls).toEqual(['resume'])
    await turn(batch)
    expect(calls).toEqual(['resume', 'create', 'followup', 'idle'])
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({ content: formatInboundBatch(batch) })

    const register = vi.fn()
    const restrict = vi.fn()
    const plugin = vi.fn().mockResolvedValue(undefined)
    await setup?.({ tools: { register, restrict }, systemPrompt: { suppressRuntimeContext: vi.fn() }, root: { on: vi.fn() }, on: vi.fn(), plugin, effect: (callback: () => () => void) => callback() } as unknown as Context)
    expect(plugin).toHaveBeenCalledWith(StandingPrompt, promptConfig)
    expect(register).toHaveBeenCalledOnce()
    expect(register.mock.calls[0]?.[0].name).toBe('pass')
    expect(restrict).toHaveBeenCalledWith({ allow: ['send_text', 'send_voice', 'read_image'] })

    await turn(batch.slice(0, 1))
    expect(calls.filter(call => call === 'create')).toHaveLength(1)
    expect(messages).toHaveLength(2)
    disposer?.()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(calls.at(-1)).toBe('dispose')
  })

  it('reuses an already composed live main agent without taking its ownership', async () => {
    const scoped = compositionContext()
    await composeMainAgent(scoped.ctx, promptConfig)
    const followup = vi.fn()
    const agent = { ctx: scoped.ctx, followup, whenIdle: vi.fn().mockResolvedValue(undefined) }
    const create = vi.fn()
    const ctx = owningContext({ get: () => agent, create })
    await createMainSessionTurn(ctx, promptConfig)(batch.slice(0, 1))
    expect(followup).toHaveBeenCalledOnce()
    expect(agent.whenIdle).toHaveBeenCalledOnce()
    expect(create).not.toHaveBeenCalled()
    expect(scoped.plugin).toHaveBeenCalledTimes(2)
    scoped.dispose()
  })

  it('refuses an existing uncomposed agent before forwarding any inbound event', async () => {
    const followup = vi.fn()
    const agent = { ctx: compositionContext().ctx, followup }
    const create = vi.fn()
    const ctx = owningContext({ get: () => agent, create })
    const turn = createMainSessionTurn(ctx, promptConfig)
    await expect(turn(batch)).rejects.toThrow(/拒绝借用/)
    expect(followup).not.toHaveBeenCalled()
    expect(create).not.toHaveBeenCalled()
  })

  it('refuses an uncomposed UI agent that wins the resume race', async () => {
    const followup = vi.fn()
    const agent = { ctx: compositionContext().ctx, followup }
    let live = false
    const create = vi.fn()
    const resume = vi.fn(async () => { live = true; throw new Error('concurrent resume') })
    const ctx = owningContext({ get: () => live ? agent : undefined, resume, create })
    const turn = createMainSessionTurn(ctx, promptConfig)
    await expect(turn(batch)).rejects.toThrow(/拒绝借用/)
    expect(resume).toHaveBeenCalledOnce()
    expect(followup).not.toHaveBeenCalled()
    expect(create).not.toHaveBeenCalled()
  })

  it('does not reuse a composition after its scope has been disposed', async () => {
    const scoped = compositionContext()
    await composeMainAgent(scoped.ctx, promptConfig)
    scoped.dispose()
    const followup = vi.fn()
    const ctx = owningContext({ get: () => ({ ctx: scoped.ctx, followup }) })
    await expect(createMainSessionTurn(ctx, promptConfig)(batch)).rejects.toThrow(/拒绝借用/)
    expect(followup).not.toHaveBeenCalled()
  })
})

describe('main agent tool scope', () => {
  it('rejects an empty base directory before normalization or plugin registration', async () => {
    const scoped = compositionContext()
    await expect(composeMainAgent(scoped.ctx, { ...promptConfig, baseDir: '' }))
      .rejects.toThrow(/baseDir must not be empty/)
    expect(scoped.plugin).not.toHaveBeenCalled()
    expect(scoped.register).not.toHaveBeenCalled()
  })

  it('registers scoped pass and exposes only send_text, send_voice, and read_image globally', async () => {
    const register = vi.fn()
    const restrict = vi.fn()
    const plugin = vi.fn().mockResolvedValue(undefined)
    await composeMainAgent({ tools: { register, restrict }, systemPrompt: { suppressRuntimeContext: vi.fn() }, root: { on: vi.fn() }, on: vi.fn(), plugin, effect: (callback: () => () => void) => callback() } as unknown as Context, promptConfig)
    expect(plugin).toHaveBeenCalledWith(StandingPrompt, promptConfig)
    expect(register.mock.calls[0]?.[0].name).toBe('pass')
    expect(restrict).toHaveBeenCalledWith({ allow: ['send_text', 'send_voice', 'read_image'] })
  })
  it('shares concurrent composition and rejects an attempt to change its fixed file selection', async () => {
    const scoped = compositionContext()
    const first = composeMainAgent(scoped.ctx, promptConfig)
    const second = composeMainAgent(scoped.ctx, { ...promptConfig, files: [...promptConfig.files] })
    expect(first).toBe(second)
    await first
    expect(scoped.plugin).toHaveBeenCalledTimes(2)
    expect(scoped.register).toHaveBeenCalledOnce()
    expect(scoped.restrict).toHaveBeenCalledOnce()
    await expect(composeMainAgent(scoped.ctx, { ...promptConfig, files: ['SOUL.md', 'USER.md'] }))
      .rejects.toThrow(/拒绝替换/)
    scoped.dispose()
  })

})


it('disposes scoped plugins and context isolation when a later tool restriction fails', async () => {
  const scoped = compositionContext()
  const prompt = { dispose: vi.fn().mockResolvedValue(undefined) }
  const capabilities = { dispose: vi.fn().mockResolvedValue(undefined) }
  scoped.plugin.mockResolvedValueOnce(prompt).mockResolvedValueOnce(capabilities)
  scoped.restrict.mockImplementationOnce(() => { throw new Error('missing search tool') })
  await expect(composeMainAgent(scoped.ctx, promptConfig)).rejects.toThrow('missing search tool')
  expect(prompt.dispose).toHaveBeenCalledOnce()
  expect(capabilities.dispose).toHaveBeenCalledOnce()
  expect(scoped.removeContextFilter).toHaveBeenCalledOnce()
  expect(scoped.restoreRuntimeContext).toHaveBeenCalledOnce()
})


it('attempts every composition cleanup even when one child fails to dispose', async () => {
  const scoped = compositionContext()
  const prompt = { dispose: vi.fn().mockResolvedValue(undefined) }
  const capabilities = { dispose: vi.fn().mockRejectedValue(new Error('guard disposal failed')) }
  scoped.plugin.mockResolvedValueOnce(prompt).mockResolvedValueOnce(capabilities)
  scoped.restrict.mockImplementationOnce(() => { throw new Error('missing search tool') })
  await expect(composeMainAgent(scoped.ctx, promptConfig)).rejects.toBeInstanceOf(AggregateError)
  expect(prompt.dispose).toHaveBeenCalledOnce()
  expect(capabilities.dispose).toHaveBeenCalledOnce()
})

describe('main agent DSH context isolation', () => {
  it('retires only visible DSH context while preserving the durable event log', () => {
    const session = Session.create(SessionId('context-isolation'))
    const ordinary = createUserMessage({ content: [{ type: 'text', text: '请保留 AGENTS.md 这个聊天词' }], source: { kind: 'user' } })
    const instructions = createUserMessage({
      content: [{ type: 'text', text: 'workspace instructions' }],
      source: { kind: 'agent-instructions' } as never,
    })
    const runtime = createUserMessage({
      content: [{ type: 'text', text: 'Current runtime context' }],
      source: { kind: 'runtime-context' } as never,
    })
    for (const message of [ordinary, instructions, runtime]) session.append('user/message', message, { surfaceOp: 'append' })

    expect(clearMainSessionDshContext({ session } as Agent)).toBe(2)
    expect(clearMainSessionDshContext({ session } as Agent)).toBe(0)
    const visible = session.surface.nodes.map(seq => session.eventAt(seq))
    expect(visible[0]?.type === 'user/message' && visible[0].data.content).toEqual(ordinary.content)
    expect(visible.slice(1).map(event => event?.type === 'user/message' ? event.data.content : undefined)).toEqual([[], []])
    expect(JSON.stringify(session.snapshotEvents())).toContain('workspace instructions')
    expect(JSON.stringify(session.snapshotEvents())).toContain('Current runtime context')
  })

  it('cleans isolation up idempotently and unwinds a failed historical replacement', () => {
    const scoped = compositionContext()
    const dispose = isolateMainAgentContext(scoped.ctx)
    dispose()
    dispose()
    expect(scoped.removeContextFilter).toHaveBeenCalledOnce()
    expect(scoped.restoreRuntimeContext).toHaveBeenCalledOnce()

    const failed = compositionContext()
    const agent = { session: { surface: { nodes: [1] }, eventAt: () => { throw new Error('fixture read failure') } } } as unknown as Agent
    expect(() => isolateMainAgentContext(failed.ctx, agent)).toThrow('fixture read failure')
    expect(failed.removeContextFilter).toHaveBeenCalledOnce()
    expect(failed.restoreRuntimeContext).toHaveBeenCalledOnce()
  })

  it('suppresses future DSH context for the main agent only', async () => {
    const scoped = compositionContext()
    isolateMainAgentContext(scoped.ctx)
    expect(scoped.suppressRuntimeContext).toHaveBeenCalledOnce()
    expect(scoped.on.mock.calls[0]?.[0]).toBe('agent/pre-step')
    expect(scoped.on.mock.calls[0]?.[2]).toEqual({ prepend: true })
    const handler = scoped.on.mock.calls[0]?.[1]
    const ordinary = createUserMessage({ content: [{ type: 'text', text: 'ordinary' }], source: { kind: 'user' } })
    const instructions = createUserMessage({
      content: [{ type: 'text', text: 'workspace instructions' }],
      source: { kind: 'agent-instructions' } as never,
    })
    const runtime = createUserMessage({
      content: [{ type: 'text', text: 'Current runtime context' }],
      source: { kind: 'runtime-context' } as never,
    })
    const decision = { kind: 'enter', messages: [ordinary, instructions, runtime] }
    const filtered = await handler({ agent: { id: MAIN_SESSION_ID } }, async () => decision)
    expect(filtered.messages).toEqual([ordinary])
    const otherDecision = await handler({ agent: { id: 'another-session' } }, async () => decision)
    expect(otherDecision).toBe(decision)
  })
})

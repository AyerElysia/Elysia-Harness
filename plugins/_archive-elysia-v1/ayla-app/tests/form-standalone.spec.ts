import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { provideWorkingDirectoryFixture } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createScope, type Scope } from '@deepseek-ai/dsh-scope'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { expect, it, onTestFinished, vi } from 'vitest'
import {
  AYLA_SESSION_ID, composeAylaAgent, createStandaloneTurn, formatInboundBatch,
} from '../src/form-standalone.ts'
import type { InboundEvent } from '../src/inbound.ts'
import type { AylaSend } from '../src/outbound.ts'

const event: InboundEvent = {
  channel: 'ayla',
  conversation: 'ayla:private:17',
  messageId: '90211',
  senderId: '8d9c',
  senderName: '小希',
  content: [{ type: 'text', text: '好了，我吃完了' }],
}

const second: InboundEvent = {
  ...event,
  messageId: '90212',
  content: [{ type: 'text', text: '也在吗' }],
}

/** A real tool registry, so the assertion is about the host's table, not a mock. */
async function toolHost(): Promise<Context> {
  const home = await mkdtemp(join(tmpdir(), 'ayla-tools-'))
  const ctx = new Context()
  onTestFinished(async () => {
    await ctx.fiber.dispose()
    await rm(home, { recursive: true, force: true })
  })
  provideWorkingDirectoryFixture(ctx)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime, { mode: 'native' })
  return ctx
}

/**
 * Mint the agent-scoped context a real setup callback receives.
 *
 * The scope key is an identity, so the returned key is the only one that reads
 * this agent's tool table.
 */
async function agentScope(ctx: Context): Promise<{ scope: Scope; key: Agent }> {
  const key = { id: AYLA_SESSION_ID } as unknown as Agent
  let scope!: Scope
  await ctx.plugin(Object.assign((inner: Context) => { scope = createScope(inner, key) }, {
    inject: ['tools'],
  }))
  onTestFinished(async () => { await scope.dispose() })
  return { scope, key }
}

/** A mock plugin context that records what the standalone form asks for. */
function mockCtx(overrides: {
  live?: Agent
  create?: (options: Record<string, unknown>) => Promise<unknown>
  resume?: (options: Record<string, unknown>) => Promise<unknown>
} = {}) {
  const calls: string[] = []
  const messages: { content: unknown }[] = []
  const disposers: (() => void)[] = []
  const handle = {
    agent: {
      followup(message: { content: unknown }) {
        calls.push('followup')
        messages.push(message)
      },
      async whenIdle() { calls.push('idle') },
    },
    async dispose() { calls.push('dispose') },
  }
  const ctx = {
    logger: () => ({ info: () => {}, warn: () => {} }),
    effect(callback: () => () => void) {
      disposers.push(callback())
    },

    agents: {
      get: () => overrides.live,
      async resume(options: Record<string, unknown>) {
        calls.push('resume')
        if (overrides.resume !== undefined) return await overrides.resume(options)
        throw new Error('no saved session')
      },
      async create(options: Record<string, unknown>) {
        calls.push('create')
        if (overrides.create !== undefined) return await overrides.create(options)
        return handle
      },
    },
  }
  return { ctx: ctx as unknown as Context, calls, messages, disposers, handle }
}

const sender: AylaSend = async () => ({ messageId: 'm-1' })

it('registers send_text inside the agent scope only, never in the global table', async () => {
  const ctx = await toolHost()
  const { scope, key } = await agentScope(ctx)

  composeAylaAgent(scope.ctx, () => sender)

  expect(ctx.tools.schemas().map(tool => tool.name)).not.toContain('send_text')
  expect(ctx.tools.schemas(key).map(tool => tool.name)).toContain('send_text')
})

it('scopes the tool to the agent the standalone form creates', async () => {
  const ctx = await toolHost()
  let setup: ((agentCtx: Context) => void) | undefined
  const harnessed = mockCtx({
    resume: async options => {
      setup = options.setup as (agentCtx: Context) => void
      throw new Error('no saved session')
    },
    create: async options => {
      setup = options.setup as (agentCtx: Context) => void
      expect(options.sessionId).toBe(AYLA_SESSION_ID)
      expect(options.meta).toEqual({ cwd: process.cwd() })
      return {
        agent: { followup: () => {}, whenIdle: async () => {} },
        dispose: async () => {},
      }
    },
  })
  await createStandaloneTurn(harnessed.ctx, {
    cwd: '',
    sender: () => sender,
    logger: { info: () => {}, warn: () => {} },
  })([event])

  const { scope, key } = await agentScope(ctx)
  setup?.(scope.ctx)
  expect(ctx.tools.schemas().map(tool => tool.name)).not.toContain('send_text')
  expect(ctx.tools.schemas(key).map(tool => tool.name)).toContain('send_text')
})

it('passes the host default model when there is one, and no selection when there is none', async () => {
  const seen: Record<string, unknown>[] = []
  const open = async (options: Record<string, unknown>) => {
    seen.push(options)
    return { agent: { followup: () => {}, whenIdle: async () => {} }, dispose: async () => {} }
  }
  await createStandaloneTurn(mockCtx({ create: open }).ctx, {
    cwd: '',
    sender: () => sender,
    model: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
    logger: { info: () => {}, warn: () => {} },
  })([event])
  expect(seen[0]?.agentOptions).toEqual({ provider: 'p', model: 'm' })

  await createStandaloneTurn(mockCtx({ create: open }).ctx, {
    cwd: '',
    sender: () => sender,
    logger: { info: () => {}, warn: () => {} },
  })([event])
  expect(seen[1]).not.toHaveProperty('agentOptions')
})

it('uses the configured working directory, and the process cwd when it is empty', async () => {
  const seen: unknown[] = []
  const open = async (options: Record<string, unknown>) => {
    seen.push(options.meta)
    return { agent: { followup: () => {}, whenIdle: async () => {} }, dispose: async () => {} }
  }
  await createStandaloneTurn(mockCtx({ create: open }).ctx, {
    cwd: 'E:/work/Ayla',
    sender: () => sender,
    logger: { info: () => {}, warn: () => {} },
  })([event])
  expect(seen[0]).toEqual({ cwd: 'E:/work/Ayla' })

  await createStandaloneTurn(mockCtx({ create: open }).ctx, {
    cwd: '   ',
    sender: () => sender,
    logger: { info: () => {}, warn: () => {} },
  })([event])
  expect(seen[1]).toEqual({ cwd: process.cwd() })
})

it('queues one user message per batch and waits for the agent to go idle', async () => {
  const harnessed = mockCtx()
  const turn = createStandaloneTurn(harnessed.ctx, {
    cwd: '',
    sender: () => sender,
    logger: { info: () => {}, warn: () => {} },
  })
  await turn([event, second])
  expect(harnessed.calls).toEqual(['resume', 'create', 'followup', 'idle'])
  expect(harnessed.messages).toHaveLength(1)
  expect(harnessed.messages[0]?.content).toEqual(formatInboundBatch([event, second]))

  await turn([event])
  expect(harnessed.calls.filter(call => call === 'create')).toHaveLength(1)
  expect(harnessed.messages).toHaveLength(2)
})

it('reuses an agent that is already live instead of creating a duplicate', async () => {
  const followup = vi.fn()
  const whenIdle = vi.fn(async () => {})
  const harnessed = mockCtx({ live: { followup, whenIdle } as unknown as Agent })
  await createStandaloneTurn(harnessed.ctx, {
    cwd: '',
    sender: () => sender,
    logger: { info: () => {}, warn: () => {} },
  })([event])
  expect(followup).toHaveBeenCalledOnce()
  expect(whenIdle).toHaveBeenCalledOnce()
  expect(harnessed.calls).toEqual([])
})

it('retries the next batch after a failed resume and create', async () => {
  let attempts = 0
  const harnessed = mockCtx({
    resume: async () => { attempts++; throw new Error('resume failed') },
    create: async () => {
      attempts++
      if (attempts === 2) throw new Error('create failed')
      return { agent: { followup: () => {}, whenIdle: async () => {} }, dispose: async () => {} }
    },
  })
  const turn = createStandaloneTurn(harnessed.ctx, {
    cwd: '',
    sender: () => sender,
    logger: { info: () => {}, warn: () => {} },
  })
  await expect(turn([event])).rejects.toThrow('create failed')
  await expect(turn([event])).resolves.toBeUndefined()
  expect(attempts).toBe(4)
})

it('disposes the agent it opened when the plugin unloads', async () => {
  const harnessed = mockCtx()
  await createStandaloneTurn(harnessed.ctx, {
    cwd: '',
    sender: () => sender,
    logger: { info: () => {}, warn: () => {} },
  })([event])
  for (const dispose of harnessed.disposers) dispose()
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(harnessed.calls.at(-1)).toBe('dispose')
})

it('renders the batch header the model reads', () => {
  expect(formatInboundBatch([event])).toEqual([{
    type: 'text',
    text: '[1] 渠道 ayla ｜ 会话 ayla:private:17 ｜ 消息id 90211\n小希(8d9c)：好了，我吃完了',
  }])
})
import type { Context } from '@deepseek-ai/cordis'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { describe, expect, it, vi } from 'vitest'
import type { InboundEvent } from '../src/inbound.ts'
import { MAIN_SESSION_CWD, MAIN_SESSION_ID, composeMainAgent, createMainSessionTurn, formatInboundBatch } from '../src/main-session.ts'
import { definePassTool } from '../src/pass.ts'

const exec = { signal: new AbortController().signal } as ToolRunContext

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
    let setup: ((agentCtx: Context) => void) | undefined
    let disposer: (() => void) | undefined
    const ctx = {
      logger: () => ({ info: vi.fn() }),
      effect(callback: () => () => void) { disposer = callback() },
      agentDefaultModel: {
        currentSelection: () => ({ provider: 'd1api', model: 'deepseek-v4.1-flash' }),
      },
      agents: {
        get: () => undefined,
        async resume(options: { setup: (agentCtx: Context) => void; agentOptions: unknown }) {
          calls.push('resume')
          expect(options.agentOptions).toEqual({ provider: 'd1api', model: 'deepseek-v4.1-flash' })
          setup = options.setup
          throw new Error('no saved session')
        },
        async create(options: { sessionId: string; setup: (agentCtx: Context) => void; agentOptions: unknown; meta: unknown }) {
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
    const turn = createMainSessionTurn(ctx)
    expect(calls).toEqual(['resume'])
    await turn(batch)
    expect(calls).toEqual(['resume', 'create', 'followup', 'idle'])
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({ content: formatInboundBatch(batch) })

    const register = vi.fn()
    const restrict = vi.fn()
    setup?.({ tools: { register, restrict } } as unknown as Context)
    expect(register).toHaveBeenCalledOnce()
    expect(register.mock.calls[0]?.[0].name).toBe('pass')
    expect(restrict).toHaveBeenCalledWith({ allow: ['send_text', 'read_image'] })

    await turn(batch.slice(0, 1))
    expect(calls.filter(call => call === 'create')).toHaveLength(1)
    expect(messages).toHaveLength(2)
    disposer?.()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(calls.at(-1)).toBe('dispose')
  })

  it('reuses an already live main agent instead of creating a duplicate', async () => {
    const followup = vi.fn()
    const agent = { followup, whenIdle: vi.fn().mockResolvedValue(undefined) }
    const ctx = {
      agents: { get: () => agent },
      effect: vi.fn(),
    } as unknown as Context
    await createMainSessionTurn(ctx)(batch.slice(0, 1))
    expect(followup).toHaveBeenCalledOnce()
    expect(agent.whenIdle).toHaveBeenCalledOnce()
  })
})

describe('main agent tool scope', () => {
  it('registers scoped pass and exposes only send_text and read_image globally', () => {
    const register = vi.fn()
    const restrict = vi.fn()
    composeMainAgent({ tools: { register, restrict } } as unknown as Context)
    expect(register.mock.calls[0]?.[0].name).toBe('pass')
    expect(restrict).toHaveBeenCalledWith({ allow: ['send_text', 'read_image'] })
  })
})

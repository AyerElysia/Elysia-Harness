import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it } from 'vitest'
import * as ConsciousMind from '../src/index.ts'
import { OutboundDeliveryUnknown } from '../src/outbound.ts'
import { deliverSendText, splitOutboundText } from '../src/send-text.ts'
import type { SendTextArgs } from '../src/send-text.ts'

const directories: string[] = []

function directory(): string {
  const path = join(tmpdir(), `elysia-send-${Date.now()}-${directories.length}`)
  mkdirSync(path)
  directories.push(path)
  return path
}

afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true })
})

function args(patch: Partial<SendTextArgs> = {}): SendTextArgs {
  return {
    channel: 'qq',
    conversation: 'private:ayer',
    content: '在呀',
    thought: '她在叫我',
    mood: '',
    decision: '',
    expected_response: '',
    ...patch,
  }
}

const exec = { signal: new AbortController().signal } as ToolRunContext

describe('splitOutboundText', () => {
  it('splits on newlines and drops blank and placeholder lines', () => {
    expect(splitOutboundText(' 第一段 \r\n\n……\r第二段 \n')).toEqual(['第一段', '第二段'])
  })
})

describe('deliverSendText', () => {
  it('sends each line in order and quotes only the first segment', async () => {
    const ctx = new Context()
    try {
      const outbound = new ConsciousMind.OutboundText(ctx)
      const calls: { text: string; replyTo?: string }[] = []
      outbound.register('qq', async (delivery) => {
        calls.push({ text: delivery.text, ...(delivery.replyTo === undefined ? {} : { replyTo: delivery.replyTo }) })
        return { messageId: `m${calls.length}` }
      })
      const result = await deliverSendText(outbound, args({
        content: '第一句\n\n第二句',
        reply_to: 'quoted',
      }))
      expect(calls).toEqual([
        { text: '第一句', replyTo: 'quoted' },
        { text: '第二句' },
      ])
      expect(result.sent).toEqual([
        { index: 0, text: '第一句', messageId: 'm1' },
        { index: 1, text: '第二句', messageId: 'm2' },
      ])
      expect(result.error).toBeUndefined()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('sends nothing when thought is blank, content is empty, or the channel is missing', async () => {
    const ctx = new Context()
    try {
      const outbound = new ConsciousMind.OutboundText(ctx)
      let calls = 0
      outbound.register('qq', async () => {
        calls += 1
        return {}
      })
      expect((await deliverSendText(outbound, args({ thought: '  ' }))).sent).toEqual([])
      expect((await deliverSendText(outbound, args({ content: '\n  \n' }))).error).toBe('发送内容为空')
      expect((await deliverSendText(outbound, args({ content: '……\n...' }))).error).toBe('发送内容不能只是省略号或占位符')
      expect((await deliverSendText(outbound, args({ channel: 'kook' }))).error).toBe('渠道未登记: kook')
      expect(calls).toBe(0)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('stops at the first failed segment and keeps the ones already accepted', async () => {
    const ctx = new Context()
    try {
      const outbound = new ConsciousMind.OutboundText(ctx)
      outbound.register('feishu', async (delivery) => {
        if (delivery.text === '停') throw new Error('平台拒绝')
        return { messageId: delivery.text }
      })
      const failed = await deliverSendText(outbound, args({
        channel: 'feishu',
        content: '已发出\n停\n不会发',
      }))
      expect(failed.sent).toEqual([{ index: 0, text: '已发出', messageId: '已发出' }])
      expect(failed.stoppedAt).toBe(1)
      expect(failed.error).toBe('平台拒绝')

      outbound.register('kook', async (delivery) => {
        if (delivery.text === '未知') throw new OutboundDeliveryUnknown()
        return {}
      })
      const unknown = await deliverSendText(outbound, args({
        channel: 'kook',
        content: '先到\n未知\n后面',
      }))
      expect(unknown.sent.map(segment => segment.text)).toEqual(['先到'])
      expect(unknown.stoppedAt).toBe(1)
      expect(unknown.error).toBe('投递状态未知')
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('send_text tool', () => {
  it('registers the schema and refuses a blank thought before any send', async () => {
    const base = directory()
    writeFileSync(join(base, 'SOUL.md'), 'soul')
    const ctx = new Context()
    try {
      await ctx.plugin(SystemPrompt, { includeHarnessIdentity: false })
      await ctx.plugin(ToolRuntime)
      await ctx.plugin(ConsciousMind, { baseDir: base, files: ['SOUL.md'] })
      const tool = ctx.tools.get('send_text')
      expect(tool).toBeDefined()
      expect(tool?.parameters.required).toEqual([
        'channel', 'conversation', 'thought', 'mood', 'decision', 'expected_response', 'content',
      ])
      let calls = 0
      ctx.outboundText.register('qq', async () => {
        calls += 1
        return {}
      })
      const result = await tool?.execute(args({ thought: '' }), exec)
      expect(result).toMatchObject({ sent: [], error: 'thought 必须是非空字符串' })
      expect(calls).toBe(0)
      await expect(tool?.execute({ content: '缺字段' }, exec)).rejects.toThrow(/invalid arguments/)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

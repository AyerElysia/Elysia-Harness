import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { AttachmentId, AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type { ImageAttachmentRef, SaveImageAttachment, StoredImageAttachment } from '@deepseek-ai/dsh-attachment'
import { describe, expect, it, vi } from 'vitest'
import { OutboundText } from '@elysia/conscious-mind/outbound'
import { InboundPending } from '@elysia/conscious-mind/src/pending.ts'
import { KookClient } from '../src/client.ts'
import { parseElysiumKookConfig } from '../src/config.ts'
import { handleKookFrame } from '../src/frame.ts'
import { kookInboundEvent, kookInboundText } from '../src/inbound.ts'
import type { KookInboundEvent } from '../src/inbound.ts'
import * as KookBot from '../src/index.ts'

const settings = parseElysiumKookConfig(`
[bot]
token = "bot-token"
bot_name = "爱莉希雅"
[features]
use_kmarkdown = true
reply_with_quote = true
`)

class FakeAttachments extends AttachmentStore {
  readonly imageLimits = {
    maxImageBytes: 1024 * 1024,
    maxImagesPerMessage: 4,
    maxMessageImageBytes: 4 * 1024 * 1024,
    maxImagePixels: 16_000_000,
    maxImageDimension: 4096,
    mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
  } as const

  async validateImage(_input: SaveImageAttachment): Promise<void> {}

  async saveImage(input: SaveImageAttachment): Promise<ImageAttachmentRef> {
    return {
      attachmentId: AttachmentId('kook-image-1'),
      mediaType: input.mediaType,
      bytes: input.data.byteLength,
      width: 1,
      height: 1,
    }
  }

  async readImage(_ref: ImageAttachmentRef): Promise<StoredImageAttachment> {
    throw new Error('not used')
  }
}

describe('Elysium KOOK config', () => {
  it('reads the bot name and the send flags', () => {
    expect(settings.botName).toBe('爱莉希雅')
    expect(settings.useKmarkdown).toBe(true)
    expect(settings.replyWithQuote).toBe(true)
    expect(settings.token).toBe('bot-token')
  })
})

describe('KOOK inbound events', () => {
  it('turns a direct text event into a conversation and drops the bot itself', () => {
    const inbound = kookInboundText({
      channel_type: 'PERSON',
      type: 9,
      content: '在吗',
      msg_id: 'k1',
      author_id: '1370110560',
      extra: { author: { username: '小希' } },
    }, '999')
    expect(kookInboundText({
      channel_type: 'PERSON',
      type: 1,
      content: '自己',
      msg_id: 'k2',
      author_id: '999',
    }, '999')).toBeUndefined()
    expect(inbound).toMatchObject({
      channel: 'kook',
      conversation: 'kook:direct:1370110560',
      messageId: 'k1',
      senderName: '小希',
      text: '在吗',
    })
  })

  it('accepts an image event as an image source rather than text', () => {
    const inbound = kookInboundEvent({
      channel_type: 'PERSON',
      type: 2,
      content: 'https://img.kookapp.cn/example.png',
      msg_id: 'k-image',
      author_id: '1370110560',
      extra: { author: { username: '小希' } },
    }, '999')
    expect(inbound?.content).toEqual([{ type: 'image', url: 'https://img.kookapp.cn/example.png' }])
    expect(kookInboundText({
      channel_type: 'PERSON', type: 2, content: 'https://img.kookapp.cn/example.png',
      msg_id: 'k-image', author_id: '1370110560',
    }, '999')).toBeUndefined()
  })
})

describe('KOOK outbound text', () => {
  it('sends one channel segment as kmarkdown and quotes the first reply', async () => {
    const calls: { url: string; authorization?: string; body?: unknown }[] = []
    const client = new KookClient(settings, async (url, init) => {
      const authorization = new Headers(init?.headers).get('authorization')
      calls.push({
        url: String(url),
        ...authorization === null ? {} : { authorization },
        ...init?.body === undefined ? {} : { body: JSON.parse(String(init.body)) },
      })
      return Response.json({ code: 0, data: { msg_id: 'k-sent' } })
    })
    const receipt = await client.sendText({
      conversation: 'kook:channel:42',
      text: '第一句',
      replyTo: 'k1',
    })
    expect(receipt).toEqual({ messageId: 'k-sent' })
    expect(calls[0]?.url).toContain('/message/create')
    expect(calls[0]?.authorization).toBe('Bot bot-token')
    expect(calls[0]?.body).toEqual({ target_id: '42', content: '第一句', type: 9, quote: 'k1' })
  })
})

describe('KOOK gateway frames', () => {
  it('accepts hello, keeps the newest event, and clears the session on reconnect', () => {
    const state = { sn: 0, sessionId: '' }
    expect(handleKookFrame({ s: 1, d: { code: 0, session_id: 'sess' } }, state)).toEqual({ type: 'hello', sessionId: 'sess' })
    expect(handleKookFrame({ s: 0, sn: 4, d: { content: '在吗' } }, state)).toEqual({ type: 'event', event: { content: '在吗' } })
    expect(handleKookFrame({ s: 0, sn: 4, d: { content: '旧的' } }, state)).toEqual({ type: 'ignore' })
    expect(handleKookFrame({ s: 5 }, state)).toEqual({ type: 'reconnect' })
    expect(state).toEqual({ sn: 0, sessionId: '' })
  })
})

describe('kook-bot plugin', () => {
  it('registers the kook sender from a config file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kook-bot-'))
    const configPath = join(dir, 'config.toml')
    await writeFile(configPath, `
[bot]
token = "bot-token"
bot_name = "爱莉希雅"
`)
    const ctx = new Context()
    try {
      new OutboundText(ctx)
      new InboundPending(ctx)
      new FakeAttachments(ctx)
      const fiber = await ctx.plugin(KookBot, { configPath, listen: false })
      expect(typeof ctx.outboundText.sender('kook')).toBe('function')
      await fiber.dispose()
      expect(ctx.outboundText.sender('kook')).toBeUndefined()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('forwards text as an admitted event without changing its content', async () => {
    const ctx = new Context()
    try {
      new FakeAttachments(ctx)
      const pending = new InboundPending(ctx)
      const receive = vi.spyOn(pending, 'receive')
      const emitted: KookInboundEvent[] = []
      ctx.on('kook/message', message => { emitted.push(message) })
      const inbound = kookInboundEvent({
        channel_type: 'PERSON', type: 9, content: '在吗', msg_id: 'k-forward',
        author_id: '1370110560', extra: { author: { username: '小希' } },
      }, '999')!
      await KookBot.forwardKookInbound(ctx, inbound, new KookClient(settings))
      expect(emitted).toEqual([inbound])
      expect(receive).toHaveBeenCalledWith({
        channel: 'kook', conversation: 'kook:direct:1370110560', messageId: 'k-forward',
        senderId: '1370110560', senderName: '小希', content: [{ type: 'text', text: '在吗' }],
      })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('downloads an image without leaking the token and queues only its durable reference', async () => {
    const ctx = new Context()
    try {
      new FakeAttachments(ctx)
      const pending = new InboundPending(ctx)
      const receive = vi.spyOn(pending, 'receive')
      const fetchImage = vi.fn(async () => new Response(new Uint8Array([1, 2, 3, 4]), {
        status: 200,
        headers: { 'content-type': 'image/png' },
      }))
      const inbound = kookInboundEvent({
        channel_type: 'PERSON', type: 2, content: 'https://img.kookapp.cn/example.png',
        msg_id: 'k-image-forward', author_id: '1370110560', extra: { author: { username: '小希' } },
      }, '999')!
      await KookBot.forwardKookInbound(ctx, inbound, new KookClient(settings, fetchImage))
      expect(new Headers(fetchImage.mock.calls[0]?.[1]?.headers).get('authorization')).toBeNull()
      const event = receive.mock.calls[0]?.[0]
      expect(event?.content[0]?.type).toBe('image')
      expect(event?.content[0]).toMatchObject({
        attachment: { attachmentId: 'kook-image-1', mediaType: 'image/png', bytes: 4 },
      })
      expect(JSON.stringify(event)).not.toContain('AQIDBA==')
      expect(JSON.stringify(event)).not.toContain('img.kookapp.cn')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('does not enqueue a partial event when image download fails', async () => {
    const ctx = new Context()
    try {
      new FakeAttachments(ctx)
      const pending = new InboundPending(ctx)
      const receive = vi.spyOn(pending, 'receive')
      const inbound = kookInboundEvent({
        channel_type: 'PERSON', type: 2, content: 'https://img.kookapp.cn/missing.png',
        msg_id: 'k-image-failed', author_id: '1370110560',
      }, '999')!
      const client = new KookClient(settings, async () => new Response('missing', { status: 404 }))
      await expect(KookBot.forwardKookInbound(ctx, inbound, client)).resolves.toBeUndefined()
      expect(receive).not.toHaveBeenCalled()
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

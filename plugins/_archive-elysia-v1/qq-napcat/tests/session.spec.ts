import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { OutboundText, OutboundDeliveryUnknown } from '@elysia/conscious-mind/outbound'
import { parseElysiumNapcatConfig } from '../src/config.ts'
import * as QqNapcat from '../src/index.ts'
import { OneBotSession } from '../src/session.ts'
import type { QqNapcatSettings } from '../src/config.ts'

const settings: QqNapcatSettings = {
  selfId: '3427056465',
  mode: 'reverse',
  host: '127.0.0.1',
  port: 8087,
  accessToken: '',
  sendTimeoutMs: 1000,
}

function session(): { bot: OneBotSession; sent: string[] } {
  const sent: string[] = []
  const bot = new OneBotSession(settings)
  bot.attach({ send: (data) => { sent.push(data) } })
  return { bot, sent }
}

describe('Elysium NapCat config', () => {
  it('reads the account and the reverse socket', () => {
    const parsed = parseElysiumNapcatConfig(`
[bot]
qq_id = "3427056465"
[napcat_server]
mode = "reverse"
host = "localhost"
port = 8087
access_token = ""
[features]
message_send_timeout_seconds = 20.0
`)
    expect(parsed.selfId).toBe('3427056465')
    expect(parsed.mode).toBe('reverse')
    expect(parsed.port).toBe(8087)
    expect(parsed.sendTimeoutMs).toBe(20_000)
  })
})

describe('OneBot text session', () => {
  it('turns a private text event into a conversation and ignores its own echo', () => {
    const { bot } = session()
    bot.receive(JSON.stringify({
      post_type: 'message',
      message_type: 'private',
      message_id: 9,
      self_id: 3427056465,
      sender: { user_id: 2665253325, nickname: '小星星' },
      message: [{ type: 'text', data: { text: '在吗' } }, { type: 'face', data: { id: 1 } }],
    }))
    bot.receive(JSON.stringify({
      post_type: 'message',
      message_type: 'private',
      message_id: 10,
      self_id: 3427056465,
      sender: { user_id: 3427056465, nickname: '爱莉希雅' },
      message: [{ type: 'text', data: { text: '这是我自己' } }],
    }))
    expect(bot.inbound).toEqual([{
      channel: 'qq',
      conversation: 'qq:private:2665253325',
      target: { kind: 'private', userId: '2665253325' },
      messageId: '9',
      senderId: '2665253325',
      senderName: '小星星',
      text: '在吗',
    }])
  })

  it('sends a private segment and returns the message id', async () => {
    const { bot, sent } = session()
    const pending = bot.sendText({
      conversation: 'qq:private:2665253325',
      text: '第一句',
      replyTo: '9',
    })
    const request = JSON.parse(sent[0] ?? '{}') as { echo: string; action: string; params: { message: unknown[] } }
    expect(request.action).toBe('send_private_msg')
    expect(request.params.message).toEqual([
      { type: 'reply', data: { id: '9' } },
      { type: 'text', data: { text: '第一句' } },
    ])
    bot.receive(JSON.stringify({
      echo: request.echo,
      status: 'ok',
      retcode: 0,
      data: { message_id: 42 },
    }))
    await expect(pending).resolves.toEqual({ messageId: '42' })
  })

  it('reports an unknown receipt instead of a confirmed send', async () => {
    const { bot, sent } = session()
    const pending = bot.sendText({ conversation: 'qq:group:100', text: '群里一句' })
    const request = JSON.parse(sent[0] ?? '{}') as { echo: string; action: string }
    expect(request.action).toBe('send_group_msg')
    bot.receive(JSON.stringify({
      echo: request.echo,
      status: 'failed',
      retcode: 1200,
      message: 'Timeout: NTEvent NodeIKernelMsgService/sendMsg',
    }))
    await expect(pending).rejects.toBeInstanceOf(OutboundDeliveryUnknown)
  })
})

describe('qq-napcat plugin', () => {
  it('registers the qq sender from the Elysium account config', async () => {
    // The plugin reads an absolute config path by default. Point it at a fixture so the
    // test asserts the mount behavior rather than the presence of one machine's checkout.
    const directory = mkdtempSync(join(tmpdir(), 'qq-napcat-config-'))
    const configPath = join(directory, 'config.toml')
    writeFileSync(configPath, `
[bot]
qq_id = "3427056465"
[napcat_server]
mode = "reverse"
host = "127.0.0.1"
port = 8098
access_token = ""
[features]
message_send_timeout_seconds = 20.0
`)
    const ctx = new Context()
    try {
      new OutboundText(ctx)
      const fiber = await ctx.plugin(QqNapcat, { port: 8098, configPath })
      expect(typeof ctx.outboundText.sender('qq')).toBe('function')
      await fiber.dispose()
      expect(ctx.outboundText.sender('qq')).toBeUndefined()
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

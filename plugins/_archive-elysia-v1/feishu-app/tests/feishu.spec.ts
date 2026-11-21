import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { OutboundText } from '@elysia/conscious-mind/outbound'
import { FeishuClient } from '../src/client.ts'
import { parseElysiumFeishuConfig } from '../src/config.ts'
import { feishuInboundText } from '../src/inbound.ts'
import * as FeishuApp from '../src/index.ts'

const settings = parseElysiumFeishuConfig(`
[app]
app_id = "cli_testapp"
app_secret = "secret-value"
api_base_url = "https://open.feishu.cn"
[bot]
bot_name = "爱莉"
[behavior]
reply_to_message = true
`)

describe('Elysium Feishu config', () => {
  it('reads the app and keeps the secret out of the parsed public fields', () => {
    expect(settings.appId).toBe('cli_testapp')
    expect(settings.botName).toBe('爱莉')
    expect(settings.replyToMessage).toBe(true)
    expect(settings.appSecret).toBe('secret-value')
  })
})

describe('Feishu text', () => {
  it('turns a private text event into a conversation and drops the app echo', () => {
    const inbound = feishuInboundText({
      header: { event_type: 'im.message.receive_v1' },
      event: {
        sender: { sender_type: 'user', sender_id: { open_id: 'ou_user' } },
        message: {
          message_id: 'om_1',
          chat_id: 'oc_chat',
          chat_type: 'p2p',
          message_type: 'text',
          content: JSON.stringify({ text: '在吗' }),
        },
      },
    })
    expect(feishuInboundText({
      event: {
        sender: { sender_type: 'app', sender_id: { open_id: 'ou_bot' } },
        message: { message_id: 'om_2', chat_type: 'p2p', message_type: 'text', content: '{"text":"自己"}' },
      },
    })).toBeUndefined()
    expect(inbound).toMatchObject({
      channel: 'feishu',
      conversation: 'feishu:private:ou_user',
      messageId: 'om_1',
      text: '在吗',
    })
  })

  it('sends one private segment with the tenant token and returns the message id', async () => {
    const calls: { url: string; body?: unknown; authorization?: string }[] = []
    const client = new FeishuClient(settings, async (url, init) => {
      const href = String(url)
      const authorization = new Headers(init?.headers).get('authorization')
      calls.push({
        url: href,
        ...authorization === null ? {} : { authorization },
        ...init?.body === undefined ? {} : { body: JSON.parse(String(init.body)) },
      })
      if (href.endsWith('/tenant_access_token/internal')) {
        return Response.json({ code: 0, tenant_access_token: 'tenant-token', expire: 7200 })
      }
      return Response.json({ code: 0, data: { message_id: 'om_sent' } })
    })
    const receipt = await client.sendText({
      conversation: 'feishu:private:ou_user',
      text: '第一句',
      replyTo: 'om_1',
    })
    expect(receipt).toEqual({ messageId: 'om_sent' })
    expect(calls[0]?.url).toContain('/tenant_access_token/internal')
    expect(calls[0]?.body).toMatchObject({ app_id: 'cli_testapp' })
    expect(calls[1]?.url).toContain('/messages/om_1/reply')
    expect(calls[1]?.authorization).toBe('Bearer tenant-token')
    expect(calls[1]?.body).toMatchObject({ msg_type: 'text', content: JSON.stringify({ text: '第一句' }) })
  })
})

describe('feishu-app plugin', () => {
  it('registers the feishu sender from a config file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'feishu-app-'))
    const configPath = join(dir, 'config.toml')
    await writeFile(configPath, `
[app]
app_id = "cli_testapp"
app_secret = "secret-value"
[bot]
bot_name = "爱莉"
`)
    const ctx = new Context()
    try {
      new OutboundText(ctx)
      const fiber = await ctx.plugin(FeishuApp, { configPath, listen: false })
      expect(typeof ctx.outboundText.sender('feishu')).toBe('function')
      await fiber.dispose()
      expect(ctx.outboundText.sender('feishu')).toBeUndefined()
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

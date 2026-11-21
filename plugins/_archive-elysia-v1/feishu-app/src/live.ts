/**
 * Acceptance run: open the Feishu long connection, read the latest private
 * text, and send two lines through send_text. The socket is closed at the
 * end so Elysium can take the only long connection back.
 */
import { Context } from '@deepseek-ai/cordis'
import { OutboundText } from '@elysia/conscious-mind/outbound'
import { deliverSendText } from '@elysia/conscious-mind/send-text'
import { FeishuClient } from './client.ts'
import { loadElysiumFeishuConfig } from './config.ts'
import { FeishuLink } from './link.ts'

const AYER = 'ou_90386a0f566828037ff9c29ebacdc4cb'
const AYER_CHAT = 'oc_400a157c93af461386bd9d56270da8fd'

const settings = loadElysiumFeishuConfig()
const client = new FeishuClient(settings)
const received: string[] = []
const link = new FeishuLink(client, settings, (message) => {
  received.push(`${message.conversation} ${message.text}`)
  process.stderr.write(`收到 ${message.conversation} ${message.text}\n`)
})

const ctx = new Context()
new OutboundText(ctx)
ctx.outboundText.register('feishu', delivery => client.sendText(delivery))

await link.start()
process.stderr.write(`飞书长连接已就绪 open_id=${link.selfOpenId}\n`)
const recent = await client.recentTexts(AYER_CHAT, link.selfOpenId)
const latest = recent[0]
process.stderr.write(latest === undefined
  ? '历史里没有对方的文字\n'
  : `最近一条 ${latest.conversation} ${latest.text}\n`)

const result = await deliverSendText(ctx.outboundText, {
  channel: 'feishu',
  conversation: `feishu:private:${AYER}`,
  content: '渠道测试，第一句\n渠道测试，第二句',
  thought: '确认飞书文字能发出去',
  mood: '',
  decision: '',
  expected_response: '',
})
process.stdout.write(`${JSON.stringify(result)}\n`)
await new Promise(resolve => setTimeout(resolve, 12_000))
process.stderr.write(`等待期间收到 ${received.length} 条\n`)
link.stop()
process.exit(result.error === undefined && result.sent.length === 2 ? 0 : 1)

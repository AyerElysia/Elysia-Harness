/**
 * Acceptance run: open the KOOK gateway, list direct chats, and send two
 * lines through send_text only to a window whose name is the operator.
 * The socket is closed at the end so Elysium can take the only gateway back.
 */
import { Context } from '@deepseek-ai/cordis'
import { OutboundText } from '@elysia/conscious-mind/outbound'
import { deliverSendText } from '@elysia/conscious-mind/send-text'
import { KookClient } from './client.ts'
import { loadElysiumKookConfig } from './config.ts'
import { KookGateway } from './gateway.ts'

const OPERATOR = /ayer|星星/iu

const settings = loadElysiumKookConfig()
const client = new KookClient(settings)
const received: string[] = []
const gateway = new KookGateway(client, (message) => {
  const text = message.content.map(part => part.type === 'text' ? part.text : '<图片>').join('')
  received.push(`${message.conversation} ${message.senderName} ${text}`)
  process.stderr.write(`收到 ${message.conversation} ${message.senderName}: ${text}\n`)
})

const ctx = new Context()
new OutboundText(ctx)
ctx.outboundText.register('kook', delivery => client.sendText(delivery))

await gateway.start()
process.stderr.write(`KOOK Gateway 已就绪 id=${gateway.selfId}\n`)
const chats = await client.directChats()
for (const chat of chats) {
  process.stderr.write(`私信 ${chat.userId} ${chat.username} 未读 ${chat.unread}\n`)
}
const operator = chats.find(chat => OPERATOR.test(chat.username))
if (operator === undefined) {
  process.stderr.write('没有名字像操作者的私信窗口，不往其他人的对话里发测试\n')
  process.stderr.write(`等待期间收到 ${received.length} 条\n`)
  gateway.stop()
  process.exit(0)
}

const result = await deliverSendText(ctx.outboundText, {
  channel: 'kook',
  conversation: `kook:direct:${operator.userId}`,
  content: '渠道测试，第一句\n渠道测试，第二句',
  thought: '确认 KOOK 文字能发出去',
  mood: '',
  decision: '',
  expected_response: '',
})
process.stdout.write(`${JSON.stringify(result)}\n`)
await new Promise(resolve => setTimeout(resolve, 12_000))
process.stderr.write(`等待期间收到 ${received.length} 条\n`)
gateway.stop()
process.exit(result.error === undefined && result.sent.length === 2 ? 0 : 1)

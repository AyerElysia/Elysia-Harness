/**
 * Acceptance run: connect to NapCat and send two text lines through send_text.
 * The port can differ from Elysium's listener when that port is already taken.
 */
import { Context } from '@deepseek-ai/cordis'
import { OutboundText } from '@elysia/conscious-mind/outbound'
import { deliverSendText } from '@elysia/conscious-mind/send-text'
import { loadElysiumNapcatConfig } from './config.ts'
import { NapcatLink } from './link.ts'

const port = Number(process.argv[2] ?? '8097')
const settings = loadElysiumNapcatConfig()
settings.port = port
const received: string[] = []
const link = new NapcatLink(settings, (message) => {
  received.push(`${message.conversation} ${message.text}`)
  process.stderr.write(`收到 ${message.conversation} ${message.text}\n`)
})

const ctx = new Context()
new OutboundText(ctx)
ctx.outboundText.register('qq', delivery => link.session.sendText(delivery))

await link.start()
process.stderr.write(`监听 127.0.0.1:${port}，等待 NapCat\n`)
await link.waitForConnection(45_000)
process.stderr.write('NapCat 已连接\n')

const result = await deliverSendText(ctx.outboundText, {
  channel: 'qq',
  conversation: 'qq:private:2665253325',
  content: '渠道测试，第一句\n渠道测试，第二句',
  thought: '确认 QQ 文字能发出去',
  mood: '',
  decision: '',
  expected_response: '',
})
process.stdout.write(`${JSON.stringify(result)}\n`)
await new Promise(resolve => setTimeout(resolve, 15_000))
process.stderr.write(`等待期间收到 ${received.length} 条\n`)
await link.stop()
await ctx.fiber.dispose()

import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AylaClient } from '../src/client.ts'
import {
  AYLA_CHANNEL, AylaReplyRejected, OutboundDeliveryUnknown,
  defineSendTextTool, deliverSendText, replyInput, splitOutboundText,
} from '../src/outbound.ts'
import type { AylaDelivery, AylaSend, SendTextArgs } from '../src/outbound.ts'

const exec = { signal: new AbortController().signal } as ToolRunContext

function args(overrides: Partial<SendTextArgs> = {}): SendTextArgs {
  return {
    channel: AYLA_CHANNEL,
    conversation: 'ayla:private:17',
    thought: '她吃完了，我想接一句',
    mood: '安心',
    decision: '顺着她说',
    expected_response: '她会继续聊',
    content: '这个决定对呀',
    ...overrides,
  }
}

/** A sender that records deliveries and answers from a scripted result list. */
function scriptedSender(results: ('ok' | Error)[]): { send: AylaSend; deliveries: AylaDelivery[] } {
  const deliveries: AylaDelivery[] = []
  const queue = [...results]
  const send: AylaSend = async delivery => {
    deliveries.push(delivery)
    const result = queue.shift()
    if (result instanceof Error) throw result
    return { messageId: 'm-' + String(deliveries.length) }
  }
  return { send, deliveries }
}

describe('Ayla outbound splitting', () => {
  it('splits on newlines and drops blank and placeholder lines', () => {
    expect(splitOutboundText('第一句\n\n第二句\r\n……\n第三句')).toEqual(['第一句', '第二句', '第三句'])
  })
})

describe('Ayla outbound delivery', () => {
  it('sends each line as its own message and backfills message ids', async () => {
    const { send, deliveries } = scriptedSender(['ok', 'ok'])
    const result = await deliverSendText(() => send, args({ content: '第一句\n第二句' }))
    expect(result).toEqual({
      sent: [
        { index: 0, text: '第一句', messageId: 'm-1' },
        { index: 1, text: '第二句', messageId: 'm-2' },
      ],
    })
    expect(deliveries.map(delivery => delivery.text)).toEqual(['第一句', '第二句'])
  })

  it('carries reply_to only on the first segment', async () => {
    const { send, deliveries } = scriptedSender(['ok', 'ok'])
    await deliverSendText(() => send, args({ content: 'a\nb', reply_to: ' 90211 ' }))
    expect(deliveries[0]?.replyTo).toBe('90211')
    expect(deliveries[1]?.replyTo).toBeUndefined()
  })

  it('stops at the first failing segment and reports where it stopped', async () => {
    const { send, deliveries } = scriptedSender([
      'ok',
      new AylaReplyRejected('conversation_not_found', '会话不存在'),
      'ok',
    ])
    const result = await deliverSendText(() => send, args({ content: '一\n二\n三' }))
    expect(result.sent).toEqual([{ index: 0, text: '一', messageId: 'm-1' }])
    expect(result.stoppedAt).toBe(1)
    expect(result.error).toContain('conversation_not_found')
    expect(deliveries).toHaveLength(2)
  })

  it('reports an unknown delivery as unknown instead of retrying', async () => {
    const { send, deliveries } = scriptedSender([new OutboundDeliveryUnknown(), 'ok'])
    const result = await deliverSendText(() => send, args({ content: '一\n二' }))
    expect(result.stoppedAt).toBe(0)
    expect(result.error).toBe('投递状态未知')
    expect(deliveries).toHaveLength(1)
    expect(result.sent).toEqual([])
  })

  it('reports a timeout as unknown delivery', async () => {
    const send: AylaSend = () => Promise.reject(new OutboundDeliveryUnknown('等待 Ayla 回执超时'))
    const result = await deliverSendText(() => send, args())
    expect(result.error).toBe('投递状态未知')
    expect(result.stoppedAt).toBe(0)
  })

  it('refuses an empty thought before touching the channel', async () => {
    const { send, deliveries } = scriptedSender(['ok'])
    const result = await deliverSendText(() => send, args({ thought: '   ' }))
    expect(result).toEqual({ sent: [], error: 'thought 必须是非空字符串' })
    expect(deliveries).toEqual([])
  })

  it('refuses another channel name', async () => {
    const { send, deliveries } = scriptedSender(['ok'])
    const result = await deliverSendText(() => send, args({ channel: 'kook' }))
    expect(result.error).toContain('渠道未登记')
    expect(deliveries).toEqual([])
  })

  it('refuses placeholder-only content', async () => {
    const { send } = scriptedSender(['ok'])
    await expect(deliverSendText(() => send, args({ content: '……\n...' })))
      .resolves.toEqual({ sent: [], error: '发送内容不能只是省略号或占位符' })
  })

  it('reports the channel as unavailable when the socket is down', async () => {
    const result = await deliverSendText(() => undefined, args())
    expect(result).toEqual({ sent: [], error: 'Ayla 通道未连接' })
  })
})

describe('Ayla outbound conversation validation', () => {
  it('refuses to build a frame for a conversation it cannot address', () => {
    expect(() => replyInput({ conversation: 'kook:direct:1', text: '在吗' }, 'c1'))
      .toThrow(/无法识别的 Ayla 会话/u)
  })

  it('keeps the group kind from the conversation id', () => {
    expect(replyInput({ conversation: 'ayla:group:42', text: '在吗' }, 'c1'))
      .toMatchObject({ conversation: { kind: 'group', id: '42' } })
  })
})

describe('Ayla send_text tool', () => {
  it('is named send_text and requires the conscious-mind argument set', () => {
    const tool = defineSendTextTool(() => async () => ({ messageId: 'm-1' }))
    expect(tool.name).toBe('send_text')
    expect(tool.parameters.required)
      .toEqual(['channel', 'conversation', 'thought', 'mood', 'decision', 'expected_response', 'content'])
    expect(Object.keys(tool.parameters.properties ?? {}).sort())
      .toEqual(['channel', 'content', 'conversation', 'decision', 'expected_response', 'mood', 'reply_to', 'thought'])
  })

  it('executes through the sender and returns the canonical result', async () => {
    const send = vi.fn(async () => ({ messageId: 'm-9' }))
    const tool = defineSendTextTool(() => send)
    await expect(tool.execute(args(), exec)).resolves.toEqual({
      sent: [{ index: 0, text: '这个决定对呀', messageId: 'm-9' }],
    })
    expect(send).toHaveBeenCalledOnce()
  })
})

describe('Ayla reply settlement end to end', () => {
  /** One client wired to a fake socket, so a frame really round-trips. */
  function wired() {
    const sent: { v: number; type: string; client_message_id?: string }[] = []
    let deliver: ((frame: unknown) => void) | undefined
    const socket = {
      send(data: string) { sent.push(JSON.parse(data) as { v: number; type: string }) },
      close() {},
      onopen: null as ((event: unknown) => void) | null,
      onmessage: null as ((event: { data: unknown }) => void) | null,
      onclose: null as ((event: { code?: number }) => void) | null,
      onerror: null as ((event: unknown) => void) | null,
    }
    const client = new AylaClient({
      baseUrl: new URL('http://127.0.0.1:8100'),
      auth: { accessToken: async () => 'a1', refreshOnce: async () => 'a2' },
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      createSocket: () => socket,
      onInbound: async () => true,
      replyTimeoutMs: 1_000,
    })
    clients.push(client)
    deliver = frame => socket.onmessage?.({ data: JSON.stringify(frame) })
    return { client, socket, sent, deliver: (frame: unknown) => { deliver?.(frame) } }
  }

  const clients: AylaClient[] = []
  afterEach(() => {
    for (const client of clients.splice(0)) client.stop()
  })

  it('backfills the message id when Ayla answers sent', async () => {
    const wiredClient = wired()
    wiredClient.client.start()
    await new Promise(resolve => setTimeout(resolve, 0))
    wiredClient.socket.onopen?.({})
    const send: AylaSend = async delivery => wiredClient.client.sendReply(
      replyInput(delivery, 'ayla-1'),
    )
    const pending = deliverSendText(() => send, args({ content: '一句' }))
    await new Promise(resolve => setTimeout(resolve, 0))
    wiredClient.deliver({ v: 1, type: 'sent', client_message_id: 'ayla-1', message_id: 'm-5' })
    await expect(pending).resolves.toEqual({
      sent: [{ index: 0, text: '一句', messageId: 'm-5' }],
    })
  })

  it('reports a failure with stoppedAt when Ayla answers error', async () => {
    const wiredClient = wired()
    wiredClient.client.start()
    await new Promise(resolve => setTimeout(resolve, 0))
    wiredClient.socket.onopen?.({})
    const send: AylaSend = async delivery => wiredClient.client.sendReply(
      replyInput(delivery, 'ayla-2'),
    )
    const pending = deliverSendText(() => send, args({ content: '一句\n二句' }))
    await new Promise(resolve => setTimeout(resolve, 0))
    wiredClient.deliver({
      v: 1, type: 'error', client_message_id: 'ayla-2',
      code: 'conversation_type_mismatch', detail: '不是私聊',
    })
    const result = await pending
    expect(result.stoppedAt).toBe(0)
    expect(result.sent).toEqual([])
    expect(result.error).toContain('conversation_type_mismatch')
  })

  it('reports unknown delivery when the receipt never arrives', async () => {
    const wiredClient = wired()
    wiredClient.client.start()
    await new Promise(resolve => setTimeout(resolve, 0))
    wiredClient.socket.onopen?.({})
    const send: AylaSend = async delivery => wiredClient.client.sendReply(
      replyInput(delivery, 'ayla-3'),
    )
    const result = await deliverSendText(() => send, args({ content: '一句' }))
    expect(result.stoppedAt).toBe(0)
    expect(result.error).toBe('投递状态未知')
  })

  it('sends the conversation type the conversation id implies', async () => {
    const wiredClient = wired()
    wiredClient.client.start()
    await new Promise(resolve => setTimeout(resolve, 0))
    wiredClient.socket.onopen?.({})
    const send: AylaSend = async delivery => wiredClient.client.sendReply(
      replyInput(delivery, 'ayla-4'),
    )
    const pending = deliverSendText(() => send, args({ conversation: 'ayla:group:42' }))
    await new Promise(resolve => setTimeout(resolve, 0))
    wiredClient.deliver({ v: 1, type: 'sent', client_message_id: 'ayla-4', message_id: 'm-6' })
    await pending
    const reply = wiredClient.sent.find(frame => frame.type === 'reply') as {
      conversation_id: string; conversation_type: string
    }
    expect(reply.conversation_id).toBe('42')
    expect(reply.conversation_type).toBe('group')
  })
})
describe('Ayla send_text sender resolution', () => {
  it('picks up a channel that was down when the tool was registered', async () => {
    let sender: AylaSend | undefined
    const tool = defineSendTextTool(() => sender)
    await expect(tool.execute(args(), exec)).resolves.toEqual({ sent: [], error: 'Ayla 通道未连接' })

    sender = async () => ({ messageId: 'm-1' })
    await expect(tool.execute(args(), exec)).resolves.toEqual({
      sent: [{ index: 0, text: '这个决定对呀', messageId: 'm-1' }],
    })
  })

  it('reports the channel as down again after it drops', async () => {
    let sender: AylaSend | undefined = async () => ({ messageId: 'm-1' })
    const tool = defineSendTextTool(() => sender)
    await expect(tool.execute(args(), exec)).resolves.toEqual({
      sent: [{ index: 0, text: '这个决定对呀', messageId: 'm-1' }],
    })
    sender = undefined
    await expect(tool.execute(args(), exec)).resolves.toEqual({ sent: [], error: 'Ayla 通道未连接' })
  })
})

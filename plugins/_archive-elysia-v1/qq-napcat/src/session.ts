/**
 * OneBot text session over an already open NapCat socket.
 * @module @elysia/qq-napcat/session
 */

import { randomUUID } from 'node:crypto'
import { OutboundDeliveryUnknown } from '@elysia/conscious-mind/outbound'
import type { OutboundDelivery, OutboundReceipt } from '@elysia/conscious-mind/outbound'
import { parseQqConversation } from './conversation.ts'
import type { QqInboundText } from './inbound.ts'
import type { QqNapcatSettings } from './config.ts'

/** Minimal socket the session can write to. */
export interface OneBotSocket {
  send(data: string): void
}

interface OneBotResponse {
  status?: string
  retcode?: number
  message?: string
  wording?: string
  data?: { message_id?: number | string }
  echo?: string
}

/**
 * Match echoes to API replies and turn message events into inbound text.
 */
export class OneBotSession {
  private socket: OneBotSocket | undefined
  private readonly pending = new Map<string, {
    resolve: (response: OneBotResponse) => void
    reject: (error: Error) => void
    timer: ReturnType<typeof setTimeout>
  }>()

  /** Inbound texts observed since the last take, in arrival order. */
  readonly inbound: QqInboundText[] = []

  /**
   * @param settings - QQ account and send timeout from Elysium.
   * @param onInbound - called for each accepted text message.
   */
  constructor(
    private readonly settings: QqNapcatSettings,
    private readonly onInbound: (message: QqInboundText) => void = () => {},
  ) {}

  /** Whether a socket is currently attached. */
  get connected(): boolean {
    return this.socket !== undefined
  }

  /** Attach the live socket. Detach the previous one. */
  attach(socket: OneBotSocket): void {
    this.detach()
    this.socket = socket
  }

  /** Drop the socket and fail every call still waiting. */
  detach(): void {
    this.socket = undefined
    for (const [echo, waiter] of this.pending) {
      clearTimeout(waiter.timer)
      waiter.reject(new Error('NapCat 连接已断开'))
      this.pending.delete(echo)
    }
  }

  /**
   * Feed one websocket text frame.
   * @param raw - JSON text from NapCat.
   * @param emit - when false, store the text but do not notify listeners. Used while scanning history.
   */
  receive(raw: string, emit = true): void {
    const event = JSON.parse(raw) as OneBotResponse & {
      post_type?: string
      message_type?: string
      message_id?: number | string
      user_id?: number | string
      group_id?: number | string
      self_id?: number | string
      sender?: { user_id?: number | string; nickname?: string; card?: string }
      message?: unknown
    }
    if (event.echo !== undefined && this.pending.has(event.echo)) {
      const waiter = this.pending.get(event.echo)
      if (waiter === undefined) return
      clearTimeout(waiter.timer)
      this.pending.delete(event.echo)
      waiter.resolve(event)
      return
    }
    const inbound = this.toInbound(event)
    if (inbound === undefined) return
    this.inbound.push(inbound)
    if (emit) this.onInbound(inbound)
  }

  /**
   * Ask NapCat for recent private messages and return the newest text from the other person.
   * @param userId - the friend's QQ id.
   * @returns that message, or undefined when the history has none.
   */
  async latestPrivateText(userId: string): Promise<QqInboundText | undefined> {
    const response = await this.call('get_friend_msg_history', {
      user_id: Number(userId),
      count: 20,
      reverseOrder: false,
    })
    const data = response.data as { messages?: unknown[] } | unknown[] | undefined
    const messages = Array.isArray(data) ? data : data?.messages ?? []
    const before = this.inbound.length
    for (const message of messages) {
      this.receive(JSON.stringify({ ...asRecord(message), post_type: 'message', message_type: 'private' }), false)
    }
    const found = this.inbound.slice(before)
    this.inbound.splice(before, found.length)
    return found.at(-1)
  }

  /**
   * Send one already-split text segment.
   * @param delivery - conversation, text, and optional quote.
   * @returns the OneBot message id.
   */
  async sendText(delivery: OutboundDelivery): Promise<OutboundReceipt> {
    const target = parseQqConversation(delivery.conversation)
    const message: { type: string; data: Record<string, string> }[] = []
    const replyTo = delivery.replyTo?.trim()
    if (replyTo !== undefined && replyTo.length > 0) {
      message.push({ type: 'reply', data: { id: replyTo } })
    }
    message.push({ type: 'text', data: { text: delivery.text } })
    const response = await this.call(
      target.kind === 'private' ? 'send_private_msg' : 'send_group_msg',
      target.kind === 'private'
        ? { user_id: Number(target.userId), message }
        : { group_id: Number(target.groupId), message },
    )
    const messageId = response.data?.message_id
    return messageId === undefined ? {} : { messageId: String(messageId) }
  }

  private async call(action: string, params: Record<string, unknown>): Promise<OneBotResponse> {
    const socket = this.socket
    if (socket === undefined) throw new Error('NapCat 未连接')
    const echo = randomUUID()
    const response = new Promise<OneBotResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(echo)
        reject(new OutboundDeliveryUnknown())
      }, this.settings.sendTimeoutMs)
      this.pending.set(echo, { resolve, reject, timer })
    })
    socket.send(JSON.stringify({ action, params, echo }))
    const result = await response
    if (isUnknownReceipt(result)) throw new OutboundDeliveryUnknown()
    if (result.status !== 'ok') {
      throw new Error(result.message || result.wording || `QQ 发送失败: ${action}`)
    }
    return result
  }

  private toInbound(event: {
    post_type?: string
    message_type?: string
    message_id?: number | string
    user_id?: number | string
    group_id?: number | string
    self_id?: number | string
    sender?: { user_id?: number | string; nickname?: string; card?: string }
    message?: unknown
  }): QqInboundText | undefined {
    if (event.post_type !== 'message') return undefined
    const senderId = String(event.sender?.user_id ?? event.user_id ?? '').trim()
    const selfId = String(event.self_id ?? this.settings.selfId).trim()
    if (senderId.length === 0 || senderId === selfId || senderId === this.settings.selfId) return undefined
    const text = plainText(event.message)
    if (text.trim().length === 0) return undefined
    if (event.message_type === 'group') {
      const groupId = String(event.group_id ?? '').trim()
      if (!/^[1-9][0-9]*$/u.test(groupId)) return undefined
      return {
        channel: 'qq',
        conversation: `qq:group:${groupId}`,
        target: { kind: 'group', groupId },
        messageId: String(event.message_id ?? ''),
        senderId,
        senderName: String(event.sender?.card || event.sender?.nickname || ''),
        text,
      }
    }
    if (event.message_type !== 'private') return undefined
    return {
      channel: 'qq',
      conversation: `qq:private:${senderId}`,
      target: { kind: 'private', userId: senderId },
      messageId: String(event.message_id ?? ''),
      senderId,
      senderName: String(event.sender?.nickname || ''),
      text,
    }
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
}

function plainText(message: unknown): string {
  if (typeof message === 'string') return message
  if (!Array.isArray(message)) return ''
  return message.flatMap((segment) => {
    if (typeof segment !== 'object' || segment === null || !('type' in segment)) return []
    if (segment.type !== 'text') return []
    const data = 'data' in segment ? segment.data : undefined
    if (typeof data !== 'object' || data === null || !('text' in data)) return []
    return [String(data.text ?? '')]
  }).join('')
}

function isUnknownReceipt(response: OneBotResponse): boolean {
  if (response.status === 'ok' || Number(response.retcode) !== 1200) return false
  const detail = `${response.message ?? ''} ${response.wording ?? ''}`
  return detail.includes('Timeout: NTEvent')
    && detail.includes('NodeIKernelMsgService/sendMsg')
}

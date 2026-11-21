/**
 * Feishu text send through the same app Elysium already configured.
 * @module @elysia/feishu-app/client
 */

import type { OutboundDelivery, OutboundReceipt } from '@elysia/conscious-mind/outbound'
import type { FeishuSettings } from './config.ts'
import { parseFeishuConversation } from './conversation.ts'
import { feishuInboundText, type FeishuInboundText } from './inbound.ts'

/** Bot identity returned by the Feishu app. */
export interface FeishuBotInfo {
  name: string
  openId: string
}

/**
 * Calls the Feishu Open API. The tenant token stays in this object.
 */
export class FeishuClient {
  private token = ''
  private tokenUntil = 0

  /**
   * @param settings - app id, secret, and API host from Elysium.
   * @param fetchImpl - HTTP implementation. Tests pass a fake.
   */
  constructor(
    readonly settings: FeishuSettings,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /**
   * Read the bot name and open_id. This does not open the event socket.
   * @returns the app's bot identity.
   */
  async identity(): Promise<FeishuBotInfo> {
    const data = await this.request('GET', '/open-apis/bot/v3/info', undefined, true)
    const nested = data.data
    const bot = (data.bot ?? (nested !== null && typeof nested === 'object' ? (nested as { bot?: unknown }).bot : undefined) ?? {}) as {
      app_name?: unknown
      open_id?: unknown
    }
    return { name: String(bot.app_name ?? this.settings.botName), openId: String(bot.open_id ?? '') }
  }

  /**
   * Send one already-split text segment.
   * @param delivery - conversation, text, and optional reply target.
   * @returns the Feishu message id when the API returned one.
   */
  /**
   * Read recent text in one chat, newest first. This uses HTTP and does not open the event socket.
   * @param chatId - Feishu chat_id.
   * @param selfOpenId - this app's open_id. Its own messages are dropped.
   * @returns user text messages.
   */
  async recentTexts(chatId: string, selfOpenId: string): Promise<FeishuInboundText[]> {
    const data = await this.request('GET', `/open-apis/im/v1/messages?container_id_type=chat&container_id=${encodeURIComponent(chatId)}&page_size=20&sort_type=ByCreateTimeDesc`, undefined, true)
    const nested = data.data
    const items = nested !== null && typeof nested === 'object' && Array.isArray((nested as { items?: unknown }).items)
      ? (nested as { items: Record<string, unknown>[] }).items
      : []
    const found: FeishuInboundText[] = []
    for (const item of items) {
      const sender = item.sender !== null && typeof item.sender === 'object' ? item.sender as { id?: unknown; sender_type?: unknown } : {}
      const body = item.body !== null && typeof item.body === 'object' ? item.body as { content?: unknown } : {}
      const inbound = feishuInboundText({
        sender: { sender_type: String(sender.sender_type ?? ''), sender_id: { open_id: String(sender.id ?? '') } },
        message: {
          message_id: String(item.message_id ?? ''),
          chat_id: String(item.chat_id ?? chatId),
          chat_type: 'p2p',
          message_type: String(item.msg_type ?? ''),
          content: String(body.content ?? ''),
        },
      }, selfOpenId)
      if (inbound !== undefined) found.push(inbound)
    }
    return found
  }

  async sendText(delivery: OutboundDelivery): Promise<OutboundReceipt> {
    const target = parseFeishuConversation(delivery.conversation)
    const content = JSON.stringify({ text: delivery.text })
    const replyTo = delivery.replyTo?.trim() ?? ''
    const data = replyTo.length > 0 && this.settings.replyToMessage
      ? await this.request('POST', `/open-apis/im/v1/messages/${encodeURIComponent(replyTo)}/reply`, { msg_type: 'text', content }, true)
      : await this.request('POST', target.kind === 'chat'
        ? '/open-apis/im/v1/messages?receive_id_type=chat_id'
        : '/open-apis/im/v1/messages?receive_id_type=open_id', {
        receive_id: target.kind === 'chat' ? target.chatId : target.openId,
        msg_type: 'text',
        content,
      }, true)
    const message = data.data !== null && typeof data.data === 'object' ? data.data as { message_id?: unknown } : {}
    const messageId = String(message.message_id ?? '')
    return messageId.length > 0 ? { messageId } : {}
  }

  private async accessToken(): Promise<string> {
    if (this.token.length > 0 && Date.now() < this.tokenUntil) return this.token
    const data = await this.request('POST', '/open-apis/auth/v3/tenant_access_token/internal', {
      app_id: this.settings.appId,
      app_secret: this.settings.appSecret,
    }, false)
    const token = String(data.tenant_access_token ?? '')
    if (token.length === 0) throw new Error('飞书没有返回 tenant_access_token')
    const expire = Number(data.expire ?? 7200)
    this.token = token
    this.tokenUntil = Date.now() + Math.max(60, (Number.isFinite(expire) ? expire : 7200) - 300) * 1000
    return token
  }

  private async request(method: 'GET' | 'POST', path: string, body: unknown, auth: boolean): Promise<Record<string, unknown>> {
    const headers: Record<string, string> = { 'content-type': 'application/json; charset=utf-8' }
    if (auth) headers.authorization = `Bearer ${await this.accessToken()}`
    const response = await this.fetchImpl(`${this.settings.apiBaseUrl}${path}`, {
      method,
      headers,
      ...body === undefined ? {} : { body: JSON.stringify(body) },
      signal: AbortSignal.timeout(20_000),
    })
    const data = await response.json() as Record<string, unknown>
    const code = Number(data.code ?? 0)
    if (!response.ok || code !== 0) {
      throw new Error(`飞书接口失败: ${Number.isFinite(code) && code !== 0 ? code : response.status} ${String(data.msg ?? '')}`.trim())
    }
    return data
  }
}

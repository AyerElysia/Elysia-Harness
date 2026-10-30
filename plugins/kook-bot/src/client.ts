/**
 * KOOK text send through the same bot token Elysium already configured.
 * @module @elysia/kook-bot/client
 */

import type { OutboundDelivery, OutboundReceipt } from '@elysia/conscious-mind/outbound'
import { KOOK_API_BASE, type KookSettings } from './config.ts'
import { parseKookConversation } from './conversation.ts'
import { kookDirectMessageEvent, kookInboundText, type KookInboundText } from './inbound.ts'

/** One KOOK direct-message window. */
export interface KookDirectChat {
  code: string
  userId: string
  username: string
  unread: number
}

/** Bot identity returned by KOOK. */
export interface KookBotInfo {
  id: string
  name: string
}

/**
 * Calls the KOOK REST API. The bot token stays in the Authorization header.
 */
export class KookClient {
  /**
   * @param settings - token and send flags from Elysium.
   * @param fetchImpl - HTTP implementation. Tests pass a fake.
   */
  constructor(
    readonly settings: KookSettings,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /**
   * Read the bot id and username. This does not open the gateway socket.
   * @returns the bot identity.
   */
  async identity(): Promise<KookBotInfo> {
    const data = await this.request('GET', '/user/me')
    return {
      id: String(data.id ?? ''),
      name: String(data.username ?? this.settings.botName),
    }
  }

  /**
   * Read the gateway URL. This does not open the socket.
   * @returns the WebSocket address KOOK issued for this token.
   */
  async gatewayUrl(): Promise<string> {
    const data = await this.request('GET', '/gateway/index?compress=0')
    const url = String(data.url ?? '')
    if (url.length === 0) throw new Error('KOOK Gateway 返回空地址')
    return url
  }

  /**
   * List direct-message windows.
   * @returns chat code, the other user, and the unread count.
   */
  async directChats(): Promise<KookDirectChat[]> {
    const data = await this.request('GET', '/user-chat/list')
    return itemsOf(data).map((item) => {
      const info = item.target_info !== null && typeof item.target_info === 'object'
        ? item.target_info as { id?: unknown; username?: unknown }
        : {}
      return {
        code: String(item.code ?? ''),
        userId: String(item.target_id ?? info.id ?? ''),
        username: String(info.username ?? ''),
        unread: Number(item.unread_count ?? 0),
      }
    }).filter(chat => chat.code.length > 0 && /^[1-9][0-9]*$/u.test(chat.userId))
  }

  /**
   * Newest user text in one direct chat.
   * @param userId - the other person.
   * @param selfId - this bot's user id.
   * @returns that text, or undefined when the chat or a user message is absent.
   */
  async latestDirectText(userId: string, selfId: string): Promise<KookInboundText | undefined> {
    const chat = (await this.directChats()).find(item => item.userId === userId)
    if (chat === undefined) return undefined
    const data = await this.request('GET', `/direct-message/list?chat_code=${encodeURIComponent(chat.code)}&page_size=20`)
    const messages = itemsOf(data).slice().sort((left, right) => Number(right.create_at ?? 0) - Number(left.create_at ?? 0))
    for (const message of messages) {
      const inbound = kookInboundText(kookDirectMessageEvent(message, userId), selfId)
      if (inbound !== undefined) return inbound
    }
    return undefined
  }

  /** Download one platform image without forwarding the bot credential to its URL. */
  async downloadImage(url: string, maxBytes: number): Promise<{
    mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
    data: string
  }> {
    const target = new URL(url)
    if (target.protocol !== 'https:') throw new Error('KOOK 图片地址必须使用 HTTPS')
    const response = await this.fetchImpl(target, { signal: AbortSignal.timeout(20_000) })
    if (!response.ok) throw new Error(`KOOK 图片下载失败: HTTP ${response.status}`)
    const declaredLength = Number(response.headers.get('content-length') ?? 0)
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      throw new Error(`KOOK 图片超过 ${maxBytes} 字节上限`)
    }
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.byteLength === 0) throw new Error('KOOK 图片内容为空')
    if (bytes.byteLength > maxBytes) throw new Error(`KOOK 图片超过 ${maxBytes} 字节上限`)
    const mediaType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
    if (mediaType !== 'image/png' && mediaType !== 'image/jpeg' && mediaType !== 'image/webp' && mediaType !== 'image/gif') {
      throw new Error(`KOOK 图片类型不受支持: ${mediaType ?? '未声明'}`)
    }
    return { mediaType, data: Buffer.from(bytes).toString('base64') }
  }

  async sendText(delivery: OutboundDelivery): Promise<OutboundReceipt> {
    const target = parseKookConversation(delivery.conversation)
    const body: Record<string, unknown> = {
      target_id: target.kind === 'direct' ? target.userId : target.channelId,
      content: delivery.text,
      type: this.settings.useKmarkdown ? 9 : 1,
    }
    const quote = delivery.replyTo?.trim() ?? ''
    if (quote.length > 0 && this.settings.replyWithQuote) body.quote = quote
    const data = await this.request('POST', target.kind === 'direct' ? '/direct-message/create' : '/message/create', body)
    const messageId = String(data.msg_id ?? '')
    return messageId.length > 0 ? { messageId } : {}
  }

  private async request(method: 'GET' | 'POST', path: string, body?: unknown): Promise<Record<string, unknown>> {
    const response = await this.fetchImpl(`${KOOK_API_BASE}${path}`, {
      method,
      headers: {
        authorization: `Bot ${this.settings.token}`,
        'content-type': 'application/json; charset=utf-8',
      },
      ...body === undefined ? {} : { body: JSON.stringify(body) },
      signal: AbortSignal.timeout(20_000),
    })
    const payload = await response.json() as { code?: unknown; message?: unknown; data?: unknown }
    if (!response.ok || Number(payload.code ?? 0) !== 0) {
      throw new Error(`KOOK 接口失败: ${String(payload.code ?? response.status)} ${String(payload.message ?? '')}`.trim())
    }
    return payload.data !== null && typeof payload.data === 'object' ? payload.data as Record<string, unknown> : {}
  }
}

function itemsOf(data: Record<string, unknown>): Record<string, unknown>[] {
  const items = data.items
  if (!Array.isArray(items)) return []
  return items.filter((item): item is Record<string, unknown> => item !== null && typeof item === 'object')
}

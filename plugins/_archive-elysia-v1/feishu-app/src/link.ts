/**
 * Feishu long connection. One app can keep one event socket; a second
 * connection replaces the first.
 * @module @elysia/feishu-app/link
 */

import { createRequire } from 'node:module'
import { join } from 'node:path'
import type { FeishuClient } from './client.ts'
import { ELYSIA_ROOT } from './config.ts'
import type { FeishuSettings } from './config.ts'
import { feishuInboundText, type FeishuInboundText } from './inbound.ts'

/**
 * The SDK installed beside Elysium, outside the harness tree.
 * `FEISHU_SDK` overrides it; otherwise it resolves under `ELYSIA_ROOT`.
 */
export const FEISHU_SDK = process.env.FEISHU_SDK
  ?? join(ELYSIA_ROOT, 'Data/feishu-sdk/node_modules/@larksuiteoapi/node-sdk')

interface LarkModule {
  LoggerLevel: { warn: unknown }
  EventDispatcher: new (params: Record<string, unknown>) => {
    register(handles: Record<string, (data: unknown) => Promise<void>>): unknown
  }
  WSClient: new (params: {
    appId: string
    appSecret: string
    domain: string
    loggerLevel: unknown
    autoReconnect: boolean
    source: string
    onReady?: () => void
    onError?: (error: Error) => void
  }) => {
    start(params: { eventDispatcher: unknown }): Promise<void>
    close(params?: { force?: boolean }): void
  }
}

const require = createRequire(import.meta.url)

function loadLark(): LarkModule {
  return require(FEISHU_SDK) as LarkModule
}

/** A connected Feishu event socket. */
export class FeishuLink {
  private socket: { close(params?: { force?: boolean }): void } | undefined
  private connectedWaiters: (() => void)[] = []
  connected = false
  selfOpenId = ''

  /**
   * @param client - REST client used to learn this app's open_id.
   * @param settings - app credentials from Elysium.
   * @param onInbound - notified for each accepted text message.
   */
  constructor(
    private readonly client: FeishuClient,
    private readonly settings: FeishuSettings,
    private readonly onInbound: (message: FeishuInboundText) => void = () => {},
  ) {}

  /** Resolves when the long connection is ready, or rejects when the wait expires. */
  waitForConnection(timeoutMs: number): Promise<void> {
    if (this.connected) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.connectedWaiters = this.connectedWaiters.filter(waiter => waiter !== resolveOnce)
        reject(new Error('等待飞书长连接超时'))
      }, timeoutMs)
      const resolveOnce = () => {
        clearTimeout(timer)
        resolve()
      }
      this.connectedWaiters.push(resolveOnce)
    })
  }

  /** Open the long connection. */
  async start(): Promise<void> {
    if (this.selfOpenId.length === 0) this.selfOpenId = (await this.client.identity()).openId
    const lark = loadLark()
    await new Promise<void>((resolve, reject) => {
      let settled = false
      const finish = (error?: Error) => {
        if (settled) return
        settled = true
        if (error === undefined) resolve()
        else reject(error)
      }
      const timer = setTimeout(() => finish(new Error('等待飞书长连接超时')), 20_000)
      const socket = new lark.WSClient({
        appId: this.settings.appId,
        appSecret: this.settings.appSecret,
        domain: this.settings.apiBaseUrl,
        loggerLevel: lark.LoggerLevel.warn,
        autoReconnect: true,
        source: 'elysia-feishu-app',
        onReady: () => {
          clearTimeout(timer)
          this.connected = true
          this.socket = socket
          for (const waiter of this.connectedWaiters) waiter()
          this.connectedWaiters = []
          finish()
        },
        onError: (error) => {
          clearTimeout(timer)
          if (!this.connected) finish(error)
        },
      })
      const dispatcher = new lark.EventDispatcher({}).register({
        'im.message.receive_v1': async (data) => {
          const inbound = feishuInboundText(data, this.selfOpenId)
          if (inbound !== undefined) this.onInbound(inbound)
        },
        'im.message.reaction.created_v1': async () => {},
        'im.message.reaction.deleted_v1': async () => {},
      })
      void socket.start({ eventDispatcher: dispatcher }).catch((error) => {
        clearTimeout(timer)
        finish(error instanceof Error ? error : new Error(String(error)))
      })
    })
  }

  /** Close the long connection. */
  stop(): void {
    this.socket?.close({ force: true })
    this.socket = undefined
    this.connected = false
  }
}

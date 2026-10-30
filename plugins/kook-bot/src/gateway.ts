/**
 * KOOK gateway socket. One token can keep one gateway; a second connection
 * replaces the first.
 * @module @elysia/kook-bot/gateway
 */

import { createRequire } from 'node:module'
import type { KookClient } from './client.ts'
import { handleKookFrame, type KookSocketState } from './frame.ts'
import { kookInboundEvent, type KookInboundEvent } from './inbound.ts'

interface SocketLike {
  send(data: string): void
  close(): void
  on(event: 'message', listener: (data: unknown) => void): void
  on(event: 'close', listener: () => void): void
  once(event: 'open' | 'error', listener: (error?: Error) => void): void
}

interface WsModule {
  WebSocket: new (url: string) => SocketLike
}

const require = createRequire(import.meta.url)

async function loadWs(): Promise<WsModule> {
  // `ws` is a declared dependency of this package; never resolve it through a
  // hardcoded .pnpm store path, which breaks whenever the checkout layout moves.
  return require('ws') as WsModule
}

/** A connected KOOK gateway. */
export class KookGateway {
  private socket: SocketLike | undefined
  private stopped = false
  private heartbeat: ReturnType<typeof setInterval> | undefined
  private readonly state: KookSocketState = { sn: 0, sessionId: '' }
  private connectedWaiters: (() => void)[] = []
  private inboundChain: Promise<void> = Promise.resolve()
  selfId = ''

  /**
   * @param client - REST client that issues the gateway URL and the bot id.
   * @param onInbound - awaited in event order for download and attachment admission.
   */
  constructor(
    private readonly client: KookClient,
    private readonly onInbound: (message: KookInboundEvent) => void | Promise<void> = () => {},
  ) {}

  get connected(): boolean {
    return this.socket !== undefined
  }

  /** Resolves when HELLO succeeds, or rejects when the wait expires. */
  waitForConnection(timeoutMs: number): Promise<void> {
    if (this.connected) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.connectedWaiters = this.connectedWaiters.filter(waiter => waiter !== resolveOnce)
        reject(new Error('等待 KOOK Gateway 超时'))
      }, timeoutMs)
      const resolveOnce = () => {
        clearTimeout(timer)
        resolve()
      }
      this.connectedWaiters.push(resolveOnce)
    })
  }

  /** Open the gateway and keep reconnecting until {@link stop}. */
  async start(): Promise<void> {
    this.stopped = false
    if (this.selfId.length === 0) this.selfId = (await this.client.identity()).id
    await this.connect()
  }

  /** Close the socket and stop reconnecting. */
  stop(): void {
    this.stopped = true
    this.clearHeartbeat()
    this.socket?.close()
    this.socket = undefined
  }

  private async connect(): Promise<void> {
    const url = await this.client.gatewayUrl()
    const { WebSocket } = await loadWs()
    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(url)
      let opened = false
      const timer = setTimeout(() => {
        socket.close()
        if (!opened) reject(new Error('等待 KOOK Gateway 超时'))
      }, 15_000)
      socket.once('error', error => {
        if (!opened) {
          clearTimeout(timer)
          reject(error ?? new Error('KOOK Gateway 连接失败'))
        }
      })
      socket.on('close', () => {
        if (this.socket === socket) {
          this.socket = undefined
          this.clearHeartbeat()
          if (!this.stopped) {
            setTimeout(() => { void this.connect().catch(() => {}) }, 2_000)
          }
        }
      })
      socket.on('message', data => {
        let frame: unknown
        try {
          frame = JSON.parse(String(data))
        } catch {
          return
        }
        let action
        try {
          action = handleKookFrame(frame, this.state)
        } catch (error) {
          if (!opened) {
            clearTimeout(timer)
            reject(error instanceof Error ? error : new Error(String(error)))
          }
          return
        }
        if (action.type === 'hello' || action.type === 'resume') {
          opened = true
          clearTimeout(timer)
          this.socket = socket
          this.armHeartbeat(socket)
          for (const waiter of this.connectedWaiters) waiter()
          this.connectedWaiters = []
          resolve()
        } else if (action.type === 'event') {
          const inbound = kookInboundEvent(action.event, this.selfId)
          if (inbound !== undefined) {
            this.inboundChain = this.inboundChain
              .then(() => this.onInbound(inbound))
              .catch((error: unknown) => {
                const reason = error instanceof Error ? error.message : String(error)
                process.stderr.write(`KOOK 消息 ${inbound.messageId} 处理失败: ${reason}\n`)
              })
          }
        } else if (action.type === 'reconnect') {
          socket.close()
        }
      })
    })
  }

  private armHeartbeat(socket: SocketLike): void {
    this.clearHeartbeat()
    this.heartbeat = setInterval(() => {
      try {
        socket.send(JSON.stringify({ s: 2, sn: this.state.sn }))
      } catch {
        socket.close()
      }
    }, 30_000)
  }

  private clearHeartbeat(): void {
    if (this.heartbeat !== undefined) clearInterval(this.heartbeat)
    this.heartbeat = undefined
  }
}

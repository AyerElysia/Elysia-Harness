/**
 * Hold the NapCat WebSocket described by Elysium's adapter config.
 * @module @elysia/qq-napcat/link
 */

import { createServer, type IncomingMessage, type Server } from 'node:http'
import { createRequire } from 'node:module'
import type { QqNapcatSettings } from './config.ts'
import { OneBotSession, type OneBotSocket } from './session.ts'
import type { QqInboundText } from './inbound.ts'

interface SocketLike {
  send(data: string): void
  close(code?: number, reason?: string): void
  on(event: 'message', listener: (data: unknown) => void): void
  on(event: 'close', listener: () => void): void
}

interface ServerLike {
  on(event: 'connection', listener: (socket: SocketLike, request: IncomingMessage) => void): void
  close(): void
}

interface WsModule {
  WebSocket: new (url: string, options?: { headers?: Record<string, string> }) => SocketLike & {
    once(event: 'open' | 'error', listener: (error?: Error) => void): void
  }
  WebSocketServer: new (options: { server: Server }) => ServerLike
}

const require = createRequire(import.meta.url)

async function loadWs(): Promise<WsModule> {
  // `ws` is a declared dependency of this package; never resolve it through a
  // hardcoded .pnpm store path, which breaks whenever the checkout layout moves.
  return require('ws') as WsModule
}

/** A connected NapCat session plus the listening socket, when this side is the server. */
export class NapcatLink {
  readonly session: OneBotSession
  private http: Server | undefined
  private sockets: ServerLike | undefined
  private active: SocketLike | undefined
  private connectedWaiters: (() => void)[] = []

  /**
   * @param settings - account, mode, and timeout.
   * @param onInbound - notified for each accepted text message.
   */
  constructor(
    readonly settings: QqNapcatSettings,
    onInbound: (message: QqInboundText) => void = () => {},
  ) {
    this.session = new OneBotSession(settings, onInbound)
  }

  /** Resolves when NapCat's socket is attached, or rejects when the wait expires. */
  waitForConnection(timeoutMs: number): Promise<void> {
    if (this.session.connected) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.connectedWaiters = this.connectedWaiters.filter(waiter => waiter !== resolveOnce)
        reject(new Error('等待 NapCat 连接超时'))
      }, timeoutMs)
      const resolveOnce = () => {
        clearTimeout(timer)
        resolve()
      }
      this.connectedWaiters.push(resolveOnce)
    })
  }

  /** Open the reverse listener or the direct client. Resolves once the socket is listening or connected. */
  async start(): Promise<void> {
    if (this.settings.mode === 'direct') {
      await this.connectDirect()
      return
    }
    await this.listenReverse()
  }

  /** Close the socket and stop listening. */
  async stop(): Promise<void> {
    this.active?.close()
    this.active = undefined
    this.session.detach()
    this.sockets?.close()
    this.sockets = undefined
    if (this.http !== undefined) {
      const http = this.http
      this.http = undefined
      await new Promise<void>((resolve, reject) => {
        http.close((error) => {
          const code = error !== undefined && 'code' in error ? String(error.code) : ''
          if (error !== undefined && code !== 'ERR_SERVER_NOT_RUNNING') reject(error)
          else resolve()
        })
      })
    }
  }

  private async listenReverse(): Promise<void> {
    const { WebSocketServer } = await loadWs()
    const http = createServer()
    const sockets = new WebSocketServer({ server: http })
    this.http = http
    this.sockets = sockets
    sockets.on('connection', (socket, request) => {
      if (!authorized(request.headers.authorization, this.settings.accessToken)) {
        socket.close(4401, 'Unauthorized')
        return
      }
      this.bind(socket)
    })
    const host = this.settings.host === 'localhost' ? '127.0.0.1' : this.settings.host
    await new Promise<void>((resolve, reject) => {
      http.once('error', reject)
      http.listen(this.settings.port, host, () => resolve())
    })
  }

  private async connectDirect(): Promise<void> {
    const { WebSocket } = await loadWs()
    const socket = new WebSocket(`ws://${this.settings.host}:${this.settings.port}`, {
      ...this.settings.accessToken.length === 0
        ? {}
        : { headers: { Authorization: `Bearer ${this.settings.accessToken}` } },
    })
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve())
      socket.once('error', error => reject(error ?? new Error('NapCat 连接失败')))
    })
    this.bind(socket)
  }

  private bind(socket: SocketLike): void {
    this.active?.close()
    this.active = socket
    const writer: OneBotSocket = {
      send: (data) => { socket.send(data) },
    }
    this.session.attach(writer)
    const waiters = this.connectedWaiters
    this.connectedWaiters = []
    for (const waiter of waiters) waiter()
    socket.on('message', (data) => {
      this.session.receive(String(data))
    })
    socket.on('close', () => {
      if (this.active === socket) {
        this.active = undefined
        this.session.detach()
      }
    })
  }
}

function authorized(header: string | undefined, token: string): boolean {
  if (token.length === 0) return true
  return header === `Bearer ${token}`
}

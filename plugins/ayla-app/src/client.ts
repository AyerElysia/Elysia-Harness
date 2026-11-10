/**
 * The one WebSocket the plugin dials into Ayla.
 *
 * DSH connects out; Ayla never needs to know where DSH is (REQUIREMENTS.zh.md
 * §2 C2). The socket carries frames from protocol.ts, keeps itself alive with a
 * ping every 30 seconds, reconnects with jittered exponential backoff, and
 * resumes from the last acked sequence so a dropped connection neither loses
 * nor repeats a message.
 *
 * Two rules shape the code. Reconnect logging happens on state changes only,
 * because an unreachable backend would otherwise write a line every second
 * forever. And a disconnect settles every outstanding reply as delivery
 * unknown: a model turn waiting on a socket that will never answer must fail
 * visibly instead of hanging.
 * @module @elysia/ayla-app/client
 */

import { AylaAuthError } from './auth.ts'
import {
  buildAck, buildPing, buildPong, buildReply, buildResume, parseFrame,
} from './protocol.ts'
import type { ErrorFrame, InboundFrame, ReplyInput, SentFrame } from './protocol.ts'
import { AylaReplyRejected, OutboundDeliveryUnknown } from './outbound.ts'

/** Bridge path on the Ayla backend. */
export const BRIDGE_PATH = '/ws/elysia-bridge/'

/** Keepalive period. */
export const HEARTBEAT_INTERVAL_MS = 30_000

/** Unanswered pings tolerated before the connection is treated as dead. */
export const MAX_HEARTBEAT_MISSES = 2

/** First reconnect delay; each failure doubles it up to {@link RECONNECT_MAX_MS}. */
export const RECONNECT_INITIAL_MS = 1_000

/** Longest reconnect delay. */
export const RECONNECT_MAX_MS = 60_000

/** How long one reply waits for its `sent` or `error` frame. */
export const REPLY_TIMEOUT_MS = 30_000

/** The subset of the WHATWG WebSocket this module drives. */
export interface AylaSocket {
  send(data: string): void
  close(code?: number, reason?: string): void
  onopen: ((event: unknown) => void) | null
  onmessage: ((event: { data: unknown }) => void) | null
  onclose: ((event: { code?: number; reason?: string }) => void) | null
  onerror: ((event: unknown) => void) | null
}

/** Opens one socket for a URL. Node's global WebSocket satisfies this. */
export type AylaSocketFactory = (url: string) => AylaSocket

/**
 * Token source for one connection attempt.
 *
 * Declared as a port so a test can supply tokens without an HTTP backend; the
 * real `AylaAuth` satisfies it.
 */
export interface AylaTokenSource {
  /** Current access token, logging in when none is held. */
  accessToken(): Promise<string>
  /** Rotate the refresh token once. */
  refreshOnce(): Promise<string>
}

/** Named logger; `ctx.logger('ayla-app')` satisfies it. */
export interface AylaClientLogger {
  info(message: string): void
  warn(message: string): void
  error(message: string): void
}

/** Connection states reported to the log. */
export type AylaClientState = 'idle' | 'connecting' | 'connected' | 'disconnected' | 'stopped' | 'failed'

/** Construction inputs for {@link AylaClient}. */
export interface AylaClientOptions {
  /** Backend base URL; the socket URL is derived from it. */
  baseUrl: URL
  /** Account tokens; the client asks for an access token per attempt. */
  auth: AylaTokenSource
  /** Delivers one inbound frame. Resolving true acks it; false leaves it for redelivery. */
  onInbound(frame: InboundFrame): Promise<boolean>
  /** Named logger. */
  logger: AylaClientLogger
  /** Socket constructor; defaults to the Node global. */
  createSocket?: AylaSocketFactory
  /** Reply settle deadline; defaults to {@link REPLY_TIMEOUT_MS}. */
  replyTimeoutMs?: number
  /** Jitter source in [0, 1); defaults to Math.random. */
  random?: () => number
}

/** One reply awaiting its settlement frame. */
interface PendingReply {
  resolve(receipt: { messageId: string }): void
  reject(error: Error): void
  timer: ReturnType<typeof setTimeout>
}

/**
 * Derive the bridge URL for one access token.
 * @param baseUrl - configured backend URL.
 * @param access - current access token.
 * @returns the ws/wss URL including the token query parameter.
 */
export function bridgeUrl(baseUrl: URL, access: string): string {
  const url = new URL(baseUrl.toString())
  url.protocol = baseUrl.protocol === 'https:' ? 'wss:' : 'ws:'
  const prefix = baseUrl.pathname.replace(/\/+$/u, '')
  url.pathname = prefix + BRIDGE_PATH
  url.search = new URLSearchParams({ token: access }).toString()
  url.hash = ''
  return url.toString()
}

/** Close codes Ayla uses to refuse an account. */
const AUTH_CLOSE_CODES = new Set([4401, 4403])

/**
 * One reconnecting Ayla bridge connection.
 *
 * `start()` and `stop()` are idempotent; a stopped client settles its pending
 * replies and never reconnects on its own.
 */
export class AylaClient {
  private socket: AylaSocket | undefined
  private stopped = true
  private state: AylaClientState = 'idle'
  private reported: AylaClientState | undefined
  private attempt = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined
  private heartbeatMisses = 0
  private lastAckedSeq = 0
  private authRetried = false
  private authCloses = 0
  private inboundChain: Promise<void> = Promise.resolve()
  private readonly pending = new Map<string, PendingReply>()
  private readonly createSocket: AylaSocketFactory
  private readonly replyTimeoutMs: number
  private readonly random: () => number

  constructor(private readonly options: AylaClientOptions) {
    this.createSocket = options.createSocket ?? ((url: string) => new WebSocket(url) as unknown as AylaSocket)
    this.replyTimeoutMs = options.replyTimeoutMs ?? REPLY_TIMEOUT_MS
    this.random = options.random ?? Math.random
  }

  /** Current state, for diagnostics and tests. */
  get currentState(): AylaClientState {
    return this.state
  }

  /** Whether a socket is open right now. */
  get connected(): boolean {
    return this.socket !== undefined
  }

  /** Highest sequence number already acked in this process. */
  get ackedSeq(): number {
    return this.lastAckedSeq
  }

  /** Start dialing. A repeat call is a no-op. */
  start(): void {
    if (!this.stopped) return
    this.stopped = false
    this.attempt = 0
    void this.connect()
  }

  /** Close the socket, settle every pending reply, and stop reconnecting. */
  stop(): void {
    this.stopped = true
    this.clearReconnect()
    this.clearHeartbeat()
    this.settleAll(new OutboundDeliveryUnknown('Ayla 通道已关闭'))
    const socket = this.socket
    this.socket = undefined
    this.state = 'stopped'
    // A client that never connected has no state change to report.
    if (this.reported !== undefined) {
      this.reported = 'stopped'
      this.options.logger.info('Ayla 通道状态: stopped')
    }
    socket?.close(1000, 'stopped')
  }

  /**
   * Send one reply and wait for its settlement frame.
   * @param input - conversation, body, and quote target.
   * @returns the stored Ayla message id.
   * @throws OutboundDeliveryUnknown when the socket is gone, the frame times out, or the connection drops first.
   * @throws AylaReplyRejected when Ayla answers with an `error` frame.
   */
  async sendReply(input: ReplyInput): Promise<{ messageId: string }> {
    const socket = this.socket
    if (socket === undefined) throw new OutboundDeliveryUnknown('Ayla 通道未连接')
    const frame = buildReply(input)
    const receipt = await new Promise<{ messageId: string }>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(frame.client_message_id)
        reject(new OutboundDeliveryUnknown('等待 Ayla 回执超时'))
      }, this.replyTimeoutMs)
      this.pending.set(frame.client_message_id, { resolve, reject, timer })
      try {
        socket.send(JSON.stringify(frame))
      } catch (error) {
        // A socket that cannot accept the frame never accepted the message.
        this.pending.delete(frame.client_message_id)
        clearTimeout(timer)
        reject(new OutboundDeliveryUnknown(error instanceof Error ? error.message : 'Ayla 通道写入失败'))
      }
    })
    return receipt
  }

  /** Ack one handled inbound sequence number. */
  ack(seq: number): void {
    if (seq <= this.lastAckedSeq) return
    const socket = this.socket
    if (socket === undefined) return
    try {
      socket.send(JSON.stringify(buildAck(seq)))
      this.lastAckedSeq = seq
    } catch (error) {
      this.options.logger.warn('Ayla ack 发送失败: ' + (error instanceof Error ? error.message : String(error)))
    }
  }

  private async connect(): Promise<void> {
    if (this.stopped) return
    this.setState('connecting')
    let url: string
    try {
      url = await this.openUrl()
    } catch (error) {
      await this.handleConnectFailure(error, undefined)
      return
    }
    if (this.stopped) return
    let socket: AylaSocket
    try {
      socket = this.createSocket(url)
    } catch (error) {
      await this.handleConnectFailure(error, undefined)
      return
    }
    socket.onopen = () => {
      if (this.socket !== socket) return
      this.attempt = 0
      this.authRetried = false
      this.heartbeatMisses = 0
      this.setState('connected')
      this.armHeartbeat(socket)
      // Resume from the last ack so Ayla redelivers only what is missing.
      this.write(socket, buildResume(this.lastAckedSeq))
    }
    socket.onmessage = event => {
      if (this.socket !== socket) return
      // A frame proves the account was accepted, so a later refusal starts
      // counting from zero rather than inheriting an older one.
      this.authCloses = 0
      this.receive(event.data)
    }
    socket.onerror = () => {
      // The close event carries the outcome; an error alone settles nothing.
    }
    socket.onclose = event => {
      if (this.socket !== socket) return
      this.socket = undefined
      this.clearHeartbeat()
      this.settleAll(new OutboundDeliveryUnknown('Ayla 连接已断开'))
      void this.handleClose(event?.code)
    }
    this.socket = socket
  }

  /** Resolve the socket URL, refreshing once if the token is refused. */
  private async openUrl(): Promise<string> {
    try {
      return bridgeUrl(this.options.baseUrl, await this.options.auth.accessToken())
    } catch (error) {
      if (!(error instanceof AylaAuthError) || this.authRetried) throw error
      this.authRetried = true
      return bridgeUrl(this.options.baseUrl, await this.options.auth.refreshOnce())
    }
  }

  private async handleConnectFailure(error: unknown, closeCode: number | undefined): Promise<void> {
    if (this.stopped) return
    if (error instanceof AylaAuthError || (closeCode !== undefined && AUTH_CLOSE_CODES.has(closeCode))) {
      if (!this.authRetried) {
        this.authRetried = true
        try {
          await this.options.auth.refreshOnce()
        } catch (refreshError) {
          this.fail('Ayla 鉴权失败且刷新令牌无效: ' + describe(refreshError))
          return
        }
        this.setState('disconnected')
        this.scheduleReconnect(0)
        return
      }
      this.fail('Ayla 鉴权失败: ' + (error === undefined ? '账号被拒绝' : describe(error)))
      return
    }
    this.setState('disconnected', describe(error))
    this.scheduleReconnect()
  }

  private async handleClose(closeCode: number | undefined): Promise<void> {
    if (this.stopped) return
    if (closeCode !== undefined && AUTH_CLOSE_CODES.has(closeCode)) {
      // Ayla closes 4401/4403 when the account is not an enabled Elysia
      // profile. A refresh cannot change that, so a second refusal is final:
      // retrying would rotate the token forever against a fixed answer.
      this.authCloses++
      if (this.authCloses > 1) {
        this.fail('Ayla 拒绝该账号连接 (close ' + String(closeCode) + ')')
        return
      }
      await this.handleConnectFailure(undefined, closeCode)
      return
    }
    this.setState('disconnected', closeCode === undefined ? undefined : 'close ' + String(closeCode))
    this.scheduleReconnect()
  }

  /** Report an unrecoverable condition once and stop. */
  private fail(reason: string): void {
    this.stopped = true
    this.clearReconnect()
    this.settleAll(new OutboundDeliveryUnknown(reason))
    this.setState('failed', reason)
  }

  private scheduleReconnect(delayMs?: number): void {
    if (this.stopped || this.reconnectTimer !== undefined) return
    const base = delayMs ?? Math.min(RECONNECT_INITIAL_MS * 2 ** this.attempt, RECONNECT_MAX_MS)
    this.attempt++
    // Jitter keeps several hosts from reconnecting in lockstep; the cap is
    // applied after jitter so a lucky draw never exceeds the ceiling.
    const jittered = Math.min(Math.round(base * (0.5 + this.random() * 0.5)), RECONNECT_MAX_MS)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined
      void this.connect()
    }, jittered)
  }

  private clearReconnect(): void {
    if (this.reconnectTimer === undefined) return
    clearTimeout(this.reconnectTimer)
    this.reconnectTimer = undefined
  }

  /**
   * Probe the peer every {@link HEARTBEAT_INTERVAL_MS}.
   *
   * A round counts as missed only when its ping went unanswered. After
   * {@link MAX_HEARTBEAT_MISSES} such rounds the socket is closed and the
   * reconnect path takes over, because a half-open TCP connection can otherwise
   * look healthy forever while nothing is delivered.
   */
  private armHeartbeat(socket: AylaSocket): void {
    this.clearHeartbeat()
    this.heartbeatTimer = setInterval(() => {
      if (this.socket !== socket) return
      if (this.heartbeatMisses >= MAX_HEARTBEAT_MISSES) {
        this.options.logger.warn('Ayla 心跳两轮无响应，断开重连')
        socket.close(4000, 'heartbeat')
        return
      }
      this.heartbeatMisses++
      this.write(socket, buildPing())
    }, HEARTBEAT_INTERVAL_MS)
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer === undefined) return
    clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = undefined
    this.heartbeatMisses = 0
  }

  private write(socket: AylaSocket, frame: object): void {
    try {
      socket.send(JSON.stringify(frame))
    } catch (error) {
      this.options.logger.warn('Ayla 帧发送失败: ' + describe(error))
    }
  }

  private receive(raw: unknown): void {
    if (typeof raw !== 'string') return
    const frame = parseFrame(raw)
    if (frame === undefined) {
      this.options.logger.warn('Ayla 收到无法解析的帧，已忽略')
      return
    }
    switch (frame.type) {
      case 'inbound':
        this.inboundChain = this.inboundChain
          .then(() => this.deliver(frame))
          .catch((error: unknown) => {
            this.options.logger.error('Ayla 入站处理失败: ' + describe(error))
          })
        return
      case 'pong':
        this.heartbeatMisses = 0
        return
      case 'ping': {
        const socket = this.socket
        if (socket !== undefined) this.write(socket, buildPong())
        return
      }
      case 'sent':
        this.settleSent(frame)
        return
      case 'error':
        this.settleError(frame)
        return
      default:
        return
    }
  }

  private async deliver(frame: InboundFrame): Promise<void> {
    let ack: boolean
    try {
      ack = await this.options.onInbound(frame)
    } catch (error) {
      // An undeliverable message is not acked, so Ayla redelivers it.
      this.options.logger.error('Ayla 消息 ' + frame.message.id + ' 不可投递: ' + describe(error))
      return
    }
    if (ack) this.ack(frame.seq)
  }

  private settleSent(frame: SentFrame): void {
    const pending = this.pending.get(frame.client_message_id)
    if (pending === undefined) return
    this.pending.delete(frame.client_message_id)
    clearTimeout(pending.timer)
    pending.resolve({ messageId: frame.message_id })
  }

  private settleError(frame: ErrorFrame): void {
    const id = frame.client_message_id
    if (id === undefined) {
      this.options.logger.warn('Ayla 拒绝了一个未指明 client_message_id 的帧: ' + frame.code)
      return
    }
    const pending = this.pending.get(id)
    if (pending === undefined) return
    this.pending.delete(id)
    clearTimeout(pending.timer)
    pending.reject(new AylaReplyRejected(frame.code, frame.detail))
  }

  private settleAll(error: Error): void {
    const entries = [...this.pending.entries()]
    this.pending.clear()
    for (const [, pending] of entries) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
  }

  /**
   * Record the connection state and log only a change of the reported state.
   *
   * 'connecting' is an internal step, not a reportable state: an unreachable
   * backend would otherwise write two lines per backoff attempt forever. The
   * reported state therefore changes only when the connection actually comes
   * up, goes down, or stops for good.
   */
  private setState(next: AylaClientState, detail?: string): void {
    this.state = next
    if (next === 'connecting' || next === 'idle' || next === this.reported) return
    this.reported = next
    const message = 'Ayla 通道状态: ' + next + (detail === undefined ? '' : ' (' + detail + ')')
    if (next === 'failed') this.options.logger.error(message)
    else this.options.logger.info(message)
  }
}

/** One line for a failure, never a stack and never a token. */
function describe(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  return '未知错误'
}

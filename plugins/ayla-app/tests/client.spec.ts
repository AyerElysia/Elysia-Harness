import { afterEach, describe, expect, it, vi } from 'vitest'
import { AylaAuthError } from '../src/auth.ts'
import {
  AylaClient, HEARTBEAT_INTERVAL_MS, RECONNECT_INITIAL_MS, RECONNECT_MAX_MS, bridgeUrl,
} from '../src/client.ts'
import type { AylaSocket, AylaTokenSource } from '../src/client.ts'
import type { InboundFrame } from '../src/protocol.ts'
import { AylaReplyRejected, OutboundDeliveryUnknown } from '../src/outbound.ts'

const clients: AylaClient[] = []

afterEach(() => {
  for (const client of clients.splice(0)) client.stop()
  vi.useRealTimers()
})

/** One scripted socket that records what the client wrote and can fire events. */
class FakeSocket implements AylaSocket {
  readonly sent: string[] = []
  closed: { code?: number; reason?: string } | undefined
  onopen: ((event: unknown) => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onclose: ((event: { code?: number; reason?: string }) => void) | null = null
  onerror: ((event: unknown) => void) | null = null

  send(data: string): void {
    this.sent.push(data)
  }

  close(code?: number, reason?: string): void {
    this.closed = { ...code === undefined ? {} : { code }, ...reason === undefined ? {} : { reason } }
  }

  /** Deliver one text frame to the client. */
  deliver(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) })
  }

  /** Run the open handler, as a real socket would after the handshake. */
  open(): void {
    this.onopen?.({})
  }

  /** Run the close handler with a backend close code. */
  drop(code?: number): void {
    this.onclose?.({ ...code === undefined ? {} : { code } })
  }

  frames(): { v: number; type: string; [key: string]: unknown }[] {
    return this.sent.map(text => JSON.parse(text) as { v: number; type: string })
  }
}

interface Harness {
  client: AylaClient
  sockets: FakeSocket[]
  logs: string[]
  warnings: string[]
  errors: string[]
  inbound: InboundFrame[]
  /** Resolve the pending gate that holds the inbound handler. */
  release(): void
  /** Hold the next inbound delivery until release() is called. */
  hold(): void
}

function harness(options: {
  tokens?: Partial<AylaTokenSource>
  onInbound?: (frame: InboundFrame) => Promise<boolean>
  replyTimeoutMs?: number
  random?: () => number
} = {}): Harness {
  const sockets: FakeSocket[] = []
  const logs: string[] = []
  const warnings: string[] = []
  const errors: string[] = []
  const inbound: InboundFrame[] = []
  let gate: (() => void) | undefined
  const auth: AylaTokenSource = {
    accessToken: options.tokens?.accessToken ?? (async () => 'access-1'),
    refreshOnce: options.tokens?.refreshOnce ?? (async () => 'access-2'),
  }
  const client = new AylaClient({
    baseUrl: new URL('http://127.0.0.1:8100'),
    auth,
    logger: {
      info: message => logs.push(message),
      warn: message => warnings.push(message),
      error: message => errors.push(message),
    },
    createSocket: () => {
      const socket = new FakeSocket()
      sockets.push(socket)
      return socket
    },
    onInbound: options.onInbound ?? (async frame => {
      inbound.push(frame)
      return true
    }),
    ...options.replyTimeoutMs === undefined ? {} : { replyTimeoutMs: options.replyTimeoutMs },
    random: options.random ?? (() => 0),
  })
  clients.push(client)
  return {
    client,
    sockets,
    logs,
    warnings,
    errors,
    inbound,
    release() {
      gate?.()
      gate = undefined
    },
    hold() {
      gate = undefined
    },
  }
}

function inboundFrame(seq = 1, id = '90211'): InboundFrame {
  return {
    v: 1,
    type: 'inbound',
    seq,
    message: {
      id,
      conversation_id: '17',
      conversation_type: 'private',
      sender_id: 'sender',
      sender_name: '小希',
      sent_at: '2026-11-09T16:20:00+08:00',
      parts: [{ type: 'text', text: '好了，我吃完了' }],
    },
  }
}

/** Let every pending promise chain settle. */
async function settle(): Promise<void> {
  for (let index = 0; index < 8; index++) await Promise.resolve()
  await new Promise(resolve => setTimeout(resolve, 0))
}

describe('Ayla bridge URL', () => {
  it('derives ws from http and wss from https, keeping the token in the query', () => {
    expect(bridgeUrl(new URL('http://127.0.0.1:8100'), 'a1'))
      .toBe('ws://127.0.0.1:8100/ws/elysia-bridge/?token=a1')
    expect(bridgeUrl(new URL('https://ayla.example/'), 'a1'))
      .toBe('wss://ayla.example/ws/elysia-bridge/?token=a1')
    expect(bridgeUrl(new URL('https://ayla.example/backend/'), 'a1'))
      .toBe('wss://ayla.example/backend/ws/elysia-bridge/?token=a1')
  })

  it('escapes a token that would otherwise change the query', () => {
    expect(bridgeUrl(new URL('http://127.0.0.1:8100'), 'a&b=c'))
      .toBe('ws://127.0.0.1:8100/ws/elysia-bridge/?token=a%26b%3Dc')
  })
})

describe('Ayla connection lifecycle', () => {
  it('resumes from the last acked sequence on open', async () => {
    const harnessed = harness()
    harnessed.client.start()
    await settle()
    expect(harnessed.sockets).toHaveLength(1)
    const socket = harnessed.sockets[0]!
    socket.open()
    await settle()
    expect(socket.frames().map(frame => frame.type)).toEqual(['resume'])
    expect(socket.frames()[0]?.seq).toBe(0)
    expect(harnessed.client.currentState).toBe('connected')
  })

  it('backs off 1s, 2s, 4s … and caps at 60s', async () => {
    vi.useFakeTimers()
    // A fixed draw of 1 makes the jitter factor exactly 1, so the delays are
    // the plain exponential series and can be asserted to the millisecond.
    const harnessed = harness({ random: () => 1 })
    harnessed.client.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(harnessed.sockets).toHaveLength(1)

    const expected = [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000]
    for (const [round, delay] of expected.entries()) {
      const before = harnessed.sockets.length
      harnessed.sockets.at(-1)!.drop()
      await vi.advanceTimersByTimeAsync(delay - 1)
      expect(harnessed.sockets, `round ${String(round)} redialed early`).toHaveLength(before)
      await vi.advanceTimersByTimeAsync(1)
      expect(harnessed.sockets, `round ${String(round)} did not redial`).toHaveLength(before + 1)
    }
    expect(RECONNECT_MAX_MS).toBe(60_000)
  })

  it('shortens the wait when the jitter draw is low', async () => {
    vi.useFakeTimers()
    const harnessed = harness({ random: () => 0 })
    harnessed.client.start()
    await vi.advanceTimersByTimeAsync(0)
    harnessed.sockets[0]!.drop()
    await vi.advanceTimersByTimeAsync(RECONNECT_INITIAL_MS / 2 - 1)
    expect(harnessed.sockets).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(harnessed.sockets).toHaveLength(2)
  })

  it('waits the scheduled delay before dialing again', async () => {
    vi.useFakeTimers()
    const harnessed = harness({ random: () => 1 })
    harnessed.client.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(harnessed.sockets).toHaveLength(1)
    harnessed.sockets[0]!.open()
    harnessed.sockets[0]!.drop()
    await vi.advanceTimersByTimeAsync(RECONNECT_INITIAL_MS - 1)
    expect(harnessed.sockets).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(harnessed.sockets).toHaveLength(2)
  })

  it('logs a state change once instead of on every reconnect attempt', async () => {
    vi.useFakeTimers()
    const harnessed = harness({ random: () => 1 })
    harnessed.client.start()
    await vi.advanceTimersByTimeAsync(0)
    harnessed.sockets[0]!.open()
    expect(harnessed.logs).toEqual(['Ayla 通道状态: connected'])
    for (let round = 0; round < 5; round++) {
      harnessed.sockets.at(-1)!.drop()
      await vi.advanceTimersByTimeAsync(RECONNECT_MAX_MS)
    }
    // Down is reported once; the five failed redials add nothing.
    expect(harnessed.logs).toEqual(['Ayla 通道状态: connected', 'Ayla 通道状态: disconnected'])
  })

  it('closes the socket after two unanswered heartbeat rounds', async () => {
    vi.useFakeTimers()
    const harnessed = harness()
    harnessed.client.start()
    await vi.advanceTimersByTimeAsync(0)
    const socket = harnessed.sockets[0]!
    socket.open()
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS)
    expect(socket.frames().filter(frame => frame.type === 'ping')).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS)
    expect(socket.frames().filter(frame => frame.type === 'ping')).toHaveLength(2)
    expect(socket.closed).toBeUndefined()
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS)
    expect(socket.closed?.code).toBe(4000)
    expect(harnessed.warnings.join('\n')).toContain('心跳')
  })

  it('keeps the connection when a pong arrives', async () => {
    vi.useFakeTimers()
    const harnessed = harness()
    harnessed.client.start()
    await vi.advanceTimersByTimeAsync(0)
    const socket = harnessed.sockets[0]!
    socket.open()
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS)
    socket.deliver({ v: 1, type: 'pong' })
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS)
    socket.deliver({ v: 1, type: 'pong' })
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS)
    expect(socket.closed).toBeUndefined()
    expect(socket.frames().filter(frame => frame.type === 'ping')).toHaveLength(3)
  })

  it('answers a peer ping with a pong', async () => {
    const harnessed = harness()
    harnessed.client.start()
    await settle()
    const socket = harnessed.sockets[0]!
    socket.open()
    socket.deliver({ v: 1, type: 'ping' })
    await settle()
    expect(socket.frames().map(frame => frame.type)).toContain('pong')
  })

  it('ignores a frame it cannot parse instead of dropping the connection', async () => {
    const harnessed = harness()
    harnessed.client.start()
    await settle()
    const socket = harnessed.sockets[0]!
    socket.open()
    socket.onmessage?.({ data: 'not json' })
    socket.deliver({ v: 2, type: 'inbound', seq: 1 })
    await settle()
    expect(harnessed.warnings.length).toBe(2)
    expect(socket.closed).toBeUndefined()
  })

  it('stops reconnecting once stopped', async () => {
    vi.useFakeTimers()
    const harnessed = harness({ random: () => 1 })
    harnessed.client.start()
    await vi.advanceTimersByTimeAsync(0)
    harnessed.sockets[0]!.open()
    harnessed.client.stop()
    expect(harnessed.client.currentState).toBe('stopped')
    await vi.advanceTimersByTimeAsync(RECONNECT_MAX_MS * 3)
    expect(harnessed.sockets).toHaveLength(1)
  })

  it('keeps dialing when a socket fails without ever emitting close', async () => {
    // Observed against a restarted backend: the dial failed, onerror fired, and
    // close never followed. The client parked forever with no socket and no
    // timer, so the process looked alive while nothing was connected.
    vi.useFakeTimers()
    const harnessed = harness({ random: () => 1 })
    harnessed.client.start()
    await vi.advanceTimersByTimeAsync(0)
    const first = harnessed.sockets[0]!
    first.onerror?.({})
    await vi.advanceTimersByTimeAsync(RECONNECT_INITIAL_MS + 1)
    expect(harnessed.sockets.length).toBeGreaterThan(1)
    expect(harnessed.client.currentState).toBe('connecting')
  })

  it('reconnects after a failure even when the failing socket also reports close', async () => {
    // Both events can arrive for one failure; the client must retire the socket
    // once and still schedule exactly one next attempt.
    vi.useFakeTimers()
    const harnessed = harness({ random: () => 1 })
    harnessed.client.start()
    await vi.advanceTimersByTimeAsync(0)
    const first = harnessed.sockets[0]!
    first.onerror?.({})
    first.drop(1006)
    await vi.advanceTimersByTimeAsync(RECONNECT_INITIAL_MS + 1)
    expect(harnessed.sockets).toHaveLength(2)
  })
})

describe('Ayla inbound acknowledgement', () => {
  it('acks a delivered message and advances the resume point', async () => {
    const harnessed = harness()
    harnessed.client.start()
    await settle()
    const socket = harnessed.sockets[0]!
    socket.open()
    socket.deliver(inboundFrame(7))
    await settle()
    expect(harnessed.inbound).toHaveLength(1)
    expect(harnessed.client.ackedSeq).toBe(7)
    const ack = socket.frames().find(frame => frame.type === 'ack')
    expect(ack?.seq).toBe(7)
  })

  it('does not ack a message the handler refused, so Ayla redelivers it', async () => {
    const harnessed = harness({ onInbound: async () => false })
    harnessed.client.start()
    await settle()
    const socket = harnessed.sockets[0]!
    socket.open()
    socket.deliver(inboundFrame(9))
    await settle()
    expect(harnessed.client.ackedSeq).toBe(0)
    expect(socket.frames().some(frame => frame.type === 'ack')).toBe(false)
  })

  it('does not ack a message whose handler threw', async () => {
    const harnessed = harness({
      onInbound: async () => { throw new Error('admission failed') },
    })
    harnessed.client.start()
    await settle()
    const socket = harnessed.sockets[0]!
    socket.open()
    socket.deliver(inboundFrame(11))
    await settle()
    expect(harnessed.client.ackedSeq).toBe(0)
    expect(harnessed.errors.join('\n')).toContain('admission failed')
  })
})

describe('Ayla outbound settlement', () => {
  const reply = {
    clientMessageId: 'c1',
    conversation: { kind: 'private' as const, id: '17' },
    content: '在的',
  }

  it('resolves with the stored message id when Ayla answers sent', async () => {
    const harnessed = harness()
    harnessed.client.start()
    await settle()
    const socket = harnessed.sockets[0]!
    socket.open()
    const pending = harnessed.client.sendReply(reply)
    await settle()
    const frame = socket.frames().find(entry => entry.type === 'reply')
    expect(frame?.conversation_id).toBe('17')
    expect(frame?.conversation_type).toBe('private')
    socket.deliver({ v: 1, type: 'sent', client_message_id: 'c1', message_id: 'm-77' })
    await expect(pending).resolves.toEqual({ messageId: 'm-77' })
  })

  it('rejects with the backend code when Ayla answers error', async () => {
    const harnessed = harness()
    harnessed.client.start()
    await settle()
    const socket = harnessed.sockets[0]!
    socket.open()
    const pending = harnessed.client.sendReply(reply)
    await settle()
    socket.deliver({
      v: 1, type: 'error', client_message_id: 'c1',
      code: 'conversation_not_found', detail: '会话不存在',
    })
    const failure = await pending.catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(AylaReplyRejected)
    expect((failure as AylaReplyRejected).code).toBe('conversation_not_found')
    expect((failure as Error).message).toContain('conversation_not_found')
  })

  it('rejects as unknown when no settlement arrives in time', async () => {
    vi.useFakeTimers()
    const harnessed = harness({ replyTimeoutMs: 5_000 })
    harnessed.client.start()
    await vi.advanceTimersByTimeAsync(0)
    harnessed.sockets[0]!.open()
    const pending = harnessed.client.sendReply(reply)
    const settled = pending.catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(5_000)
    await expect(settled).resolves.toBeInstanceOf(OutboundDeliveryUnknown)
  })

  it('settles every outstanding reply when the connection drops', async () => {
    const harnessed = harness()
    harnessed.client.start()
    await settle()
    const socket = harnessed.sockets[0]!
    socket.open()
    const first = harnessed.client.sendReply(reply).catch((error: unknown) => error)
    const second = harnessed.client
      .sendReply({ ...reply, clientMessageId: 'c2' })
      .catch((error: unknown) => error)
    await settle()
    socket.drop()
    await expect(first).resolves.toBeInstanceOf(OutboundDeliveryUnknown)
    await expect(second).resolves.toBeInstanceOf(OutboundDeliveryUnknown)
  })

  it('settles outstanding replies when the client stops', async () => {
    const harnessed = harness()
    harnessed.client.start()
    await settle()
    harnessed.sockets[0]!.open()
    const pending = harnessed.client.sendReply(reply).catch((error: unknown) => error)
    await settle()
    harnessed.client.stop()
    await expect(pending).resolves.toBeInstanceOf(OutboundDeliveryUnknown)
  })

  it('reports the channel as unconnected instead of sending nowhere', async () => {
    const harnessed = harness()
    await expect(harnessed.client.sendReply(reply)).rejects.toBeInstanceOf(OutboundDeliveryUnknown)
  })
})

describe('Ayla authentication during connect', () => {
  it('refreshes once and redials when the access token cannot be issued', async () => {
    let attempts = 0
    const harnessed = harness({
      tokens: {
        accessToken: async () => {
          attempts++
          throw new AylaAuthError('Ayla /api/v1/auth/refresh/ 返回 401', 401)
        },
        refreshOnce: async () => 'access-2',
      },
    })
    harnessed.client.start()
    await settle()
    expect(attempts).toBe(1)
    expect(harnessed.sockets).toHaveLength(1)
    expect(harnessed.client.currentState).toBe('connecting')
  })

  it('fails loudly when the refresh is refused too, without redialing forever', async () => {
    const harnessed = harness({
      tokens: {
        accessToken: async () => { throw new AylaAuthError('no token', 401) },
        refreshOnce: async () => { throw new AylaAuthError('refresh refused', 401) },
      },
    })
    harnessed.client.start()
    await settle()
    expect(harnessed.client.currentState).toBe('failed')
    expect(harnessed.errors.join('\n')).toContain('鉴权失败')
    expect(harnessed.errors.join('\n')).toContain('refresh refused')
    expect(harnessed.sockets).toHaveLength(0)
    expect(harnessed.logs).toEqual([])
  })

  it('gives up after a second account refusal instead of rotating tokens forever', async () => {
    let refreshes = 0
    const harnessed = harness({
      tokens: {
        accessToken: async () => 'access-1',
        refreshOnce: async () => { refreshes++; return 'access-2' },
      },
    })
    harnessed.client.start()
    await settle()
    harnessed.sockets[0]!.open()
    harnessed.sockets[0]!.drop(4403)
    await settle()
    expect(harnessed.client.currentState).not.toBe('failed')
    expect(refreshes).toBe(1)

    // The redial opens a new socket, which is refused again.
    await new Promise(resolve => setTimeout(resolve, 700))
    const next = harnessed.sockets.at(-1)!
    expect(harnessed.sockets.length).toBeGreaterThan(1)
    next.open()
    next.drop(4403)
    await settle()
    expect(harnessed.client.currentState).toBe('failed')
    expect(refreshes).toBe(1)
  })

  it('treats a 4403 close as an account refusal, not a network drop', async () => {
    const harnessed = harness({
      tokens: {
        accessToken: async () => 'access-1',
        refreshOnce: async () => { throw new AylaAuthError('refresh refused', 401) },
      },
    })
    harnessed.client.start()
    await settle()
    harnessed.sockets[0]!.open()
    harnessed.sockets[0]!.drop(4403)
    await settle()
    expect(harnessed.client.currentState).toBe('failed')
    expect(harnessed.errors.join('\n')).toContain('鉴权失败')
  })
})

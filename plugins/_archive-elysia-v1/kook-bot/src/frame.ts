/**
 * KOOK gateway signal handling. The socket loop and the tests share this.
 * @module @elysia/kook-bot/frame
 */

/** Sequence state for one gateway session. */
export interface KookSocketState {
  sn: number
  sessionId: string
}

/** What one gateway frame asked the socket to do. */
export type KookFrame =
  | { type: 'hello'; sessionId: string }
  | { type: 'event'; event: unknown }
  | { type: 'pong' }
  | { type: 'reconnect' }
  | { type: 'resume'; sessionId: string }
  | { type: 'ignore' }

/**
 * Apply one gateway frame to the session state.
 * @param frame - a decoded JSON frame.
 * @param state - latest sn and session id. Updated in place.
 * @returns the action for that frame. A failed HELLO throws.
 */
export function handleKookFrame(frame: unknown, state: KookSocketState): KookFrame {
  if (frame === null || typeof frame !== 'object') return { type: 'ignore' }
  const message = frame as { s?: unknown; sn?: unknown; d?: unknown }
  const signal = Number(message.s)
  if (signal === 1) {
    const body = message.d !== null && typeof message.d === 'object' ? message.d as { code?: unknown; session_id?: unknown } : {}
    if (Number(body.code ?? 0) !== 0) throw new Error(`KOOK HELLO 失败: ${String(body.code)}`)
    state.sessionId = String(body.session_id ?? '')
    return { type: 'hello', sessionId: state.sessionId }
  }
  if (signal === 0) {
    const sn = Number(message.sn ?? 0)
    if (!Number.isFinite(sn) || sn <= state.sn) return { type: 'ignore' }
    state.sn = sn
    return { type: 'event', event: message.d }
  }
  if (signal === 3) return { type: 'pong' }
  if (signal === 5) {
    state.sn = 0
    state.sessionId = ''
    return { type: 'reconnect' }
  }
  if (signal === 6) {
    const body = message.d !== null && typeof message.d === 'object' ? message.d as { session_id?: unknown } : {}
    if (body.session_id !== undefined) state.sessionId = String(body.session_id)
    return { type: 'resume', sessionId: state.sessionId }
  }
  return { type: 'ignore' }
}

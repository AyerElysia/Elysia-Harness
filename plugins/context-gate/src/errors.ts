/**
 * Stable refusal codes of the context gate.
 *
 * The Remote layer prefixes each code with `contextGate/`, so the browser half
 * can tell a stale render (an unregistered kind) from a real failure.
 *
 * @module @elysia/context-gate/errors
 */

/** Every refusal the Host answers with a stable code. */
export type ContextGateErrorCode =
  | 'CONTEXT_UNKNOWN'
  | 'SESSION_NOT_FOUND'
  | 'EVENT_INVALID'
  | 'EVENT_PAYLOAD_INVALID'
  | 'EVENT_TOO_LARGE'
  | 'STATE_INVALID'
  | 'STATE_WRITE_FAILED'

/** One refusal with its code and optional JSON details. */
export class ContextGateError extends Error {
  /**
   * @param code - stable refusal code.
   * @param message - human-readable explanation.
   * @param details - JSON-serializable context for the caller.
   */
  constructor(
    readonly code: ContextGateErrorCode,
    message: string,
    readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message)
    this.name = 'ContextGateError'
  }
}

/**
 * Render one caught value for a diagnostic message.
 * @param error - the caught value.
 * @returns its message, or its string form.
 */
export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** A subscription named an unregistered context kind. */
    'contextGate/CONTEXT_UNKNOWN': Readonly<Record<string, unknown>> | undefined
    /** The session has no live Agent. */
    'contextGate/SESSION_NOT_FOUND': Readonly<Record<string, unknown>> | undefined
    /** A publication carried an invalid field. */
    'contextGate/EVENT_INVALID': Readonly<Record<string, unknown>> | undefined
    /** A publication payload could not be represented as JSON. */
    'contextGate/EVENT_PAYLOAD_INVALID': Readonly<Record<string, unknown>> | undefined
    /** A publication exceeded its size ceiling. */
    'contextGate/EVENT_TOO_LARGE': Readonly<Record<string, unknown>> | undefined
    /** The state document could not be read. */
    'contextGate/STATE_INVALID': Readonly<Record<string, unknown>> | undefined
    /** The state write failed. */
    'contextGate/STATE_WRITE_FAILED': Readonly<Record<string, unknown>> | undefined
  }
}
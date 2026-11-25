/**
 * Stable refusal codes of the orchestrator.
 *
 * The Remote layer prefixes each code with `villvHelix/`, so a browser half can
 * tell a stale render (a locked static tool) from a real failure.
 *
 * @module @elysia/villv-helix/errors
 */

/** Every refusal the Host answers with a stable code. */
export type HelixErrorCode =
  | 'TOOL_UNKNOWN'
  | 'TOOL_STATIC_LOCKED'
  | 'CONTEXT_UNKNOWN'
  | 'SESSION_NOT_FOUND'
  | 'EVENT_INVALID'
  | 'EVENT_PAYLOAD_INVALID'
  | 'EVENT_TOO_LARGE'
  | 'STATE_INVALID'
  | 'STATE_WRITE_FAILED'

/** One refusal with its code and optional JSON details. */
export class VillvHelixError extends Error {
  /**
   * @param code - stable refusal code.
   * @param message - human-readable explanation.
   * @param details - JSON-serializable context for the caller.
   */
  constructor(
    readonly code: HelixErrorCode,
    message: string,
    readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message)
    this.name = 'VillvHelixError'
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
    /** A switch named a tool no provider registered. */
    'villvHelix/TOOL_UNKNOWN': Readonly<Record<string, unknown>> | undefined
    /** A switch targeted a preset static tool. */
    'villvHelix/TOOL_STATIC_LOCKED': Readonly<Record<string, unknown>> | undefined
    /** A subscription named an unregistered context kind. */
    'villvHelix/CONTEXT_UNKNOWN': Readonly<Record<string, unknown>> | undefined
    /** The session has no live Agent. */
    'villvHelix/SESSION_NOT_FOUND': Readonly<Record<string, unknown>> | undefined
    /** A publication carried an invalid field. */
    'villvHelix/EVENT_INVALID': Readonly<Record<string, unknown>> | undefined
    /** A publication payload could not be represented as JSON. */
    'villvHelix/EVENT_PAYLOAD_INVALID': Readonly<Record<string, unknown>> | undefined
    /** A publication exceeded its size ceiling. */
    'villvHelix/EVENT_TOO_LARGE': Readonly<Record<string, unknown>> | undefined
    /** The state document could not be read. */
    'villvHelix/STATE_INVALID': Readonly<Record<string, unknown>> | undefined
    /** The state write failed. */
    'villvHelix/STATE_WRITE_FAILED': Readonly<Record<string, unknown>> | undefined
  }
}

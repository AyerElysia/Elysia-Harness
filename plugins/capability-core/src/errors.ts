/**
 * Coded failures and diagnostics of the capability Host. Every refusal the
 * panel can act on carries a stable code; anything else is a programming error
 * and is rethrown unchanged.
 *
 * @module @elysia/capability-core/errors
 */

/** Stable refusal codes, mirrored by the Remote error namespace. */
export type CapabilityErrorCode =
  | 'TOOL_UNKNOWN'
  | 'TOOL_STATIC_LOCKED'
  | 'CONTEXT_UNKNOWN'
  | 'SCOPE_NOT_FOUND'
  | 'SCOPE_READ_ONLY'
  | 'SCOPE_INVALID'
  | 'GATE_FAILED'
  | 'EVENT_TOO_LARGE'
  | 'EVENT_PAYLOAD_INVALID'
  | 'EVENT_INVALID'
  | 'STATE_INVALID'
  | 'STATE_WRITE_FAILED'
  | 'TOOL_REGISTRATION_FAILED'
  | 'NOT_AUTHORIZED'
  | 'NOT_READY'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** A switch named a tool no provider declared. */
    'capabilityHost/TOOL_UNKNOWN': Readonly<Record<string, unknown>> | undefined
    /** A switch targeted a preset's static tool, which the panel cannot change. */
    'capabilityHost/TOOL_STATIC_LOCKED': Readonly<Record<string, unknown>> | undefined    /** A subscription named a context kind no provider declared. */
    'capabilityHost/CONTEXT_UNKNOWN': Readonly<Record<string, unknown>> | undefined
    /** A switch named a preset or session nothing knows. */
    'capabilityHost/SCOPE_NOT_FOUND': Readonly<Record<string, unknown>> | undefined
    /** A caller addressed the removed Base scope: static tools have no writable switch. */
    'capabilityHost/SCOPE_READ_ONLY': Readonly<Record<string, unknown>> | undefined
    /** A scope reference was malformed. */
    'capabilityHost/SCOPE_INVALID': Readonly<Record<string, unknown>> | undefined
    /** A fail-loud gate could not resolve availability. */
    'capabilityHost/GATE_FAILED': Readonly<Record<string, unknown>> | undefined
    /** A publication exceeded its size ceiling. */
    'capabilityHost/EVENT_TOO_LARGE': Readonly<Record<string, unknown>> | undefined
    /** A publication payload could not be represented as JSON. */
    'capabilityHost/EVENT_PAYLOAD_INVALID': Readonly<Record<string, unknown>> | undefined
    /** A publication carried an invalid field. */
    'capabilityHost/EVENT_INVALID': Readonly<Record<string, unknown>> | undefined
    /** The state document could not be read or is not a readable generation. */
    'capabilityHost/STATE_INVALID': Readonly<Record<string, unknown>> | undefined
    /** The state write failed. */
    'capabilityHost/STATE_WRITE_FAILED': Readonly<Record<string, unknown>> | undefined
    /** A provider declaration could not be registered. */
    'capabilityHost/TOOL_REGISTRATION_FAILED': Readonly<Record<string, unknown>> | undefined
    /** The caller is not the configured owner. */
    'capabilityHost/NOT_AUTHORIZED': Readonly<Record<string, unknown>> | undefined
    /** The Host has not finished opening its document. */
    'capabilityHost/NOT_READY': Readonly<Record<string, unknown>> | undefined
  }
}

/** One coded refusal with optional structured detail for the panel. */
export class CapabilityHostError extends Error {  /**
   * @param code - stable refusal code.
   * @param message - actionable explanation.
   * @param details - optional JSON detail carried to the caller.
   */
  constructor(
    readonly code: CapabilityErrorCode,
    message: string,
    readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message)
    this.name = 'CapabilityHostError'
  }
}

/**
 * Render any caught value as one line suitable for a diagnostic.
 * @param error - the caught failure.
 * @returns its message, or a string form for non-Error values.
 */
export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

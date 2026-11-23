/**
 * Coded failures of the preset manager. The code is the discriminator on both
 * sides of the Remote boundary; the message carries the operator-facing detail.
 *
 * @module @elysia/preset-manager/errors
 */

/** Every refusal the manager can answer. */
export type PresetErrorCode =
  /** The id is empty or uses characters outside `[a-z0-9-]`. */
  | 'PRESET_ID_INVALID'
  /** A roster preset already uses the id. */
  | 'PRESET_ID_EXISTS'
  /** The display name is empty. */
  | 'PRESET_NAME_INVALID'
  /** The injected preset identity is empty. */
  | 'PRESET_IDENTITY_INVALID'
  /** No roster preset and no manager entry carry the id. */
  | 'PRESET_NOT_FOUND'
  /** The preset belongs to a bundle or profile declaration. */
  | 'PRESET_NOT_MANAGED'
  /** A live session runs the preset. */
  | 'PRESET_IN_USE'
  /** The manager entry exists but its registration is gone. */
  | 'PRESET_UNREGISTERED'
  /** The preset registry rejected the definition. */
  | 'PRESET_REGISTER_FAILED'
  /** The registration could not be disposed, so the owned entry is kept. */
  | 'PRESET_DISPOSE_FAILED'
  /** No directory exists at the configured prompt root. */
  | 'PROMPT_ROOT_MISSING'
  /** The prompt root is not an absolute, readable directory path. */
  | 'PROMPT_ROOT_INVALID'
  /** A configured file is missing, unreadable, or not a regular file. */
  | 'PROMPT_FILE_INVALID'
  /** A configured file resolves outside the prompt root. */
  | 'PROMPT_FILE_OUTSIDE_ROOT'
  /** Every configured file is blank. */
  | 'PROMPT_FILE_EMPTY'
  /** No prompt file was submitted. */
  | 'PROMPT_FILES_EMPTY'
  /** A submitted tool id is not in the catalog this build composes. */
  | 'TOOL_UNKNOWN'
  /** A tool face names no tool, or its id or kind is malformed. */
  | 'TOOL_FACE_INVALID'
  /** No custom face carries the id. */
  | 'TOOL_FACE_NOT_FOUND'
  /** A custom face already uses the id or the name. */
  | 'TOOL_FACE_EXISTS'
  /** The face belongs to the built-in, common, or existing-preset families. */
  | 'TOOL_FACE_READONLY'
  /** The persisted manager document is unreadable or malformed. */
  | 'STATE_INVALID'
  /** The persisted manager document could not be written. */
  | 'STATE_WRITE_FAILED'

/** Structured detail carried beside a {@link PresetErrorCode}. */
export interface PresetErrorDetails {
  /** Preset the refusal is about. */
  readonly presetId?: string
  /** Live session ids that keep the preset in use. */
  readonly sessionIds?: readonly string[]
  /** Filesystem path the refusal is about. */
  readonly path?: string
  /** Tool id the refusal is about. */
  readonly toolId?: string
  /** Tool face id the refusal is about. */
  readonly toolFaceId?: string
  /** One line of machine- and operator-readable context. */
  readonly reason?: string
}

/** One refused preset-manager operation. */
export class PresetManagerError extends Error {
  /**
   * @param code - the refusal discriminator.
   * @param message - operator-facing explanation.
   * @param details - structured fields the caller may branch on.
   */
  constructor(
    readonly code: PresetErrorCode,
    message: string,
    readonly details: PresetErrorDetails = {},
  ) {
    super(message)
    this.name = 'PresetManagerError'
  }
}

/** Wire failures of the preset-manager Remote namespace. */
type PresetRemoteErrors = Record<`presetManager/${PresetErrorCode}`, PresetErrorDetails>

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap extends PresetRemoteErrors {}
}

/**
 * Render one refusal as a message for an operator log or a panel row.
 * @param error - a caught value of unknown origin.
 * @returns the refusal's own message, or a generic description of the value.
 */
export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

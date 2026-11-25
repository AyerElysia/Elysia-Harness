/**
 * Localized copy for the Host's refusal codes. A code the panel does not know
 * falls back to the Host message, so a newer Host still explains itself.
 *
 * @module @elysia/villv-helix/client/errors
 */

import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import { VillvHelixRemoteError } from './api.ts'
import type { ControlPanelLocaleKey } from './locales.ts'

/** Refusal the Host answers when a write targets a preset's static tool. */
export const STATIC_LOCKED_CODE = 'villvHelix/TOOL_STATIC_LOCKED'

/** Locale key for every refusal the panel can explain itself. */
export const ERROR_KEYS: Readonly<Record<string, ControlPanelLocaleKey>> = {
  'villvHelix/TOOL_UNKNOWN': 'errorToolUnknown',
  [STATIC_LOCKED_CODE]: 'errorToolStaticLocked',
  'villvHelix/CONTEXT_UNKNOWN': 'errorContextUnknown',
  'villvHelix/SESSION_NOT_FOUND': 'errorScopeNotFound',
  'villvHelix/EVENT_TOO_LARGE': 'errorEventTooLarge',
  'villvHelix/EVENT_PAYLOAD_INVALID': 'errorEventInvalid',
  'villvHelix/EVENT_INVALID': 'errorEventInvalid',
  'villvHelix/STATE_INVALID': 'errorState',
  'villvHelix/STATE_WRITE_FAILED': 'errorState',
}

/**
 * How the page reports one refused write. A static-tool refusal is a stale
 * render, not a failed gesture: the panel never offers that switch, so it
 * reports a notice and refreshes instead of the failure banner.
 */
export type WriteFailureKind = 'static-locked' | 'failure'

/**
 * Classify one refused write.
 * @param error - the caught refusal.
 * @returns `static-locked` when the Host refused a preset's static tool, else `failure`.
 */
export function classifyWriteFailure(error: unknown): WriteFailureKind {
  return error instanceof VillvHelixRemoteError && error.code === STATIC_LOCKED_CODE
    ? 'static-locked'
    : 'failure'
}

/**
 * Render one refused call for the panel.
 * @param error - the caught failure.
 * @param t - the panel's localized copy.
 * @returns localized copy for a known refusal code, otherwise the Host message.
 */
export function describeFailure(
  error: unknown,
  t: Translate<ControlPanelLocaleKey>,
): string {
  if (error instanceof VillvHelixRemoteError) {
    const key = ERROR_KEYS[error.code]
    if (key !== undefined) return t(key)
  }
  return error instanceof Error ? error.message : t('error')
}
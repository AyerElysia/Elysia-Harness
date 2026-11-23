/**
 * Localized copy for the Host's refusal codes. A code the panel does not know
 * falls back to the Host message, so a newer Host still explains itself.
 *
 * @module @elysia/capability-host/client/errors
 */

import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import { CapabilityRemoteError } from './api.ts'
import type { ControlPanelLocaleKey } from './locales.ts'

/** Refusal the Host answers when a write targets a preset's static tool. */
export const STATIC_LOCKED_CODE = 'capabilityHost/TOOL_STATIC_LOCKED'

/** Locale key for every refusal the panel can explain itself. */
export const ERROR_KEYS: Readonly<Record<string, ControlPanelLocaleKey>> = {
  'capabilityHost/TOOL_UNKNOWN': 'errorToolUnknown',
  [STATIC_LOCKED_CODE]: 'errorToolStaticLocked',
  'capabilityHost/CONTEXT_UNKNOWN': 'errorContextUnknown',
  'capabilityHost/SCOPE_NOT_FOUND': 'errorScopeNotFound',
  'capabilityHost/SCOPE_READ_ONLY': 'errorScopeReadOnly',
  'capabilityHost/GATE_FAILED': 'errorGateFailed',
  'capabilityHost/EVENT_TOO_LARGE': 'errorEventTooLarge',
  'capabilityHost/EVENT_PAYLOAD_INVALID': 'errorEventInvalid',
  'capabilityHost/STATE_INVALID': 'errorState',
  'capabilityHost/STATE_WRITE_FAILED': 'errorState',
  'capabilityHost/NOT_OWNER': 'errorNotOwner',
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
  return error instanceof CapabilityRemoteError && error.code === STATIC_LOCKED_CODE
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
  if (error instanceof CapabilityRemoteError) {
    const key = ERROR_KEYS[error.code]
    if (key !== undefined) return t(key)
  }
  return error instanceof Error ? error.message : t('error')
}
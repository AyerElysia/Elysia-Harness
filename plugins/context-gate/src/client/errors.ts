/**
 * Localized copy for the Host's refusal codes. A code these views do not know
 * falls back to the Host message, so a newer Host still explains itself.
 *
 * @module @elysia/context-gate/client/errors
 */

import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import { ContextGateRemoteError } from './api.ts'
import type { ContextGateLocaleKey } from './locales.ts'

/** Locale key for every refusal the views can explain themselves. */
export const ERROR_KEYS: Readonly<Record<string, ContextGateLocaleKey>> = {
  'contextGate/CONTEXT_UNKNOWN': 'errorContextUnknown',
  'contextGate/SESSION_NOT_FOUND': 'errorScopeNotFound',
  'contextGate/STATE_INVALID': 'errorState',
  'contextGate/STATE_WRITE_FAILED': 'errorState',
}

/**
 * Render one refused call for the views.
 * @param error - the caught failure.
 * @param t - the views' localized copy.
 * @returns localized copy for a known refusal code, otherwise the Host message.
 */
export function describeFailure(
  error: unknown,
  t: Translate<ContextGateLocaleKey>,
): string {
  if (error instanceof ContextGateRemoteError) {
    const key = ERROR_KEYS[error.code]
    if (key !== undefined) return t(key)
  }
  return error instanceof Error ? error.message : t('error')
}
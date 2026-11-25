/**
 * Localized copy for the Host's refusal codes. A code the page does not know
 * falls back to the Host message, so a newer Host still explains itself.
 *
 * @module @elysia/mobius-infinity/client/errors
 */

import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import { PresetManagerRemoteError } from './api.ts'
import type { PresetManagerLocaleKey } from './locales.ts'

/** Locale key for every refusal the page can explain itself. */
export const ERROR_KEYS: Readonly<Record<string, PresetManagerLocaleKey>> = {
  'presetManager/PRESET_ID_INVALID': 'errorIdShape',
  'presetManager/PRESET_ID_EXISTS': 'errorIdExists',
  'presetManager/PRESET_NAME_INVALID': 'errorName',
  'presetManager/PRESET_IDENTITY_INVALID': 'errorIdentity',
  'presetManager/PROMPT_ROOT_MISSING': 'errorRoot',
  'presetManager/PROMPT_ROOT_INVALID': 'errorRoot',
  'presetManager/PROMPT_FILE_INVALID': 'errorFiles',
  'presetManager/PROMPT_FILE_OUTSIDE_ROOT': 'errorFiles',
  'presetManager/PROMPT_FILE_EMPTY': 'errorFiles',
  'presetManager/PROMPT_FILES_EMPTY': 'errorFiles',
  'presetManager/PRESET_IN_USE': 'errorInUse',
  'presetManager/PRESET_NOT_MANAGED': 'errorNotManaged',
  'presetManager/PRESET_NOT_FOUND': 'errorNotManaged',
  'presetManager/PRESET_UNREGISTERED': 'errorNotManaged',
  'presetManager/PRESET_REGISTER_FAILED': 'errorRegister',
  'presetManager/PRESET_DISPOSE_FAILED': 'errorRegister',
  'presetManager/STATE_INVALID': 'errorState',
  'presetManager/STATE_WRITE_FAILED': 'errorState',
  'presetManager/TOOL_UNKNOWN': 'errorToolUnknown',
  'presetManager/TOOL_FACE_INVALID': 'errorToolFace',
  'presetManager/TOOL_FACE_NOT_FOUND': 'errorToolFaceMissing',
  'presetManager/TOOL_FACE_EXISTS': 'errorToolFace',
  'presetManager/TOOL_FACE_READONLY': 'errorToolFaceReadOnly',
}

/**
 * Render one refused call for the page.
 * @param error - the caught failure.
 * @param t - the page's localized copy.
 * @returns localized copy for a known refusal code, otherwise the Host message.
 */
export function describeFailure(
  error: unknown,
  t: Translate<PresetManagerLocaleKey>,
): string {
  if (error instanceof PresetManagerRemoteError) {
    const key = ERROR_KEYS[error.code]
    if (key !== undefined) return t(key)
  }
  return error instanceof Error ? error.message : t('error')
}

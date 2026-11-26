/**
 * Built-in agent presets whose static tool composition is owned by the harness.
 * Only these sessions lock their preset tools; custom presets may override the
 * same ids through Helix's session tools.
 *
 * @module @elysia/villv-helix/presets
 */

/** Stable ids of the harness-provided agent presets. */
export const OFFICIAL_PRESET_IDS = new Set(['standard', 'minimal', 'ptc', 'cordis'])

/**
 * Whether a session runs one of the harness-provided presets.
 * @param presetId - the session header's agent preset id.
 * @returns true only for the built-in preset ids.
 */
export function isOfficialPreset(presetId: string | undefined): boolean {
  return presetId !== undefined && OFFICIAL_PRESET_IDS.has(presetId)
}
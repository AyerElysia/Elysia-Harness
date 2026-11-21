/**
 * Which delivery form the plugin takes at mount time.
 *
 * The plugin installs into any dsh, with or without the conscious mind, so the
 * form is decided from what the context actually provides plus the operator's
 * setting. An explicit 'elyh' setting that cannot be honoured fails the mount
 * instead of silently changing where messages go (REQUIREMENTS.zh.md §4).
 * @module @elysia/ayla-app/forms
 */

/** The operator's form setting. */
export type AylaMode = 'auto' | 'elyh' | 'standalone'

/** The form the plugin runs as. */
export type AylaForm = 'elyh' | 'standalone'

/**
 * Decide the form from the setting and the services the context provides.
 *
 * - 'elyh' with either service missing throws: the operator asked for a
 *   specific destination that this process cannot reach.
 * - 'standalone' always uses the plugin's own session, even when the services
 *   exist, and never registers a second 'send_text'.
 * - 'auto' uses 'elyh' only when both services exist, and 'standalone' otherwise.
 * @param mode - the configured form.
 * @param hasPending - whether an 'inboundPending' service is available.
 * @param hasOutboundText - whether an 'outboundText' service is available.
 * @returns the form to install.
 */
export function resolveForm(mode: AylaMode, hasPending: boolean, hasOutboundText: boolean): AylaForm {
  if (mode === 'standalone') return 'standalone'
  if (mode === 'elyh') {
    if (!hasPending || !hasOutboundText) {
      const missing = [!hasPending ? 'inboundPending' : undefined, !hasOutboundText ? 'outboundText' : undefined]
        .filter((name): name is string => name !== undefined)
        .join('、')
      throw new Error('mode 设为 elyh，但缺少服务: ' + missing + '。请安装 conscious-mind，或把 mode 改为 standalone。')
    }
    return 'elyh'
  }
  return hasPending && hasOutboundText ? 'elyh' : 'standalone'
}

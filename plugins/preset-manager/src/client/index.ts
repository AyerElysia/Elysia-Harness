/**
 * Browser half: one left-sidebar entry that opens the Presets main panel. The
 * panel lists the roster, deletes the manager-owned presets, and navigates to
 * the dedicated create page with its tool-face configuration. It never creates
 * a session and never edits prompt content.
 *
 * @module @elysia/preset-manager/client
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
// Type-only: pulls the `ctx.slots` merge.
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { createPresetManagerApi } from './api.ts'
import { NS, en, zh, type PresetManagerLocaleKey } from './locales.ts'
import { PresetManagerIcon } from './PresetManagerIcon.tsx'
import { PresetManagerPage } from './PresetManagerPage.tsx'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Preset manager page copy. */
    presetManager: PresetManagerLocaleKey
  }
}

/** Services this plugin needs; all of them exist in the Web shell. */
export const inject = ['slots', 'locale', 'connection']

/** The id shared by the sidebar entry and the main panel it opens. */
export const PANEL_ID = 'presets' as MainPanelId

/** Sidebar position: after Plugins and Schedules, before future features. */
const PANEL_ORDER = 30

/**
 * Register the dictionaries, the sidebar entry, and the main panel; every
 * registration belongs to this plugin's fiber and leaves with it.
 * @param ctx - client root context.
 */
export function apply(ctx: Context): void {
  const { rpc } = ctx.get('connection') as ConnectionHandle
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'elysia-preset-manager: dictionaries')
  const t = ctx.locale.bind(NS)
  const api = createPresetManagerApi(rpc)
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: PANEL_ID,
    locale: NS,
    inject: () => ({ api }),
  }, PresetManagerPage))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: PANEL_ID,
    order: PANEL_ORDER,
    locale: NS,
    label: () => t('panel'),
  }, PresetManagerIcon))
}

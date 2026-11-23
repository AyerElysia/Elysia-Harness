/**
 * Browser half: one left-sidebar entry that opens the Capabilities main panel.
 * The panel lists sessions and presets, shows each preset's static (locked) tool
 * face, switches dynamic tool groups and per-session/preset subscriptions, and
 * reports the Host's health. It never creates a session, never edits a preset,
 * and never writes the Host's state document directly.
 *
 * @module @elysia/capability-host/client
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
import { createCapabilityPanelApi } from './api.ts'
import { NS, en, zh, type ControlPanelLocaleKey } from './locales.ts'
import { ControlPanelIcon } from './ControlPanelIcon.tsx'
import { ControlPanelPage } from './ControlPanelPage.tsx'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Capability panel copy. */
    controlPanel: ControlPanelLocaleKey
  }
}

/** Services this plugin needs; all of them exist in the Web shell. */
export const inject = ['slots', 'locale', 'connection']

/** The id shared by the sidebar entry and the main panel it opens. */
export const PANEL_ID = 'capabilities' as MainPanelId

/** Sidebar position: after Presets (30), before future features. */
const PANEL_ORDER = 40

/**
 * Register the dictionaries, the sidebar entry, and the main panel; every
 * registration belongs to this plugin's fiber and leaves with it.
 * @param ctx - client root context.
 */
export function apply(ctx: Context): void {
  const { rpc } = ctx.get('connection') as ConnectionHandle
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'elysia-control-panel: dictionaries')
  const t = ctx.locale.bind(NS)
  const api = createCapabilityPanelApi(rpc)
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: PANEL_ID,
    locale: NS,
    inject: () => ({ api }),
  }, ControlPanelPage))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: PANEL_ID,
    order: PANEL_ORDER,
    locale: NS,
    label: () => t('panel'),
  }, ControlPanelIcon))
}
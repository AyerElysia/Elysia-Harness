/**
 * Browser half: five native Conversation views named 工具, 事件, 日志, 健康 and
 * 预设. Each view renders one face of the ported capability panel for the
 * active session; there is no intermediate 能力 page and no drawer.
 *
 * @module @elysia/villv-helix/client
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { createVillvHelixApi } from './api.ts'
import { NS, en, zh, type ControlPanelLocaleKey } from './locales.ts'
import { ControlPanelPage, type ControlPanelPageInjected } from './ControlPanelPage.tsx'
import type { PanelTab } from './ControlPanelView.tsx'
import { HelixModeCapsule, type HelixModeCapsuleInjected } from './HelixModeCapsule.tsx'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** VillV-Helix capability panel copy. */
    villvHelix: ControlPanelLocaleKey
  }
}

/** Services this plugin needs; all of them exist in the Web shell. */
export const inject = ['slots', 'locale', 'connection']

/** One top-level view the panel contributes. */
interface HelixView {
  readonly id: string
  readonly tab: PanelTab
  readonly label: 'tabTools' | 'tabEvents' | 'tabLog' | 'tabHealth' | 'tabPreset'
  readonly order: number
}

const VIEWS: readonly HelixView[] = [
  { id: 'helix-tools', tab: 'tools', label: 'tabTools', order: 20 },
  { id: 'helix-events', tab: 'contexts', label: 'tabEvents', order: 21 },
  { id: 'helix-log', tab: 'events', label: 'tabLog', order: 22 },
  { id: 'helix-health', tab: 'health', label: 'tabHealth', order: 23 },
  { id: 'helix-preset', tab: 'static', label: 'tabPreset', order: 24 },
]

/**
 * Register the dictionaries and the five session-scoped views; every
 * registration belongs to this plugin's fiber and leaves with it.
 * @param ctx - client root context.
 */
export function apply(ctx: Context): void {
  const { rpc } = ctx.get('connection') as ConnectionHandle
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'villv-helix: dictionaries')
  const t = ctx.locale.bind(NS)
  ctx.slots.inject('conversation.view', function* () {
    for (const view of VIEWS) {
      yield ctx.slots.register({
        name: 'conversation.view',
        id: view.id,
        order: view.order,
        locale: NS,
        label: () => t(view.label),
        inject: (sessionId: SessionId): ControlPanelPageInjected => ({
          api: createVillvHelixApi(rpc, sessionId),
          tab: view.tab,
        }),
      }, ControlPanelPage)
    }
  })
  ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
    name: 'conversation.session.header.utilities',
    id: 'helix-mode',
    order: 10,
    locale: NS,
    inject: (sessionId: SessionId): HelixModeCapsuleInjected => ({
      api: createVillvHelixApi(rpc, sessionId),
    }),
  }, HelixModeCapsule))

  // New-session Hero: stage the same mode choice before the session exists, in
  // the row above the composer next to workspace and preset controls.
  ctx.slots.inject('conversation.hero.options', () => ctx.slots.register({
    name: 'conversation.hero.options',
    id: 'helix-mode-new',
    order: 10,
    locale: NS,
    inject: (sessionId: SessionId): HelixModeCapsuleInjected => ({
      api: createVillvHelixApi(rpc, sessionId),
    }),
  }, HelixModeCapsule))
}
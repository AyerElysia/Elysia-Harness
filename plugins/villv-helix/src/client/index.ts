/**
 * Browser half: two native Conversation views named 工具 and 预设. Each renders
 * the session's tool face; there is no intermediate 能力 page and no drawer.
 * Context subscriptions and the injection log live in `@elysia/context-gate`.
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
    /** VillV-Helix tool panel copy. */
    villvHelix: ControlPanelLocaleKey
  }
}

/** Services this plugin needs; all of them exist in the Web shell. */
export const inject = ['slots', 'locale', 'connection']

/** One top-level view the panel contributes. */
interface HelixView {
  readonly id: string
  readonly tab: PanelTab
  readonly label: 'tabTools' | 'tabPreset'
  readonly order: number
}

const VIEWS: readonly HelixView[] = [
  { id: 'helix-tools', tab: 'tools', label: 'tabTools', order: 20 },
  { id: 'helix-preset', tab: 'static', label: 'tabPreset', order: 21 },
]

/** Attribute the client puts on its own native tab buttons. */
export const HELIX_TAB_ATTRIBUTE = 'data-villv-helix-tab'

/**
 * Mark only the Helix tool/preset buttons in the native tab strip. The View
 * registry is root-scoped, so the client cannot make registration
 * session-conditional; the marker gives CSS a stable selector that does not
 * depend on the number of other views or on nth-child positions.
 * @param labels - localized tool and preset labels.
 * @returns nothing.
 */
function markHelixTabs(labels: { tools: string; preset: string }): void {
  const strip = document.querySelector('[data-conversation-tabs]')
  if (strip === null) return
  for (const button of strip.querySelectorAll(':scope > button[role="tab"]')) {
    const text = button.textContent?.trim()
    const marker = text === labels.tools ? 'tools' : text === labels.preset ? 'preset' : undefined
    if (marker === undefined) button.removeAttribute(HELIX_TAB_ATTRIBUTE)
    else button.setAttribute(HELIX_TAB_ATTRIBUTE, marker)
  }
}

/**
 * Install the tab marker observer for the lifetime of the client plugin. The
 * tab strip can mount after apply and locale changes can replace its text, so
 * observe the whole body rather than guessing a mount delay.
 * @param ctx - client root context.
 * @param labels - localized tool and preset labels.
 * @returns nothing.
 */
function installTabMarkers(ctx: Context, labels: { tools: string; preset: string }): void {
  ctx.effect(() => {
    const observer = new MutationObserver(() => { markHelixTabs(labels) })
    observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true })
    markHelixTabs(labels)
    return () => { observer.disconnect() }
  }, 'villv-helix:tab-markers')
}

/**
 * Register the dictionaries and the two session-scoped views; every
 * registration belongs to this plugin's fiber and leaves with it.
 * @param ctx - client root context.
 */
export function apply(ctx: Context): void {
  const { rpc } = ctx.get('connection') as ConnectionHandle
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'villv-helix: dictionaries')
  const t = ctx.locale.bind(NS)
  // The tab registry is root-scoped, so tag our two buttons by their localized
  // label; CSS then hides just these two when tool editing mode is off.
  installTabMarkers(ctx, { tools: t('tabTools'), preset: t('tabPreset') })
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
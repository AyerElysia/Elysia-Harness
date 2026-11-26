/**
 * Browser half: two native Conversation views named 事件 and 日志. They render
 * the context gate's per-session subscriptions and recent injection log.
 *
 * Both views are registered unconditionally: context subscriptions belong to
 * the session, not to the tool face, so they must work whether or not the
 * session orchestration mode is on and whether or not any tool plugin is
 * mounted.
 *
 * @module @elysia/context-gate/client
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { createContextGateApi } from './api.ts'
import { NS, en, zh, type ContextGateLocaleKey } from './locales.ts'
import { ContextGatePage, type ContextGatePageInjected } from './ContextGatePage.tsx'
import type { PanelTab } from './ContextGateView.tsx'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Context gate views copy. */
    contextGate: ContextGateLocaleKey
  }
}

/** Services this plugin needs; all of them exist in the Web shell. */
export const inject = ['slots', 'locale', 'connection']

/** One top-level view the context gate contributes. */
interface ContextView {
  readonly id: string
  readonly tab: PanelTab
  readonly label: 'tabEvents' | 'tabLog'
  readonly order: number
}

const VIEWS: readonly ContextView[] = [
  { id: 'context-gate-events', tab: 'events', label: 'tabEvents', order: 21 },
  { id: 'context-gate-log', tab: 'log', label: 'tabLog', order: 22 },
]

/**
 * Register the dictionaries and the two session-scoped views; every
 * registration belongs to this plugin's fiber and leaves with it.
 * @param ctx - client root context.
 */
export function apply(ctx: Context): void {
  const { rpc } = ctx.get('connection') as ConnectionHandle
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'context-gate: dictionaries')
  const t = ctx.locale.bind(NS)
  ctx.slots.inject('conversation.view', function* () {
    for (const view of VIEWS) {
      yield ctx.slots.register({
        name: 'conversation.view',
        id: view.id,
        order: view.order,
        locale: NS,
        label: () => t(view.label),
        inject: (sessionId: SessionId): ContextGatePageInjected => ({
          api: createContextGateApi(rpc, sessionId),
          tab: view.tab,
          sessionId,
        }),
      }, ContextGatePage)
    }
  })
}
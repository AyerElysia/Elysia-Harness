/** Browser half: an independently removable, session-scoped complete-prompt view. */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { ContextInspectorView, type ContextInspectorInjected } from './ContextInspectorView.tsx'
import { ContextMetricsMeter } from './ContextMetricsMeter.tsx'
import { en, NS, zh } from './locales.ts'

export const inject = ['slots', 'locale', 'connection']

/** Register one Conversation tab and let the plugin effect own locale/slot teardown. */
export function apply(ctx: Context): void {
  const { rpc } = ctx.get('connection') as ConnectionHandle
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'context-inspector: dictionaries')
  const t = ctx.locale.bind(NS)
  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: 'context-inspector',
    order: 20,
    locale: NS,
    label: () => t('view.label'),
    inject: (sessionId: SessionId): ContextInspectorInjected => ({
      inspectorSessionId: sessionId,
      inspectorRpc: rpc,
    }),
  }, ContextInspectorView))
  ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
    name: 'conversation.composer.dock',
    id: 'elysia-context-metrics',
    order: 20,
    locale: NS,
  }, ContextMetricsMeter))
}

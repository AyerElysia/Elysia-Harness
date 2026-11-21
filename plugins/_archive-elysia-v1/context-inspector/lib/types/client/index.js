import { ContextInspectorView } from "./ContextInspectorView.js";
import { ContextMetricsMeter } from "./ContextMetricsMeter.js";
import { en, NS, zh } from "./locales.js";
export const inject = ['slots', 'locale', 'connection'];
/** Register one Conversation tab and let the plugin effect own locale/slot teardown. */
export function apply(ctx) {
    const { rpc } = ctx.get('connection');
    ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'context-inspector: dictionaries');
    const t = ctx.locale.bind(NS);
    ctx.slots.inject('conversation.view', () => ctx.slots.register({
        name: 'conversation.view',
        id: 'context-inspector',
        order: 20,
        locale: NS,
        label: () => t('view.label'),
        inject: (sessionId) => ({
            inspectorSessionId: sessionId,
            inspectorRpc: rpc,
        }),
    }, ContextInspectorView));
    ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
        name: 'conversation.composer.dock',
        id: 'elysia-context-metrics',
        order: 20,
        locale: NS,
    }, ContextMetricsMeter));
}
//# sourceMappingURL=index.js.map
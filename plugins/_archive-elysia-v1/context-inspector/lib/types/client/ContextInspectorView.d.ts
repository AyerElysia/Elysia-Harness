import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client';
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import type { ClientConnectionRpc } from '@deepseek-ai/dsh-client-connection/client';
import type { NS } from './locales.ts';
export interface ContextInspectorInjected {
    readonly inspectorSessionId: string;
    readonly inspectorRpc: Pick<ClientConnectionRpc, 'call'>;
}
type LocaleProps = PropsLocale<typeof NS>;
/** Session key prevents an earlier session's retained prompt flashing during navigation. */
export declare function ContextInspectorView({ inspectorSessionId, inspectorRpc, t, }: ConvViewProps & InjectFace<ContextInspectorInjected> & LocaleProps): import("react").JSX.Element;
export {};
//# sourceMappingURL=ContextInspectorView.d.ts.map
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import type { ContextMetrics } from '../metrics-types.ts';
import type { NS } from './locales.ts';
import './context-meter-compat.css';
type Locale = PropsLocale<typeof NS>;
export declare function ContextMetricsMeter({ useProjection, t }: PropsRuntime<'conversation.composer.dock'> & Locale): import("react").JSX.Element;
export declare function ContextMetricsDisplay({ metrics, t }: {
    metrics: ContextMetrics | undefined;
} & Locale): import("react").JSX.Element | null;
export {};
//# sourceMappingURL=ContextMetricsMeter.d.ts.map
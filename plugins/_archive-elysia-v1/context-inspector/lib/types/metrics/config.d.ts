/** Deployment choices for the independent context metrics projection. */
import z from '@deepseek-ai/schemastery';
import type { CounterOptions } from './counter.ts';
export interface MetricsConfig {
    enabled?: boolean;
    tokenizerEnabled?: boolean;
    assetDirectory?: string;
    modelIds?: string[];
    providerIds?: string[];
    maxTextBytes?: number;
    cacheEntries?: number;
    asciiTokensPerCharacter?: number;
    cjkTokensPerCharacter?: number;
    otherTokensPerByte?: number;
}
export interface ResolvedMetricsConfig extends Omit<CounterOptions, 'enabled'> {
    enabled: boolean;
    tokenizerEnabled: boolean;
}
export declare const MetricsConfig: z<MetricsConfig, ResolvedMetricsConfig>;
//# sourceMappingURL=config.d.ts.map
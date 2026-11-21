import type { TextCounter } from './counter-types.ts';
export interface CounterOptions {
    enabled: boolean;
    assetDirectory: string;
    modelIds: string[];
    providerIds: string[];
    maxTextBytes: number;
    cacheEntries: number;
    asciiTokensPerCharacter: number;
    cjkTokensPerCharacter: number;
    otherTokensPerByte: number;
}
export interface DisposableTextCounter extends TextCounter {
    dispose(): void;
}
/** A complete-text fallback with explicit configurable densities, not a model token count. */
export declare function heuristicTextTokens(text: string, options: CounterOptions): number;
/** Load once; each counted body retains only a digest and numeric prices in a bounded cache. */
export declare function createTextCounter(options: CounterOptions): Promise<DisposableTextCounter>;
//# sourceMappingURL=counter.d.ts.map
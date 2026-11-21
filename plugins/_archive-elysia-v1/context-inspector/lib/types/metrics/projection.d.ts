import { z } from 'zod';
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection';
import type { TextCounter } from './counter-types.ts';
declare const stateBaseSchema: any;
/** Numeric-only checkpoint; no message, prompt, tool schema or original header text. */
export type ContextMetricsState = z.infer<typeof stateBaseSchema>;
declare module '@deepseek-ai/dsh-session-projection/types' {
    interface SessionProjectionStateMap {
        elysiaContextMetrics: ContextMetricsState;
    }
}
type ContextMetricsProjection = Omit<ProjectionDefinition<'elysiaContextMetrics', ContextMetricsState>, 'wire'> & {
    wire: NonNullable<ProjectionDefinition<'elysiaContextMetrics', ContextMetricsState>['wire']>;
};
/**
 * Build one scope-owned metrics unit with a cache-invalidating counter identity.
 * Current totals are always recomputed from retained nodes, never old API residuals.
 * @param counter - initialized local counter retained for this registration.
 * @param fingerprint - counter/model asset/configuration identity for checkpoint validation.
 * @returns pure native projection definition; register through the caller's effect scope.
 */
export declare function createContextMetricsProjection(counter: TextCounter, fingerprint: string): ContextMetricsProjection;
export {};
//# sourceMappingURL=projection.d.ts.map
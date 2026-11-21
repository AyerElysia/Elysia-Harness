/** Read-only, session-authorized inspection of immutable framework request archives. */
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { type InspectorConfig } from './server/controller.ts';
import { MetricsConfig } from './metrics/config.ts';
export type * from './types.ts';
export type * from './metrics-types.ts';
export { ContextInspector } from './server/controller.ts';
export { SnapshotReader } from './server/reader.ts';
export declare const name = "elysia-context-inspector";
export declare const inject: string[];
export declare const DEFAULT_ARCHIVE_DIR: string;
export interface Config {
    dir?: string;
    maxArchiveBytes?: number;
    maxCacheBytes?: number;
    maxWorkers?: number;
    maxChunkBytes?: number;
    workerTimeoutMs?: number;
    metrics?: MetricsConfig;
}
interface ResolvedPluginConfig extends InspectorConfig {
    metrics?: MetricsConfig;
}
export declare const Config: z<Config, ResolvedPluginConfig>;
export declare function apply(ctx: Context, config: Config): Promise<void>;
//# sourceMappingURL=index.d.ts.map
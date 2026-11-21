import z from '@deepseek-ai/schemastery';
import { join, resolve } from 'node:path';
import { ContextInspector } from "./server/controller.js";
import { MetricsConfig } from "./metrics/config.js";
import { createTextCounter } from "./metrics/counter.js";
import { createContextMetricsProjection } from "./metrics/projection.js";
export { ContextInspector } from "./server/controller.js";
export { SnapshotReader } from "./server/reader.js";
export const name = 'elysia-context-inspector';
export const inject = ['typert', 'remoteAccess', 'sessionController', 'sessionProjections'];
export const DEFAULT_ARCHIVE_DIR = process.env.ELYSIA_REQUESTS_DIR
    ?? join(process.env.DSH_HOME ?? '/home/ayerelysia/Elysia/Elysium/Elysia-Harness/homes/web', 'requests');
export const Config = z.object({
    dir: z.string().default(DEFAULT_ARCHIVE_DIR),
    maxArchiveBytes: z.natural().min(1).max(64 * 1024 * 1024).default(8 * 1024 * 1024),
    maxCacheBytes: z.natural().min(1).max(256 * 1024 * 1024).default(32 * 1024 * 1024),
    maxWorkers: z.natural().min(1).max(4).default(2),
    maxChunkBytes: z.natural().min(4).max(65536).default(65536),
    workerTimeoutMs: z.natural().min(1).max(60000).default(10000),
    metrics: MetricsConfig.default({}),
});
const metricsOwners = new WeakSet();
export async function apply(ctx, config) {
    const resolved = Config(config);
    const metrics = MetricsConfig(resolved.metrics ?? {});
    let removeMetrics;
    let releaseOwner;
    let counter;
    try {
        if (metrics.enabled) {
            const registry = ctx.sessionProjections;
            releaseOwner = ctx.effect(() => {
                if (metricsOwners.has(registry))
                    throw new Error('Context metrics already has an owner');
                metricsOwners.add(registry);
                return () => { metricsOwners.delete(registry); };
            }, 'context-inspector.metrics-owner');
            const activeCounter = await createTextCounter({ ...metrics, enabled: metrics.tokenizerEnabled });
            counter = activeCounter;
            removeMetrics = ctx.effect(() => {
                let unregister;
                try {
                    unregister = registry.register(createContextMetricsProjection(activeCounter, activeCounter.id));
                }
                catch (error) {
                    activeCounter.dispose();
                    throw error;
                }
                return () => { try {
                    unregister?.();
                }
                finally {
                    activeCounter.dispose();
                } };
            }, 'context-inspector.metrics');
        }
        await ctx.plugin(ContextInspector, { ...resolved, dir: resolve(resolved.dir) });
    }
    catch (error) {
        try {
            removeMetrics?.();
        }
        finally {
            counter?.dispose();
            releaseOwner?.();
        }
        throw error;
    }
}
//# sourceMappingURL=index.js.map
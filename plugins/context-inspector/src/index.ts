/** Read-only, session-authorized inspection of immutable framework request archives. */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { join, resolve } from 'node:path'
import { ContextInspector, type InspectorConfig } from './server/controller.ts'

export type * from './types.ts'
export { ContextInspector } from './server/controller.ts'
export { SnapshotReader } from './server/reader.ts'

export const name = 'elysia-context-inspector'
export const inject = ['typert', 'remoteAccess', 'sessionController']
export const DEFAULT_ARCHIVE_DIR = process.env.ELYSIA_REQUESTS_DIR
  ?? join(process.env.DSH_HOME ?? '/home/ayerelysia/Elysia/Elysium/Elysia-Harness/homes/web', 'requests')

export interface Config {
  dir?: string
  maxArchiveBytes?: number
  maxCacheBytes?: number
  maxWorkers?: number
  maxChunkBytes?: number
  workerTimeoutMs?: number
}
export const Config: z<Config, InspectorConfig> = z.object({
  dir: z.string().default(DEFAULT_ARCHIVE_DIR),
  maxArchiveBytes: z.natural().min(1).max(64 * 1024 * 1024).default(8 * 1024 * 1024),
  maxCacheBytes: z.natural().min(1).max(256 * 1024 * 1024).default(32 * 1024 * 1024),
  maxWorkers: z.natural().min(1).max(4).default(2),
  maxChunkBytes: z.natural().min(4).max(65536).default(65536),
  workerTimeoutMs: z.natural().min(1).max(60000).default(10000),
})

export async function apply(ctx: Context, config: Config): Promise<void> {
  const resolved = Config(config)
  await ctx.plugin(ContextInspector, { ...resolved, dir: resolve(resolved.dir) })
}

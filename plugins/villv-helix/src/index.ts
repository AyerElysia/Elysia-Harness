/**
 * Host entry of Elysia/VillV-Helix: mount the session-scoped orchestrator
 * service. The browser half is declared by `dsh.client`; the Conversation view
 * talks to the `villvHelix` Remote namespace served here.
 *
 * The plugin registers no tools of its own, has no global/preset switch, and
 * does not depend on a capability core.
 *
 * @module @elysia/villv-helix
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { VillVHelix, type HostConfig } from './service.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'villv-helix'

/** Prerequisite services of the Host row. */
export const inject = ['agents', 'tools']

/** Where the per-session document lives and how delivery is bounded. */
export interface Config {
  /** Absolute directory holding the panel document. */
  stateDir: string
  /** Default age ceiling for an undelivered context event. */
  contextTtlMs?: number
  /** Default per-event size ceiling. */
  contextMaxBytes?: number
  /** Default undelivered events retained per session. */
  contextQueueDepth?: number
  /** Maximum events merged into one snapshot. */
  snapshotMaxEvents?: number
  /** Maximum bytes of one merged snapshot. */
  snapshotMaxBytes?: number
}

/** Validation and defaults for {@link Config}. */
export const Config: z<Config> = z.object({
  stateDir: z.string().required(),
  contextTtlMs: z.number().default(15 * 60_000),
  contextMaxBytes: z.number().default(65_536),
  contextQueueDepth: z.number().default(64),
  snapshotMaxEvents: z.number().default(16),
  snapshotMaxBytes: z.number().default(8_192),
})

/**
 * Mount the Host and wait for its document and relay listener.
 * @param ctx - host context carrying `agents` and `tools`.
 * @param config - state directory and delivery limits.
 * @throws when the state directory is unusable.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const host = new VillVHelix(ctx, resolveConfig(config))
  await host.ready
}

/**
 * Apply the documented defaults to a config the loader supplied.
 * @param config - validated or partial configuration.
 * @returns the resolved Host configuration.
 */
export function resolveConfig(config: Config): HostConfig {
  return {
    stateDir: config.stateDir,
    context: {
      ttlMs: config.contextTtlMs ?? 15 * 60_000,
      maxBytes: config.contextMaxBytes ?? 65_536,
      maxQueueDepth: config.contextQueueDepth ?? 64,
    },
    maxEventsPerSnapshot: config.snapshotMaxEvents ?? 16,
    maxSnapshotBytes: config.snapshotMaxBytes ?? 8_192,
  }
}

export { VillVHelix } from './service.ts'
export type { HelixChange } from './service.ts'
export { RELAY_SECTION, RELAY_SOURCE } from './context-bus.ts'
export type * from './types.ts'
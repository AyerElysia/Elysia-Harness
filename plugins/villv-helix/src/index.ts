/**
 * Host entry of Elysia/VillV-Helix: mount the session-scoped tool-panel
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

/** Where the per-session document lives. */
export interface Config {
  /** Absolute directory holding the panel document. */
  stateDir: string
}

/** Validation and defaults for {@link Config}. */
export const Config: z<Config> = z.object({
  stateDir: z.string().required(),
})

/**
 * Mount the Host and wait for its document.
 * @param ctx - host context carrying `agents` and `tools`.
 * @param config - state directory.
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
  return { stateDir: config.stateDir }
}

export { VillVHelix } from './service.ts'
export type { HelixChange } from './service.ts'
export type * from './types.ts'

/**
 * Host entry of the capability panel. The panel is an optional consumer of
 * `@elysia/capability-core`: this half only ensures the shared core exists and
 * leaves the client declaration to `dsh.client`.
 *
 * @module @elysia/capability-panel
 */

import type { Context } from '@deepseek-ai/cordis'
import { ensureCapabilityCore } from '@elysia/capability-core'
import { Config as CoreConfig } from '@elysia/capability-core'

export const name = 'elysia-capability-panel'

/** The panel needs the same registries the core does. */
export const inject = ['agents', 'tools']

/** Re-exported so the profile row keeps its existing config schema. */
export type Config = CoreConfig
export const Config = CoreConfig

/**
 * Ensure the Host-only core is mounted, then let the panel client talk to it.
 * @param ctx - host context.
 * @param config - core state directory and delivery limits.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  await ensureCapabilityCore(ctx, config)
}
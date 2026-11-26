/**
 * Mount the shared capability core once per application root.
 *
 * The panel and preset-manager both need the same tool-state service, but
 * neither may depend on the other. This helper creates a root-owned core fiber
 * on first use; the second consumer sees the provided service and reuses it.
 *
 * @module @elysia/capability-core/ensure
 */

import type { Context } from '@deepseek-ai/cordis'
import type { CapabilityHost } from './service.ts'
import * as corePlugin from './plugin.ts'
import type { Config } from './plugin.ts'

/** One in-flight/finished mount per root context, so two consumers cannot race. */
const mounts = new WeakMap<Context, Promise<CapabilityHost>>()

/**
 * Read the existing core or mount it at the application root.
 * @param ctx - any context in the application tree.
 * @param config - core state directory and delivery limits, used only on the
 *   first mount.
 * @returns the shared core service.
 */
export async function ensureCapabilityCore(ctx: Context, config: Config): Promise<CapabilityHost> {
  const root = ctx.root
  const existing = root.get('capabilityHost')
  if (existing !== undefined) return existing

  let pending = mounts.get(root)
  if (pending === undefined) {
    pending = (async () => {
      const fiber = await root.plugin(corePlugin, config)
      const service = root.get('capabilityHost')
      if (service === undefined) {
        await fiber.dispose()
        throw new Error('capability core mounted without providing capabilityHost')
      }
      await service.ready
      return service
    })()
    mounts.set(root, pending)
    void pending.catch(() => { mounts.delete(root) })
  }
  return pending
}

/**
 * Host-only capability core. Provides the shared tool catalog/state/gate/guard
 * service consumed by the panel and other tool-providing plugins.
 *
 * @module @elysia/capability-core
 */

export * from './plugin.ts'
export { ensureCapabilityCore } from './ensure.ts'

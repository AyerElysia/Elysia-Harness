/**
 * Host entry of the capability panel. It mounts one service, opens the panel
 * document, and attaches the single `agent/pre-step` relay listener. No
 * profile row is added here: a deployment composes this package through its
 * bundle patch.
 *
 * @module @elysia/capability-host
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { HostState } from './types.ts'
import { CapabilityHost, type HostConfig } from './service.ts'

export const name = 'elysia-capability-host'

/** Registries this Host contributes to. */
export const inject = ['agents', 'tools']

/** Where the panel document lives and how delivery is bounded. */
export interface Config {
  /** Absolute directory holding the panel document. */
  stateDir: string
  /** Initial delivery state; `paused` queues without injecting. */
  hostState?: HostState
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
  /** Principal allowed to change switches; absent admits any in-process caller. */
  ownerId?: string
}

/** Validation and defaults for {@link Config}. */
export const Config: z<Config> = z.object({
  stateDir: z.string().required(),
  hostState: z.union(['enabled', 'paused']).default('enabled'),
  contextTtlMs: z.number().default(15 * 60_000),
  contextMaxBytes: z.number().default(65_536),
  contextQueueDepth: z.number().default(64),
  snapshotMaxEvents: z.number().default(16),
  snapshotMaxBytes: z.number().default(8_192),
  ownerId: z.string(),
})

/**
 * Mount the Host and wait for its document and relay listener.
 * @param ctx - host context carrying `agents` and `tools`.
 * @param config - state directory, delivery limits, and optional owner.
 * @throws when the state directory is unusable or a required field is missing.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const host = new CapabilityHost(ctx, resolveConfig(config))
  await host.ready
}

/**
 * Apply the documented defaults to a config the loader or a test supplied.
 * @param config - validated or partial configuration.
 * @returns the resolved Host configuration.
 */
function resolveConfig(config: Config): HostConfig {
  return {
    stateDir: config.stateDir,
    hostState: config.hostState ?? 'enabled',
    context: {
      ttlMs: config.contextTtlMs ?? 15 * 60_000,
      maxBytes: config.contextMaxBytes ?? 65_536,
      maxQueueDepth: config.contextQueueDepth ?? 64,
    },
    maxEventsPerSnapshot: config.snapshotMaxEvents ?? 16,
    maxSnapshotBytes: config.snapshotMaxBytes ?? 8_192,
    ...(config.ownerId === undefined ? {} : { ownerId: config.ownerId }),
  }
}

export { CapabilityHost } from './service.ts'
export type { AuditEntry, CapabilityChange, HostConfig } from './service.ts'
export { STATIC_TOOL_MODULES } from './contracts.ts'
export type {
  CatalogRecord, ContextDefaults, ContextKindRegistration, ResolvedContextKind, ToolCatalogEntry,
  ToolFactory, ToolFailureMode,
} from './contracts.ts'
export { StaticToolProbe } from './static-tools.ts'
export type { StaticToolEntry, StaticToolSnapshot } from './static-tools.ts'
export { CapabilityHostError, describeError } from './errors.ts'
export type { CapabilityErrorCode } from './errors.ts'
export { DOCUMENT_FILE_NAME, DOCUMENT_VERSION } from './state.ts'
export type { CapabilityDocument, QueueRecord, ScopeStateRecord } from './state.ts'
export { RELAY_SECTION, RELAY_SOURCE } from './context-bus.ts'
export { AGENT_PROBE_TOOL, GLOBAL_PROBE_TOOL } from './probe-tools.ts'
export type * from './types.ts'

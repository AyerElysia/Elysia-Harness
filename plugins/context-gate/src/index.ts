/**
 * Host entry of Elysia/Context-Gate: mount the generic context-event service.
 * The browser half is declared by `dsh.client`; the Conversation views talk to
 * the `contextGate` Remote namespace served here.
 *
 * The gate is independent of VillV-Helix and of its tool editing mode. It
 * registers no tools, owns no health surface, and has no global enable flag.
 * Providers publish the generic envelope (origin/params/content/causation);
 * the gate owns subscription, queueing, TTL, dedupe, backpressure, and
 * injection.
 *
 * @module @elysia/context-gate
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { ContextGate, type HostConfig } from './service.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'context-gate'

/** Prerequisite services of the Host row. */
export const inject = ['agents']

/** Where the gate document lives, how delivery is bounded, and how wakes batch. */
export interface Config {
  /** Absolute directory holding the gate document. */
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
  /** Quiet window after the first active event, in milliseconds. */
  batchMs?: number
  /** Total postponement ceiling from the first active event, in milliseconds. */
  maxWaitMs?: number
}

/** Validation and defaults for {@link Config}. */
export const Config: z<Config> = z.object({
  stateDir: z.string().required(),
  contextTtlMs: z.number().default(15 * 60_000),
  contextMaxBytes: z.number().default(65_536),
  contextQueueDepth: z.number().default(64),
  snapshotMaxEvents: z.number().default(16),
  snapshotMaxBytes: z.number().default(8_192),
  batchMs: z.number().default(1_200),
  maxWaitMs: z.number().default(5_000),
})

/**
 * Mount the Host and wait for its document and relay listener.
 * @param ctx - host context carrying `agents`.
 * @param config - state directory, delivery limits, and batching.
 * @throws when the state directory is unusable.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const host = new ContextGate(ctx, resolveConfig(config))
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
    batchMs: config.batchMs ?? 1_200,
    maxWaitMs: config.maxWaitMs ?? 5_000,
  }
}

export { ContextGate } from './service.ts'
export { RELAY_SECTION, RELAY_SOURCE } from './context-bus.ts'
export type { ContextAgent, ContextBusOptions } from './context-bus.ts'
export type * from './types.ts'
/**
 * Host entry of Elysia/Context-Gate: mount the context-event service, its time
 * engine, its merged custom-event rule engine, and their model tools. The
 * browser half is declared by `dsh.client`; the Conversation views talk to the
 * `contextGate` Remote namespace served here.
 *
 * The gate is independent of VillV-Helix and of its tool editing mode. It
 * registers no health surface and has no global enable flag. Providers publish
 * the generic envelope (origin/params/content/causation); the gate owns
 * subscription, queueing, TTL, dedupe, backpressure, injection, timers, and the
 * custom-event rules.
 *
 * Native DSH Schedule is not imported, mounted, or intercepted.
 *
 * @module @elysia/context-gate
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { ContextGate, type HostConfig } from './service.ts'
import { registerContextGateTools, TOOL_NAME_ZH } from './tools.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'context-gate'

/** Prerequisite services of the Host row. */
export const inject = ['agents']

/** Where the gate document lives, how delivery is bounded, and how wakes and engines batch. */
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
  /** Scheduler wake interval for timers, absence, and time rules. */
  tickMs?: number
  /** Timer instances one session may own. */
  maxTimersPerSession?: number
  /** Timer presets in the shared library. */
  maxPresets?: number
  /** Absence watchers one session may own. */
  maxAbsencesPerSession?: number
  /** Custom-event rules one session may own. */
  maxRulesPerSession?: number
  /** Hostnames an HTTP-poll rule may reach; empty denies every URL. */
  ruleHttpAllowedHosts?: string[]
  /** HTTP-poll request timeout. */
  ruleHttpTimeoutMs?: number
  /** Largest HTTP-poll response body. */
  ruleHttpMaxBytes?: number
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
  tickMs: z.number().default(250),
  maxTimersPerSession: z.number().default(64),
  maxPresets: z.number().default(64),
  maxAbsencesPerSession: z.number().default(32),
  maxRulesPerSession: z.number().default(64),
  ruleHttpAllowedHosts: z.array(z.string()).default([]),
  ruleHttpTimeoutMs: z.number().default(10_000),
  ruleHttpMaxBytes: z.number().default(65_536),
})

/**
 * Mount the Host, register the model tools, and wait for its document and engines.
 * @param ctx - host context carrying `agents` and optionally `tools`.
 * @param config - state directory, delivery limits, batching, and engine limits.
 * @throws when the state directory is unusable.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const host = new ContextGate(ctx, resolveConfig(config))
  registerContextGateTools(ctx, host)
  registerToolNames(ctx)
  await host.ready
}

/**
 * Supply the Chinese display names to the optional orchestrator. This is
 * display metadata only: registration and visibility never depend on it.
 * @param ctx - Host context.
 */
function registerToolNames(ctx: Context): void {
  ctx.inject(['villvHelix'], (scope) => {
    const helix = scope.get('villvHelix') as
      | { registerToolName(toolId: string, nameZh: string): () => void }
      | undefined
    if (helix === undefined) return
    for (const [toolId, nameZh] of Object.entries(TOOL_NAME_ZH)) {
      scope.effect(() => helix.registerToolName(toolId, nameZh), `context-gate.tool-name.${toolId}`)
    }
  })
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
    tickMs: config.tickMs ?? 250,
    maxTimersPerSession: config.maxTimersPerSession ?? 64,
    maxPresets: config.maxPresets ?? 64,
    maxAbsencesPerSession: config.maxAbsencesPerSession ?? 32,
    maxRulesPerSession: config.maxRulesPerSession ?? 64,
    ruleHttpAllowedHosts: config.ruleHttpAllowedHosts ?? [],
    ruleHttpTimeoutMs: config.ruleHttpTimeoutMs ?? 10_000,
    ruleHttpMaxBytes: config.ruleHttpMaxBytes ?? 65_536,
  }
}

export { ContextGate } from './service.ts'
export { RELAY_SECTION, RELAY_SOURCE } from './context-bus.ts'
export type { ContextAgent, ContextBusOptions, DirectEventInput } from './context-bus.ts'
export { TimeEngine, nextAfter, firstDue, resolveSchedule } from './time-engine.ts'
export { RuleEngine, ruleKind } from './rules.ts'
export { buildContextGateTools, TOOL_NAME_ZH } from './tools.ts'
export type * from './types.ts'
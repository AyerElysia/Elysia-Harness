/**
 * The step gate: it answers whether one **dynamic** tool is on for one Agent
 * right now.
 *
 * Static tools never reach this gate. They are part of a preset's composition,
 * always on, and locked against panel writes. Merging is therefore fixed by the
 * v1.2 contract: a preset switch applies to its sessions, and a session switch
 * either adds a dynamic tool or overrides the preset with an explicit `false`.
 * An unlisted dynamic tool is off. The gate is a pure in-memory read, because
 * `when` runs during step preparation.
 *
 * @module @elysia/capability-host/gate
 */

import type { GateStatus, ScopeRef, SwitchOrigin } from './types.ts'
import type { CapabilityStateStore } from './state.ts'
import type { DiagnosticLog } from './diagnostics.ts'
import { CapabilityHostError, describeError } from './errors.ts'
import type { ToolFailureMode } from './contracts.ts'

/** The part of an Agent the gate reads. */
export interface GateAgent {
  /** Session identity; the switch key and the preset lookup key. */
  readonly session: { readonly id: string }
}

/** The gate's own accounting, reported by `status()`. */
interface GateCounters {
  evaluated: number
  errorCount: number
  lastError: string | undefined
  lastErrorLoud: boolean
}

/**
 * Decide one dynamic tool's availability for one Agent.
 *
 * A failure while resolving state is contained for an optional extension (hide
 * it, record a diagnostic) and rethrown for a fail-loud group such as `reply`,
 * whose disappearance would leave a session unable to answer.
 */
export class ToolGate {
  private readonly counters: GateCounters = { evaluated: 0, errorCount: 0, lastError: undefined, lastErrorLoud: false }

  /**
   * @param store - switch document the gate reads.
   * @param presetOf - preset a session runs, live or recorded.
   * @param diagnostics - sink for contained failures.
   */
  private readonly store: CapabilityStateStore
  private readonly presetOf: (sessionId: string) => string | undefined
  private readonly diagnostics: DiagnosticLog

  constructor(
    store: CapabilityStateStore,
    presetOf: (sessionId: string) => string | undefined,
    diagnostics: DiagnosticLog,
  ) {
    this.store = store
    this.presetOf = presetOf
    this.diagnostics = diagnostics
  }

  /**
   * Resolve one dynamic tool's effective state without catching failures.
   * @param agent - Agent whose step is being prepared; absent for a programmatic call.
   * @param toolId - dynamic catalog id.
   * @returns whether the tool participates in this Agent's step.
   */
  enabled(agent: GateAgent | undefined, toolId: string): boolean {
    this.counters.evaluated += 1
    // A dynamic extension cannot be decided for a caller with no session: fail closed.
    if (agent === undefined) return false
    const sessionRef: ScopeRef = { kind: 'session', id: agent.session.id }
    const own = this.store.switchValue(sessionRef, 'tools', toolId)
    if (own !== undefined) return own
    const presetId = this.presetOf(agent.session.id)
    if (presetId === undefined) return false
    const inherited = this.store.switchValue({ kind: 'preset', id: presetId }, 'tools', toolId)
    return inherited ?? false
  }

  /**
   * Resolve one tool's state the way `when` needs it, containing failures.
   * @param agent - Agent whose step is being prepared.
   * @param toolId - dynamic catalog id.
   * @param failureMode - `loud` rethrows a resolution failure, failing the step.
   * @returns whether the tool participates in this step.
   * @throws CapabilityHostError `GATE_FAILED` when a fail-loud entry cannot be resolved.
   */
  evaluate(agent: GateAgent | undefined, toolId: string, failureMode: ToolFailureMode = 'closed'): boolean {
    try {
      return this.enabled(agent, toolId)
    } catch (error: unknown) {
      this.counters.errorCount += 1
      this.counters.lastError = describeError(error)
      this.counters.lastErrorLoud = failureMode === 'loud'
      const message = `gate failed for tool ${JSON.stringify(toolId)}: ${describeError(error)}`
      if (failureMode === 'loud') throw new CapabilityHostError('GATE_FAILED', message, { toolId })
      this.diagnostics.report({ code: 'GATE_FAILED', message, toolId })
      return false
    }
  }

  /**
   * Explain which layer decided one switch.
   * @param ref - scope being described.
   * @param toolId - dynamic catalog id.
   * @returns the overriding layer, or `default`.
   */
  origin(ref: ScopeRef, toolId: string): SwitchOrigin {
    return this.store.switchOrigin(ref, 'tools', toolId)
  }

  /**
   * Merge one scope's effective dynamic switches over the given catalog ids.
   * @param ref - scope to merge; a session scope folds in its preset.
   * @param ids - dynamic catalog ids to report.
   * @returns explicit on/off per id after preset and session merging.
   */
  merged(ref: ScopeRef, ids: readonly string[]): Record<string, boolean> {
    const merged: Record<string, boolean> = {}
    for (const id of ids) {
      if (ref.kind === 'preset') {
        merged[id] = this.store.switchValue(ref, 'tools', id) ?? false
        continue
      }
      const own = this.store.switchValue(ref, 'tools', id)
      if (own !== undefined) {
        merged[id] = own
        continue
      }
      const presetId = this.presetOf(ref.id)
      merged[id] = presetId === undefined
        ? false
        : this.store.switchValue({ kind: 'preset', id: presetId }, 'tools', id) ?? false
    }
    return merged
  }

  /** Gate accounting for `status()`. */
  status(): GateStatus {
    return {
      evaluated: this.counters.evaluated,
      errorCount: this.counters.errorCount,
      ...(this.counters.lastError === undefined ? {} : { lastError: this.counters.lastError }),
      lastErrorLoud: this.counters.lastErrorLoud,
    }
  }
}

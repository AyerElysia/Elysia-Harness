/**
 * The Host's bounded diagnostic log. Problems that must not stop the panel —
 * an unknown stored tool id, a missing provider service, a refused publication —
 * are recorded here and surfaced by `status()` instead of being dropped.
 *
 * @module @elysia/capability-core/diagnostics
 */

import type { Diagnostic, ScopeRef } from './types.ts'

/** One reported problem, before its timestamp is added. */
export interface DiagnosticInput {
  /** Stable code such as `UNKNOWN_TOOL`. */
  readonly code: string
  /** Human-readable explanation. */
  readonly message: string
  /** Scope the problem belongs to. */
  readonly scope?: ScopeRef
  /** Tool the problem belongs to. */
  readonly toolId?: string
  /** Context kind the problem belongs to. */
  readonly eventKind?: string
}

/** Retained diagnostics; the oldest entry is dropped past the limit. */
export class DiagnosticLog {
  private readonly entries: Diagnostic[] = []

  /**
   * @param limit - maximum retained entries.
   */
  private readonly limit: number

  constructor(limit = 200) {
    this.limit = limit
  }

  /**
   * Record one problem.
   * @param input - the problem to record.
   */
  report(input: DiagnosticInput): void {
    this.entries.push({
      code: input.code,
      message: input.message,
      at: new Date().toISOString(),
      ...(input.scope === undefined ? {} : { scope: input.scope }),
      ...(input.toolId === undefined ? {} : { toolId: input.toolId }),
      ...(input.eventKind === undefined ? {} : { eventKind: input.eventKind }),
    })
    while (this.entries.length > this.limit) this.entries.shift()
  }

  /** Every retained entry, oldest first. */
  list(): readonly Diagnostic[] {
    return this.entries
  }
}

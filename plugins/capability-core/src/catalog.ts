/**
 * The dynamic tool catalog: every switchable definition this deployment offers,
 * plus the registration the Host owns for global entries.
 *
 * A global entry is registered once, with `when` reading the step gate, so a
 * switch change takes effect on the next step without re-registration. An
 * agent-scoped entry is never registered here: the generic Capability Set row
 * mounts it in the Agent or preset scope that owns its services.
 *
 * A preset's static tool face is not part of this catalog and does not change
 * what is registered here. Static and dynamic tools may share an id: the preset
 * registers its static tool in its own scope, and DSH's scoped layers shadow the
 * global registration only for that scope's Agents. Every other preset keeps the
 * dynamic tool. The panel derives per-scope shadowing from the static rows.
 *
 * @module @elysia/capability-core/catalog
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { CatalogRecord, ToolCatalogEntry } from './contracts.ts'
import type { DiagnosticLog } from './diagnostics.ts'
import type { ToolGate } from './gate.ts'
import type { ScopeRef } from './types.ts'
import { CapabilityHostError, describeError } from './errors.ts'

/** One catalog slot; the mutable fields are what registration observed. */
interface CatalogSlot {
  readonly entry: ToolCatalogEntry
  schema: ToolDefinition | undefined
  registered: boolean
  reason: string | undefined
  /** Set while the global registration lives. */
  dispose: (() => void) | undefined
  /** Whether a missing-service diagnostic was already recorded for this slot. */
  failureNoted: boolean
}

/**
 * Collect dynamic definitions and own the registrations the Host makes.
 *
 * Every registration is made through the Host context, so disposing the Host
 * fiber removes it; {@link dispose} exists for an explicit remount.
 */
export class ToolCatalog {
  private readonly slots = new Map<string, CatalogSlot>()
  private readonly disposers = new Set<() => void>()

  /**
   * @param ctx - Host context that owns global registrations.
   * @param gate - step gate every global registration consults.
   * @param diagnostics - sink for entries that could not be registered.
   */
  private readonly ctx: Context
  private readonly gate: ToolGate
  private readonly diagnostics: DiagnosticLog

  constructor(
    ctx: Context,
    gate: ToolGate,
    diagnostics: DiagnosticLog,
  ) {
    this.ctx = ctx
    this.gate = gate
    this.diagnostics = diagnostics
  }

  /**
   * Declare one dynamic tool and, for a global entry, register it now.
   *
   * An entry whose required services are missing is recorded as unavailable with
   * a diagnostic; a malformed declaration or a factory failure rejects
   * registration.
   * @param entry - the provider's declaration.
   * @returns a disposer that removes the declaration and its registration.
   * @throws CapabilityHostError `TOOL_REGISTRATION_FAILED` for an unknown scope, a duplicate id, or a factory failure.
   */
  register(entry: ToolCatalogEntry): () => void {
    const id = entry.id.trim()
    if (id === '') throw registrationError(id, 'the catalog id is empty')
    if (entry.scope !== 'global' && entry.scope !== 'agent') {
      throw registrationError(id, `unknown scope ${JSON.stringify(entry.scope)}; expected "global" or "agent"`)
    }
    if (this.slots.has(id)) throw registrationError(id, 'the id is already declared in this Host process')
    const slot: CatalogSlot = {
      entry: { ...entry, id },
      schema: undefined,
      registered: false,
      reason: undefined,
      dispose: undefined,
      failureNoted: false,
    }
    this.slots.set(id, slot)
    if (entry.scope === 'global') this.install(slot)
    let disposed = false
    const owned = (): void => {
      if (disposed) return
      disposed = true
      this.uninstall(slot)
      if (this.slots.get(id) === slot) this.slots.delete(id)
      this.disposers.delete(owned)
    }
    this.disposers.add(owned)
    return owned
  }

  /**
   * Read one catalog slot.
   * @param id - catalog id.
   * @returns the record, or undefined when no provider declared the id.
   */
  find(id: string): CatalogRecord | undefined {
    const slot = this.slots.get(id)
    if (slot === undefined) return undefined
    return {
      entry: slot.entry,
      registered: slot.registered,
      ...(slot.schema === undefined ? {} : { schema: slot.schema }),
      ...(slot.reason === undefined ? {} : { reason: slot.reason }),
    }
  }

  /** Every declaration in registration order. */
  list(): readonly CatalogRecord[] {
    return [...this.slots.values()].map(slot => this.find(slot.entry.id) as CatalogRecord)
  }

  /** Global entries a `when` gate can control. */
  globalEntries(): readonly ToolCatalogEntry[] {
    return [...this.slots.values()].map(slot => slot.entry).filter(entry => entry.scope === 'global')
  }

  /** Agent-scoped entries the Capability Set may mount. */
  agentEntries(): readonly ToolCatalogEntry[] {
    return [...this.slots.values()].map(slot => slot.entry).filter(entry => entry.scope === 'agent')
  }

  /**
   * Agent-scoped entries switched on at one scope.
   * @param ref - preset or session scope whose switches decide the answer.
   * @returns entries enabled at that scope, in declaration order.
   */
  agentEntriesFor(ref: ScopeRef): readonly ToolCatalogEntry[] {
    const entries = this.agentEntries()
    const merged = this.gate.merged(ref, entries.map(entry => entry.id))
    return entries.filter(entry => merged[entry.id] === true)
  }

  /** Dispose every registration this catalog made. */
  dispose(): void {
    for (const dispose of [...this.disposers]) dispose()
  }

  /**
   * Register one global slot.
   * @param slot - the slot to install.
   */
  private install(slot: CatalogSlot): void {
    if (slot.dispose !== undefined) return
    const missing = (slot.entry.required ?? []).filter(service => this.ctx.get(service) === undefined)
    if (missing.length > 0) {
      slot.registered = false
      slot.reason = `required service(s) not mounted: ${missing.join(', ')}`
      if (slot.failureNoted !== true) {
        slot.failureNoted = true
        this.diagnostics.report({
          code: 'TOOL_REGISTRATION_FAILED',
          message: `dynamic tool ${JSON.stringify(slot.entry.id)} is unavailable: ${slot.reason}`,
          toolId: slot.entry.id,
        })
      }
      return
    }
    let definition: ToolDefinition
    try {
      definition = slot.entry.factory(this.ctx)
    } catch (error: unknown) {
      throw registrationError(slot.entry.id, `the factory failed: ${describeError(error)}`)
    }
    const failureMode = slot.entry.failureMode ?? 'closed'
    slot.dispose = this.ctx.tools.register(definition, {
      when: ({ agent }) => this.gate.evaluate(agent, slot.entry.id, failureMode),
    })
    slot.schema = definition
    slot.registered = true
    slot.reason = undefined
  }

  /**
   * Remove one global registration, keeping the declaration for the panel.
   * @param slot - the slot to uninstall.
   */
  private uninstall(slot: CatalogSlot): void {
    slot.dispose?.()
    slot.dispose = undefined
    slot.registered = false
  }
}

function registrationError(id: string, reason: string): CapabilityHostError {
  return new CapabilityHostError('TOOL_REGISTRATION_FAILED', `tool ${JSON.stringify(id)} cannot be registered: ${reason}`, {
    toolId: id, reason,
  })
}

/**
 * The generic Capability Set bridge. A preset or Agent mounts one row of this
 * child; it reads the Host's catalog and mounts whatever agent-scoped entries
 * are switched on in that scope. It contains no tool list of its own.
 *
 * Switching a tool on or off emits `capability-host/change`, and the row
 * re-syncs: entries that were switched off are disposed, entries that were
 * switched on are registered. Unmounting the row disposes every registration it
 * made, so a preset or Agent can compose it again cleanly.
 *
 * @module @elysia/capability-host/capability-set
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type { ScopeRef } from './types.ts'
import type { ToolCatalogEntry } from './contracts.ts'
import { describeError } from './errors.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'elysia-capability-set'

/** The tool registry this bridge contributes to. */
export const inject = ['tools']

/**
 * Mount the bridge in the scope of the row that composes it.
 * @param ctx - Agent- or preset-scoped context of the composing row.
 * @throws when the capability Host is not mounted or the row is mounted outside both scopes.
 */
export function apply(ctx: Context): void {
  const host = ctx.get('capabilityHost')
  if (host === undefined) {
    throw new Error('elysia-capability-set requires @elysia/capability-host in the same tree')
  }
  const scope = scopeOf(ctx)
  if (scope === undefined) {
    throw new Error('elysia-capability-set must be mounted in an Agent or preset scope')
  }
  const owner = 'session' in scope ? scope as Agent : undefined
  const ref = resolveScopeRef(ctx, owner)

  /** Registrations this row owns, by catalog id. */
  const registered = new Map<string, () => void>()
  let disposed = false

  const sync = (): void => {
    if (disposed) return
    let wanted: readonly ToolCatalogEntry[]
    try {
      wanted = host.agentToolEntries(ref)
    } catch (error: unknown) {
      host.reportMountFailure('', `capability-set cannot read the catalog: ${describeError(error)}`)
      return
    }
    const ids = new Set(wanted.map(entry => entry.id))
    for (const [id, dispose] of [...registered]) {
      if (ids.has(id)) continue
      dispose()
      registered.delete(id)
    }
    for (const entry of wanted) {
      if (registered.has(entry.id)) continue
      const factory = entry.factory
      if (factory === undefined) continue
      try {
        const definition = factory(ctx)
        const dispose = ctx.tools.register(definition, {
          when: ({ agent }) => host.isEnabled(agent, entry.id),
        })
        registered.set(entry.id, dispose)
      } catch (error: unknown) {
        host.reportMountFailure(entry.id, `capability-set cannot mount ${JSON.stringify(entry.id)}: ${describeError(error)}`)
      }
    }
  }

  ctx.effect(() => () => {
    disposed = true
    for (const dispose of [...registered.values()]) dispose()
    registered.clear()
  }, 'elysia-capability-set.registrations')

  // Call-level backstop for the tools this row registered: a switch flipped
  // after the step admitted the tool must not let the call run.
  ctx.effect(() => ctx.tools.guard((exec) => {
    if (exec.agent === undefined || !registered.has(exec.name)) return undefined
    if (exec.toolSet === undefined || !exec.toolSet.view(exec.agent).has(exec.name)) return undefined
    return host.isEnabled(exec.agent, exec.name)
      ? undefined
      : `tool ${JSON.stringify(exec.name)} is switched off for this session`
  }), 'elysia-capability-set.guard')

  ctx.on('capability-host/change', () => { sync() })
  sync()
}

/**
 * Resolve the scope switches this row answers to.
 * @param ctx - the row's mounting context.
 * @param owner - Agent owning the row, when it is Agent-scoped.
 * @returns the session scope for an Agent row, otherwise the preset scope.
 * @throws when a preset-scoped row cannot resolve its preset id.
 */
function resolveScopeRef(ctx: Context, owner: Agent | undefined): ScopeRef {
  if (owner !== undefined) return { kind: 'session', id: owner.session.id }
  const presetId = ctx.get('agentPresets')?.composedPreset(ctx)
  if (presetId === undefined) {
    throw new Error('elysia-capability-set cannot resolve the preset it is composed by')
  }
  return { kind: 'preset', id: presetId }
}

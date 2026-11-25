/**
 * Switch state of the create page's tool configuration: one boolean per tool
 * the Host offers, plus the two operations the page performs on it.
 *
 * The state is plain data so the page never derives a face by hand: selecting
 * a face rebuilds every switch from that face, which is what makes selecting
 * `none` switch everything off instead of leaving stale entries.
 *
 * @module @elysia/mobius-infinity/client/tool-face-state
 */

import type { ToolFace } from '../types.ts'

/** One switch per tool id the Host offers. */
export type ToolSwitches = Readonly<Record<string, boolean>>

/**
 * Rebuild every switch for one face.
 * @param toolIds - every tool id the Host offers, in display order.
 * @param faceTools - tool ids the face switches on.
 * @returns a switch set with exactly the face's tools enabled.
 */
export function switchesForFace(toolIds: readonly string[], faceTools: readonly string[]): ToolSwitches {
  const switches: Record<string, boolean> = {}
  for (const id of toolIds) switches[id] = faceTools.includes(id)
  return switches
}

/**
 * Flip one switch.
 * @param current - the current switch set.
 * @param id - tool id to flip.
 * @returns a new switch set.
 */
export function toggleSwitch(current: ToolSwitches, id: string): ToolSwitches {
  return { ...current, [id]: current[id] !== true }
}

/**
 * Read the enabled tool ids in display order.
 * @param current - the current switch set.
 * @param toolIds - every tool id the Host offers, in display order.
 * @returns enabled ids, catalog order.
 */
export function enabledTools(current: ToolSwitches, toolIds: readonly string[]): string[] {
  return toolIds.filter(id => current[id] === true)
}

/**
 * Whether one face may be deleted from the page.
 * @param face - the selected face.
 * @returns true for an operator-created face only.
 */
export function isDeletableFace(face: ToolFace): boolean {
  return face.kind === 'custom'
}

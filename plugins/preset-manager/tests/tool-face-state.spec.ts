/**
 * Create-page switch behavior: selecting a face rebuilds every switch, so the
 * chat-only face really turns everything off, and a manual toggle leaves the
 * face behind.
 */
import { describe, expect, it } from 'vitest'
import {
  enabledTools, isDeletableFace, switchesForFace, toggleSwitch,
} from '../src/client/tool-face-state.ts'
import type { ToolFace } from '../src/types.ts'

const TOOLS = ['tool-web', 'tool-fs', 'tool-fs-search', 'tool-office']

describe('tool switches', () => {
  it('keeps a switch for every offered tool', () => {
    const switches = switchesForFace(TOOLS, ['tool-web'])
    expect(Object.keys(switches).toSorted()).toEqual([...TOOLS].toSorted())
    expect(switches).toEqual({
      'tool-web': true,
      'tool-fs': false,
      'tool-fs-search': false,
      'tool-office': false,
    })
  })

  it('turns every switch off for the chat-only face', () => {
    const full = switchesForFace(TOOLS, TOOLS)
    const none = switchesForFace(TOOLS, [])
    expect(enabledTools(full, TOOLS)).toEqual(TOOLS)
    expect(enabledTools(none, TOOLS)).toEqual([])
    // No stale entry survives a face change.
    expect(none).toEqual(Object.fromEntries(TOOLS.map(id => [id, false])))
  })

  it('flips one switch and leaves the rest alone', () => {
    const start = switchesForFace(TOOLS, ['tool-web'])
    const next = toggleSwitch(start, 'tool-fs')
    expect(next['tool-fs']).toBe(true)
    expect(next['tool-web']).toBe(true)
    expect(start['tool-fs']).toBe(false)
    expect(enabledTools(toggleSwitch(next, 'tool-web'), TOOLS)).toEqual(['tool-fs'])
  })

  it('reads enabled tools in catalog order, not toggle order', () => {
    const switches = switchesForFace(TOOLS, ['tool-office', 'tool-fs'])
    expect(enabledTools(switches, TOOLS)).toEqual(['tool-fs', 'tool-office'])
  })

  it('allows deleting a custom face only', () => {
    const face = (kind: ToolFace['kind']): ToolFace => ({ kind, id: 'x', name: '', tools: [] })
    expect(isDeletableFace(face('custom'))).toBe(true)
    expect(isDeletableFace(face('default'))).toBe(false)
    expect(isDeletableFace(face('common'))).toBe(false)
    expect(isDeletableFace(face('existing'))).toBe(false)
  })
})

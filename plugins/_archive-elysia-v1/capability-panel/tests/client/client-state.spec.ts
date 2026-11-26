/**
 * Pure projections the panel renders from: static tools (locked, always on),
 * per-scope shadowing derived from the effective preset's static face, the reply
 * group's atomicity, group switches, scope selection across a refresh, and the
 * ordering the lists use.
 */
import { describe, expect, it } from 'vitest'
import type { ToolEntry } from '../../src/client/types.ts'
import {
  canToggleTool, effectivePresetId, formatAge, groupEnabled, groupMembers, groupStep, groupWrites,
  isShadowed, memberLocked, memberWrite, orderGroups, orderSessions, resolveScope, scopeKeyOf,
  scopeOfRow, selectInitialScope, shadowedToolIds, staticToolsFor, toolEnabled, toolKey,
  writableMembers,
} from '../../src/client/panel-state.ts'
import { LIVE_SESSION, OFFLINE_SESSION, PRESET_ID, groups, snapshot } from './fixtures.ts'

const PRESET_SCOPE = { kind: 'preset', id: PRESET_ID } as const
const presetKey = `preset:${PRESET_ID}`

/** The shadow set the panel derives for one preset, exactly as the view does. */
function shadowFor(presetId: string | undefined): ReadonlySet<string> {
  return shadowedToolIds(staticToolsFor(snapshot().tools, presetId))
}

/** The shadow set of the fixture's effective preset. */
function scopeShadow(): ReadonlySet<string> {
  return shadowFor(PRESET_ID)
}

function group(id: string) {
  const match = groups().find(entry => entry.id === id)
  if (match === undefined) throw new Error(`fixture has no group ${id}`)
  return match
}

function tool(id: string, origin: ToolEntry['origin'] = 'dynamic'): ToolEntry {
  const match = snapshot().tools.find(entry => entry.id === id && entry.origin === origin)
  if (match === undefined) throw new Error(`fixture has no ${origin} tool ${id}`)
  return match
}

describe('scope addressing', () => {
  it('keys the two writable scopes the Host stores', () => {
    expect(scopeKeyOf({ kind: 'preset', id: 'p1' })).toBe('preset:p1')
    expect(scopeKeyOf({ kind: 'session', id: 's1' })).toBe('session:s1')
  })

  it('addresses a row by its own kind', () => {
    expect(scopeOfRow({ kind: 'session', id: 's1', live: true })).toEqual({ kind: 'session', id: 's1' })
    expect(scopeOfRow({ kind: 'preset', id: 'p1', live: true })).toEqual({ kind: 'preset', id: 'p1' })
  })

  it('identifies a tool by origin and id, so a shadowed row stays distinct', () => {
    expect(toolKey(tool('web_search', 'static'))).toBe('static:web_search')
    expect(toolKey(tool('web_search', 'dynamic'))).toBe('dynamic:web_search')
  })
})

describe('static tools', () => {
  it('are always on and never writable', () => {
    const search = tool('web_search', 'static')
    expect(toolEnabled(search, presetKey, scopeShadow())).toBe(true)
    expect(toolEnabled(search, 'session:missing', scopeShadow())).toBe(true)
    expect(search.locked).toBe(true)
    expect(canToggleTool(search, scopeShadow())).toBe(false)
  })

  it('come from the effective preset of the selected scope', () => {
    const current = snapshot()
    expect(effectivePresetId(PRESET_SCOPE, current)).toBe(PRESET_ID)
    expect(effectivePresetId({ kind: 'session', id: LIVE_SESSION }, current)).toBe(PRESET_ID)
    expect(effectivePresetId({ kind: 'session', id: 'ghost' }, current)).toBeUndefined()
    expect(effectivePresetId(undefined, current)).toBeUndefined()

    expect(staticToolsFor(current.tools, PRESET_ID).map(entry => entry.id)).toEqual(['web_search', 'web_fetch'])
    expect(staticToolsFor(current.tools, undefined)).toEqual([])
    expect(staticToolsFor(current.tools, 'other-preset')).toEqual([])
  })
})

describe('per-scope shadowing', () => {
  it('derives the shadow set from the effective preset static face', () => {
    expect([...scopeShadow()].toSorted()).toEqual(['web_fetch', 'web_search'])
    expect([...shadowFor(undefined)].toSorted()).toEqual([])
    expect([...shadowFor('other-preset')].toSorted()).toEqual([])
  })

  it('blocks a dynamic row the preset static tool already covers', () => {
    const duplicate = tool('web_search')
    // The Host may omit the advisory flag entirely; derivation still blocks it.
    expect(duplicate.shadowed).toBeUndefined()
    expect(isShadowed(duplicate, scopeShadow())).toBe(true)
    expect(canToggleTool(duplicate, scopeShadow())).toBe(false)
    expect(toolEnabled(duplicate, presetKey, scopeShadow())).toBe(false)
  })

  it('ignores a stale host flag the preset does not actually shadow', () => {
    const stray: ToolEntry = {
      id: 'web_search',
      group: 'web',
      scope: 'global',
      origin: 'dynamic',
      locked: false,
      shadowed: true,
      enabledBy: {},
    }
    // No static tool covers that id in this scope, so the flag is not authority.
    expect(isShadowed(stray, shadowFor('other-preset'))).toBe(false)
    expect(canToggleTool(stray, shadowFor('other-preset'))).toBe(true)
  })
})

describe('dynamic tools', () => {
  it('are switchable unless the preset shadows them', () => {
    expect(canToggleTool(tool('send_text'), scopeShadow())).toBe(true)
  })

  it('never writes a shadowed or locked member', () => {
    const current = snapshot()
    const shadow = scopeShadow()
    // The `web` group holds only the shadowed duplicate: nothing to write.
    expect(groupWrites(PRESET_SCOPE, group('web'), current.tools, true, shadow)).toEqual([])
    expect(writableMembers(group('web'), current.tools, shadow)).toEqual([])
    expect(groupEnabled(group('web'), current.tools, presetKey, shadow)).toBe(false)

    const filesRead = writableMembers(group('files-read'), current.tools, shadow)
    expect(filesRead.map(entry => entry.id)).toEqual(['read', 'glob'])
  })
})

describe('reply group atomicity', () => {
  it('keeps pass as the locked member and offers the channels', () => {
    const reply = group('reply')
    expect(memberLocked(reply, tool('pass'))).toBe(true)
    expect(memberLocked(reply, tool('send_text'))).toBe(false)
    expect(memberLocked(reply, tool('send_voice'))).toBe(false)
    expect(memberLocked(group('files-read'), tool('read'))).toBe(false)
  })

  it('writes every member when the whole group switches', () => {
    const reply = group('reply')
    const shadow = scopeShadow()
    expect(groupWrites(PRESET_SCOPE, reply, snapshot().tools, false, shadow)).toEqual([
      { scope: PRESET_SCOPE, toolId: 'send_text', enabled: false },
      { scope: PRESET_SCOPE, toolId: 'send_voice', enabled: false },
      { scope: PRESET_SCOPE, toolId: 'pass', enabled: false },
    ])
    expect(groupWrites(PRESET_SCOPE, reply, snapshot().tools, true, shadow).every(write => write.enabled)).toBe(true)
  })

  it('writes one member only for a channel gesture', () => {
    expect(memberWrite(PRESET_SCOPE, tool('send_voice'), false)).toEqual({
      scope: PRESET_SCOPE, toolId: 'send_voice', enabled: false,
    })
  })

  it('reads a group as on only when every writable member is on', () => {
    const reply = group('reply')
    const shadow = scopeShadow()
    expect(groupEnabled(reply, snapshot().tools, presetKey, shadow)).toBe(true)
    expect(groupEnabled(reply, snapshot().tools, `session:${LIVE_SESSION}`, shadow)).toBe(false)
    expect(groupMembers(reply, snapshot().tools).map(entry => entry.id)).toEqual(['send_text', 'send_voice', 'pass'])
  })

  it('reports the worst current-step verdict of the members', () => {
    const reply = group('reply')
    expect(groupStep(reply, snapshot().tools, presetKey)).toBe('active')
    expect(groupStep(reply, snapshot().tools, `session:${LIVE_SESSION}`)).toBe('frozen')
  })

  it('treats an unstored scope as off', () => {
    const shadow = scopeShadow()
    expect(toolEnabled(tool('send_text'), 'session:missing', shadow)).toBe(false)
    expect(groupEnabled(group('reply'), snapshot().tools, 'session:missing', shadow)).toBe(false)
  })
})

describe('scope lists', () => {
  it('orders live sessions before offline ones', () => {
    expect(orderSessions(snapshot().sessions).map(row => row.id)).toEqual([LIVE_SESSION, OFFLINE_SESSION])
  })

  it('opens on the first live session, then a preset, then nothing', () => {
    expect(selectInitialScope(snapshot().presets, snapshot().sessions))
      .toEqual({ kind: 'session', id: LIVE_SESSION })
    expect(selectInitialScope(snapshot().presets, [])).toEqual({ kind: 'preset', id: PRESET_ID })
    expect(selectInitialScope([], [])).toBeUndefined()
  })

  it('keeps a selected scope across a refresh and falls back when it vanishes', () => {
    expect(resolveScope(`preset:${PRESET_ID}`, snapshot().presets, snapshot().sessions))
      .toEqual({ kind: 'preset', id: PRESET_ID })
    expect(resolveScope('session:gone', snapshot().presets, snapshot().sessions))
      .toEqual({ kind: 'session', id: LIVE_SESSION })
    expect(resolveScope(undefined, snapshot().presets, snapshot().sessions))
      .toEqual({ kind: 'session', id: LIVE_SESSION })
    expect(resolveScope(undefined, [], [])).toBeUndefined()
  })

  it('puts a static group first, then the dynamic groups', () => {
    expect(orderGroups(groups()).map(entry => entry.id)).toEqual(['static', 'reply', 'files-read', 'web'])
  })
})

describe('health ages', () => {
  it('splits an age into the bucket the panel renders', () => {
    expect(formatAge(0)).toEqual({ unit: 'justNow', count: 0 })
    expect(formatAge(999)).toEqual({ unit: 'justNow', count: 0 })
    expect(formatAge(4_000)).toEqual({ unit: 'seconds', count: 4 })
    expect(formatAge(120_000)).toEqual({ unit: 'minutes', count: 2 })
    expect(formatAge(7_200_000)).toEqual({ unit: 'hours', count: 2 })
    expect(formatAge(Number.NaN)).toEqual({ unit: 'justNow', count: 0 })
  })
})
/**
 * Fixtures shared by the browser-half specs: one loaded Host v1.2 snapshot, one
 * status, and the panel's own Chinese dictionary as the translate function.
 *
 * The snapshot carries both origins: the preset's static tools (`web_search`,
 * `web_fetch`) and the dynamic catalog rows (`reply`, `files-read`, and one
 * shadowed `web_search` duplicate).
 */
import type {
  CapabilitySnapshot, HostStatus, ScopeRowEntry, ToolEntry, ToolGroupEntry,
} from '../../src/client/types.ts'
import { zh, type ControlPanelLocaleKey } from '../../src/client/locales.ts'

export const PRESET_ID = 'elysia-conscious'
export const LIVE_SESSION = 'session-live'
export const OFFLINE_SESSION = 'session-offline'

/**
 * Render one dictionary key with `{name}` interpolation, exactly as the locale
 * service does.
 * @param key - dictionary key.
 * @param params - template parameters.
 * @returns the rendered copy.
 */
export function translate(key: ControlPanelLocaleKey, params?: Record<string, unknown>): string {
  const template = zh[key]
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in params ? String(params[name]) : match)
}

function presetRow(): ScopeRowEntry {
  return { kind: 'preset', id: PRESET_ID, title: 'Elysia conscious', live: true, sessionCount: 2 }
}

function sessionRows(): readonly ScopeRowEntry[] {
  return [
    { kind: 'session', id: OFFLINE_SESSION, title: 'Offline chat', live: false, presetId: PRESET_ID },
    { kind: 'session', id: LIVE_SESSION, title: 'Live chat', live: true, presetId: PRESET_ID, lastActiveAt: 2_000 },
  ]
}

const presetScope = `preset:${PRESET_ID}`
const liveScope = `session:${LIVE_SESSION}`

function staticTools(): readonly ToolEntry[] {
  return [
    {
      id: 'web_search',
      group: 'static',
      scope: 'global',
      origin: 'static',
      locked: true,
      sourcePresetId: PRESET_ID,
      provider: 'modsearch',
      stepBy: { [presetScope]: 'active', [liveScope]: 'active' },
    },
    {
      id: 'web_fetch',
      group: 'static',
      scope: 'global',
      origin: 'static',
      locked: true,
      sourcePresetId: PRESET_ID,
      stepBy: { [presetScope]: 'active', [liveScope]: 'active' },
    },
  ]
}

function replyTools(): readonly ToolEntry[] {
  return [
    {
      id: 'send_text',
      group: 'reply',
      scope: 'global',
      origin: 'dynamic',
      locked: false,
      enabledBy: { [presetScope]: true, [liveScope]: true },
      stepBy: { [presetScope]: 'active', [liveScope]: 'active' },
    },
    {
      id: 'send_voice',
      group: 'reply',
      scope: 'global',
      origin: 'dynamic',
      locked: false,
      enabledBy: { [presetScope]: true, [liveScope]: false },
      stepBy: { [presetScope]: 'active', [liveScope]: 'frozen' },
    },
    {
      id: 'pass',
      group: 'reply',
      scope: 'global',
      origin: 'dynamic',
      locked: false,
      enabledBy: { [presetScope]: true, [liveScope]: true },
      stepBy: { [presetScope]: 'active', [liveScope]: 'active' },
    },
  ]
}

function filesReadTools(): readonly ToolEntry[] {
  return [
    { id: 'read', group: 'files-read', scope: 'agent', origin: 'dynamic', locked: false, enabledBy: {} },
    {
      id: 'glob',
      group: 'files-read',
      scope: 'agent',
      origin: 'dynamic',
      locked: false,
      enabledBy: {},
      failure: 'fs is not mounted',
    },
  ]
}

/** One dynamic catalog row the preset's static tool shadows. */
function shadowedTools(): readonly ToolEntry[] {
  return [
    {
      id: 'web_search',
      group: 'web',
      scope: 'global',
      origin: 'dynamic',
      locked: false,
      enabledBy: {},
    },
  ]
}

export function groups(): readonly ToolGroupEntry[] {
  return [
    { id: 'reply', scope: 'global', origin: 'dynamic', atomic: true, locked: false, tools: ['send_text', 'send_voice', 'pass'] },
    { id: 'static', scope: 'global', origin: 'static', atomic: false, locked: true, tools: ['web_search', 'web_fetch'] },
    { id: 'files-read', scope: 'agent', origin: 'dynamic', atomic: false, locked: false, tools: ['read', 'glob'] },
    { id: 'web', scope: 'global', origin: 'dynamic', atomic: false, locked: false, tools: ['web_search'] },
  ]
}

export function snapshot(): CapabilitySnapshot {
  return {
    groups: groups(),
    tools: [...staticTools(), ...replyTools(), ...filesReadTools(), ...shadowedTools()],
    contexts: [
      {
        kind: 'app.message',
        active: true,
        ttlMs: 60_000,
        backlog: 2,
        enabledBy: { [presetScope]: true, [liveScope]: false },
      },
      { kind: 'prompt.change', active: false, ttlMs: 5_000, enabledBy: {} },
    ],
    presets: [presetRow()],
    sessions: sessionRows(),
    events: [
      { id: 'event-1', kind: 'app.message', outcome: 'published', at: 1_766_000_000_000, detail: 'delivered 2' },
      { id: 'event-2', kind: 'prompt.change', outcome: 'dropped', at: 1_766_000_001_000, detail: 'ttl' },
    ],
  }
}

export function status(overrides: Partial<HostStatus> = {}): HostStatus {
  return {
    writable: true,
    mode: 'live',
    health: {
      tools: { static: 2, registered: 6, enabled: 5, failed: 1, global: 5, agent: 2 },
      contexts: { queueDepth: 3, oldestAgeMs: 4_000, consumed: 9, failed: 1, merged: 2 },
      gate: { failClosed: 1, failLoud: 0, lastError: 'reply gate threw' },
      capturedAt: 1_766_000_002_000,
    },
    ...overrides,
  }
}

export function emptySnapshot(): CapabilitySnapshot {
  return { groups: [], tools: [], contexts: [], presets: [], sessions: [], events: [] }
}

/**
 * Slice the markup of one element marked by an opening attribute, up to the next
 * sibling marker.
 * @param html - rendered markup.
 * @param start - opening attribute text, including quotes.
 * @param next - the next sibling marker to stop at.
 * @returns the element's markup.
 */
export function segment(html: string, start: string, next: string): string {
  const from = html.indexOf(start)
  if (from < 0) throw new Error(`markup does not contain ${start}`)
  const to = html.indexOf(next, from + start.length)
  return to < 0 ? html.slice(from) : html.slice(from, to)
}
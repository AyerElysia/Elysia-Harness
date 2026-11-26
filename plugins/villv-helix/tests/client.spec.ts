/**
 * Browser-half behavior that does not need a DOM: the Remote adapter's session
 * binding and payload guards, and the pure projections the tool panel renders
 * from.
 */
import { describe, expect, it } from 'vitest'
import type { ClientConnectionRpc } from '@deepseek-ai/dsh-client-connection/client'
import type { CapabilitySnapshot } from '../src/types.ts'
import { createVillvHelixApi, VillvHelixRemoteError } from '../src/client/api.ts'
import {
  currentScope, effectivePresetId, isShadowed, scopeKeyOf, shadowedToolIds, staticToolsFor, toolStep,
} from '../src/client/panel-state.ts'

function snapshot(): CapabilitySnapshot {
  return {
    tools: [
      {
        id: 'preset_tool', group: 'static', scope: 'agent', origin: 'static', locked: true,
        sourcePresetId: 'standard', enabledBy: { 'session:s1': true }, stepBy: { 'session:s1': 'active' },
      },
      {
        id: 'alpha_tool', group: 'registered', scope: 'global', origin: 'dynamic', locked: false,
        enabledBy: { 'session:s1': false }, stepBy: { 'session:s1': 'hidden' },
      },
    ],
    groups: [{ id: 'registered', scope: 'global', origin: 'dynamic', atomic: false, locked: false, tools: ['alpha_tool'] }],
    sessions: [{ id: 's1', title: 'Hello', live: true, presetId: 'standard', orchestrated: true }],
    toolPresets: [{ id: 'p1', name: '组', tools: ['alpha_tool'], createdAt: 1 }],
  }
}

interface Call {
  readonly endpoint: string
  readonly args: object
}

function fakeRpc(handler: (call: Call) => unknown): { rpc: Pick<ClientConnectionRpc, 'call'>, calls: Call[] } {
  const calls: Call[] = []
  const rpc = {
    async call(_channel: string, endpoint: string, payload: { args?: object }): Promise<unknown> {
      const call = { endpoint, args: payload.args ?? {} }
      calls.push(call)
      return handler(call)
    },
  } as unknown as Pick<ClientConnectionRpc, 'call'>
  return { rpc, calls }
}

describe('Remote adapter', () => {
  it('binds every call to the session the view renders', async () => {
    const { rpc, calls } = fakeRpc(call => call.endpoint === 'villvHelix/getMode'
      ? { ok: true, value: true }
      : { ok: true, value: snapshot() })
    const api = createVillvHelixApi(rpc, 's1')
    await api.list(new AbortController().signal)
    await api.setTool('alpha_tool', false, new AbortController().signal)
    await api.getMode(new AbortController().signal)
    expect(calls.map(call => call.endpoint)).toEqual([
      'villvHelix/list', 'villvHelix/setTool', 'villvHelix/getMode',
    ])
    expect(calls[0]?.args).toEqual({ sessionId: 's1' })
    expect(calls[1]?.args).toEqual({ sessionId: 's1', toolId: 'alpha_tool', enabled: false })
  })

  it('offers the tool face only, with no context or status operations', () => {
    const { rpc } = fakeRpc(() => ({ ok: true, value: snapshot() }))
    const api = createVillvHelixApi(rpc, 's1')
    expect(Object.keys(api).sort()).toEqual([
      'createToolPreset', 'deleteToolPreset', 'getMode', 'list', 'readPresetPrompt', 'readSystemPrompt',
      'setMode', 'setTool',
    ])
  })

  it('surfaces the Host refusal code', async () => {
    const { rpc } = fakeRpc(() => ({
      ok: false,
      error: { code: 'villvHelix/TOOL_STATIC_LOCKED', message: 'locked' },
    }))
    const api = createVillvHelixApi(rpc, 's1')
    const error: unknown = await api.setTool('preset_tool', false, new AbortController().signal)
      .then(() => undefined, (reason: unknown) => reason)
    expect(error).toBeInstanceOf(VillvHelixRemoteError)
    expect((error as VillvHelixRemoteError).code).toBe('villvHelix/TOOL_STATIC_LOCKED')
  })

  it('refuses a malformed snapshot instead of rendering it', async () => {
    const { rpc } = fakeRpc(() => ({ ok: true, value: { tools: 'nope' } }))
    const api = createVillvHelixApi(rpc, 's1')
    await expect(api.list(new AbortController().signal)).rejects.toThrow('villv-helix/invalid-list-response')
  })
})

describe('panel projections', () => {
  it('addresses the one session the snapshot carries', () => {
    const loaded = snapshot()
    expect(currentScope(loaded)).toEqual({ kind: 'session', id: 's1' })
    expect(scopeKeyOf({ kind: 'session', id: 's1' })).toBe('session:s1')
    expect(effectivePresetId(loaded)).toBe('standard')
  })

  it('lists the preset static rows and marks the shadowed global row', () => {
    const loaded = snapshot()
    const staticTools = staticToolsFor(loaded.tools, effectivePresetId(loaded))
    expect(staticTools.map(tool => tool.id)).toEqual(['preset_tool'])
    const shadowed = shadowedToolIds(staticTools)
    expect(isShadowed(loaded.tools[1]!, shadowed)).toBe(false)
    expect(isShadowed(loaded.tools[0]!, shadowed)).toBe(false)
  })

  it('still lists static rows when the Host did not attribute a preset', () => {
    const loaded = snapshot()
    expect(staticToolsFor(loaded.tools, undefined).map(tool => tool.id)).toEqual(['preset_tool'])
  })

  it('projects the stored verdict of a dynamic switch', () => {
    const loaded = snapshot()
    const dynamic = loaded.tools[1]!
    expect(toolStep(dynamic, 'session:s1')).toBe('hidden')
    expect(toolStep(dynamic, 'session:other')).toBe('hidden')
  })
})
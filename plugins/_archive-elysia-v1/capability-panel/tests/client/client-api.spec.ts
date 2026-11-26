/**
 * Behavior of the browser RPC adapter: which endpoint each operation calls, how
 * arguments are packed, how refusals surface, and which responses it rejects as
 * malformed.
 */
import { describe, expect, it } from 'vitest'
import type { ConnectionRpcResult } from '@deepseek-ai/dsh-client-connection/client'
import type { ContextEvent } from '../../src/client/types.ts'
import { CapabilityRemoteError, createCapabilityPanelApi } from '../../src/client/api.ts'
import { emptySnapshot, snapshot, status } from './fixtures.ts'

const SIGNAL = new AbortController().signal
const PRESET_SCOPE = { kind: 'preset', id: 'elysia-conscious' } as const

interface Call {
  readonly channel: string
  readonly endpoint: string
  readonly payload: unknown
}

/** One scripted RPC caller that records every call. */
function rpcReturning(...results: ConnectionRpcResult<unknown>[]) {
  const calls: Call[] = []
  return {
    calls,
    rpc: {
      async call(channel: string, endpoint: string, payload: unknown): Promise<ConnectionRpcResult<unknown>> {
        calls.push({ channel, endpoint, payload })
        const result = results.shift()
        if (result === undefined) throw new Error('no scripted result')
        return result
      },
    },
  }
}

describe('capability panel adapter', () => {
  it('reads the snapshot through capabilityHost/list', async () => {
    const value = snapshot()
    const { calls, rpc } = rpcReturning({ ok: true, value })
    await expect(createCapabilityPanelApi(rpc).list(SIGNAL)).resolves.toBe(value)
    expect(calls).toEqual([{ channel: '/api', endpoint: 'capabilityHost/list', payload: { args: {} } }])
  })

  it('reads write authority and health through capabilityHost/status', async () => {
    const value = status()
    const { calls, rpc } = rpcReturning({ ok: true, value })
    await expect(createCapabilityPanelApi(rpc).status(SIGNAL)).resolves.toBe(value)
    expect(calls[0]).toEqual({ channel: '/api', endpoint: 'capabilityHost/status', payload: { args: {} } })
  })

  it('packs setTool arguments by parameter name', async () => {
    const { calls, rpc } = rpcReturning({ ok: true, value: undefined })
    await createCapabilityPanelApi(rpc).setTool(PRESET_SCOPE, 'send_voice', false, SIGNAL)
    expect(calls[0]).toEqual({
      channel: '/api',
      endpoint: 'capabilityHost/setTool',
      payload: { args: { scope: PRESET_SCOPE, toolId: 'send_voice', enabled: false } },
    })
  })

  it('packs setContext arguments by parameter name', async () => {
    const { calls, rpc } = rpcReturning({ ok: true, value: undefined })
    await createCapabilityPanelApi(rpc).setContext(PRESET_SCOPE, 'app.message', true, SIGNAL)
    expect(calls[0]).toEqual({
      channel: '/api',
      endpoint: 'capabilityHost/setContext',
      payload: { args: { scope: PRESET_SCOPE, eventKind: 'app.message', enabled: true } },
    })
  })

  it('publishes an event unchanged and validates the receipt', async () => {
    const event: ContextEvent = {
      id: 'event-1',
      kind: 'app.message',
      source: 'bridge',
      summary: 'one message',
      payload: { text: 'hi' },
      visibility: {},
      active: true,
      dedupeKey: 'bridge:1',
      createdAt: 1_766_000_000_000,
    }
    const receipt = { eventId: 'event-1', delivered: 2, suppressed: 0, failed: 0 }
    const good = rpcReturning({ ok: true, value: receipt })
    await expect(createCapabilityPanelApi(good.rpc).publish(event, SIGNAL)).resolves.toEqual(receipt)
    expect(good.calls[0]).toEqual({
      channel: '/api',
      endpoint: 'capabilityHost/publish',
      payload: { args: { event } },
    })

    const bad = rpcReturning({ ok: true, value: { eventId: 1 } })
    await expect(createCapabilityPanelApi(bad.rpc).publish(event, SIGNAL))
      .rejects.toThrow('control-panel/invalid-publish-response')
  })

  it('accepts an empty snapshot but rejects a malformed one', async () => {
    const empty = rpcReturning({ ok: true, value: emptySnapshot() })
    await expect(createCapabilityPanelApi(empty.rpc).list(SIGNAL)).resolves.toEqual(emptySnapshot())

    const cases: readonly unknown[] = [
      // Tool without the v1.2 origin/lock fields.
      { groups: [], tools: [{ id: 1 }], contexts: [], presets: [], sessions: [], events: [] },
      {
        groups: [], tools: [], contexts: [{ kind: 'app.message', active: 'yes', enabledBy: {} }],
        presets: [], sessions: [], events: [],
      },
      {
        groups: [], tools: [], contexts: [], presets: [],
        sessions: [{ kind: 'session', id: 's', live: 'no' }], events: [],
      },
      // Group still using the v1.1 readOnly field instead of origin/locked.
      {
        groups: [{ id: 'base', scope: 'global', atomic: false, readOnly: true, tools: [] }],
        tools: [], contexts: [], presets: [], sessions: [], events: [],
      },
      // Dynamic tool whose shadowed flag is not a boolean.
      {
        groups: [],
        tools: [{
          id: 'web_search', group: 'web', scope: 'global', origin: 'dynamic', locked: false, shadowed: 'yes',
        }],
        contexts: [], presets: [], sessions: [], events: [],
      },
      { groups: [], tools: [], contexts: [], presets: [], sessions: [] },
      null,
    ]
    for (const value of cases) {
      const { rpc } = rpcReturning({ ok: true, value })
      await expect(createCapabilityPanelApi(rpc).list(SIGNAL))
        .rejects.toThrow('control-panel/invalid-list-response')
    }
  })

  it('accepts one tool id reported as both a static and a dynamic row, without a shadow flag', async () => {
    const value = snapshot()
    const staticRow = value.tools.find(entry => entry.origin === 'static' && entry.id === 'web_search')
    const dynamicRow = value.tools.find(entry => entry.origin === 'dynamic' && entry.id === 'web_search')
    expect(staticRow?.locked).toBe(true)
    // The Host may drop the advisory flag; the panel derives shadowing per scope.
    expect(dynamicRow?.shadowed).toBeUndefined()
    const { rpc } = rpcReturning({ ok: true, value })
    await expect(createCapabilityPanelApi(rpc).list(SIGNAL)).resolves.toBe(value)
  })

  it('rejects a malformed status', async () => {
    const cases: readonly unknown[] = [
      { writable: 'yes', mode: 'live', health: status().health },
      { writable: true, mode: 'unknown', health: status().health },
      { writable: true, mode: 'live', health: { tools: {}, contexts: {}, gate: {}, capturedAt: 0 } },
    ]
    for (const value of cases) {
      const { rpc } = rpcReturning({ ok: true, value })
      await expect(createCapabilityPanelApi(rpc).status(SIGNAL))
        .rejects.toThrow('control-panel/invalid-status-response')
    }
  })

  it('surfaces a refused static-tool write with its code', async () => {
    const { rpc } = rpcReturning({
      ok: false,
      error: { code: 'capabilityHost/TOOL_STATIC_LOCKED', message: 'static tool cannot be switched', details: {} },
    })
    const error = await createCapabilityPanelApi(rpc)
      .setTool(PRESET_SCOPE, 'web_search', false, SIGNAL)
      .catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(CapabilityRemoteError)
    expect(error).toMatchObject({ code: 'capabilityHost/TOOL_STATIC_LOCKED' })
  })
})
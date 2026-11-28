/**
 * Browser-half behavior that does not need a DOM: the Remote adapter's session
 * binding, payload guards, and adapter reuse.
 */
import { describe, expect, it } from 'vitest'
import type { ClientConnectionRpc } from '@deepseek-ai/dsh-client-connection/client'
import type { ContextSnapshot } from '../../src/types.ts'
import { ContextGateRemoteError, createContextGateApi } from '../../src/client/api.ts'

function snapshot(): ContextSnapshot {
  return {
    contexts: [
      {
        kind: 'app.message', nameZh: '应用消息', description: '外部渠道进入的消息', ttlMs: 60_000,
        backlog: 2, enabledBy: { s1: true },
      },
    ],
    events: [{
      id: 'row-1', eventId: 'e1', kind: 'app.message', source: 'channel-im',
      origin: { plugin: 'channel-im', channel: 'qq', conversation: 'c1' },
      summary: 'inbound message', causationId: 'cause-1', outcome: 'delivered', at: 1, detail: '1 个会话',
    }],
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

describe('context gate Remote adapter', () => {
  it('binds list and setContext to the session the view renders', async () => {
    const { rpc, calls } = fakeRpc(() => ({ ok: true, value: snapshot() }))
    const api = createContextGateApi(rpc, 's1')
    const loaded = await api.list(new AbortController().signal)
    await api.setContext('app.message', true, new AbortController().signal)
    expect(loaded.contexts[0]?.kind).toBe('app.message')
    expect(calls.map(call => call.endpoint)).toEqual(['contextGate/list', 'contextGate/setContext'])
    expect(calls[0]?.args).toEqual({ sessionId: 's1' })
    expect(calls[1]?.args).toEqual({ sessionId: 's1', kind: 'app.message', enabled: true })
  })

  it('offers the context, timer, absence, and rule surface', () => {
    const { rpc } = fakeRpc(() => ({ ok: true, value: snapshot() }))
    const api = createContextGateApi(rpc, 's1')
    expect(Object.keys(api).sort()).toEqual([
      'adoptTimerPreset', 'cancelAbsence', 'cancelRule', 'cancelTimer', 'createAbsence', 'createRule',
      'createTimer', 'createTimerPreset', 'deleteTimerPreset', 'list', 'pauseRule', 'pauseTimer',
      'setContext', 'setSubscriptionParams', 'subscribeFuture', 'testRule', 'timers', 'updateAbsence',
      'updateRule', 'updateTimer', 'updateTimerPreset',
    ])
  })

  it('binds timer and rule endpoints to the same session scope', async () => {
    const { rpc, calls } = fakeRpc((call) => {
      if (call.endpoint === 'contextGate/timers') {
        return { ok: true, value: { timers: [], presets: [], absences: [], now: 1 } }
      }
      return {
        ok: true,
        value: {
          id: 'timer-1', ownerSessionId: 's1', name: 't', content: 'c',
          schedule: { kind: 'after', afterMs: 1000 }, wake: true, anchorAt: 1, enabled: true, nextDueAt: 2,
          firedCount: 0, createdAt: 1, updatedAt: 1,
        },
      }
    })
    const api = createContextGateApi(rpc, 's1')
    await api.timers(new AbortController().signal)
    await api.createTimer({ name: 't', content: 'c', afterSeconds: 1 }, new AbortController().signal)
    expect(calls.map(call => call.endpoint)).toEqual(['contextGate/timers', 'contextGate/createTimer'])
    expect(calls[0]?.args).toEqual({ sessionId: 's1' })
    expect(calls[1]?.args).toEqual({ sessionId: 's1', draft: { name: 't', content: 'c', afterSeconds: 1 } })
  })

  it('surfaces the Host refusal code', async () => {
    const { rpc } = fakeRpc(() => ({
      ok: false,
      error: { code: 'contextGate/CONTEXT_UNKNOWN', message: 'unknown kind' },
    }))
    const api = createContextGateApi(rpc, 's1')
    const error: unknown = await api.setContext('nope', true, new AbortController().signal)
      .then(() => undefined, (reason: unknown) => reason)
    expect(error).toBeInstanceOf(ContextGateRemoteError)
    expect((error as ContextGateRemoteError).code).toBe('contextGate/CONTEXT_UNKNOWN')
  })

  it('refuses a malformed snapshot instead of rendering it', async () => {
    const { rpc } = fakeRpc(() => ({ ok: true, value: { contexts: 'nope' } }))
    const api = createContextGateApi(rpc, 's1')
    await expect(api.list(new AbortController().signal)).rejects.toThrow('context-gate/invalid-list-response')
  })

  it('reuses one adapter per rpc handle and session', () => {
    const { rpc } = fakeRpc(() => ({ ok: true, value: snapshot() }))
    expect(createContextGateApi(rpc, 's1')).toBe(createContextGateApi(rpc, 's1'))
    expect(createContextGateApi(rpc, 's1')).not.toBe(createContextGateApi(rpc, 's2'))
  })
})
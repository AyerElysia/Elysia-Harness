/**
 * Behavior of the browser RPC adapter: which endpoint each operation calls,
 * how refusals surface, and which responses it rejects as malformed.
 */
import { describe, expect, it } from 'vitest'
import type { ConnectionRpcResult } from '@deepseek-ai/dsh-client-connection/client'
import { createPresetManagerApi, PresetManagerRemoteError } from '../src/client/api.ts'
import type { PresetSummary } from '../src/types.ts'

const SIGNAL = new AbortController().signal

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

const ROW: PresetSummary = { id: 'elysia', managed: true, inUse: [] }

const FACE = { kind: 'custom', id: 'custom-1', name: 'Mine', tools: ['tool-web'] }

const CATALOG = {
  tools: [{ id: 'tool-web', module: '@deepseek-ai/dsh-tool-web', available: true }],
  faces: [
    { kind: 'default', id: 'default', name: '', tools: ['tool-web'] },
    { kind: 'common', id: 'none', name: '', tools: [] },
    FACE,
  ],
}

describe('preset manager adapter', () => {
  it('reads the roster through the preset-manager endpoint', async () => {
    const { calls, rpc } = rpcReturning({ ok: true, value: [ROW] })
    const api = createPresetManagerApi(rpc)
    await expect(api.list(SIGNAL)).resolves.toEqual([ROW])
    expect(calls).toEqual([{ channel: '/api', endpoint: 'presetManager/list', payload: { args: {} } }])
  })

  it('reads the tool catalog and rejects a malformed one', async () => {
    const good = rpcReturning({ ok: true, value: CATALOG })
    await expect(createPresetManagerApi(good.rpc).listToolFaces(SIGNAL)).resolves.toEqual(CATALOG)
    expect(good.calls[0]?.endpoint).toBe('presetManager/listToolFaces')

    const bad = rpcReturning({ ok: true, value: { tools: [{ id: 1 }], faces: [] } })
    await expect(createPresetManagerApi(bad.rpc).listToolFaces(SIGNAL))
      .rejects.toThrow('preset-manager/invalid-tool-faces-response')
  })

  it('creates and deletes custom faces through their endpoints', async () => {
    const created = rpcReturning({ ok: true, value: FACE })
    await expect(createPresetManagerApi(created.rpc).createToolFace({ name: 'Mine', tools: ['tool-web'] }, SIGNAL))
      .resolves.toEqual(FACE)
    expect(created.calls[0]).toEqual({
      channel: '/api',
      endpoint: 'presetManager/createToolFace',
      payload: { args: { input: { name: 'Mine', tools: ['tool-web'] } } },
    })

    const removed = rpcReturning({ ok: true, value: undefined })
    await createPresetManagerApi(removed.rpc).deleteToolFace('custom-1', SIGNAL)
    expect(removed.calls[0]).toEqual({
      channel: '/api',
      endpoint: 'presetManager/deleteToolFace',
      payload: { args: { id: 'custom-1' } },
    })
  })

  it('sends the draft unchanged and returns the created row', async () => {
    const { calls, rpc } = rpcReturning({ ok: true, value: ROW })
    const api = createPresetManagerApi(rpc)
    const draft = {
      id: 'elysia',
      name: 'Elysia',
      identity: 'You are Elysia.',
      promptRoot: '/tmp/prompts',
      promptFiles: ['SOUL.md'],
      tools: ['tool-web'],
      toolFace: { kind: 'default' as const, id: 'default' },
    }
    await expect(api.create(draft, SIGNAL)).resolves.toEqual(ROW)
    expect(calls[0]?.endpoint).toBe('presetManager/create')
    expect(calls[0]?.payload).toEqual({ args: { draft } })
  })

  it('omits absent delete options and sends present ones', async () => {
    const first = rpcReturning({ ok: true, value: undefined })
    await createPresetManagerApi(first.rpc).remove('elysia', undefined, SIGNAL)
    expect(first.calls[0]?.payload).toEqual({ args: { id: 'elysia' } })

    const second = rpcReturning({ ok: true, value: undefined })
    await createPresetManagerApi(second.rpc).remove('elysia', { force: true }, SIGNAL)
    expect(second.calls[0]?.payload).toEqual({ args: { id: 'elysia', options: { force: true } } })
  })

  it('reads prompt candidates and rejects a malformed list', async () => {
    const good = rpcReturning({ ok: true, value: [{ path: 'SOUL.md', bytes: 9 }] })
    await expect(createPresetManagerApi(good.rpc).listPromptCandidates('/tmp/prompts', SIGNAL))
      .resolves.toEqual([{ path: 'SOUL.md', bytes: 9 }])
    expect(good.calls[0]?.payload).toEqual({ args: { root: '/tmp/prompts' } })

    const bad = rpcReturning({ ok: true, value: [{ path: 1 }] })
    await expect(createPresetManagerApi(bad.rpc).listPromptCandidates('/tmp/prompts', SIGNAL))
      .rejects.toThrow('preset-manager/invalid-candidates-response')
  })

  it('uses the host directory picker and maps a cancel to null', async () => {
    const picked = rpcReturning({ ok: true, value: '/tmp/prompts' })
    await expect(createPresetManagerApi(picked.rpc).pickDirectory(SIGNAL)).resolves.toBe('/tmp/prompts')
    expect(picked.calls[0]).toEqual({ channel: '/api', endpoint: 'directoryPicker/pick', payload: { args: {} } })

    const cancelled = rpcReturning({ ok: true, value: null })
    await expect(createPresetManagerApi(cancelled.rpc).pickDirectory(SIGNAL)).resolves.toBeNull()
  })

  it('surfaces a host refusal with its code', async () => {
    const { rpc } = rpcReturning({
      ok: false,
      error: { code: 'presetManager/PRESET_IN_USE', message: 'preset "elysia" is used by 1 live session(s): session-1' },
    } as ConnectionRpcResult<unknown>)
    const error = await createPresetManagerApi(rpc).remove('elysia', undefined, SIGNAL).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(PresetManagerRemoteError)
    expect(error).toMatchObject({ code: 'presetManager/PRESET_IN_USE' })
  })
})

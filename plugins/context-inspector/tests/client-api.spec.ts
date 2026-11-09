import { describe, expect, it, vi } from 'vitest'
import { createInspectorApi, PAGE_BYTES } from '../src/client/api.ts'
import type { SnapshotMetadata } from '../src/types.ts'

function metadata(sessionId = 'session-a'): SnapshotMetadata {
  return {
    requestId: 'fixture-1', sessionId, recordedAt: '2026-01-01T00:00:00Z',
    provider: 'fixture-provider', model: 'fixture-model', messageCount: 2, toolCount: 1, loop: true,
    sections: { system: { bytes: 2 }, messages: { bytes: 2 }, tools: { bytes: 2 }, raw: { bytes: 2 } },
  }
}

describe('context inspector session-bound Gateway adapter', () => {
  it('uses the official carrier, session resource, named request envelope and cancellation signal', async () => {
    const request = metadata()
    const call = vi.fn(async () => ({ ok: true as const, value: { request } }))
    const api = createInspectorApi({ call }, 'session-a')
    const controller = new AbortController()
    await expect(api.latest(controller.signal)).resolves.toEqual({ request })
    expect(call).toHaveBeenCalledWith('/api', 'contextInspector/latest', {
      args: { request: { sessionId: 'session-a' } },
    }, controller.signal)
  })

  it('pins a read to the selected request and a bounded byte page', async () => {
    const response = { requestId: 'fixture-1', section: 'raw', offset: 0, nextOffset: 2, totalBytes: 2, text: '{}', complete: true }
    const call = vi.fn(async () => ({ ok: true as const, value: response }))
    const api = createInspectorApi({ call }, 'session-a')
    const controller = new AbortController()
    await expect(api.read(metadata(), 'raw', 0, controller.signal)).resolves.toEqual(response)
    expect(call).toHaveBeenCalledWith('/api', 'contextInspector/read', {
      args: { request: { sessionId: 'session-a', requestId: 'fixture-1', section: 'raw', offset: 0, maxBytes: PAGE_BYTES } },
    }, controller.signal)
  })

  it('distinguishes no archive from a missing archive index', async () => {
    for (const reason of ['not-recorded', 'index-unavailable'] as const) {
      const call = vi.fn(async () => ({ ok: true as const, value: { request: null, reason } }))
      await expect(createInspectorApi({ call }, 'session-a').latest(new AbortController().signal))
        .resolves.toEqual({ request: null, reason })
    }
  })

  it('rejects another session in both metadata and a local read before it can be displayed', async () => {
    const call = vi.fn(async () => ({ ok: true as const, value: { request: metadata('session-b') } }))
    const api = createInspectorApi({ call }, 'session-a')
    await expect(api.latest(new AbortController().signal)).rejects.toThrow('invalid-response')
    const afterLatest = call.mock.calls.length
    await expect(api.read(metadata('session-b'), 'system', 0, new AbortController().signal)).rejects.toThrow('session-mismatch')
    expect(call).toHaveBeenCalledTimes(afterLatest)
  })

  it('rejects a response from a different pinned request', async () => {
    const call = vi.fn(async () => ({ ok: true as const, value: {
      requestId: 'another-request', section: 'raw', offset: 0, nextOffset: 2, totalBytes: 2, text: '{}', complete: true,
    } }))
    await expect(createInspectorApi({ call }, 'session-a').read(metadata(), 'raw', 0, new AbortController().signal))
      .rejects.toThrow('invalid-response')
  })

  it('keeps provider/server diagnostics out of errors shown by the view', async () => {
    const call = vi.fn(async () => ({
      ok: false as const, error: { code: 'fixture', message: 'private diagnostic body', details: { body: 'private' } },
    }))
    await expect(createInspectorApi({ call }, 'session-a').latest(new AbortController().signal))
      .rejects.toThrow('context-inspector/request-failed')
  })

  it('does not return data delivered after the caller cancelled', async () => {
    const controller = new AbortController()
    const call = vi.fn(async () => {
      controller.abort()
      return { ok: true as const, value: { request: metadata() } }
    })
    await expect(createInspectorApi({ call }, 'session-a').latest(controller.signal)).rejects.toThrow()
  })
})

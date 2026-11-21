// @vitest-environment jsdom
/** Synthetic browser fixtures only: no request archive, session store, socket or model calls. */
import { createElement, type ComponentType } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { LatestResponse, ReadRequest, ReadResponse, Section, SnapshotMetadata } from '../src/types.ts'
import type { InspectorApi } from '../src/client/api.ts'
import { ContextInspectorView, type ContextInspectorInjected } from '../src/client/ContextInspectorView.tsx'
import { NS, zh } from '../src/client/locales.ts'

type Translate = PropsLocale<typeof NS>['t']
const t = ((key: keyof typeof zh, values: Record<string, unknown> = {}) =>
  zh[key].replace(/\{([^}]+)\}/g, (_match, name: string) => String(values[name] ?? ''))) as Translate
const View = ContextInspectorView as ComponentType<ContextInspectorInjected & { t: Translate }>

const sections: Record<Section, string> = {
  system: JSON.stringify({ system: 'fixture-system', messages: [{ role: 'developer', content: 'fixture-injection' }] }, null, 2),
  messages: JSON.stringify([{ role: 'user', content: 'fixture-message' }], null, 2),
  tools: JSON.stringify([{ name: 'fixture-tool', parameters: { type: 'object' } }], null, 2),
  raw: JSON.stringify({ request: { content: '<img src=x onerror=alert(1)>' } }, null, 2),
}
function metadata(sessionId = 'fixture-session', requestId = 'fixture-request'): SnapshotMetadata {
  return {
    sessionId, requestId, recordedAt: '2026-01-01T00:00:00Z', provider: 'fixture-provider',
    model: 'fixture-model', messageCount: 1, toolCount: 1, loop: false,
    sections: Object.fromEntries(Object.entries(sections).map(([key, value]) =>
      [key, { bytes: new TextEncoder().encode(value).byteLength }])) as SnapshotMetadata['sections'],
  }
}
function chunk(request: SnapshotMetadata, section: Section, offset = 0): ReadResponse {
  const text = sections[section].slice(offset)
  return { requestId: request.requestId, section, offset, nextOffset: sections[section].length,
    totalBytes: request.sections[section].bytes, text, complete: true }
}
const carriers = new WeakMap<InspectorApi, ContextInspectorInjected['inspectorRpc']>()
function view(api: InspectorApi, sessionId = 'fixture-session') {
  let rpc = carriers.get(api)
  if (rpc === undefined) {
    let current: SnapshotMetadata | null = null
    rpc = { call: async (_channel, endpoint, payload, signal) => {
      const request = (payload as { args: { request: ReadRequest } }).args.request
      if (endpoint === 'contextInspector/latest') {
        const value = await api.latest(signal ?? new AbortController().signal)
        current = value.request
        return { ok: true, value }
      }
      const snapshot = current ?? metadata(request.sessionId, request.requestId)
      return { ok: true, value: await api.read(snapshot, request.section, request.offset, signal ?? new AbortController().signal) }
    } }
    carriers.set(api, rpc)
  }
  return createElement(View, { inspectorRpc: rpc, inspectorSessionId: sessionId, t })
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
afterEach(cleanup)

describe('context inspector browser view', () => {
  it('shows call provenance and system injections, then explicitly loads complete text and all four sections', async () => {
    const request = metadata()
    const api: InspectorApi = {
      latest: vi.fn(async () => ({ request })),
      read: vi.fn(async (snapshot, section, offset) => section === 'system' && offset === 0
        ? { ...chunk(snapshot, section), nextOffset: 5, text: sections.system.slice(0, 5), complete: false }
        : chunk(snapshot, section, offset)),
    }
    render(view(api))
    await screen.findByText('fixture-model')
    const recordedTime = document.querySelector('time')
    expect(recordedTime?.textContent).toBe(request.recordedAt)
    expect(recordedTime?.getAttribute('title')).toBe(request.recordedAt)
    expect(recordedTime?.getAttribute('datetime')).toBe(request.recordedAt)
    expect(screen.getByText('其他框架调用')).toBeTruthy()
    expect(screen.getByText(/所有 system \/ developer 消息/)).toBeTruthy()
    await screen.findByText('当前只显示已加载部分，尚非全文。')
    expect(screen.queryByText('本节已完整加载')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '加载全文' }))
    await screen.findByRole('button', { name: '可读文本' })
    expect(screen.getByLabelText('系统提示词内容').textContent).toContain('fixture-system')
    expect(screen.getByLabelText('系统提示词内容').textContent).toContain('fixture-injection')
    fireEvent.click(screen.getByRole('button', { name: 'JSON 结构' }))
    expect(screen.getByLabelText('系统提示词内容').textContent).toBe(sections.system)
    expect(screen.queryByText('当前只显示已加载部分，尚非全文。')).toBeNull()
    for (const [section, label] of [['messages', '完整消息'], ['tools', '工具定义'], ['raw', '原始 JSON']] as const) {
      fireEvent.click(screen.getByRole('tab', { name: label }))
      await waitFor(() => expect(screen.getByLabelText(label + '内容').textContent).toBe(sections[section]))
    }
    expect(document.querySelector('img')).toBeNull()
  })

  it('keeps the same session and carrier API stable across ordinary parent rerenders', async () => {
    const request = metadata()
    const api: InspectorApi = {
      latest: vi.fn(async () => ({ request })),
      read: vi.fn(async (snapshot, section, offset) => chunk(snapshot, section, offset)),
    }
    const rendered = render(view(api))
    await screen.findByText('fixture-model')
    rendered.rerender(view(api))
    await act(async () => { await Promise.resolve() })
    expect(api.latest).toHaveBeenCalledTimes(1)
    expect(api.read).toHaveBeenCalledTimes(1)
  })

  it('aborts an old session lookup and rejects its late response during session navigation', async () => {
    const pending = deferred<LatestResponse>()
    let previousSignal: AbortSignal | undefined
    const first: InspectorApi = {
      latest: signal => { previousSignal = signal; return pending.promise },
      read: vi.fn(),
    }
    const secondRequest = { ...metadata('session-b', 'request-b'), model: 'model-b' }
    const second: InspectorApi = {
      latest: async () => ({ request: secondRequest }),
      read: async (request, section, offset) => chunk(request, section, offset),
    }
    const rendered = render(view(first, 'session-a'))
    rendered.rerender(view(second, 'session-b'))
    await screen.findByText('model-b')
    expect(previousSignal?.aborted).toBe(true)
    await act(async () => { pending.resolve({ request: metadata('session-a', 'request-a') }) })
    expect(screen.queryByText('fixture-model')).toBeNull()
    expect(screen.getByText('request-b')).toBeTruthy()
  })

  it('aborts a hidden section read and never shows its late content in another tab', async () => {
    const pending = deferred<ReadResponse>()
    let systemSignal: AbortSignal | undefined
    const request = metadata()
    const api: InspectorApi = {
      latest: async () => ({ request }),
      read: (_request, section, offset, signal) => {
        if (section === 'system') { systemSignal = signal; return pending.promise }
        return Promise.resolve(chunk(request, section, offset))
      },
    }
    render(view(api))
    await screen.findByText('fixture-model')
    await waitFor(() => expect(systemSignal).toBeDefined())
    fireEvent.click(screen.getByRole('tab', { name: '完整消息' }))
    await waitFor(() => expect(screen.getByLabelText('完整消息内容').textContent).toBe(sections.messages))
    expect(systemSignal?.aborted).toBe(true)
    await act(async () => { pending.resolve(chunk(request, 'system')) })
    expect(screen.queryByLabelText('系统提示词内容')).toBeNull()
    expect(screen.getByLabelText('完整消息内容').textContent).toBe(sections.messages)
  })

  it('keeps missing indexes distinct from an empty archive', async () => {
    const api: InspectorApi = { latest: async () => ({ request: null, reason: 'index-unavailable' }), read: vi.fn() }
    render(view(api))
    await screen.findByText('请求归档索引当前不可用，无法确认最近请求。')
    expect(screen.queryByText('此会话暂无请求归档。')).toBeNull()
    expect(api.read).not.toHaveBeenCalled()
  })

  it('does not render raw diagnostics from a failed lookup', async () => {
    const api: InspectorApi = { latest: async () => { throw new Error('private fixture response') }, read: vi.fn() }
    render(view(api))
    await screen.findByRole('alert')
    expect(document.body.textContent).not.toContain('private fixture response')
    expect(api.read).not.toHaveBeenCalled()
  })
})

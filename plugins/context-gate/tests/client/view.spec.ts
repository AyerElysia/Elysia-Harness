/**
 * Presentation of the context gate views: one render of the loaded snapshot,
 * with the real Chinese dictionary, proves the subscription list and the
 * injection log are what the pages actually draw.
 */
import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ContextSnapshot } from '../../src/types.ts'
import { ContextGateView, type ContextGateViewProps } from '../../src/client/ContextGateView.tsx'
import { zh, type ContextGateLocaleKey } from '../../src/client/locales.ts'
import type { ContextGateTranslate } from '../../src/client/ContextGateView.tsx'

const t = ((key: ContextGateLocaleKey, vars?: Readonly<Record<string, string>>): string => {
  const template = zh[key] ?? key
  if (vars === undefined) return template
  return template.replace(/\{(\w+)\}/g, (match, name: string) => vars[name] ?? match)
}) as ContextGateTranslate

function snapshot(): ContextSnapshot {
  return {
    contexts: [
      {
        kind: 'app.message', nameZh: '应用消息', description: '外部渠道进入的消息', ttlMs: 60_000,
        backlog: 2, enabledBy: { s1: true },
      },
      {
        kind: 'live.event', nameZh: '实时事件', description: '直播与语音的实时事件', ttlMs: 5_000,
        backlog: 0, enabledBy: { s1: false },
      },
    ],
    events: [
      {
        id: 'e1', eventId: 'evt-1', kind: 'app.message', source: 'channel-im', outcome: 'delivered',
        at: Date.UTC(2026, 0, 1, 12, 34, 56), detail: '1 个会话',
      },
      { id: 'e2', kind: 'unknown.kind', outcome: 'failed', at: Date.UTC(2026, 0, 1, 12, 35, 0) },
    ],
  }
}

function render(overrides: Partial<ContextGateViewProps> = {}): string {
  const props: ContextGateViewProps = {
    t,
    snapshot: snapshot(),
    sessionId: 's1',
    draft: {},
    onToggle: () => {},
    ...overrides,
  }
  return renderToStaticMarkup(createElement(ContextGateView, props))
}

describe('context gate view', () => {
  it('renders the events and log tabs', () => {
    const markup = render()
    expect(markup).toContain('>事件<')
    expect(markup).toContain('>日志<')
    expect(markup).not.toContain('>健康<')
    expect(markup).not.toContain('>工具<')
  })

  it('removes the in-page tab strip when a native view forces one tab', () => {
    const markup = render({ forcedTab: 'events' })
    expect(markup).not.toContain('role="tablist"')
    expect(markup).toContain('data-context-gate-panel="true"')
  })

  it('renders each subscription with its session state and delivery limits', () => {
    const markup = render()
    expect(markup).toContain('data-context-kind="app.message"')
    expect(markup).toContain('应用消息')
    expect(markup).toContain('外部渠道进入的消息')
    expect(markup).toContain('TTL 1 分钟')
    expect(markup).toContain('积压 2')
    expect(markup).toContain('aria-label="订阅 应用消息"')
    expect(markup).toContain('已订阅')
    expect(markup).toContain('TTL 5 秒')
  })

  it('marks an unsubscribed kind as unsubscribed and unchecked', () => {
    const markup = render()
    const row = markup.slice(markup.indexOf('data-context-kind="live.event"'))
    expect(row).toContain('未订阅')
    expect(row).toContain('data-subscribed="false"')
    expect(row).not.toContain('checked=""')
  })

  it('keeps the value the operator just chose until the Host confirms it', () => {
    const markup = render({ draft: { 'live.event': true } })
    const row = markup.slice(markup.indexOf('data-context-kind="live.event"'))
    expect(row).toContain('data-subscribed="true"')
    expect(row).toContain('已订阅')
    expect(row).toContain('checked=""')
  })

  it('renders the injection log with localized outcomes and kind names', () => {
    const markup = render({ forcedTab: 'log' })
    expect(markup).toContain('12:34:56')
    expect(markup).toContain('投递')
    expect(markup).toContain('应用消息')
    expect(markup).toContain('channel-im')
    expect(markup).toContain('1 个会话')
    expect(markup).toContain('失败')
    expect(markup).toContain('unknown.kind')
  })

  it('explains an empty context surface and log', () => {
    const empty = render({ snapshot: { contexts: [], events: [] } })
    expect(empty).toContain('没有可订阅的上下文事件。')
    expect(empty).toContain('还没有事件记录。')
  })

  it('shows a write in flight and disables further toggles', () => {
    const markup = render({ pendingKind: 'app.message' })
    expect(markup).toContain('正在写入…')
    expect(markup).toContain('disabled=""')
  })

  it('carries no orchestration or health copy', () => {
    const markup = render()
    expect(markup).not.toContain('编排')
    expect(markup).not.toContain('健康')
  })
})
/**
 * Presentation of the three context views: 事件 renders subscriptions,
 * parameters, and rules; 定时 renders timers, presets, and absence reminders;
 * 日志 renders the injection log. The native tab strip owns the tab labels, so
 * no view renders an in-page tab bar.
 */
import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ContextSnapshot, TimerSnapshot } from '../../src/types.ts'
import {
  EventsView, LogView, TimersView, type EventsViewProps, type LogViewProps, type TimersViewProps,
} from '../../src/client/ContextGateView.tsx'
import { CONTEXT_VIEWS } from '../../src/client/index.ts'
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
        backlog: 2, enabledBy: { s1: true }, subscribed: true,
        parameters: [{
          key: 'sources', labelZh: '来源会话', type: 'session', multiple: true, allowAll: true, allowFuture: true,
          options: [{ value: 's1', labelZh: '当前会话' }],
        }],
        params: { sources: ['s1'] },
      },
      {
        kind: 'live.event', nameZh: '实时事件', description: '直播与语音的实时事件', ttlMs: 5_000,
        backlog: 0, enabledBy: { s1: false }, subscribed: false,
        parameters: [{ key: 'level', labelZh: '级别', type: 'enum', options: [{ value: 'low', labelZh: '低' }] }],
        params: {},
      },
    ],
    events: [
      {
        id: 'e1', eventId: 'evt-1', kind: 'app.message', source: 'channel-im', outcome: 'delivered',
        at: Date.UTC(2026, 0, 1, 12, 34, 56), detail: '1 个会话',
      },
      { id: 'e2', kind: 'unknown.kind', outcome: 'failed', at: Date.UTC(2026, 0, 1, 12, 35, 0) },
    ],
    rules: [{
      id: 'rule-1', ownerSessionId: 's1', name: '回合规则',
      trigger: { kind: 'internal', event: 'turn/start' }, where: [],
      contentTemplate: '回合开始', wake: false, visibility: {}, cooldownMs: 0, maxFires: 0,
      enabled: true, fireCount: 2, createdAt: 1, updatedAt: 1,
    }],
  }
}

function timers(): TimerSnapshot {
  return {
    now: Date.UTC(2026, 0, 1, 12, 0, 0),
    timers: [{
      id: 'timer-1', ownerSessionId: 's1', name: '喝水', content: '该喝水了。',
      schedule: { kind: 'after', afterMs: 60_000 }, wake: false, anchorAt: 1, enabled: true,
      nextDueAt: Date.UTC(2026, 0, 1, 12, 1, 0), firedCount: 0, createdAt: 1, updatedAt: 1,
    }],
    presets: [{
      id: 'preset-1', ownerSessionId: 's1', name: '每日提醒', content: '每日提醒正文',
      schedule: { kind: 'seconds', everySeconds: 3_600 }, wake: true, createdAt: 1,
    }],
    absences: [{
      id: 'absence-1', ownerSessionId: 's1', kinds: ['app.message'], quietMs: 300_000,
      lastSeenAt: 1, fired: false, enabled: true, createdAt: 1, updatedAt: 1,
    }],
  }
}

function renderEvents(overrides: Partial<EventsViewProps> = {}): string {
  const props: EventsViewProps = {
    t,
    pending: false,
    snapshot: snapshot(),
    sessionId: 's1',
    draft: {},
    onToggle: () => {},
    onParams: () => {},
    onSubscribeFuture: () => {},
    onRuleCreate: () => {},
    onRuleUpdate: () => {},
    onRuleTest: () => {},
    onRulePause: () => {},
    onRuleCancel: () => {},
    ...overrides,
  }
  return renderToStaticMarkup(createElement(EventsView, props))
}

function renderTimers(overrides: Partial<TimersViewProps> = {}): string {
  const props: TimersViewProps = {
    t,
    pending: false,
    snapshot: timers(),
    onCreateTimer: () => {},
    onUpdateTimer: () => {},
    onPauseTimer: () => {},
    onCancelTimer: () => {},
    onCreatePreset: () => {},
    onUpdatePreset: () => {},
    onAdoptPreset: () => {},
    onDeletePreset: () => {},
    onCreateAbsence: () => {},
    onUpdateAbsence: () => {},
    onCancelAbsence: () => {},
    ...overrides,
  }
  return renderToStaticMarkup(createElement(TimersView, props))
}

function renderLog(overrides: Partial<LogViewProps> = {}): string {
  const props: LogViewProps = { t, pending: false, snapshot: snapshot(), ...overrides }
  return renderToStaticMarkup(createElement(LogView, props))
}

describe('context gate views', () => {
  it('registers the three root views in the documented order', () => {
    expect(CONTEXT_VIEWS.map(view => view.order)).toEqual([22, 23, 24])
    expect(CONTEXT_VIEWS.map(view => view.tab)).toEqual(['events', 'timers', 'log'])
    expect(CONTEXT_VIEWS.map(view => view.label)).toEqual(['tabEvents', 'tabTimers', 'tabLog'])
  })

  it('renders no in-page tab strip in any view', () => {
    expect(renderEvents()).not.toContain('role="tablist"')
    expect(renderTimers()).not.toContain('role="tablist"')
    expect(renderLog()).not.toContain('role="tablist"')
  })

  it('renders each subscription with its state and delivery limits', () => {
    const markup = renderEvents()
    expect(markup).toContain('data-context-kind="app.message"')
    expect(markup).toContain('应用消息')
    expect(markup).toContain('外部渠道进入的消息')
    expect(markup).toContain('TTL 1 分钟')
    expect(markup).toContain('积压 2')
    expect(markup).toContain('aria-label="订阅 应用消息"')
    expect(markup).toContain('已订阅')
  })

  it('renders subscription parameters and the future-session gesture', () => {
    const markup = renderEvents()
    expect(markup).toContain('订阅参数')
    expect(markup).toContain('来源会话')
    expect(markup).toContain('全部当前会话')
    expect(markup).toContain('包含未来新会话')
    expect(markup).toContain('未来会话自动订阅')
    expect(markup).toContain('保存参数')
  })

  it('renders custom-event rules with their actions and generated kind', () => {
    const markup = renderEvents()
    expect(markup).toContain('自定义事件规则')
    expect(markup).toContain('回合规则')
    expect(markup).toContain('turn/start')
    expect(markup).toContain('已触发 2 次')
    expect(markup).toContain('agent.script.rule1')
    expect(markup).toContain('测试')
    expect(markup).toContain('编辑')
  })

  it('explains that composite rules need the tool for editing', () => {
    const rule = snapshot().rules?.[0]
    if (rule === undefined) throw new Error('missing rule fixture')
    const composite = {
      ...rule,
      id: 'rule-composite',
      trigger: { kind: 'composite' as const, op: 'any' as const, triggers: [{ kind: 'internal' as const, event: 'turn/start' as const }] },
    }
    const markup = renderEvents({ snapshot: { ...snapshot(), rules: [composite] } })
    expect(markup).toContain('组合规则暂不支持在面板内编辑')
  })

  it('renders timers, presets, and absence reminders separately', () => {
    const markup = renderTimers()
    expect(markup).toContain('当前会话定时器')
    expect(markup).toContain('喝水')
    expect(markup).toContain('该喝水了。')
    expect(markup).toContain('定时预设')
    expect(markup).toContain('每日提醒')
    expect(markup).toContain('采用')
    expect(markup).toContain('安静提醒')
    expect(markup).toContain('app.message')
    expect(markup).toContain('待命')
    expect(markup).toContain('编辑')
  })

  it('renders the injection log with localized outcomes and kind names', () => {
    const markup = renderLog()
    expect(markup).toContain('12:34:56')
    expect(markup).toContain('投递')
    expect(markup).toContain('应用消息')
    expect(markup).toContain('channel-im')
    expect(markup).toContain('1 个会话')
    expect(markup).toContain('失败')
    expect(markup).toContain('unknown.kind')
  })

  it('explains empty event, timer, and log surfaces', () => {
    expect(renderEvents({ snapshot: { contexts: [], events: [], rules: [] } })).toContain('没有可订阅的上下文事件。')
    expect(renderTimers({ snapshot: { now: 0, timers: [], presets: [], absences: [] } })).toContain('当前会话还没有定时器。')
    expect(renderLog({ snapshot: { contexts: [], events: [] } })).toContain('还没有事件记录。')
  })

  it('shows a write in flight and disables further subscription toggles', () => {
    const markup = renderEvents({ pendingKind: 'app.message' })
    expect(markup).toContain('正在写入…')
    expect(markup).toContain('disabled=""')
  })

  it('carries no orchestration or health copy', () => {
    for (const markup of [renderEvents(), renderTimers(), renderLog()]) {
      expect(markup).not.toContain('编排')
      expect(markup).not.toContain('健康')
    }
  })
})
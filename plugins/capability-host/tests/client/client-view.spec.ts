/**
 * User-visible behavior of the presented panel (v1.2): static tools render as a
 * locked preset face, dynamic tools carry the switches, a shadowed duplicate is
 * blocked, and the reply group still cannot offer a lone `pass` switch.
 *
 * The view is a pure function of props, so these specs render it to static
 * markup and assert the copy, badges, and control affordances a reader sees.
 */
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { CapabilitySnapshot, ScopeRef, ToolEntry } from '../../src/client/types.ts'
import {
  ControlPanelFailure, ControlPanelLoading, ControlPanelView, type ControlPanelViewProps,
} from '../../src/client/ControlPanelView.tsx'
import {
  LIVE_SESSION, PRESET_ID, emptySnapshot, segment, snapshot, status, translate,
} from './fixtures.ts'

const presetScope: ScopeRef = { kind: 'preset', id: PRESET_ID }
const liveScope: ScopeRef = { kind: 'session', id: LIVE_SESSION }

function render(overrides: Partial<ControlPanelViewProps> = {}): string {
  const props: ControlPanelViewProps = {
    t: translate,
    snapshot: snapshot(),
    status: status(),
    selected: presetScope,
    busy: false,
    draft: {},
    dirty: false,
    saving: false,
    contextDraft: {},
    contextDirty: false,
    contextSaving: false,
    toolPresets: [],
    selectedToolPresetId: undefined,
    onSelect: () => {},
    onToggleTool: () => {},
    onToggleTools: () => {},
    onSaveTools: () => {},
    onSaveContexts: () => {},
    onSelectToolPreset: () => {},
    onApplyToolPreset: () => {},
    onCreateToolPreset: async () => true,
    onDeleteToolPreset: () => {},
    onToggleContext: () => {},
    ...overrides,
  }
  return renderToStaticMarkup(createElement(ControlPanelView, props))
}

function checkboxes(markup: string): number {
  return (markup.match(/type="checkbox"/g) ?? []).length
}

function categoryMarkup(html: string, id: string): string {
  return segment(html, `data-category-id="${id}"`, '</article>')
}

describe('scope list', () => {
  it('lists sessions and presets without a Base scope', () => {
    const html = render()
    expect(html).toContain('Live chat')
    expect(html).toContain('Offline chat')
    expect(html).toContain('在线')
    expect(html).toContain('离线')
    expect(html).toContain('识别到的预设：elysia-conscious')
    expect(html).toContain('Elysia conscious')
    expect(html).toContain('2 个会话')
    expect(html).toContain('aria-pressed="true"')
    expect(html).not.toContain('Base')
  })

  it('marks an empty roster and asks for a scope instead of rendering switches', () => {
    const html = render({ snapshot: emptySnapshot(), selected: undefined })
    expect(html).toContain('还没有会话。')
    expect(html).toContain('还没有预设。')
    expect(html).toContain('还没有会话或预设，无法显示工具与上下文。')
    expect(html).not.toContain('静态工具（预设默认）')
    expect(html).not.toContain('动态工具（面板管理）')
  })
})

describe('static tools', () => {
  it('shows the preset default face as locked, with its source preset', () => {
    const html = render()
    const staticFace = segment(html, 'data-group-id="static"', '</article>')
    expect(staticFace).toContain('只读')
    expect(staticFace).toContain('web_search')
    expect(staticFace).toContain('web_fetch')
    expect(staticFace).toContain('modsearch')
    expect(staticFace).toContain('预设默认工具，不能关闭。')
    expect(staticFace).toContain('来源预设：elysia-conscious')
    expect(staticFace).toContain('锁定')
    expect(staticFace).toContain('data-origin="static"')
    expect(staticFace).toContain('data-locked="true"')
    expect(checkboxes(staticFace)).toBe(0)
  })

  it('names the effective preset of a session scope', () => {
    const html = render({ selected: liveScope })
    expect(segment(html, 'data-group-id="static"', '</article>')).toContain('来源预设：elysia-conscious')
  })

  it('says so when the effective preset has no static tool', () => {
    const other: CapabilitySnapshot = {
      ...snapshot(),
      tools: snapshot().tools.filter(entry => entry.origin !== 'static'),
    }
    expect(render({ snapshot: other })).toContain('该预设没有静态工具。')
  })
})

describe('panel tabs', () => {
  it('renders one tab row for every section and drops duplicate section titles', () => {
    const html = render()
    expect(html).toContain('role="tablist"')
    expect(html).toContain('aria-label="面板板块"')
    expect(html).toContain('aria-selected="true"')
    expect(html).not.toContain('动态工具（面板管理）')
    expect(html).not.toContain('静态工具（预设默认）')
  })
})

describe('dynamic tools', () => {
  it('renders functional categories with counts and no select-all checkbox', () => {
    const html = render()
    const files = categoryMarkup(html, 'files')
    expect(files).toContain('文件')
    expect(files).toContain('0/2')
    expect(files).toContain('aria-expanded="true"')
    expect(html).toContain('翻译工具名')
    expect(html).not.toContain('启用 已注册工具')
    expect(html).toContain('data-category-id="other"')
  })

  it('splits DSH native tools from plugin tools', () => {
    const base = snapshot()
    const dynamicRead = base.tools.find(tool => tool.id === 'read')
    if (dynamicRead === undefined) throw new Error('fixture read tool is missing')
    const standardRead: ToolEntry = {
      ...dynamicRead,
      origin: 'static',
      locked: true,
      sourcePresetId: 'standard',
    }
    const pluginMarket: ToolEntry = {
      id: 'plugin_market',
      group: 'plugins',
      scope: 'global',
      origin: 'dynamic',
      locked: false,
      enabledBy: {},
      stepBy: {},
    }
    const withBoth: CapabilitySnapshot = {
      ...base,
      tools: [
        ...base.tools.filter(tool => tool.id !== 'read'),
        standardRead,
        dynamicRead,
        pluginMarket,
      ],
    }
    const html = render({ snapshot: withBoth })
    expect(html).toContain('data-parent-id="dsh-native"')
    expect(html).toContain('data-parent-id="plugin-tools"')
    expect(segment(html, 'data-parent-id="plugin-tools"', '</section>')).toContain('plugin_market')
  })

it('offers one checkbox per category to select every member', () => {
    const html = render()
    expect(categoryMarkup(html, 'files')).toContain('一键选择「文件」工具')
  })

it('renders every dynamic tool as its own switch', () => {
    const html = render()
    expect(html).toContain('启用 发送文本')
    expect(html).toContain('启用 发送语音')
    expect(html).toContain('启用 沉默（pass）')
    expect(html).toContain('保存')
  })

  it('reflects the unsaved draft and enables the save action', () => {
    const html = render({ draft: { read: true }, dirty: true })
    const files = categoryMarkup(html, 'files')
    expect(files).toContain('1/2')
    expect(files).toContain('checked=""')
    expect(html).toContain('工具修改尚未保存。')
    expect(html).not.toContain('没有需要保存的工具修改。')
  })

  it('renders saved tool groups and their actions', () => {
    const html = render({
      toolPresets: [{ id: 'set-1', name: '日常', tools: ['read'], createdAt: 1 }],
    })
    expect(html).toContain('工具组预设')
    expect(html).toContain('日常')
    expect(html).toContain('新建工具组')
    expect(html).toContain('删除')
  })

  it('hides a dynamic category the preset default shadows completely', () => {
    const html = render()
    expect(html).not.toContain('data-category-id="web"')
    expect(html).not.toContain('被预设默认工具覆盖，不能开启。')
  })

  it('marks a failed member tool and does not swallow the reason', () => {
    expect(render()).toContain('fs is not mounted')
  })

  it('disables dynamic switches for a read-only connection', () => {
    const html = render({ status: status({ writable: false }) })
    expect(html).toContain('当前连接不是 owner')
    expect(categoryMarkup(html, 'files')).toContain('disabled=""')
  })
})

describe('context subscriptions', () => {
  it('shows active/passive, TTL, and backlog per event kind', () => {
    const html = render()
    expect(html).toContain('应用消息')
    expect(html).toContain('主动')
    expect(html).toContain('TTL 1 分钟')
    expect(html).toContain('积压 2')
    expect(html).toContain('提示词变更')
    expect(html).toContain('被动')
    expect(html).toContain('TTL 5 秒')
    expect(html).toContain('订阅 应用消息')
  })
})

describe('event log and health', () => {
  it('renders the recent outcomes and their times', () => {
    const html = render()
    expect(html).toContain('发布')
    expect(html).toContain('丢弃')
    expect(html).toContain('delivered 2')
    expect(html).toContain('data-outcome="published"')
    expect(html).toContain('data-outcome="dropped"')
  })

  it('renders static and dynamic counters with the gate error', () => {
    const html = render()
    expect(html).toContain('静态 2 · 动态 6 · 启用 5 · 失败 1')
    expect(html).toContain('全局 5 · agent 2')
    expect(html).toContain('深度 3')
    expect(html).toContain('合并 2 次')
    expect(html).toContain('最老事件 4 秒前')
    expect(html).toContain('fail-closed 1 · fail-loud 0')
    expect(html).toContain('最近错误：reply gate threw')
  })

  it('keeps an unknown event kind verbatim', () => {
    const unknown: CapabilitySnapshot = {
      ...snapshot(),
      events: [{ id: 'event-3', kind: 'custom.event', outcome: 'consumed', at: 1 }],
    }
    expect(render({ snapshot: unknown })).toContain('custom.event')
  })
})

describe('load states', () => {
  it('renders the loading copy', () => {
    expect(renderToStaticMarkup(createElement(ControlPanelLoading, { t: translate })))
      .toContain('正在读取能力状态…')
  })

  it('renders the failure copy with a retry action', () => {
    const markup = renderToStaticMarkup(createElement(ControlPanelFailure, {
      t: translate,
      onRetry: () => {},
    }))
    expect(markup).toContain('暂时无法读取能力状态。')
    expect(markup).toContain('重试')
  })

  it('shows the in-flight and degraded notices without dropping the panel', () => {
    const saving = render({ saving: true })
    expect(saving).toContain('正在写入…')
    expect(render({ status: status({ mode: 'degraded' }) })).toContain('Host 尚未完全就绪')
  })

  it('renders a session scope with its drafted tools', () => {
    const html = render({ selected: liveScope, draft: { read: true }, dirty: true })
    expect(categoryMarkup(html, 'files')).toContain('1/2')
    expect(html).toContain('工具修改尚未保存。')
  })
})
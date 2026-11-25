/**
 * Presentation of the ported panel: one render of the loaded view, with the
 * real Chinese dictionary, proves the original tabs, session card, tool
 * categories, counts, and static card are what the page actually draws.
 */
import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { CapabilitySnapshot, HostStatus } from '../src/types.ts'
import { ControlPanelView, type ControlPanelViewProps } from '../src/client/ControlPanelView.tsx'
import { zh, type ControlPanelLocaleKey } from '../src/client/locales.ts'
import type { ControlPanelTranslate } from '../src/client/labels.ts'

const t = ((key: ControlPanelLocaleKey, vars?: Readonly<Record<string, string>>): string => {
  const template = zh[key] ?? key
  if (vars === undefined) return template
  return template.replace(/\{(\w+)\}/g, (match, name: string) => vars[name] ?? match)
}) as ControlPanelTranslate

function snapshot(): CapabilitySnapshot {
  return {
    tools: [
      {
        id: 'preset_tool', nameZh: '预设工具', group: 'static', scope: 'agent', origin: 'static',
        locked: true, sourcePresetId: 'standard', enabledBy: { 'session:s1': true },
        stepBy: { 'session:s1': 'active' },
      },
      {
        id: 'alpha_tool', nameZh: '阿尔法', group: 'registered', scope: 'global', origin: 'dynamic',
        locked: false, enabledBy: { 'session:s1': true }, stepBy: { 'session:s1': 'active' },
      },
      {
        id: 'working_directory', nameZh: '工作目录', group: 'registered', scope: 'global', origin: 'dynamic',
        locked: false, enabledBy: { 'session:s1': true }, stepBy: { 'session:s1': 'active' },
      },
    ],
    groups: [],
    contexts: [{ kind: 'demo.ping', nameZh: '示例事件', active: false, ttlMs: 60_000, backlog: 0, enabledBy: { 'session:s1': true } }],
    sessions: [{ id: 's1', title: '测试会话', live: true, presetId: 'standard', workspace: 'E:\\work\\demo' }],
    toolPresets: [{ id: 'p1', name: '常用组', tools: ['alpha_tool'], createdAt: 1 }],
    events: [{ id: 'e1', kind: 'demo.ping', outcome: 'delivered', at: 1, detail: 'ok' }],
  }
}

function status(): HostStatus {
  return {
    writable: true,
    mode: 'live',
    health: {
      tools: { static: 1, registered: 2, enabled: 2, failed: 0, global: 2, agent: 1 },
      contexts: { queueDepth: 0, oldestAgeMs: 0, consumed: 0, failed: 0, merged: 0 },
      gate: { failClosed: 0, failLoud: 0 },
      capturedAt: 1,
    },
  }
}

function render(overrides: Partial<ControlPanelViewProps> = {}): string {
  const props: ControlPanelViewProps = {
    t,
    snapshot: snapshot(),
    status: status(),
    selected: { kind: 'session', id: 's1' },
    busy: false,
    draft: {},
    dirty: false,
    saving: false,
    contextDraft: {},
    contextDirty: false,
    contextSaving: false,
    toolPresets: [{ id: 'p1', name: '常用组', tools: ['alpha_tool'], createdAt: 1 }],
    onToggleTool: () => {},
    onToggleTools: () => {},
    onSaveTools: () => {},
    onSaveContexts: () => {},
    onSelectToolPreset: () => {},
    onApplyToolPreset: () => {},
    onCreateToolPreset: async () => false,
    onDeleteToolPreset: () => {},
    onToggleContext: () => {},
    ...overrides,
  }
  return renderToStaticMarkup(createElement(ControlPanelView, props))
}

describe('ported panel view', () => {
  it('renders the five session tabs and no scope sidebar', () => {
    const markup = render()
    for (const label of ['工具', '事件', '日志', '健康', '预设']) {
      expect(markup).toContain(`>${label}<`)
    }
    expect(markup).not.toContain('当前会话')
    expect(markup).not.toContain('data-scope-key=')
    expect(markup).not.toContain('全部工作区')
  })

  it('removes the in-page tab strip when a native view forces one tab', () => {
    const markup = render({ forcedTab: 'tools' })
    expect(markup).not.toContain('role="tablist"')
    expect(markup).toContain('data-villv-helix-panel="true"')
  })

  it('renders tool categories, counts, bulk selection, and both tool groups', () => {
    const markup = render()
    expect(markup).toContain('1/1')
    expect(markup).toContain('DSH 基础工具')
    expect(markup).toContain('其他全局工具')
    expect(markup).toContain('阿尔法')
    expect(markup).toContain('一键选择')
  })

  it('renders the static card as read-only with its source preset', () => {
    const markup = render()
    expect(markup).toContain('预设工具')
    expect(markup).toContain('来源预设：standard')
    expect(markup).toContain('不能关闭')
  })

  it('shows the save action for a dirty tool draft', () => {
    const markup = render({ draft: { alpha_tool: false }, dirty: true })
    expect(markup).toContain('工具修改尚未保存')
    expect(markup).toContain('保存')
  })
})
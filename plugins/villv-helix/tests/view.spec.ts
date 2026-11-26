/**
 * Presentation of the tool panel: one render of the loaded view, with the real
 * Chinese dictionary, proves the tool and preset tabs, tool categories, counts,
 * and static card are what the page actually draws.
 */
import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { CapabilitySnapshot, PresetPrompt } from '../src/types.ts'
import { ControlPanelView, type ControlPanelViewProps } from '../src/client/ControlPanelView.tsx'
import { zh, type ControlPanelLocaleKey } from '../src/client/locales.ts'
import type { ControlPanelTranslate } from '../src/client/labels.ts'
import { isOfficialPreset } from '../src/presets.ts'

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
    sessions: [{ id: 's1', title: '测试会话', live: true, presetId: 'standard', workspace: 'E:\\work\\demo', orchestrated: true }],
    toolPresets: [{ id: 'p1', name: '常用组', tools: ['alpha_tool'], createdAt: 1 }],
  }
}

function render(overrides: Partial<ControlPanelViewProps> = {}): string {
  const props: ControlPanelViewProps = {
    t,
    snapshot: snapshot(),
    selected: { kind: 'session', id: 's1' },
    busy: false,
    draft: {},
    dirty: false,
    saving: false,
    toolPresets: [{ id: 'p1', name: '常用组', tools: ['alpha_tool'], createdAt: 1 }],
    onToggleTool: () => {},
    onToggleTools: () => {},
    onSaveTools: () => {},
    onSelectToolPreset: () => {},
    onApplyToolPreset: () => {},
    onCreateToolPreset: async () => false,
    onDeleteToolPreset: () => {},
    ...overrides,
  }
  return renderToStaticMarkup(createElement(ControlPanelView, props))
}

const prompt: PresetPrompt = {
  id: 'standard',
  name: '标准预设',
  root: 'E:\\work\\presets\\standard',
  files: ['system.md'],
  text: '你是助手。',
  missing: [],
}

describe('tool panel view', () => {
  it('locks only the harness-provided preset ids', () => {
    expect(isOfficialPreset('standard')).toBe(true)
    expect(isOfficialPreset('minimal')).toBe(true)
    expect(isOfficialPreset('ptc')).toBe(true)
    expect(isOfficialPreset('cordis')).toBe(true)
    expect(isOfficialPreset('custom-demo')).toBe(false)
    expect(isOfficialPreset(undefined)).toBe(false)
  })

  it('renders the tool and preset tabs only', () => {
    const markup = render()
    for (const label of ['工具', '预设']) {
      expect(markup).toContain(`>${label}<`)
    }
    for (const removed of ['事件', '日志', '健康']) {
      expect(markup).not.toContain(`>${removed}<`)
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

  it('keeps a custom preset managed static id as a switchable dynamic row', () => {
    const base = snapshot()
    const custom: CapabilitySnapshot = {
      ...base,
      tools: [
        {
          id: 'read', nameZh: '读取文件', group: 'static', scope: 'agent', origin: 'static',
          locked: true, sourcePresetId: 'custom-demo', enabledBy: { 'session:s1': true },
          stepBy: { 'session:s1': 'active' },
        },
        {
          id: 'read', nameZh: '读取文件', group: 'managed', scope: 'agent', origin: 'dynamic',
          locked: false, enabledBy: { 'session:s1': false }, stepBy: { 'session:s1': 'hidden' },
        },
      ],
      sessions: [{ ...base.sessions[0]!, presetId: 'custom-demo' }],
    }
    const markup = render({ snapshot: custom })
    expect(markup.match(/data-tool-id="read"/g)?.length).toBe(1)
    expect(markup).not.toContain('data-tool-id="read" data-origin="static"')
    expect(markup).toContain('data-tool-id="read"')
  })

  it('keeps an official preset static id locked and hides the dynamic duplicate', () => {
    const base = snapshot()
    const official: CapabilitySnapshot = {
      ...base,
      tools: [
        {
          id: 'read', nameZh: '读取文件', group: 'static', scope: 'agent', origin: 'static',
          locked: true, sourcePresetId: 'standard', enabledBy: { 'session:s1': true },
          stepBy: { 'session:s1': 'active' },
        },
        {
          id: 'read', nameZh: '读取文件', group: 'managed', scope: 'agent', origin: 'dynamic',
          locked: false, enabledBy: { 'session:s1': false }, stepBy: { 'session:s1': 'hidden' },
        },
      ],
      sessions: [{ ...base.sessions[0]!, presetId: 'standard' }],
    }
    const markup = render({ snapshot: official })
    expect(markup.match(/data-tool-id="read" data-origin="static"/g)?.length).toBe(2)
    expect(markup).not.toContain('aria-label="切换读取文件"')
  })

  it('shows the save action for a dirty tool draft', () => {
    const markup = render({ draft: { alpha_tool: false }, dirty: true })
    expect(markup).toContain('工具修改尚未保存')
    expect(markup).toContain('保存')
  })

  it('renders the preset prompt read-only on the preset tab', () => {
    const markup = render({ forcedTab: 'static', presetPrompt: prompt })
    expect(markup).toContain('data-preset-prompt="true"')
    expect(markup).toContain('标准预设')
    expect(markup).toContain('你是助手。')
    expect(markup).not.toContain('当前预设不是由预设管理器创建的')
  })

  it('explains an unreadable preset prompt', () => {
    const markup = render({ forcedTab: 'static' })
    expect(markup).toContain('当前预设不是由预设管理器创建的')
  })

  it('asks for tool editing mode before showing tools', () => {
    const base = snapshot()
    const markup = render({ snapshot: { ...base, sessions: [{ ...base.sessions[0]!, orchestrated: false }] } })
    expect(markup).toContain('请先开启工具编辑模式')
    expect(markup).not.toContain('DSH 基础工具')
  })
})
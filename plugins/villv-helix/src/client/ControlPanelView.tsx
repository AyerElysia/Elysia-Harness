/**
 * Presentational tool panel: one pure render of a loaded session snapshot and
 * the tool draft, with the static preset tools, the switchable global tool
 * groups, and the read-only preset prompt.
 *
 * Static tools come from the preset composition and carry no switch; every
 * global tool is a dynamic row the session may disable. It owns no request, so
 * a spec can drive every state by props.
 *
 * @module @elysia/villv-helix/client/ControlPanelView
 */

import { useState, type ReactNode } from 'react'
import type {
  CapabilitySnapshot, PresetPrompt, ScopeKey, ScopeRef, ToolEntry, ToolPresetEntry,
} from '../types.ts'
import {
  effectivePresetId, isShadowed, scopeKeyOf, shadowedToolIds, staticToolsFor, toolKey,
} from './panel-state.ts'
import { isOfficialPreset } from '../presets.ts'
import { DSH_CORE_GLOBAL_TOOL_IDS, toolCategories, type ToolCategory } from './categories.ts'
import { stepText, toolLabel, type ControlPanelTranslate } from './labels.ts'
import css from './ControlPanelPage.module.css'

/** The panel's translate seat, narrowed to its own dictionary. */
type T = ControlPanelTranslate

/** One top-level session tab. */
export type PanelTab = 'tools' | 'static'

const PANEL_TABS: readonly { id: PanelTab; label: 'tabTools' | 'tabPreset' }[] = [
  { id: 'tools', label: 'tabTools' },
  { id: 'static', label: 'tabPreset' },
]

/** Props of the whole panel; the container supplies every value. */
export interface ControlPanelViewProps {
  /** Localized copy. */
  readonly t: T
  /** Every tool the Host reports for this session. */
  readonly snapshot: CapabilitySnapshot
  /** The session scope; absent when the snapshot carries no session row. */
  readonly selected: ScopeRef | undefined
  /** Native top tab this page renders; omit for the standalone in-page tabs. */
  readonly forcedTab?: PanelTab | undefined
  /** Read-only prompt bundle of the active preset, when the manager owns it. */
  readonly presetPrompt?: PresetPrompt | undefined
  /** Whether a write is in flight; every switch is disabled meanwhile. */
  readonly busy: boolean
  /** Unsaved tool changes keyed by tool id. */
  readonly draft: Readonly<Record<string, boolean>>
  /** Whether the current draft differs from the Host snapshot. */
  readonly dirty: boolean
  /** Whether a tool save is in flight. */
  readonly saving: boolean
  /** Saved tool groups the Host reports. */
  readonly toolPresets: readonly ToolPresetEntry[]
  /** Saved tool group selected in the toolbar. */
  readonly selectedToolPresetId?: string | undefined
  /** Change one draft tool switch. */
  readonly onToggleTool: (tool: ToolEntry, enabled: boolean) => void
  /** Change every tool in one category at once. */
  readonly onToggleTools: (tools: readonly ToolEntry[], enabled: boolean) => void
  /** Save every pending tool change. */
  readonly onSaveTools: () => void
  /** Select a saved tool group. */
  readonly onSelectToolPreset: (id: string | undefined) => void
  /** Apply a saved tool group to the draft. */
  readonly onApplyToolPreset: (preset: ToolPresetEntry) => void
  /** Create a saved tool group from the current draft. */
  readonly onCreateToolPreset: (name: string) => Promise<boolean>
  /** Delete a saved tool group. */
  readonly onDeleteToolPreset: (preset: ToolPresetEntry) => void
}

/** The preset's static tool face: always on, locked, and never written. */
function StaticToolsCard({
  t, tools, presetId, presetName, scopeKey,
}: {
  readonly t: T
  readonly tools: readonly ToolEntry[]
  readonly presetId: string | undefined
  readonly presetName: string | undefined
  readonly scopeKey: ScopeKey
}): ReactNode {
  return (
    <article className={css.groupCard} data-group-id="static" data-origin="static" data-locked="true">
      <header className={css.groupHeader}>
        <span className={css.badgeRow}>
          <span className={css.badgeMuted}>{t('readOnly')}</span>
          <span className={css.badgeMuted}>{t('lockedShort')}</span>
          {presetId === undefined ? null : (
            <span className={css.badgeMuted}>{t('staticSourceLabel', { preset: presetName ?? presetId })}</span>
          )}
        </span>
      </header>
      <p className={css.groupNote}>{t('staticLockedHint')}</p>
      {tools.length === 0 ? <p className={css.hint}>{t('staticEmpty')}</p> : null}
      <ul className={css.toolList}>
        {tools.map(tool => (
          <li
            key={toolKey(tool)}
            className={css.toolRow}
            data-tool-id={tool.id}
            data-origin="static"
            data-locked="true"
          >
            <span className={css.toolName}>{toolLabel(t, tool.id, true, tool.nameZh)}</span>
            <code className={css.toolId}>{tool.id}</code>
            {tool.provider === undefined ? null : <span className={css.badgeMuted}>{tool.provider}</span>}
            <span className={css.badgeMuted}>{t(tool.scope === 'global' ? 'scopeGlobal' : 'scopeAgent')}</span>
            <span className={css.toolMeta}>
              {t('stepLabel')}: {stepText(t, tool.stepBy?.[scopeKey])}
            </span>
            <span className={css.badgeMuted}>{t('staticLockedShort')}</span>
          </li>
        ))}
      </ul>
    </article>
  )
}

/** Read-only preview of the active preset's prompt bundle. */
function PresetPromptCard({ t, prompt }: { readonly t: T; readonly prompt: PresetPrompt }): ReactNode {
  return (
    <article className={css.groupCard} data-preset-prompt="true">
      <header className={css.groupHeader}>
        <span className={css.badgeRow}>
          <span className={css.badgeMuted}>{t('readOnly')}</span>
          <span className={css.badgeMuted}>{prompt.name ?? prompt.id}</span>
        </span>
      </header>
      <p className={css.groupNote}>{t('presetPromptHint')}</p>
      <p className={css.promptRoot}>{prompt.root}</p>
      {prompt.missing.length === 0 ? null : (
        <p className={css.failure} role="alert">
          {t('presetPromptMissing', { files: prompt.missing.join(', ') })}
        </p>
      )}
      <ul className={css.promptFiles}>
        {prompt.files.map(file => <li key={file}><code>{file}</code></li>)}
      </ul>
      <pre className={css.promptText}>{prompt.text}</pre>
    </article>
  )
}

/** One collapsible functional category of switchable global tools. */
function ToolCategoryCard({
  t, category, draft, translate, disabled, scopeKey, shadowedIds, onToggleTool, onToggleTools,
}: {
  readonly t: T
  readonly category: ToolCategory
  readonly draft: Readonly<Record<string, boolean>>
  readonly translate: boolean
  readonly disabled: boolean
  readonly scopeKey: ScopeKey
  readonly shadowedIds: ReadonlySet<string>
  readonly onToggleTool: (tool: ToolEntry, enabled: boolean) => void
  readonly onToggleTools: (tools: readonly ToolEntry[], enabled: boolean) => void
}): ReactNode {
  const [open, setOpen] = useState(true)
  const members = category.tools.filter(tool => !isShadowed(tool, shadowedIds))
  if (members.length === 0) return null
  const enabledCount = members.filter(tool => draft[tool.id] ?? tool.enabledBy?.[scopeKey] ?? true).length
  return (
    <article className={css.categoryCard} data-category-id={category.id}>
      <header className={css.categoryHeaderRow}>
        <button
          type="button"
          className={css.categoryHeader}
          aria-expanded={open}
          onClick={() => { setOpen(value => !value) }}
        >
          <span className={css.categoryChevron} aria-hidden>{open ? '▾' : '▸'}</span>
          <span className={css.categoryTitle}>{t(category.label)}</span>
          <span className={css.badgeMuted}>{t('toolCount', {
            enabled: String(enabledCount), total: String(members.length),
          })}</span>
        </button>
        <label className={css.categoryCheck}>
          <input
            type="checkbox"
            className={css.checkbox}
            checked={enabledCount === members.length && members.length > 0}
            disabled={disabled}
            aria-label={t('selectCategoryTools', { category: t(category.label) })}
            onChange={(event) => { onToggleTools(members, event.currentTarget.checked) }}
          />
        </label>
      </header>
      {open ? (
        <ul className={css.memberList}>
          {members.map((tool) => {
            const checked = draft[tool.id] ?? tool.enabledBy?.[scopeKey] ?? true
            return (
              <li key={toolKey(tool)} className={css.member} data-tool-id={tool.id}>
                <label className={css.switchRow}>
                  <input
                    type="checkbox"
                    className={css.checkbox}
                    checked={checked}
                    disabled={disabled || tool.failure !== undefined}
                    aria-label={t('toolToggleLabel', { tool: toolLabel(t, tool.id, translate, tool.nameZh) })}
                    onChange={(event) => { onToggleTool(tool, event.currentTarget.checked) }}
                  />
                  <span className={css.memberName}>{toolLabel(t, tool.id, translate, tool.nameZh)}</span>
                  <code className={css.toolId}>{tool.id}</code>
                </label>
                {tool.failure === undefined ? null : (
                  <span className={css.badgeError} role="alert">{t('toolFailure', { failure: tool.failure })}</span>
                )}
              </li>
            )
          })}
        </ul>
      ) : null}
    </article>
  )
}

/** Saved tool-group selector and its apply/create/delete actions. */
function ToolPresetBar({
  t, presets, selectedId, disabled, onSelect, onApply, onCreate, onDelete,
}: {
  readonly t: T
  readonly presets: readonly ToolPresetEntry[]
  readonly selectedId: string | undefined
  readonly disabled: boolean
  readonly onSelect: (id: string | undefined) => void
  readonly onApply: (preset: ToolPresetEntry) => void
  readonly onCreate: () => void
  readonly onDelete: (preset: ToolPresetEntry) => void
}): ReactNode {
  const selected = presets.find(preset => preset.id === selectedId)
  return (
    <div className={css.toolPresetBar}>
      <label className={css.toolPresetSelect}>
        <span>{t('toolPresets')}</span>
        <select
          value={selectedId ?? ''}
          disabled={disabled}
          onChange={(event) => { onSelect(event.currentTarget.value === '' ? undefined : event.currentTarget.value) }}
        >
          <option value="">{t('toolPresetPlaceholder')}</option>
          {presets.map(preset => <option key={preset.id} value={preset.id}>{preset.name}</option>)}
        </select>
      </label>
      <button
        type="button"
        className={css.secondary}
        disabled={disabled || selected === undefined}
        onClick={() => { if (selected !== undefined) onApply(selected) }}
      >
        {t('applyToolPreset')}
      </button>
      <button type="button" className={css.secondary} disabled={disabled} onClick={onCreate}>
        {t('createToolPreset')}
      </button>
      <button
        type="button"
        className={css.secondary}
        disabled={disabled || selected === undefined}
        onClick={() => { if (selected !== undefined) onDelete(selected) }}
      >
        {t('deleteToolPreset')}
      </button>
    </div>
  )
}

/** Modal asking for the new saved tool group's name. */
function CreateToolPresetDialog({
  t, busy, onClose, onCreate,
}: {
  readonly t: T
  readonly busy: boolean
  readonly onClose: () => void
  readonly onCreate: (name: string) => Promise<boolean>
}): ReactNode {
  const [name, setName] = useState('')
  const [error, setError] = useState<string | undefined>(undefined)
  const submit = async (): Promise<void> => {
    if (name.trim() === '') {
      setError(t('toolPresetNameRequired'))
      return
    }
    setError(undefined)
    if (await onCreate(name.trim())) onClose()
  }
  return (
    <div className={css.modalBackdrop} role="presentation">
      <form
        className={css.modal}
        role="dialog"
        aria-modal="true"
        aria-label={t('createToolPreset')}
        onSubmit={(event) => { event.preventDefault(); void submit() }}
      >
        <h4 className={css.modalTitle}>{t('createToolPreset')}</h4>
        <label className={css.modalField}>
          <span>{t('toolPresetName')}</span>
          <input
            autoFocus
            value={name}
            placeholder={t('toolPresetNamePlaceholder')}
            onChange={(event) => { setName(event.currentTarget.value); setError(undefined) }}
          />
        </label>
        {error === undefined ? null : <p className={css.failure} role="alert">{error}</p>}
        <div className={css.modalActions}>
          <button type="button" className={css.secondary} disabled={busy} onClick={onClose}>{t('cancel')}</button>
          <button type="submit" className={css.primary} disabled={busy}>{t('create')}</button>
        </div>
      </form>
    </div>
  )
}

/** Render the panel's loading state. */
export function ControlPanelLoading({ t }: { readonly t: T }): ReactNode {
  return <p className={css.hint}>{t('loading')}</p>
}

/** Render the panel's load-failure state with its retry action. */
export function ControlPanelFailure({
  t, onRetry,
}: {
  readonly t: T
  readonly onRetry: () => void
}): ReactNode {
  return (
    <p className={css.failure} role="alert">
      {t('error')}
      <button type="button" className={css.secondary} onClick={onRetry}>
        {t('retry')}
      </button>
    </p>
  )
}

/** Render the loaded panel. */
export function ControlPanelView({
  t, snapshot, selected, forcedTab, presetPrompt, busy, draft, dirty, saving,
  toolPresets, selectedToolPresetId,
  onToggleTool, onToggleTools, onSaveTools, onSelectToolPreset, onApplyToolPreset,
  onCreateToolPreset, onDeleteToolPreset,
}: ControlPanelViewProps): ReactNode {
  const [translateNames, setTranslateNames] = useState(true)
  const [createOpen, setCreateOpen] = useState(false)
  const [stateTab, setActiveTab] = useState<PanelTab>('tools')
  const activeTab = forcedTab ?? stateTab
  const [nativeOpen, setNativeOpen] = useState(true)
  const [pluginOpen, setPluginOpen] = useState(true)
  const key = selected === undefined ? undefined : scopeKeyOf(selected)
  const presetId = effectivePresetId(snapshot)
  const presetName = snapshot.sessions[0]?.presetName
  const official = isOfficialPreset(presetId)
  const allStaticTools = staticToolsFor(snapshot.tools, presetId)
  const allDynamicTools = snapshot.tools.filter(tool => tool.origin === 'dynamic')
  const staticIds = shadowedToolIds(allStaticTools)
  const dynamicIds = new Set(allDynamicTools.map(tool => tool.id))
  // Official presets keep their static ids locked. A custom preset's static
  // copy of a managed id is behind the session-local Helix definition, so it
  // disappears from the locked list and the switchable row stays above.
  const staticTools = official
    ? allStaticTools
    : allStaticTools.filter(tool => !dynamicIds.has(tool.id))
  const shadowedIds = official ? staticIds : new Set<string>()
  const dynamicTools = official
    ? allDynamicTools.filter(tool => !isShadowed(tool, staticIds))
    : allDynamicTools
  // DSH native = the base bundle's host-global tools. Optional/experimental
  // packages (plugin market, Cordis inspection, external MCP) stay outside this
  // parent, exactly as the original panel split the two groups.
  const nativeTools = dynamicTools.filter(tool => DSH_CORE_GLOBAL_TOOL_IDS.has(tool.id))
  const pluginTools = dynamicTools.filter(tool => !DSH_CORE_GLOBAL_TOOL_IDS.has(tool.id))
  const nativeCategories = toolCategories(nativeTools)
  const pluginCategories = toolCategories(pluginTools)
  const enabledCount = key === undefined
    ? 0
    : dynamicTools.filter(tool => draft[tool.id] ?? tool.enabledBy?.[key] ?? true).length
  const nativeEnabledCount = key === undefined
    ? 0
    : nativeTools.filter(tool => draft[tool.id] ?? tool.enabledBy?.[key] ?? true).length
  const pluginEnabledCount = key === undefined
    ? 0
    : pluginTools.filter(tool => draft[tool.id] ?? tool.enabledBy?.[key] ?? true).length
  if (snapshot.sessions[0]?.orchestrated === false) {
    return (
      <div className={css.page} data-villv-helix-panel>
        <p className={css.notice}>{t('modeRequired')}</p>
      </div>
    )
  }
  return (
    <div className={css.page} data-villv-helix-panel>
      {busy ? <p className={css.notice}>{t('pending')}</p> : null}
      <section className={css.panel}>
          {forcedTab === undefined ? (
            <nav className={css.tabBar} role="tablist" aria-label={t('panelTabs')}>
              {PANEL_TABS.map(tab => (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  className={activeTab === tab.id ? `${css.tab} ${css.tabActive}` : css.tab}
                  aria-selected={activeTab === tab.id}
                  onClick={() => { setActiveTab(tab.id) }}
                >
                  {t(tab.label)}
                </button>
              ))}
            </nav>
          ) : null}

          <div className={css.tabPanel} role="tabpanel" hidden={activeTab !== 'tools'}>
            {selected === undefined || key === undefined ? (
              <p className={css.hint}>{t('noScopeHint')}</p>
            ) : (
              <>
                <p className={css.hint}>{t('toolsScopeHint')}</p>

                <div className={css.dynamicHeaderRow}>
                  <span className={css.badgeMuted}>{t('toolCount', {
                    enabled: String(enabledCount), total: String(dynamicTools.length),
                  })}</span>
                  <label className={css.inlineSwitch}>
                    <input
                      type="checkbox"
                      className={css.checkbox}
                      checked={translateNames}
                      onChange={(event) => { setTranslateNames(event.currentTarget.checked) }}
                    />
                    <span>{t('translateTools')}</span>
                  </label>
                </div>

                <ToolPresetBar
                  t={t}
                  presets={toolPresets}
                  selectedId={selectedToolPresetId}
                  disabled={busy || saving}
                  onSelect={onSelectToolPreset}
                  onApply={onApplyToolPreset}
                  onCreate={() => { setCreateOpen(true) }}
                  onDelete={(preset) => {
                    if (window.confirm(t('toolPresetDeleteConfirm', { name: preset.name }))) {
                      onDeleteToolPreset(preset)
                    }
                  }}
                />

                {nativeCategories.length === 0 && pluginCategories.length === 0
                  ? <p className={css.hint}>{t('emptyGroups')}</p>
                  : null}
                {nativeCategories.length === 0 ? null : (
                  <section className={css.parentGroup} data-parent-id="dsh-native">
                    <header className={css.parentHeaderRow}>
                      <button
                        type="button"
                        className={css.parentHeader}
                        aria-expanded={nativeOpen}
                        onClick={() => { setNativeOpen(value => !value) }}
                      >
                        <span className={css.categoryChevron} aria-hidden>{nativeOpen ? '▾' : '▸'}</span>
                        <span className={css.categoryTitle}>{t('nativeToolsGroup')}</span>
                        <span className={css.badgeMuted}>{t('toolCount', {
                          enabled: String(nativeEnabledCount), total: String(nativeTools.length),
                        })}</span>
                      </button>
                      <label className={css.categoryCheck}>
                        <input
                          type="checkbox"
                          className={css.checkbox}
                          checked={nativeEnabledCount === nativeTools.length && nativeTools.length > 0}
                          disabled={busy || saving}
                          aria-label={t('selectCategoryTools', { category: t('nativeToolsGroup') })}
                          onChange={(event) => { onToggleTools(nativeTools, event.currentTarget.checked) }}
                        />
                      </label>
                    </header>
                    {nativeOpen ? nativeCategories.map(category => (
                      <ToolCategoryCard
                        key={category.id}
                        t={t}
                        category={category}
                        draft={draft}
                        translate={translateNames}
                        disabled={busy || saving}
                        scopeKey={key}
                        shadowedIds={shadowedIds}
                        onToggleTool={onToggleTool}
                        onToggleTools={onToggleTools}
                      />
                    )) : null}
                  </section>
                )}
                {pluginCategories.length === 0 ? null : (
                  <section className={css.parentGroup} data-parent-id="plugin-tools">
                    <header className={css.parentHeaderRow}>
                      <button
                        type="button"
                        className={css.parentHeader}
                        aria-expanded={pluginOpen}
                        onClick={() => { setPluginOpen(value => !value) }}
                      >
                        <span className={css.categoryChevron} aria-hidden>{pluginOpen ? '▾' : '▸'}</span>
                        <span className={css.categoryTitle}>{t('pluginToolsGroup')}</span>
                        <span className={css.badgeMuted}>{t('toolCount', {
                          enabled: String(pluginEnabledCount), total: String(pluginTools.length),
                        })}</span>
                      </button>
                      <label className={css.categoryCheck}>
                        <input
                          type="checkbox"
                          className={css.checkbox}
                          checked={pluginEnabledCount === pluginTools.length && pluginTools.length > 0}
                          disabled={busy || saving}
                          aria-label={t('selectCategoryTools', { category: t('pluginToolsGroup') })}
                          onChange={(event) => { onToggleTools(pluginTools, event.currentTarget.checked) }}
                        />
                      </label>
                    </header>
                    {pluginOpen ? pluginCategories.map(category => (
                      <ToolCategoryCard
                        key={category.id}
                        t={t}
                        category={category}
                        draft={draft}
                        translate={translateNames}
                        disabled={busy || saving}
                        scopeKey={key}
                        shadowedIds={shadowedIds}
                        onToggleTool={onToggleTool}
                        onToggleTools={onToggleTools}
                      />
                    )) : null}
                  </section>
                )}

                <StaticToolsCard
                  t={t}
                  tools={staticTools}
                  presetId={presetId}
                  presetName={presetName}
                  scopeKey={key}
                />

                {createOpen ? (
                  <CreateToolPresetDialog
                    t={t}
                    busy={saving}
                    onClose={() => { setCreateOpen(false) }}
                    onCreate={onCreateToolPreset}
                  />
                ) : null}
              </>
            )}
          </div>

          <div className={css.tabPanel} role="tabpanel" hidden={activeTab !== 'static'}>
            {selected === undefined || key === undefined ? (
              <p className={css.hint}>{t('noScopeHint')}</p>
            ) : (
              <>
                <StaticToolsCard t={t} tools={staticTools} presetId={presetId} presetName={presetName} scopeKey={key} />
                {presetPrompt === undefined
                  ? <p className={css.hint}>{t('presetPromptUnavailable')}</p>
                  : <PresetPromptCard t={t} prompt={presetPrompt} />}
              </>
            )}
          </div>

          {selected === undefined ? null : activeTab === 'tools' ? (
            <div className={css.panelFooter}>
              <span className={dirty ? css.unsavedHint : css.hint}>
                {dirty ? t('toolsUnsaved') : t('noToolChanges')}
              </span>
              <button
                type="button"
                className={css.primary}
                disabled={busy || saving || !dirty}
                onClick={onSaveTools}
              >
                {saving ? t('pending') : t('saveTools')}
              </button>
            </div>
          ) : null}
        </section>
    </div>
  )
}
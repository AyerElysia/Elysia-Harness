/**
 * Presentational capability panel: one pure render of a loaded Host snapshot
 * and status, with the scope list on the left and the static tools, dynamic
 * tool groups, subscriptions, event log, and health on the right.
 *
 * v1.2 shows two tool origins side by side: static tools come from the preset
 * definition and carry no switch, dynamic tools come from the Host catalog and
 * switch per scope. It owns no state and performs no request, so a spec can
 * drive every state by props.
 *
 * @module @elysia/capability-host/client/ControlPanelView
 */

import { useState, type ReactNode } from 'react'
import type {
  CapabilitySnapshot, ContextEntry, HostStatus, ScopeKey, ScopeRef,
  ScopeRowEntry, ToolEntry, ToolPresetEntry,
} from './types.ts'
import {
  effectivePresetId, formatAge, formatClock, isShadowed, orderSessions,
  scopeKeyOf, scopeOfRow, shadowedToolIds, staticToolsFor, toolKey,
} from './panel-state.ts'
import { DSH_CORE_GLOBAL_TOOL_IDS, toolCategories, type ToolCategory } from './categories.ts'
import {
  contextLabel, outcomeText, stepText, toolLabel, type ControlPanelTranslate,
} from './labels.ts'
import css from './ControlPanelPage.module.css'

/** The panel's translate seat, narrowed to its own dictionary. */
type T = ControlPanelTranslate

/** How many event-log rows the panel shows. */
const EVENT_LOG_LIMIT = 20

/** One quick-switch tab above the right-hand panel. */
type PanelTab = 'tools' | 'contexts' | 'events' | 'health' | 'static'

const PANEL_TABS: readonly { id: PanelTab; label: 'toolsSection' | 'contextsSection' | 'eventLogSection' | 'healthSection' | 'tabStaticTools' }[] = [
  { id: 'tools', label: 'toolsSection' },
  { id: 'contexts', label: 'contextsSection' },
  { id: 'events', label: 'eventLogSection' },
  { id: 'health', label: 'healthSection' },
  { id: 'static', label: 'tabStaticTools' },
]

/** Last path segment of a workspace, used as its short label. */
function workspaceName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path
}

function ttlText(t: T, ttlMs: number): string {
  if (ttlMs >= 60_000 && ttlMs % 60_000 === 0) return t('ttlMinutes', { count: String(ttlMs / 60_000) })
  return t('ttlSeconds', { count: String(Math.round(ttlMs / 1000)) })
}

function ageText(t: T, ms: number): string {
  const age = formatAge(ms)
  if (age.unit === 'justNow') return t('justNow')
  if (age.unit === 'seconds') return t('secondsAgo', { count: String(age.count) })
  if (age.unit === 'minutes') return t('minutesAgo', { count: String(age.count) })
  return t('hoursAgo', { count: String(age.count) })
}

/** Props of the whole panel; the container supplies every value. */
export interface ControlPanelViewProps {
  /** Localized copy. */
  readonly t: T
  /** Every switchable surface and the scope lists. */
  readonly snapshot: CapabilitySnapshot
  /** Write authority and the health sample. */
  readonly status: HostStatus
  /** Scope the right-hand panels show; absent when no session or preset exists. */
  readonly selected: ScopeRef | undefined
  /** Whether a write is in flight; every switch is disabled meanwhile. */
  readonly busy: boolean
  /** Unsaved tool changes keyed by tool id. */
  readonly draft: Readonly<Record<string, boolean>>
  /** Whether the current draft differs from the Host snapshot. */
  readonly dirty: boolean
  /** Whether a tool save is in flight. */
  readonly saving: boolean
  /** Unsaved context-subscription changes keyed by event kind. */
  readonly contextDraft: Readonly<Record<string, boolean>>
  /** Whether the current context draft differs from the Host snapshot. */
  readonly contextDirty: boolean
  /** Whether a context save is in flight. */
  readonly contextSaving: boolean
  /** Saved tool groups the Host reports. */
  readonly toolPresets: readonly ToolPresetEntry[]
  /** Saved tool group selected in the toolbar. */
  readonly selectedToolPresetId?: string | undefined
  /** Workspace path selected in the session filter; absent means all. */
  readonly workspaceFilter?: string | undefined
  /** Change the session workspace filter. */
  readonly onWorkspaceFilter?: (workspace: string | undefined) => void
  /** Select one scope. */
  readonly onSelect: (scope: ScopeRef) => void
  /** Change one draft tool switch. */
  readonly onToggleTool: (tool: ToolEntry, enabled: boolean) => void
  /** Change every tool in one category at once. */
  readonly onToggleTools: (tools: readonly ToolEntry[], enabled: boolean) => void
  /** Save every pending tool change. */
  readonly onSaveTools: () => void
  /** Save every pending context change. */
  readonly onSaveContexts: () => void
  /** Select a saved tool group. */
  readonly onSelectToolPreset: (id: string | undefined) => void
  /** Apply a saved tool group to the draft. */
  readonly onApplyToolPreset: (preset: ToolPresetEntry) => void
  /** Create a saved tool group from the current draft. */
  readonly onCreateToolPreset: (name: string) => Promise<boolean>
  /** Delete a saved tool group. */
  readonly onDeleteToolPreset: (preset: ToolPresetEntry) => void
  /** Subscribe or unsubscribe one context event kind. */
  readonly onToggleContext: (entry: ContextEntry, enabled: boolean) => void
}

/** One navigation row of the scope list. */
function ScopeItem({
  t, row, selectedKey, onSelect,
}: {
  readonly t: T
  readonly row: ScopeRowEntry
  readonly selectedKey: ScopeKey | undefined
  readonly onSelect: (scope: ScopeRef) => void
}): ReactNode {
  const scope = scopeOfRow(row)
  const key = scopeKeyOf(scope)
  const name = row.title ?? row.id
  return (
    <li>
      <button
        type="button"
        className={key === selectedKey ? `${css.scopeButton} ${css.scopeButtonActive}` : css.scopeButton}
        aria-pressed={key === selectedKey}
        data-scope-key={key}
        onClick={() => { onSelect(scope) }}
      >
        <span className={css.scopeTitle}>{name}</span>
        <span className={css.badgeRow}>
          {row.kind === 'session' ? (
            <span className={row.live ? css.badgeOk : css.badgeMuted}>
              {t(row.live ? 'sessionLive' : 'sessionOffline')}
            </span>
          ) : null}
          {row.kind === 'preset' && row.sessionCount !== undefined ? (
            <span className={css.badgeMuted}>{t('presetSessionCount', { count: String(row.sessionCount) })}</span>
          ) : null}
          {row.kind === 'session' && row.workspace !== undefined ? (
            <span className={css.badgeMuted} title={row.workspace}>{workspaceName(row.workspace)}</span>
          ) : null}
          {row.kind !== 'session' ? null : row.presetId === undefined
            ? <span className={css.badgeMuted}>{t('noPreset')}</span>
            : <span className={css.badgeMuted}>{t('detectedPreset', { preset: row.presetId })}</span>}
        </span>
      </button>
    </li>
  )
}

/** The preset's static tool face: always on, locked, and never written. */
function StaticToolsCard({
  t, tools, presetId, scopeKey,
}: {
  readonly t: T
  readonly tools: readonly ToolEntry[]
  readonly presetId: string | undefined
  readonly scopeKey: ScopeKey
}): ReactNode {
  return (
    <article className={css.groupCard} data-group-id="static" data-origin="static" data-locked="true">
      <header className={css.groupHeader}>
        <span className={css.badgeRow}>
          <span className={css.badgeMuted}>{t('readOnly')}</span>
          <span className={css.badgeMuted}>{t('lockedShort')}</span>
          {presetId === undefined ? null : (
            <span className={css.badgeMuted}>{t('staticSourceLabel', { preset: presetId })}</span>
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
            <span className={css.toolName}>{toolLabel(t, tool.id)}</span>
            <code className={css.toolId}>{tool.id}</code>
            {tool.provider === undefined ? null : <span className={css.badgeMuted}>{tool.provider}</span>}
            <span className={css.badgeMuted}>{t(tool.scope === 'global' ? 'scopeGlobal' : 'scopeAgent')}</span>
            <span className={css.toolMeta}>
              {t('stepLabel')}: {stepText(t, tool.stepBy === undefined ? undefined : tool.stepBy[scopeKey])}
            </span>
            <span className={css.badgeMuted}>{t('staticLockedShort')}</span>
          </li>
        ))}
      </ul>
    </article>
  )
}

/** One collapsible functional category of switchable dynamic tools. */
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
  const enabledCount = members.filter(tool => draft[tool.id] ?? tool.enabledBy?.[scopeKey] ?? false).length
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
            const checked = draft[tool.id] ?? tool.enabledBy?.[scopeKey] ?? false
            return (
              <li key={toolKey(tool)} className={css.member} data-tool-id={tool.id}>
                <label className={css.switchRow}>
                  <input
                    type="checkbox"
                    className={css.checkbox}
                    checked={checked}
                    disabled={disabled}
                    aria-label={t('toolToggleLabel', { tool: toolLabel(t, tool.id, translate) })}
                    onChange={(event) => { onToggleTool(tool, event.currentTarget.checked) }}
                  />
                  <span className={css.memberName}>{toolLabel(t, tool.id, translate)}</span>
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

/** One context event kind with its per-scope subscription switch. */
function ContextRow({
  t, entry, checked, writable, busy, onToggle,
}: {
  readonly t: T
  readonly entry: ContextEntry
  readonly checked: boolean
  readonly writable: boolean
  readonly busy: boolean
  readonly onToggle: (entry: ContextEntry, enabled: boolean) => void
}): ReactNode {
  const label = contextLabel(t, entry.kind)
  return (
    <li className={css.contextRow} data-context-kind={entry.kind}>
      <label className={css.switchRow}>
        <input
          type="checkbox"
          className={css.checkbox}
          checked={checked}
          disabled={!writable || busy}
          aria-label={t('contextToggleLabel', { kind: label })}
          onChange={(event) => { onToggle(entry, event.currentTarget.checked) }}
        />
        <span className={css.toolName}>{label}</span>
        <code className={css.toolId}>{entry.kind}</code>
      </label>
      <span className={css.badgeRow}>
        <span className={entry.active ? css.badgeWarn : css.badgeMuted}>
          {t(entry.active ? 'contextActive' : 'contextPassive')}
        </span>
        {entry.ttlMs === undefined ? null : <span className={css.badgeMuted}>{ttlText(t, entry.ttlMs)}</span>}
        {entry.backlog === undefined ? null : (
          <span className={css.badgeMuted}>{t('contextBacklog', { count: String(entry.backlog) })}</span>
        )}
      </span>
      {entry.failure === undefined ? null : (
        <p className={css.failure} role="alert">{t('contextFailure', { failure: entry.failure })}</p>
      )}
    </li>
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
  t, snapshot, status, selected, busy, draft, dirty, saving,
  contextDraft, contextDirty, contextSaving,
  toolPresets, selectedToolPresetId,
  workspaceFilter = undefined, onWorkspaceFilter = () => {},
  onSelect, onToggleTool, onToggleTools, onSaveTools, onSaveContexts, onSelectToolPreset, onApplyToolPreset,
  onCreateToolPreset, onDeleteToolPreset, onToggleContext,
}: ControlPanelViewProps): ReactNode {
  const [translateNames, setTranslateNames] = useState(true)
  const [createOpen, setCreateOpen] = useState(false)
  const [activeTab, setActiveTab] = useState<PanelTab>('tools')
  const [nativeOpen, setNativeOpen] = useState(true)
  const [pluginOpen, setPluginOpen] = useState(true)
  const key = selected === undefined ? undefined : scopeKeyOf(selected)
  const writable = status.writable
  const allSessions = orderSessions(snapshot.sessions)
  const workspaceOptions = [...new Set(allSessions.flatMap(row => row.workspace === undefined ? [] : [row.workspace]))]
    .sort()
  const activeWorkspace = workspaceFilter !== undefined && workspaceOptions.includes(workspaceFilter)
    ? workspaceFilter
    : undefined
  const sessions = activeWorkspace === undefined
    ? allSessions
    : allSessions.filter(row => row.workspace === activeWorkspace)
  const presetId = effectivePresetId(selected, snapshot)
  const staticTools = staticToolsFor(snapshot.tools, presetId)
  const shadowedIds = shadowedToolIds(staticTools)
  const dynamicTools = snapshot.tools.filter(tool => tool.origin === 'dynamic' && !isShadowed(tool, shadowedIds))
  // DSH native = the standard preset's static tool face plus the base bundle's
  // host-global tools. Optional/experimental packages (plugin market, Cordis
  // inspection, external MCP) stay outside this parent.
  const standardStaticIds = new Set(snapshot.tools
    .filter(tool => tool.origin === 'static' && tool.sourcePresetId === 'standard')
    .map(tool => tool.id))
  const nativeTools = dynamicTools.filter(tool =>
    standardStaticIds.has(tool.id) || DSH_CORE_GLOBAL_TOOL_IDS.has(tool.id))
  const pluginTools = dynamicTools.filter(tool =>
    !standardStaticIds.has(tool.id) && !DSH_CORE_GLOBAL_TOOL_IDS.has(tool.id))
  const nativeCategories = toolCategories(nativeTools)
  const pluginCategories = toolCategories(pluginTools)
  const enabledCount = key === undefined
    ? 0
    : dynamicTools.filter(tool => draft[tool.id] ?? tool.enabledBy?.[key] ?? false).length
  const nativeEnabledCount = key === undefined
    ? 0
    : nativeTools.filter(tool => draft[tool.id] ?? tool.enabledBy?.[key] ?? false).length
  const pluginEnabledCount = key === undefined
    ? 0
    : pluginTools.filter(tool => draft[tool.id] ?? tool.enabledBy?.[key] ?? false).length
  const scopeText = selected === undefined
    ? undefined
    : selected.kind === 'preset'
      ? t('scopePreset', { id: selected.id })
      : t('scopeSession', { id: selected.id })
  return (
    <div className={css.page}>
      {status.mode === 'live' ? null : <p className={css.notice}>{t('degradedNotice')}</p>}
      {status.writable ? null : <p className={css.notice}>{t('readOnlyNotice')}</p>}
      {busy ? <p className={css.notice}>{t('pending')}</p> : null}
      <div className={css.columns}>
        <nav className={css.scopeColumn} aria-label={t('title')}>
          <h3 className={css.sectionTitle}>{t('presetsSection')}</h3>
          <ul className={css.scopeList}>
            {snapshot.presets.map(row => (
              <ScopeItem key={row.id} t={t} row={row} selectedKey={key} onSelect={onSelect} />
            ))}
          </ul>
          {snapshot.presets.length === 0 ? <p className={css.hint}>{t('emptyPresets')}</p> : null}

          <h3 className={css.sectionTitle}>{t('sessionsSection')}</h3>
          <label className={css.filterRow}>
            <span>{t('workspaceFilter')}</span>
            <select
              className={css.filterSelect}
              value={activeWorkspace ?? ''}
              aria-label={t('workspaceFilter')}
              onChange={(event) => {
                const value = event.currentTarget.value
                onWorkspaceFilter(value === '' ? undefined : value)
              }}
            >
              <option value="">{t('allWorkspaces')}</option>
              {workspaceOptions.map(workspace => (
                <option key={workspace} value={workspace} title={workspace}>{workspaceName(workspace)}</option>
              ))}
            </select>
          </label>
          <ul className={css.scopeList}>
            {sessions.map(row => (
              <ScopeItem key={row.id} t={t} row={row} selectedKey={key} onSelect={onSelect} />
            ))}
          </ul>
          {sessions.length === 0 ? <p className={css.hint}>{t('emptySessions')}</p> : null}
        </nav>

        <section className={css.panel}>
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

          <div className={css.tabPanel} role="tabpanel" hidden={activeTab !== 'tools'}>
            {selected === undefined || key === undefined ? (
              <p className={css.hint}>{t('noScopeHint')}</p>
            ) : (
              <>
                <p className={css.hint}>{t('toolsScopeHint', { scope: scopeText ?? '' })}</p>

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
                disabled={!writable || busy || saving}
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
                        disabled={!writable || busy || saving}
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
                      disabled={!writable || busy || saving}
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
                        disabled={!writable || busy || saving}
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
                      disabled={!writable || busy || saving}
                      scopeKey={key}
                      shadowedIds={shadowedIds}
                      onToggleTool={onToggleTool}
                      onToggleTools={onToggleTools}
                    />
                  )) : null}
                </section>
              )}

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

          <div className={css.tabPanel} role="tabpanel" hidden={activeTab !== 'contexts'}>
            {selected === undefined || key === undefined ? (
              <p className={css.hint}>{t('noScopeHint')}</p>
            ) : (
              <>
                <p className={css.hint}>{t('contextsScopeHint')}</p>
                {snapshot.contexts.length === 0 ? <p className={css.hint}>{t('emptyContexts')}</p> : null}
                <ul className={css.contextList}>
                  {snapshot.contexts.map(entry => (
                    <ContextRow
                      key={entry.kind}
                      t={t}
                      entry={entry}
                      checked={contextDraft[entry.kind] ?? entry.enabledBy[key] ?? false}
                      writable={writable}
                      busy={busy || contextSaving}
                      onToggle={onToggleContext}
                    />
                  ))}
                </ul>
              </>
            )}
          </div>

          <div className={css.tabPanel} role="tabpanel" hidden={activeTab !== 'events'}>
            <p className={css.hint}>{t('eventLogHint')}</p>
          {snapshot.events.length === 0 ? <p className={css.hint}>{t('emptyEvents')}</p> : null}
          <ul className={css.eventList}>
            {snapshot.events.slice(0, EVENT_LOG_LIMIT).map(entry => (
              <li key={entry.id} className={css.eventRow} data-outcome={entry.outcome}>
                <time className={css.eventTime} dateTime={new Date(entry.at).toISOString()}>
                  {formatClock(entry.at)}
                </time>
                <span className={entry.outcome === 'failed' ? css.badgeError : css.badgeMuted}>
                  {outcomeText(t, entry.outcome)}
                </span>
                <span className={css.eventKind}>{contextLabel(t, entry.kind)}</span>
                {entry.detail === undefined ? null : <span className={css.eventDetail}>{entry.detail}</span>}
              </li>
            ))}
            </ul>
          </div>

          <div className={css.tabPanel} role="tabpanel" hidden={activeTab !== 'health'}>
            <dl className={css.health}>
            <div className={css.healthRow}>
              <dt>{t('healthTools')}</dt>
              <dd>
                <span>
                  {t('healthToolsValue', {
                    static: String(status.health.tools.static),
                    registered: String(status.health.tools.registered),
                    enabled: String(status.health.tools.enabled),
                    failed: String(status.health.tools.failed),
                  })}
                </span>
                <span className={css.healthMeta}>
                  {t('healthScopesValue', {
                    global: String(status.health.tools.global),
                    agent: String(status.health.tools.agent),
                  })}
                </span>
              </dd>
            </div>
            <div className={css.healthRow}>
              <dt>{t('healthContexts')}</dt>
              <dd>
                <span>
                  {t('healthContextsValue', {
                    depth: String(status.health.contexts.queueDepth),
                    consumed: String(status.health.contexts.consumed),
                    failed: String(status.health.contexts.failed),
                  })}
                </span>
                <span className={css.healthMeta}>
                  {t('healthMerged', { merged: String(status.health.contexts.merged) })}
                  {' · '}
                  {t('healthOldest', { age: ageText(t, status.health.contexts.oldestAgeMs) })}
                </span>
              </dd>
            </div>
            <div className={css.healthRow}>
              <dt>{t('healthGate')}</dt>
              <dd>
                <span>
                  {t('healthGateValue', {
                    closed: String(status.health.gate.failClosed),
                    loud: String(status.health.gate.failLoud),
                  })}
                </span>
                {status.health.gate.lastError === undefined ? null : (
                  <span className={css.failure}>{t('healthGateError', { error: status.health.gate.lastError })}</span>
                )}
              </dd>
            </div>
          </dl>
          <p className={css.hint}>{t('healthCaptured', { at: formatClock(status.health.capturedAt) })}</p>
          </div>

          <div className={css.tabPanel} role="tabpanel" hidden={activeTab !== 'static'}>
            {selected === undefined || key === undefined ? (
              <p className={css.hint}>{t('noScopeHint')}</p>
            ) : (
              <StaticToolsCard t={t} tools={staticTools} presetId={presetId} scopeKey={key} />
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
                disabled={!writable || busy || saving || !dirty}
                onClick={onSaveTools}
              >
                {saving ? t('pending') : t('saveTools')}
              </button>
            </div>
          ) : activeTab === 'contexts' ? (
            <div className={css.panelFooter}>
              <span className={contextDirty ? css.unsavedHint : css.hint}>
                {contextDirty ? t('contextsUnsaved') : t('noContextChanges')}
              </span>
              <button
                type="button"
                className={css.primary}
                disabled={!writable || busy || contextSaving || !contextDirty}
                onClick={onSaveContexts}
              >
                {contextSaving ? t('pending') : t('saveContexts')}
              </button>
            </div>
          ) : null}
        </section>
      </div>
    </div>
  )
}
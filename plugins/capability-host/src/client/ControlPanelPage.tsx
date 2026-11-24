/**
 * The Capabilities main panel: it loads one Host snapshot plus its status, keeps
 * the selected scope across refreshes, and turns every switch gesture into the
 * exact set of `setTool` / `setContext` writes the Host expects.
 *
 * @module @elysia/capability-host/client/ControlPanelPage
 */
import { useEffect, useState, type ReactNode } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  CapabilitySnapshot, ContextEntry, HostStatus, ScopeKey, ScopeRef, ToolEntry, ToolPresetEntry,
} from './types.ts'
import type { CapabilityPanelApi } from './api.ts'
import { classifyWriteFailure, describeFailure } from './errors.ts'

import {
  effectivePresetId, isShadowed, resolveScope, scopeKeyOf, shadowedToolIds, staticToolsFor,
} from './panel-state.ts'
import { ControlPanelFailure, ControlPanelLoading, ControlPanelView } from './ControlPanelView.tsx'
import css from './ControlPanelPage.module.css'

/** Registration-side Remote face used by the panel. */
export interface ControlPanelPageInjected {
  /** Host operations the panel performs. */
  readonly api: CapabilityPanelApi
}

/** Full component props assembled by the main slot renderer. */
export type ControlPanelPageProps = PropsRuntime<'main'>
  & PropsLocale<'controlPanel'>
  & InjectFace<ControlPanelPageInjected>

type LoadState =
  | { readonly status: 'loading' }
  | { readonly status: 'error' }
  | { readonly status: 'ready'; readonly snapshot: CapabilitySnapshot; readonly host: HostStatus }

/** Render the capability panel. */
export function ControlPanelPage({ api, t }: ControlPanelPageProps): ReactNode {
  const [request, setRequest] = useState(0)
  const [load, setLoad] = useState<LoadState>({ status: 'loading' })
  const [selectedKey, setSelectedKey] = useState<ScopeKey | undefined>(undefined)
  const [workspaceFilter, setWorkspaceFilter] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | undefined>(undefined)
  const [failure, setFailure] = useState<string | undefined>(undefined)
  const [draft, setDraft] = useState<Readonly<Record<string, boolean>>>({})
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [contextDraft, setContextDraft] = useState<Readonly<Record<string, boolean>>>({})
  const [contextDirty, setContextDirty] = useState(false)
  const [toolPresets, setToolPresets] = useState<readonly ToolPresetEntry[]>([])
  const [selectedToolPresetId, setSelectedToolPresetId] = useState<string | undefined>(undefined)

  useEffect(() => {
    let current = true
    const controller = new AbortController()
    setLoad(previous => previous.status === 'ready' ? previous : { status: 'loading' })
    void Promise.all([api.list(controller.signal), api.status(controller.signal)]).then(
      ([snapshot, host]) => {
        if (current) setLoad({ status: 'ready', snapshot, host })
      },
      () => {
        if (current) setLoad({ status: 'error' })
      },
    )
    return () => {
      current = false
      controller.abort()
    }
  }, [api, request])

  // The preset manager and this panel share one core state. Poll while visible
// so a switch made in the other panel shows up without a manual refresh.
  useEffect(() => {
    const refresh = (): void => {
      if (document.visibilityState === 'visible') setRequest(value => value + 1)
    }
    const timer = window.setInterval(refresh, 5_000)
    document.addEventListener('visibilitychange', refresh)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', refresh)
    }
  }, [])

  useEffect(() => {
    setDraft({})
    setDirty(false)
    setContextDraft({})
    setContextDirty(false)
  }, [selectedKey])

  useEffect(() => {
    if (load.status !== 'ready') return
    const presets = load.snapshot.toolPresets ?? []
    setToolPresets(presets)
    setSelectedToolPresetId(current =>
      current !== undefined && presets.some(preset => preset.id === current) ? current : undefined)
  }, [load])

  const snapshot = load.status === 'ready' ? load.snapshot : undefined
  const selected = snapshot === undefined
    ? undefined
    : resolveScope(selectedKey, snapshot.presets, snapshot.sessions)

  /**
   * Turn one refused write into page state. A write against a preset's static
   * tool means this render was stale — the panel never offers that switch — so it
   * reports the lock as a notice and refreshes instead of failing the gesture.
   * @param error - the caught refusal.
   */
  const reportWriteFailure = (error: unknown): void => {
    setBusy(false)
    if (classifyWriteFailure(error) === 'static-locked') {
      setNotice(t('noticeStaticLocked'))
    } else {
      setFailure(describeFailure(error, t))
    }
    // A partially applied group write leaves the Host ahead of this render, so
    // refresh on refusal too.
    setRequest(value => value + 1)
  }

  const editableTools = (scope: ScopeRef, source: CapabilitySnapshot): readonly ToolEntry[] => {
    const shadowedIds = shadowedToolIds(staticToolsFor(source.tools, effectivePresetId(scope, source)))
    return source.tools.filter(tool => tool.origin === 'dynamic' && !isShadowed(tool, shadowedIds))
  }

  const toggleTool = (tool: ToolEntry, enabled: boolean): void => {
    if (selected === undefined || busy || saving) return
    setDraft(current => ({ ...current, [tool.id]: enabled }))
    setDirty(true)
    setNotice(undefined)
    setFailure(undefined)
  }

  const toggleTools = (tools: readonly ToolEntry[], enabled: boolean): void => {
    if (busy || saving || tools.length === 0) return
    setDraft(current => {
      const next = { ...current }
      for (const tool of tools) next[tool.id] = enabled
      return next
    })
    setDirty(true)
    setNotice(undefined)
    setFailure(undefined)
  }

  const saveTools = (): void => {
    if (selected === undefined || snapshot === undefined || busy || saving) return
    const key = scopeKeyOf(selected)
    const writes = editableTools(selected, snapshot).flatMap((tool) => {
      const next = draft[tool.id]
      const before = tool.enabledBy?.[key] ?? false
      return next !== undefined && next !== before ? [{ toolId: tool.id, enabled: next }] : []
    })
    if (writes.length === 0) {
      setDraft({})
      setDirty(false)
      setNotice(t('noToolChanges'))
      return
    }
    setSaving(true)
    setFailure(undefined)
    setNotice(undefined)
    const controller = new AbortController()
    void (async () => {
      for (const write of writes) {
        await api.setTool(selected, write.toolId, write.enabled, controller.signal)
      }
    })().then(
      () => {
        setSaving(false)
        setDraft({})
        setDirty(false)
        setNotice(t('toolsSaved'))
        setRequest(value => value + 1)
      },
      (error: unknown) => {
        setSaving(false)
        setFailure(describeFailure(error, t))
        setRequest(value => value + 1)
      },
    )
  }

  const applyToolPreset = (preset: ToolPresetEntry): void => {
    if (selected === undefined || snapshot === undefined || busy || saving) return
    const next: Record<string, boolean> = {}
    for (const tool of editableTools(selected, snapshot)) next[tool.id] = preset.tools.includes(tool.id)
    setDraft(next)
    setDirty(true)
    setSelectedToolPresetId(preset.id)
    setNotice(t('toolPresetApplied', { name: preset.name }))
    setFailure(undefined)
  }

  const createToolPreset = async (name: string): Promise<boolean> => {
    if (selected === undefined || snapshot === undefined || busy || saving) return false
    const key = scopeKeyOf(selected)
    const enabled = editableTools(selected, snapshot)
      .filter(tool => draft[tool.id] ?? tool.enabledBy?.[key] ?? false)
      .map(tool => tool.id)
    if (enabled.length === 0) {
      setFailure(t('toolPresetEmpty'))
      return false
    }
    setSaving(true)
    setFailure(undefined)
    setNotice(undefined)
    try {
      const created = await api.createToolPreset(name, enabled, new AbortController().signal)
      setToolPresets(current => [...current, created])
      setSelectedToolPresetId(created.id)
      setNotice(t('toolPresetCreated', { name: created.name }))
      return true
    } catch (error: unknown) {
      setFailure(describeFailure(error, t))
      return false
    } finally {
      setSaving(false)
    }
  }

  const deleteToolPreset = (preset: ToolPresetEntry): void => {
    if (busy || saving) return
    setSaving(true)
    setFailure(undefined)
    void api.deleteToolPreset(preset.id, new AbortController().signal).then(
      () => {
        setSaving(false)
        setToolPresets(current => current.filter(entry => entry.id !== preset.id))
        setSelectedToolPresetId(current => current === preset.id ? undefined : current)
        setNotice(t('toolPresetDeleted', { name: preset.name }))
      },
      (error: unknown) => {
        setSaving(false)
        setFailure(describeFailure(error, t))
      },
    )
  }

  const toggleContext = (entry: ContextEntry, enabled: boolean): void => {
    if (selected === undefined || busy) return
    setContextDraft(current => ({ ...current, [entry.kind]: enabled }))
    setContextDirty(true)
    setNotice(undefined)
    setFailure(undefined)
  }

  const saveContexts = (): void => {
    if (selected === undefined || snapshot === undefined || busy || saving) return
    const key = scopeKeyOf(selected)
    const writes = snapshot.contexts.flatMap((entry) => {
      const next = contextDraft[entry.kind]
      const before = entry.enabledBy[key] ?? false
      return next !== undefined && next !== before ? [{ kind: entry.kind, enabled: next }] : []
    })
    if (writes.length === 0) {
      setContextDraft({})
      setContextDirty(false)
      setNotice(t('noContextChanges'))
      return
    }
    setBusy(true)
    setFailure(undefined)
    setNotice(undefined)
    const controller = new AbortController()
    void (async () => {
      for (const write of writes) {
        await api.setContext(selected, write.kind, write.enabled, controller.signal)
      }
    })().then(
      () => {
        setBusy(false)
        setContextDraft({})
        setContextDirty(false)
        setNotice(t('contextsSaved'))
        setRequest(value => value + 1)
      },
      reportWriteFailure,
    )
  }

  return (
    <div className={css.shell} aria-busy={load.status === 'loading' || busy || saving}>
      <header className={css.header}>
        <h2 className={css.title}>{t('title')}</h2>
        <span className={css.actions}>
          <button
            type="button"
            className={css.secondary}
            disabled={busy}
            onClick={() => { setRequest(value => value + 1) }}
          >
            {t('refresh')}
          </button>
        </span>
      </header>
      <p className={css.subtitle}>{t('subtitle')}</p>

      {notice === undefined ? null : <p className={css.notice} role="status">{notice}</p>}
      {failure === undefined ? null : <p className={css.failure} role="alert">{failure}</p>}

      {load.status === 'loading' ? <ControlPanelLoading t={t} /> : null}
      {load.status === 'error' ? (
        <ControlPanelFailure t={t} onRetry={() => { setRequest(value => value + 1) }} />
      ) : null}
      {load.status === 'ready' ? (
        <ControlPanelView
          t={t}
          snapshot={load.snapshot}
          status={load.host}
          selected={selected}
          busy={busy}
          draft={draft}
          dirty={dirty}
          saving={saving}
          contextDraft={contextDraft}
          contextDirty={contextDirty}
          contextSaving={busy}
          toolPresets={toolPresets}
          selectedToolPresetId={selectedToolPresetId}
          workspaceFilter={workspaceFilter}
          onWorkspaceFilter={setWorkspaceFilter}
          onSelect={(scope) => {
            if ((dirty && !window.confirm(t('toolsUnsaved')))
              || (contextDirty && !window.confirm(t('contextsUnsaved')))) return
            setSelectedKey(scopeKeyOf(scope))
          }}
          onToggleTool={toggleTool}
          onToggleTools={toggleTools}
          onSaveTools={saveTools}
          onSaveContexts={saveContexts}
          onSelectToolPreset={setSelectedToolPresetId}
          onApplyToolPreset={applyToolPreset}
          onCreateToolPreset={createToolPreset}
          onDeleteToolPreset={deleteToolPreset}
          onToggleContext={toggleContext}
        />
      ) : null}
    </div>
  )
}
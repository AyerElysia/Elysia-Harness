/**
 * The Capabilities main panel for one session: it loads the Host snapshot plus
 * its status and turns every switch gesture into the exact set of `setTool` /
 * `setContext` writes the Host expects.
 *
 * This is the original capability panel page with the scope switcher removed:
 * the session whose Conversation view renders it is the only scope, so no
 * selection state survives a refresh and every write targets that session.
 *
 * @module @elysia/villv-helix/client/ControlPanelPage
 */
import { useEffect, useState, type ReactNode } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  CapabilitySnapshot, ContextEntry, HostStatus, PresetPrompt, ScopeRef, ToolEntry, ToolPresetEntry,
} from '../types.ts'
import { isOfficialPreset } from '../presets.ts'
import type { VillvHelixApi } from './api.ts'
import { notifyCapabilityChanged, subscribeCapabilityChanged } from './capability-events.ts'
import { classifyWriteFailure, describeFailure } from './errors.ts'

import {
  currentScope, effectivePresetId, isShadowed, scopeKeyOf, shadowedToolIds, staticToolsFor,
} from './panel-state.ts'
import { ControlPanelFailure, ControlPanelLoading, ControlPanelView, type PanelTab } from './ControlPanelView.tsx'
import css from './ControlPanelPage.module.css'

/** Registration-side Remote face used by the panel. */
export interface ControlPanelPageInjected {
  /** Host operations the panel performs for this session. */
  readonly api: VillvHelixApi
  /** Top-level native tab this page renders. */
  readonly tab: PanelTab
}

/** Full component props assembled by the conversation view renderer. */
export type ControlPanelPageProps = PropsRuntime<'conversation.view'>
  & PropsLocale<'villvHelix'>
  & InjectFace<ControlPanelPageInjected>

type LoadState =
  | { readonly status: 'loading' }
  | { readonly status: 'error' }
  | { readonly status: 'ready'; readonly snapshot: CapabilitySnapshot; readonly host: HostStatus }

/** Render the capability panel for the current session. */
export function ControlPanelPage({ api, t, tab }: ControlPanelPageProps): ReactNode {
  const [request, setRequest] = useState(0)
  const [load, setLoad] = useState<LoadState>({ status: 'loading' })
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
  const [presetPrompt, setPresetPrompt] = useState<PresetPrompt | undefined>(undefined)

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

  // A panel write is visible to every other open capability UI through the
  // browser event channel; refreshing on that event and on page visibility
  // keeps two open views consistent without polling.
  useEffect(() => {
    const refresh = (): void => {
      if (document.visibilityState === 'visible') setRequest(value => value + 1)
    }
    const disposeChanges = subscribeCapabilityChanged(refresh)
    document.addEventListener('visibilitychange', refresh)
    return () => {
      disposeChanges()
      document.removeEventListener('visibilitychange', refresh)
    }
  }, [])

  useEffect(() => {
    if (load.status !== 'ready') return
    const presets = load.snapshot.toolPresets
    setToolPresets(presets)
    setSelectedToolPresetId(current =>
      current !== undefined && presets.some(preset => preset.id === current) ? current : undefined)
  }, [load])

  useEffect(() => {
    if (load.status !== 'ready') return
    const presetId = load.snapshot.sessions[0]?.presetId
    if (presetId === undefined) {
      setPresetPrompt(undefined)
      return
    }
    let current = true
    const controller = new AbortController()
    const fallback = (): void => {
      void api.readSystemPrompt(controller.signal).then(
        (text) => {
          if (!current) return
          setPresetPrompt(text === ''
            ? undefined
            : {
                id: presetId,
                ...(load.snapshot.sessions[0]?.presetName === undefined
                  ? {}
                  : { name: load.snapshot.sessions[0].presetName }),
                root: '',
                files: [],
                text,
                missing: [],
              })
        },
        () => { if (current) setPresetPrompt(undefined) },
      )
    }
    void api.readPresetPrompt(presetId, controller.signal).then(
      (prompt) => {
        if (!current) return
        if (prompt === undefined) fallback()
        else setPresetPrompt(prompt)
      },
      () => { if (current) fallback() },
    )
    return () => {
      current = false
      controller.abort()
    }
  }, [api, load])

  const snapshot = load.status === 'ready' ? load.snapshot : undefined
  const selected: ScopeRef | undefined = snapshot === undefined ? undefined : currentScope(snapshot)

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
    setRequest(value => value + 1)
  }

  const editableTools = (source: CapabilitySnapshot): readonly ToolEntry[] => {
    const presetId = effectivePresetId(source)
    const shadowedIds = shadowedToolIds(staticToolsFor(source.tools, presetId))
    const official = isOfficialPreset(presetId)
    return source.tools.filter(tool => tool.origin === 'dynamic'
      && (!official || !isShadowed(tool, shadowedIds)))
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
    const writes = editableTools(snapshot).flatMap((tool) => {
      const next = draft[tool.id]
      const before = tool.enabledBy?.[key] ?? true
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
        await api.setTool(write.toolId, write.enabled, controller.signal)
      }
    })().then(
      () => {
        setSaving(false)
        setDraft({})
        setDirty(false)
        setNotice(t('toolsSaved'))
        notifyCapabilityChanged()
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
    for (const tool of editableTools(snapshot)) next[tool.id] = preset.tools.includes(tool.id)
    setDraft(next)
    setDirty(true)
    setSelectedToolPresetId(preset.id)
    setNotice(t('toolPresetApplied', { name: preset.name }))
    setFailure(undefined)
  }

  const createToolPreset = async (name: string): Promise<boolean> => {
    if (selected === undefined || snapshot === undefined || busy || saving) return false
    const key = scopeKeyOf(selected)
    const enabled = editableTools(snapshot)
      .filter(tool => draft[tool.id] ?? tool.enabledBy?.[key] ?? true)
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
        await api.setContext(write.kind, write.enabled, controller.signal)
      }
    })().then(
      () => {
        setBusy(false)
        setContextDraft({})
        setContextDirty(false)
        setNotice(t('contextsSaved'))
        notifyCapabilityChanged()
        setRequest(value => value + 1)
      },
      reportWriteFailure,
    )
  }

  return (
    <div className={css.shell} aria-busy={load.status === 'loading' || busy || saving}>
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
          forcedTab={tab}
          presetPrompt={presetPrompt}
          busy={busy}
          draft={draft}
          dirty={dirty}
          saving={saving}
          contextDraft={contextDraft}
          contextDirty={contextDirty}
          contextSaving={busy}
          toolPresets={toolPresets}
          selectedToolPresetId={selectedToolPresetId}
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
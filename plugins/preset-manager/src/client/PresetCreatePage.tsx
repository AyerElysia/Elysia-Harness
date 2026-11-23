/**
 * The dedicated "new preset" page: metadata, prompt files, and the tool face.
 *
 * Every switch is rebuilt from the selected face, so picking a face (including
 * the chat-only one) replaces the whole switch set instead of merging into it.
 * A Back action returns to the manager list without creating anything.
 *
 * @module @elysia/preset-manager/client/PresetCreatePage
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  PresetDraft, PresetSummary, PromptCandidate, ToolFace, ToolFaceCatalog,
} from '../types.ts'
import type { PresetManagerApi } from './api.ts'
import { describeFailure } from './errors.ts'
import { FACE_LABEL_KEYS, TOOL_LABEL_KEYS, type PresetManagerLocaleKey } from './locales.ts'
import {
  enabledTools, isDeletableFace, switchesForFace, toggleSwitch, type ToolSwitches,
} from './tool-face-state.ts'
import css from './PresetManagerPage.module.css'

/** Identity shape the Host enforces; checked here so the page answers immediately. */
const PRESET_ID = /^[a-z0-9-]+$/

/** Prompt-file read state of one chosen root. */
type CandidateState =
  | { readonly status: 'idle' }
  | { readonly status: 'loading' }
  | { readonly status: 'error' }
  | { readonly status: 'ready'; readonly items: readonly PromptCandidate[] }

/** Tool catalog plus the switch set the page is editing. */
type ToolState =
  | { readonly status: 'loading' }
  | { readonly status: 'error' }
  | {
    readonly status: 'ready'
    readonly catalog: ToolFaceCatalog
    readonly switches: ToolSwitches
    readonly face: ToolFace['id'] | undefined
    readonly faceKind: ToolFace['kind'] | undefined
  }

/** Props the manager page supplies; the create page is not a slot occupant. */
export interface PresetCreatePageProps {
  /** Host operations the page performs. */
  readonly api: PresetManagerApi
  /** Localized copy. */
  readonly t: Translate<PresetManagerLocaleKey>
  /** Return to the manager list. */
  readonly onBack: () => void
  /** Report a created preset so the list refreshes and announces it. */
  readonly onCreated: (row: PresetSummary) => void
}

/** Every tool id the catalog offers, in display order. */
function catalogToolIds(catalog: ToolFaceCatalog): readonly string[] {
  return catalog.tools.map(tool => tool.id)
}

/** Option value that keeps the same id in different families apart. */
function faceOptionValue(face: ToolFace): string {
  return `${face.kind}:${face.id}`
}

/** One option list entry: the built-in faces flat, then grouped families. */
function FaceOptions({ faces, t }: { readonly faces: readonly ToolFace[]; readonly t: Translate<PresetManagerLocaleKey> }): ReactNode {
  const option = (face: ToolFace): ReactNode => (
    <option key={faceOptionValue(face)} value={faceOptionValue(face)}>
      {face.kind === 'custom' || face.kind === 'existing'
        ? face.name
        : t(FACE_LABEL_KEYS[face.id] ?? 'faceDefault')}
      {face.partial === true ? ` · ${t('facePartial')}` : ''}
    </option>
  )
  const existing = faces.filter(face => face.kind === 'existing')
  const custom = faces.filter(face => face.kind === 'custom')
  return (
    <>
      {faces.filter(face => face.kind === 'default' || face.kind === 'common').map(option)}
      {existing.length === 0 ? null : <optgroup label={t('faceExistingGroup')}>{existing.map(option)}</optgroup>}
      {custom.length === 0 ? null : <optgroup label={t('faceCustomGroup')}>{custom.map(option)}</optgroup>}
    </>
  )
}

/** Render the create page. */
export function PresetCreatePage({ api, t, onBack, onCreated }: PresetCreatePageProps): ReactNode {
  const [id, setId] = useState('')
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [identity, setIdentity] = useState('')
  const [agentInstructions, setAgentInstructions] = useState(false)
  const [order, setOrder] = useState('')
  const [root, setRoot] = useState<string | undefined>(undefined)
  const [candidates, setCandidates] = useState<CandidateState>({ status: 'idle' })
  const [selected, setSelected] = useState<readonly string[]>([])
  const [tools, setTools] = useState<ToolState>({ status: 'loading' })
  const [customFaceName, setCustomFaceName] = useState('')
  const [faceBusy, setFaceBusy] = useState(false)
  const [failure, setFailure] = useState<string | undefined>(undefined)
  const [notice, setNotice] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)

  const seedTools = useCallback((catalog: ToolFaceCatalog): ToolState => {
    const fallback = catalog.faces.find(face => face.kind === 'default') ?? catalog.faces.find(face => face.kind === 'common' && face.id === 'none')
    return {
      status: 'ready',
      catalog,
      switches: switchesForFace(catalogToolIds(catalog), fallback?.tools ?? []),
      face: fallback?.id,
      faceKind: fallback?.kind,
    }
  }, [])

  useEffect(() => {
    let current = true
    const controller = new AbortController()
    void Promise.resolve()
      .then(() => api.listToolFaces(controller.signal))
      .then((catalog) => {
        if (!current) return
        setTools(seedTools(catalog))
      }, () => { if (current) setTools({ status: 'error' }) })
    return () => {
      current = false
      controller.abort()
    }
  }, [api, seedTools])

  const readyTools = tools.status === 'ready' ? tools : undefined
  const toolIds = readyTools === undefined ? [] : catalogToolIds(readyTools.catalog)
  const switches: ToolSwitches = readyTools?.switches ?? {}
  const faceId = readyTools?.face
  const faceKind = readyTools?.faceKind
  const selectedFace = readyTools === undefined || faceId === undefined
    ? undefined
    : readyTools.catalog.faces.find(face => face.id === faceId && face.kind === faceKind)

  const chooseRoot = (): void => {
    const controller = new AbortController()
    setFailure(undefined)
    void api.pickDirectory(controller.signal).then(async (picked) => {
      if (picked === null) return
      setRoot(picked)
      setSelected([])
      setCandidates({ status: 'loading' })
      try {
        const items = await api.listPromptCandidates(picked, controller.signal)
        setCandidates({ status: 'ready', items })
      } catch {
        setCandidates({ status: 'error' })
      }
    }, () => { setFailure(t('error')) })
  }

  const toggleFile = (path: string): void => {
    setSelected(current => current.includes(path)
      ? current.filter(item => item !== path)
      : [...current, path])
  }

  const applyFace = (value: string): void => {
    const face = readyTools?.catalog.faces.find(candidate => faceOptionValue(candidate) === value)
    if (face === undefined) return
    setFailure(undefined)
    setNotice(undefined)
    setTools(current => current.status === 'ready'
      ? {
        ...current,
        switches: switchesForFace(catalogToolIds(current.catalog), face.tools),
        face: face.id,
        faceKind: face.kind,
      }
      : current)
  }

  const toggleTool = (toolId: string): void => {
    setTools(current => current.status === 'ready'
      ? {
        ...current,
        switches: toggleSwitch(current.switches, toolId),
        face: undefined,
        faceKind: undefined,
      }
      : current)
  }

  const saveFace = (): void => {
    if (readyTools === undefined || faceBusy) return
    const chosen = enabledTools(switches, toolIds)
    if (customFaceName.trim() === '' || chosen.length === 0) return
    setFaceBusy(true)
    setFailure(undefined)
    setNotice(undefined)
    const controller = new AbortController()
    void api.createToolFace({ name: customFaceName.trim(), tools: chosen }, controller.signal)
      .then(async (created) => {
        const catalog = await api.listToolFaces(controller.signal)
        setTools({
          status: 'ready',
          catalog,
          switches: switchesForFace(catalogToolIds(catalog), created.tools),
          face: created.id,
          faceKind: created.kind,
        })
        setCustomFaceName('')
        setNotice(t('faceSaved', { name: created.name }))
        setFaceBusy(false)
      }, (error: unknown) => {
        setFaceBusy(false)
        setFailure(describeFailure(error, t))
      })
  }

  const removeFace = (): void => {
    if (readyTools === undefined || selectedFace === undefined || faceBusy) return
    if (!isDeletableFace(selectedFace)) return
    setFaceBusy(true)
    setFailure(undefined)
    setNotice(undefined)
    const controller = new AbortController()
    void api.deleteToolFace(selectedFace.id, controller.signal)
      .then(async () => {
        const catalog = await api.listToolFaces(controller.signal)
        setTools(current => current.status === 'ready'
          ? { ...current, catalog, face: undefined, faceKind: undefined }
          : current)
        setNotice(t('faceDeleted', { name: selectedFace.name }))
        setFaceBusy(false)
      }, (error: unknown) => {
        setFaceBusy(false)
        setFailure(describeFailure(error, t))
      })
  }

  const submit = (): void => {
    setFailure(undefined)
    setNotice(undefined)
    if (!PRESET_ID.test(id)) {
      setFailure(t('invalidId'))
      return
    }
    if (name.trim() === '') {
      setFailure(t('invalidName'))
      return
    }
    if (identity.trim() === '') {
      setFailure(t('invalidIdentity'))
      return
    }
    if (root === undefined) {
      setFailure(t('rootRequired'))
      return
    }
    if (selected.length === 0) {
      setFailure(t('filesRequired'))
      return
    }
    // A failed catalog read leaves no switches; submitting then would silently
    // create a chat-only preset instead of the face the operator meant.
    if (readyTools === undefined) {
      setFailure(t('toolsError'))
      return
    }
    const draft: PresetDraft = {
      id,
      name: name.trim(),
      promptRoot: root,
      promptFiles: [...selected],
      identity: identity.trim(),
      agentInstructions,
      tools: enabledTools(switches, toolIds),
      ...(readyTools?.face === undefined || readyTools.faceKind === undefined
        ? {}
        : { toolFace: { kind: readyTools.faceKind, id: readyTools.face } }),
      ...(description.trim() === '' ? {} : { description: description.trim() }),
      ...(order.trim() === '' ? {} : { order: Number(order) }),
    }
    setBusy(true)
    const controller = new AbortController()
    void api.create(draft, controller.signal).then((row) => {
      setBusy(false)
      onCreated(row)
    }, (error: unknown) => {
      setBusy(false)
      setFailure(describeFailure(error, t))
    })
  }

  const chosenTools = enabledTools(switches, toolIds)

  return (
    <div className={css.shell}>
      <div className={css.page} aria-busy={busy || tools.status === 'loading'}>
      <header className={css.header}>
        <span className={css.headerLeading}>
          <button type="button" className={css.secondary} onClick={onBack} disabled={busy}>
            {t('backAction')}
          </button>
          <h2 className={css.title}>{t('createTitle')}</h2>
        </span>
      </header>
      <p className={css.subtitle}>{t('createSubtitle')}</p>

      {notice === undefined ? null : <p className={css.notice} role="status">{notice}</p>}
      {failure === undefined ? null : <p className={css.failure} role="alert">{failure}</p>}

      <section className={css.card} aria-label={t('createTitle')}>
        <div className={css.fields}>
          <label className={css.field}>
            <span className={css.fieldLabel}>{t('fieldId')}</span>
            <input value={id} onChange={(event) => { setId(event.currentTarget.value) }} />
            <span className={css.fieldHint}>{t('fieldIdHint')}</span>
          </label>
          <label className={css.field}>
            <span className={css.fieldLabel}>{t('fieldName')}</span>
            <input value={name} onChange={(event) => { setName(event.currentTarget.value) }} />
          </label>
          <label className={css.field}>
            <span className={css.fieldLabel}>{t('fieldDescription')}</span>
            <input value={description} onChange={(event) => { setDescription(event.currentTarget.value) }} />
          </label>
          <label className={css.field}>
            <span className={css.fieldLabel}>{t('fieldIdentity')}</span>
            <input value={identity} onChange={(event) => { setIdentity(event.currentTarget.value) }} />
          </label>
          <label className={css.field}>
            <span className={css.fieldLabel}>{t('fieldOrder')}</span>
            <input value={order} inputMode="numeric" onChange={(event) => { setOrder(event.currentTarget.value) }} />
          </label>
          <label className={`${css.field} ${css.checkboxRow}`}>
            <span className={css.fieldLabel}>{t('fieldAgentInstructions')}</span>
            <span className={css.checkboxRow}>
              <input
                type="checkbox"
                checked={agentInstructions}
                onChange={(event) => { setAgentInstructions(event.currentTarget.checked) }}
              />
              <span className={css.fieldHint}>{t('fieldAgentInstructionsHint')}</span>
            </span>
          </label>
        </div>
        </section>

        <div className={css.columns}>
          <section className={`${css.card} ${css.promptCard}`} aria-label={t('fieldFiles')}>
            <h3 className={css.cardTitle}>{t('fieldFiles')}</h3>
            <div className={css.promptBody}>
              <div className={css.field}>
                <span className={css.fieldLabel}>{t('fieldRoot')}</span>
                <div className={css.inlineRow}>
                  <button type="button" className={css.secondary} onClick={chooseRoot} disabled={busy}>
                    {t('chooseRoot')}
                  </button>
                  {root === undefined ? null : <code className={css.path}>{t('rootChosen', { root })}</code>}
                </div>
              </div>

              <div className={css.field}>
                {candidates.status === 'idle'
                  ? <div className={css.emptyState}><p className={css.hint}>{t('candidatesHint')}</p></div>
                  : null}
                {candidates.status === 'loading' ? <p className={css.hint}>{t('candidatesLoading')}</p> : null}
                {candidates.status === 'error' ? <p className={css.failure}>{t('error')}</p> : null}
                {candidates.status === 'ready' && candidates.items.length === 0
                  ? <p className={css.hint}>{t('candidatesEmpty')}</p>
                  : null}
                {candidates.status === 'ready' && candidates.items.length > 0 ? (
                  <ul className={css.list}>
                    {candidates.items.map(item => {
                      const index = selected.indexOf(item.path)
                      return (
                        <li key={item.path} className={css.listRow}>
                          <label className={css.listLabel}>
                            <input type="checkbox" checked={index >= 0} onChange={() => { toggleFile(item.path) }} />
                            <code>{item.path}</code>
                            <span className={css.size}>{item.bytes === 0 ? t('fileEmpty') : `${String(item.bytes)} B`}</span>
                          </label>
                          {index < 0 ? null : <span className={css.orderMark}>{String(index + 1)}</span>}
                        </li>
                      )
                    })}
                  </ul>
                ) : null}
              </div>
            </div>
          </section>

          <section className={css.card} aria-label={t('sectionTools')}>
        <h3 className={css.cardTitle}>{t('sectionTools')}</h3>
        <p className={css.hint}>{t('sectionToolsHint')}</p>
        {tools.status === 'loading' ? <p className={css.hint}>{t('toolsLoading')}</p> : null}
        {tools.status === 'error' ? <p className={css.failure}>{t('toolsError')}</p> : null}

        {readyTools === undefined ? null : (
          <>
            <div className={css.faceRow}>
              <label className={css.field}>
                <span className={css.fieldLabel}>{t('faceLabel')}</span>
                <select
                  value={selectedFace === undefined ? '' : faceOptionValue(selectedFace)}
                  onChange={(event) => { applyFace(event.currentTarget.value) }}
                >
                  {selectedFace === undefined ? <option value="">{t('faceManual')}</option> : null}
                  <FaceOptions faces={readyTools.catalog.faces} t={t} />
                </select>
              </label>
              <span className={css.badge}>
                {selectedFace !== undefined && isDeletableFace(selectedFace) ? t('faceCustomGroup') : t('faceReadOnly')}
              </span>
              {selectedFace === undefined || !isDeletableFace(selectedFace) ? null : (
                <button type="button" className={css.danger} onClick={removeFace} disabled={faceBusy}>
                  {faceBusy ? t('customFaceDeleting') : t('customFaceDelete')}
                </button>
              )}
            </div>
            {selectedFace?.partial === true ? <p className={css.hint}>{t('facePartial')}</p> : null}

            <ul className={css.list}>
              {readyTools.catalog.tools.map(tool => {
                const labelKey = TOOL_LABEL_KEYS[tool.id]
                return (
                  <li key={tool.id} className={css.listRow}>
                    <label className={css.listLabel}>
                      <input
                        type="checkbox"
                        checked={switches[tool.id] === true}
                        disabled={!tool.available || busy}
                        onChange={() => { toggleTool(tool.id) }}
                      />
                      <span className={css.toolName}>{labelKey === undefined ? tool.id : t(labelKey)}</span>
                      <code className={css.toolModule}>{tool.module}</code>
                      {tool.platform === undefined
                        ? null
                        : <span className={css.badge}>{t(tool.platform === 'win32' ? 'toolPlatformWin' : 'toolPlatformPosix')}</span>}
                      {tool.available ? null : <span className={css.badgeBroken}>{t('toolUnavailable')}</span>}
                    </label>
                    {tool.available || tool.reason === undefined
                      ? null
                      : <p className={css.toolReason}>{tool.reason}</p>}
                  </li>
                )
              })}
            </ul>

            <div className={css.faceRow}>
              <label className={css.field}>
                <span className={css.fieldLabel}>{t('customFaceName')}</span>
                <input
                  value={customFaceName}
                  placeholder={t('customFaceNamePlaceholder')}
                  onChange={(event) => { setCustomFaceName(event.currentTarget.value) }}
                />
              </label>
              <button
                type="button"
                className={css.secondary}
                onClick={saveFace}
                disabled={faceBusy || customFaceName.trim() === '' || chosenTools.length === 0}
              >
                {faceBusy ? t('customFaceSaving') : t('customFaceSave')}
              </button>
            </div>
            <p className={css.hint}>{t('customFaceHint')}</p>
          </>
        )}
        </section>
      </div>

      </div>

      <div className={css.actionsBar}>
        <span className={css.actionsSummary}>
          {t('fileCount', { count: String(selected.length) })}
          {' · '}
          {t('toolCount', { count: String(chosenTools.length) })}
        </span>
        <button type="button" className={css.primary} onClick={submit} disabled={busy || readyTools === undefined}>
          {busy ? t('creating') : t('createAction')}
        </button>
      </div>
    </div>
  )
}

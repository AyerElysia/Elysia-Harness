/**
 * The Presets main panel: the manager list with its delete action, and the
 * navigation to the dedicated create page. Back from the create page returns
 * here; the list is re-read whenever it is shown.
 *
 * @module @elysia/preset-manager/client/PresetManagerPage
 */
import { useEffect, useState, type ReactNode } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { PresetSummary } from '../types.ts'
import type { PresetManagerApi } from './api.ts'
import { describeFailure } from './errors.ts'
import { PresetCreatePage } from './PresetCreatePage.tsx'
import css from './PresetManagerPage.module.css'

/** Registration-side Remote face used by the page. */
export interface PresetManagerPageInjected {
  /** Host operations the page performs. */
  readonly api: PresetManagerApi
}

/** Full component props assembled by the main slot renderer. */
export type PresetManagerPageProps = PropsRuntime<'main'>
  & PropsLocale<'presetManager'>
  & InjectFace<PresetManagerPageInjected>

type RosterState =
  | { readonly status: 'loading' }
  | { readonly status: 'error' }
  | { readonly status: 'ready'; readonly rows: readonly PresetSummary[] }

/** One roster row with its ownership and live-use badges. */
function PresetRow({
  row, t, busy, onDelete,
}: {
  readonly row: PresetSummary
  readonly t: PresetManagerPageProps['t']
  readonly busy: boolean
  readonly onDelete: (row: PresetSummary) => void
}): ReactNode {
  const removable = row.managed && row.inUse.length === 0
  return (
    <li className={css.row} data-preset-id={row.id} data-managed={row.managed ? 'true' : undefined}>
      <div className={css.rowMain}>
        <span className={css.rowTitle}>
          <strong>{row.name ?? row.id}</strong>
          <code className={css.identity}>{row.id}</code>
        </span>
        <span className={css.badges}>
          <span className={css.badge}>{t(row.managed ? 'badgeManaged' : 'badgeBuiltin')}</span>
          {row.inUse.length === 0 ? null : <span className={css.badgeInUse}>{t('badgeInUse')}</span>}
          {row.diagnostic === undefined ? null : <span className={css.badgeBroken}>{t('badgeBroken')}</span>}
        </span>
      </div>
      {row.description === undefined ? null : <p className={css.rowNote}>{row.description}</p>}
      {row.inUse.length === 0 ? null : (
        <p className={css.rowNote}>{t('inUseLabel', { sessions: row.inUse.join(', ') })}</p>
      )}
      {row.diagnostic === undefined ? null : (
        <p className={css.failure}>{t('diagnosticLabel', { diagnostic: row.diagnostic })}</p>
      )}
      <p className={css.rowMeta}>
        {row.promptFileCount === undefined ? null : <span>{t('fileCount', { count: String(row.promptFileCount) })}</span>}
        {row.tools === undefined ? null : <span>{t('toolCount', { count: String(row.tools.length) })}</span>}
        {row.promptRoot === undefined ? null : <code className={css.path}>{row.promptRoot}</code>}
        {row.createdAt === undefined ? null : <span>{t('createdAtLabel', { createdAt: row.createdAt })}</span>}
      </p>
      {row.unknownTools === undefined ? null : (
        <p className={css.failure}>{t('unknownToolsLabel', { tools: row.unknownTools.join(', ') })}</p>
      )}
      {row.managed ? (
        <button
          type="button"
          className={css.danger}
          disabled={!removable || busy}
          onClick={() => { onDelete(row) }}
        >
          {busy ? t('deleting') : t('deleteAction')}
        </button>
      ) : null}
    </li>
  )
}

/** Render the preset roster and navigate to the create page. */
export function PresetManagerPage({ api, t }: PresetManagerPageProps): ReactNode {
  const [view, setView] = useState<'list' | 'create'>('list')
  const [request, setRequest] = useState(0)
  const [roster, setRoster] = useState<RosterState>({ status: 'loading' })
  const [pendingId, setPendingId] = useState<string | undefined>(undefined)
  const [notice, setNotice] = useState<string | undefined>(undefined)
  const [failure, setFailure] = useState<string | undefined>(undefined)

  useEffect(() => {
    if (view !== 'list') return undefined
    let current = true
    const controller = new AbortController()
    void Promise.resolve()
      .then(() => api.list(controller.signal))
      .then(
        (rows) => { if (current) setRoster({ status: 'ready', rows }) },
        () => { if (current) setRoster({ status: 'error' }) },
      )
    return () => {
      current = false
      controller.abort()
    }
  }, [api, request, view])

  const remove = (row: PresetSummary): void => {
    setFailure(undefined)
    setNotice(undefined)
    setPendingId(row.id)
    const controller = new AbortController()
    void api.remove(row.id, undefined, controller.signal).then(() => {
      setPendingId(undefined)
      setNotice(t('deleted', { name: row.name ?? row.id }))
      setRequest(value => value + 1)
    }, (error: unknown) => {
      setPendingId(undefined)
      setFailure(describeFailure(error, t))
    })
  }

  if (view === 'create') {
    return (
      <PresetCreatePage
        api={api}
        t={t}
        onBack={() => { setView('list') }}
        onCreated={(row) => {
          setNotice(t('created', { name: row.name ?? row.id }))
          setView('list')
          setRequest(value => value + 1)
        }}
      />
    )
  }

  const rows = roster.status === 'ready' ? roster.rows : []
  const managed = rows.filter(row => row.managed)
  const builtin = rows.filter(row => !row.managed)

  return (
    <div className={css.page} aria-busy={roster.status === 'loading'}>
      <header className={css.header}>
        <h2 className={css.title}>{t('title')}</h2>
        <span className={css.actions}>
          <button type="button" className={css.primary} onClick={() => { setView('create') }}>
            {t('createEntry')}
          </button>
          <button type="button" className={css.secondary} onClick={() => { setRequest(value => value + 1) }}>
            {t('refresh')}
          </button>
        </span>
      </header>
      <p className={css.subtitle}>{t('subtitle')}</p>

      {notice === undefined ? null : <p className={css.notice} role="status">{notice}</p>}
      {failure === undefined ? null : <p className={css.failure} role="alert">{failure}</p>}

      {roster.status === 'loading' ? <p className={css.hint}>{t('loading')}</p> : null}
      {roster.status === 'error' ? (
        <p className={css.failure} role="alert">
          {t('error')}
          <button type="button" className={css.secondary} onClick={() => { setRequest(value => value + 1) }}>
            {t('retry')}
          </button>
        </p>
      ) : null}
      {roster.status === 'ready' && rows.length === 0 ? <p className={css.hint}>{t('empty')}</p> : null}

      {managed.length === 0 ? null : (
        <>
          <h3 className={css.groupTitle}>{t('managedSection')}</h3>
          <ul className={css.rows}>
            {managed.map(row => (
              <PresetRow key={row.id} row={row} t={t} busy={pendingId === row.id} onDelete={remove} />
            ))}
          </ul>
        </>
      )}

      {builtin.length === 0 ? null : (
        <>
          <h3 className={css.groupTitle}>{t('builtinSection')}</h3>
          <ul className={css.rows}>
            {builtin.map(row => (
              <PresetRow key={row.id} row={row} t={t} busy={false} onDelete={remove} />
            ))}
          </ul>
        </>
      )}
    </div>
  )
}

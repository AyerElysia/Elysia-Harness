/** Read-only view of one pinned archived request with explicitly bounded section loading. */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { LatestResponse, Section, SnapshotMetadata } from '../types.ts'
import type { InspectorApi } from './api.ts'
import type { ClientConnectionRpc } from '@deepseek-ai/dsh-client-connection/client'
import { createInspectorApi, SECTIONS } from './api.ts'
import { readableSystemBlocks } from './readable-system.ts'
import { PagedTextReader } from './paged-text.ts'
import type { NS } from './locales.ts'
import css from './ContextInspectorView.module.css'

export interface ContextInspectorInjected {
  readonly inspectorSessionId: string
  readonly inspectorRpc: Pick<ClientConnectionRpc, 'call'>
}

type LocaleProps = PropsLocale<typeof NS>
type LatestState =
  | { readonly phase: 'loading' }
  | { readonly phase: 'error' }
  | { readonly phase: 'ready'; readonly value: LatestResponse; readonly revision: number }

/** Session key prevents an earlier session's retained prompt flashing during navigation. */
export function ContextInspectorView({
  inspectorSessionId, inspectorRpc, t,
}: ConvViewProps & InjectFace<ContextInspectorInjected> & LocaleProps) {
  const api = useMemo(() => createInspectorApi(inspectorRpc, inspectorSessionId), [inspectorRpc, inspectorSessionId])
  return <SessionInspector key={inspectorSessionId} api={api} t={t} />
}

function SessionInspector({ api, t }: { api: InspectorApi } & LocaleProps) {
  const [latest, setLatest] = useState<LatestState>({ phase: 'loading' })
  const [section, setSection] = useState<Section>('system')
  const pending = useRef<AbortController>()
  const revision = useRef(0)
  const refresh = useCallback(async () => {
    pending.current?.abort()
    const controller = new AbortController()
    pending.current = controller
    setLatest({ phase: 'loading' })
    try {
      const value = await api.latest(controller.signal)
      if (!controller.signal.aborted && pending.current === controller) {
        setLatest({ phase: 'ready', value, revision: ++revision.current })
      }
    } catch {
      if (!controller.signal.aborted && pending.current === controller) setLatest({ phase: 'error' })
    }
  }, [api])
  useEffect(() => {
    void refresh()
    return () => { pending.current?.abort() }
  }, [refresh])
  const request = latest.phase === 'ready' ? latest.value.request : null

  return (
    <section className={css.root} aria-label={t('title')}>
      <div className={css.header}>
        <div>
          <h2 className={css.title}>{t('title')}</h2>
          <p className={css.description}>{t('description')}</p>
        </div>
        <button className={css.button} type="button" onClick={() => { void refresh() }} disabled={latest.phase === 'loading'}>
          {t('refresh')}
        </button>
      </div>
      {latest.phase === 'loading' && <p className={css.notice} role="status">{t('loading')}</p>}
      {latest.phase === 'error' && <p className={css.error} role="alert">{t('latestError')}</p>}
      {latest.phase === 'ready' && request === null && (
        <p className={css.notice} role="status">{t(latest.value.reason === 'index-unavailable' ? 'indexUnavailable' : 'empty')}</p>
      )}
      {request !== null && latest.phase === 'ready' && (
        <>
          <RequestMetadata request={request} t={t} />
          <div className={css.tabs} role="tablist" aria-label={t('sections')}>
            {SECTIONS.map(item => (
              <button
                className={item === section ? `${css.tab} ${css.tabActive}` : css.tab}
                id={`elysia-context-tab-${item}`}
                aria-controls="elysia-context-panel"
                type="button"
                role="tab"
                aria-selected={item === section}
                key={item}
                onClick={() => { setSection(item) }}
              >{t(item)}</button>
            ))}
          </div>
          <SectionContent
            key={`${request.requestId}:${latest.revision}:${section}`}
            api={api}
            request={request}
            section={section}
            t={t}
          />
        </>
      )}
    </section>
  )
}

function RequestMetadata({ request, t }: { request: SnapshotMetadata } & LocaleProps) {
  const recordedAt = request.recordedAt
  return (
    <dl className={css.metadata}>
      <div><dt>{t('capturedAt')}</dt><dd><time dateTime={request.recordedAt} title={request.recordedAt}>{recordedAt}</time></dd></div>
      <div><dt>{t('model')}</dt><dd>{request.model}</dd></div>
      <div><dt>{t('provider')}</dt><dd>{request.provider}</dd></div>
      <div><dt>{t('callKind')}</dt><dd>{t(request.loop ? 'agentLoop' : 'otherCall')}</dd></div>
      <div><dt>{t('messagesCount')}</dt><dd>{request.messageCount}</dd></div>
      <div><dt>{t('toolsCount')}</dt><dd>{request.toolCount}</dd></div>
      <div><dt>{t('requestId')}</dt><dd>{request.requestId}</dd></div>
    </dl>
  )
}

function SectionContent({ api, request, section, t }: {
  api: InspectorApi
  request: SnapshotMetadata
  section: Section
} & LocaleProps) {
  const reader = useMemo(() => new PagedTextReader(
    (offset, signal) => api.read(request, section, offset, signal),
    request.sections[section].bytes,
  ), [api, request, section])
  const state = useSyncExternalStore(reader.subscribe, reader.getSnapshot, reader.getSnapshot)
  const [readable, setReadable] = useState(true)
  const blocks = useMemo(() => section === 'system' && state.complete
    ? readableSystemBlocks(state.text) : [], [section, state.complete, state.text])
  useEffect(() => {
    void reader.load()
    // Cancel rather than permanently dispose: React StrictMode replays this effect.
    return () => { reader.cancel() }
  }, [reader])
  return (
    <div className={css.panel} role="tabpanel" id="elysia-context-panel" aria-labelledby={`elysia-context-tab-${section}`}>
      {section === 'system' && <p className={css.notice}>{t('systemDescription')}</p>}
      <div className={css.progress}>
        <span role="status" aria-live="polite">
          {t('loaded', { loaded: state.loadedBytes.toLocaleString(), total: state.totalBytes.toLocaleString() })}
          {state.loading ? ` · ${t('reading')}` : state.complete ? ` · ${t('complete')}` : ''}
        </span>
        <span className={css.actions}>
          {state.loading
            ? <button className={css.button} type="button" onClick={() => { reader.cancel() }}>{t('cancel')}</button>
            : !state.complete && (
              <>
                <button className={css.button} type="button" onClick={() => { void reader.load() }}>{t('loadMore')}</button>
                <button className={css.button} type="button" onClick={() => { void reader.load(true) }}>{t('loadAll')}</button>
              </>
            )}
        </span>
      </div>
      {section === 'system' && state.complete && (
        <div className={css.displayModes} role="group" aria-label={t('displayMode')}>
          <button className={css.button} type="button" aria-pressed={readable} onClick={() => { setReadable(true) }}>{t('readableText')}</button>
          <button className={css.button} type="button" aria-pressed={!readable} onClick={() => { setReadable(false) }}>{t('jsonStructure')}</button>
        </div>
      )}
      {!state.complete && <p className={css.notice}>{t('partial')}</p>}
      {state.error !== null && <p className={css.error} role="alert">{t('readError')}</p>}
      {state.complete && state.text === ''
        ? <p className={css.notice}>{t('emptySection')}</p>
        : section === 'system' && state.complete && readable
          ? <div aria-label={t('content', { section: t(section) })}>{blocks.map((block, index) => (
            <section className={css.readableBlock} key={index}>
              <h3 className={css.sourceLabel}>{block.source}</h3>
              <pre className={css.content}>{block.text}</pre>
            </section>
          ))}</div>
          : <pre className={css.content} aria-label={t('content', { section: t(section) })}>{state.text}</pre>}
    </div>
  )
}

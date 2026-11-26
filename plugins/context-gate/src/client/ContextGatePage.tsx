/**
 * The context gate views for one session: they load the Host snapshot and turn
 * each subscription gesture into one `setContext` write.
 *
 * The session whose Conversation view renders it is the only scope. Nothing
 * here depends on 会话编排模式 or on tool management, so the views work for any
 * session.
 *
 * @module @elysia/context-gate/client/ContextGatePage
 */
import { useEffect, useState, type ReactNode } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ContextEntry, ContextSnapshot } from '../types.ts'
import type { ContextGateApi } from './api.ts'
import { notifyContextChanged, subscribeContextChanged } from './context-events.ts'
import { describeFailure } from './errors.ts'
import {
  ContextGateFailure, ContextGateLoading, ContextGateView, type PanelTab,
} from './ContextGateView.tsx'
import css from './ContextGatePage.module.css'

/** Registration-side Remote face used by the views. */
export interface ContextGatePageInjected {
  /** Host operations the views perform for this session. */
  readonly api: ContextGateApi
  /** Top-level native tab this page renders. */
  readonly tab: PanelTab
  /** Session the snapshot belongs to. */
  readonly sessionId: string
}

/** Full component props assembled by the conversation view renderer. */
export type ContextGatePageProps = PropsRuntime<'conversation.view'>
  & PropsLocale<'contextGate'>
  & InjectFace<ContextGatePageInjected>

type LoadState =
  | { readonly status: 'loading' }
  | { readonly status: 'error' }
  | { readonly status: 'ready'; readonly snapshot: ContextSnapshot }

/** Render the context views for the current session. */
export function ContextGatePage({ api, t, tab, sessionId }: ContextGatePageProps): ReactNode {
  const [request, setRequest] = useState(0)
  const [load, setLoad] = useState<LoadState>({ status: 'loading' })
  const [draft, setDraft] = useState<Readonly<Record<string, boolean>>>({})
  const [pendingKind, setPendingKind] = useState<string | undefined>(undefined)
  const [failure, setFailure] = useState<string | undefined>(undefined)

  useEffect(() => {
    let current = true
    const controller = new AbortController()
    setLoad(previous => previous.status === 'ready' ? previous : { status: 'loading' })
    void api.list(controller.signal).then(
      (snapshot) => {
        if (current) setLoad({ status: 'ready', snapshot })
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

  // A subscription change is visible to the other context view through the
  // browser event channel; refreshing on that event and on page visibility
  // keeps two open views consistent without polling.
  useEffect(() => {
    const refresh = (): void => {
      if (document.visibilityState === 'visible') setRequest(value => value + 1)
    }
    const disposeChanges = subscribeContextChanged(refresh)
    document.addEventListener('visibilitychange', refresh)
    return () => {
      disposeChanges()
      document.removeEventListener('visibilitychange', refresh)
    }
  }, [])

  // Drop a draft entry once the snapshot the Host returns agrees with it; until
  // then the switch keeps the value the operator just chose instead of snapping
  // back to the pre-write snapshot while the refresh is in flight.
  useEffect(() => {
    if (load.status !== 'ready') return
    const contexts = load.snapshot.contexts
    setDraft((current) => {
      let changed = false
      const next: Record<string, boolean> = { ...current }
      for (const [kind, wanted] of Object.entries(current)) {
        const entry = contexts.find(candidate => candidate.kind === kind)
        if (entry !== undefined && (entry.enabledBy[sessionId] ?? false) === wanted) {
          delete next[kind]
          changed = true
        }
      }
      return changed ? next : current
    })
  }, [load, sessionId])

  const toggle = (entry: ContextEntry, enabled: boolean): void => {
    if (pendingKind !== undefined) return
    setDraft(current => ({ ...current, [entry.kind]: enabled }))
    setPendingKind(entry.kind)
    setFailure(undefined)
    void api.setContext(entry.kind, enabled, new AbortController().signal).then(
      () => {
        setPendingKind(undefined)
        notifyContextChanged()
        setRequest(value => value + 1)
      },
      (error: unknown) => {
        setPendingKind(undefined)
        setDraft((current) => {
          const next = { ...current }
          delete next[entry.kind]
          return next
        })
        setFailure(describeFailure(error, t))
        setRequest(value => value + 1)
      },
    )
  }

  return (
    <div className={css.shell} aria-busy={load.status === 'loading' || pendingKind !== undefined}>
      {failure === undefined ? null : <p className={css.failure} role="alert">{failure}</p>}

      {load.status === 'loading' ? <ContextGateLoading t={t} /> : null}
      {load.status === 'error' ? (
        <ContextGateFailure t={t} onRetry={() => { setRequest(value => value + 1) }} />
      ) : null}
      {load.status === 'ready' ? (
        <ContextGateView
          t={t}
          snapshot={load.snapshot}
          sessionId={sessionId}
          forcedTab={tab}
          draft={draft}
          pendingKind={pendingKind}
          onToggle={toggle}
        />
      ) : null}
    </div>
  )
}
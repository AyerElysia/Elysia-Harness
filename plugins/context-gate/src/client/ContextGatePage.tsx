/**
 * The three context views for one session: 事件, 定时, and 日志. Each native
 * view loads its Host snapshot and turns a gesture into one Remote write.
 *
 * The session whose Conversation view renders it is the only scope. Nothing
 * here depends on 工具编辑模式 or on tool management, so the views work for any
 * session.
 *
 * @module @elysia/context-gate/client/ContextGatePage
 */
import { useEffect, useState, type ReactNode } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  AbsenceDraft, ContextEntry, ContextSnapshot, EventParameterValues, EventRule, EventRuleDraft, TimerDraft,
  TimerSnapshot,
} from '../types.ts'
import type { ContextGateApi } from './api.ts'
import { notifyContextChanged, subscribeContextChanged } from './context-events.ts'
import { describeFailure } from './errors.ts'
import {
  ContextGateFailure, ContextGateLoading, EventsView, LogView, TimersView, type PanelTab,
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

/** Render one context view for the current session. */
export function ContextGatePage({ api, t, tab, sessionId }: ContextGatePageProps): ReactNode {
  const [request, setRequest] = useState(0)
  const [load, setLoad] = useState<LoadState>({ status: 'loading' })
  const [timers, setTimers] = useState<TimerSnapshot | undefined>(undefined)
  const [draft, setDraft] = useState<Readonly<Record<string, boolean>>>({})
  const [pendingKind, setPendingKind] = useState<string | undefined>(undefined)
  const [pending, setPending] = useState(false)
  const [failure, setFailure] = useState<string | undefined>(undefined)
  const [ruleResult, setRuleResult] = useState<{ readonly id: string; readonly detail: string } | undefined>(undefined)

  useEffect(() => {
    let current = true
    const controller = new AbortController()
    setLoad(previous => previous.status === 'ready' ? previous : { status: 'loading' })
    void api.list(controller.signal).then(
      (snapshot) => {
        if (!current) return
        setLoad({ status: 'ready', snapshot })
      },
      () => {
        if (current) setLoad({ status: 'error' })
      },
    )
    if (tab === 'timers') {
      void api.timers(controller.signal).then(
        (snapshot) => { if (current) setTimers(snapshot) },
        (error: unknown) => { if (current) setFailure(describeFailure(error, t)) },
      )
    }
    return () => {
      current = false
      controller.abort()
    }
  }, [api, request, tab, t])

  // Subscription, timer, and rule changes are visible to the other views
  // through the browser event channel; refreshing on that event and on page
  // visibility keeps open views consistent without polling.
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

  // Drop a draft entry once the snapshot the Host returns agrees with it.
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

  const run = async (action: () => Promise<unknown>): Promise<void> => {
    setPending(true)
    setFailure(undefined)
    try {
      await action()
      notifyContextChanged()
      setRequest(current => current + 1)
    } catch (error: unknown) {
      setFailure(describeFailure(error, t))
      setRequest(current => current + 1)
    } finally {
      setPending(false)
    }
  }

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

  const saveParams = (kind: string, params: EventParameterValues): void => {
    void run(() => api.setSubscriptionParams(kind, params, new AbortController().signal))
  }

  const subscribeFuture = (kind: string, params: EventParameterValues): void => {
    void run(() => api.subscribeFuture(kind, params, new AbortController().signal))
  }

  const createRule = (rule: EventRuleDraft): void => {
    void run(() => api.createRule(rule, new AbortController().signal))
  }

  const updateRule = (id: string, rule: EventRuleDraft, previous: EventRule): void => {
    void run(() => api.updateRule(id, {
      name: rule.name,
      trigger: rule.trigger,
      where: rule.where ?? [],
      contentTemplate: rule.contentTemplate,
      ...(rule.script === undefined
        ? (previous.script === undefined ? {} : { script: null })
        : { script: rule.script }),
      ...(rule.wake === undefined ? {} : { wake: rule.wake }),
      ...(rule.webhookSecret === undefined ? {} : { webhookSecret: rule.webhookSecret }),
    }, new AbortController().signal))
  }

  const testRule = (id: string): void => {
    setPending(true)
    setFailure(undefined)
    void api.testRule(id, new AbortController().signal).then(
      (result) => {
        setRuleResult({ id, detail: result.detail })
        setPending(false)
      },
      (error: unknown) => {
        setFailure(describeFailure(error, t))
        setPending(false)
      },
    )
  }

  const pauseRule = (id: string, paused: boolean): void => {
    void run(() => api.pauseRule(id, !paused, new AbortController().signal))
  }

  const cancelRule = (id: string): void => {
    void run(() => api.cancelRule(id, new AbortController().signal))
  }

  const createTimer = (draftTimer: TimerDraft): void => {
    void run(() => api.createTimer(draftTimer, new AbortController().signal))
  }

  const updateTimer = (id: string, draftTimer: TimerDraft): void => {
    void run(() => api.updateTimer(id, draftTimer, new AbortController().signal))
  }

  const pauseTimer = (id: string, paused: boolean): void => {
    void run(() => api.pauseTimer(id, paused, new AbortController().signal))
  }

  const cancelTimer = (id: string): void => {
    void run(() => api.cancelTimer(id, new AbortController().signal))
  }

  const createPreset = (draftTimer: TimerDraft): void => {
    void run(() => api.createTimerPreset(draftTimer, new AbortController().signal))
  }

  const updatePreset = (presetId: string, draftTimer: TimerDraft): void => {
    void run(() => api.updateTimerPreset(presetId, draftTimer, new AbortController().signal))
  }

  const adoptPreset = (presetId: string): void => {
    void run(() => api.adoptTimerPreset(presetId, new AbortController().signal))
  }

  const deletePreset = (presetId: string): void => {
    void run(() => api.deleteTimerPreset(presetId, new AbortController().signal))
  }

  const createAbsence = (draftAbsence: AbsenceDraft): void => {
    void run(() => api.createAbsence(draftAbsence, new AbortController().signal))
  }

  const updateAbsence = (id: string, draftAbsence: AbsenceDraft): void => {
    void run(() => api.updateAbsence(id, {
      ...(draftAbsence.name === undefined ? {} : { name: draftAbsence.name }),
      kinds: draftAbsence.kinds,
      quietMs: draftAbsence.quietMs,
    }, new AbortController().signal))
  }

  const cancelAbsence = (id: string): void => {
    void run(() => api.cancelAbsence(id, new AbortController().signal))
  }

  return (
    <div className={css.pageHost} aria-busy={load.status === 'loading' || pendingKind !== undefined || pending}>
      {load.status === 'loading' ? <ContextGateLoading t={t} /> : null}
      {load.status === 'error' ? (
        <ContextGateFailure t={t} onRetry={() => { setRequest(value => value + 1) }} />
      ) : null}
      {load.status === 'ready' && tab === 'events' ? (
        <EventsView
          t={t}
          pending={pending}
          failure={failure}
          snapshot={load.snapshot}
          sessionId={sessionId}
          draft={draft}
          pendingKind={pendingKind}
          onToggle={toggle}
          onParams={saveParams}
          onSubscribeFuture={subscribeFuture}
          onRuleCreate={createRule}
          onRuleUpdate={updateRule}
          onRuleTest={testRule}
          onRulePause={pauseRule}
          onRuleCancel={cancelRule}
          ruleResult={ruleResult}
        />
      ) : null}
      {load.status === 'ready' && tab === 'log' ? (
        <LogView t={t} pending={pending} failure={failure} snapshot={load.snapshot} />
      ) : null}
      {load.status === 'ready' && tab === 'timers' && timers === undefined ? <ContextGateLoading t={t} /> : null}
      {load.status === 'ready' && tab === 'timers' && timers !== undefined ? (
        <TimersView
          t={t}
          pending={pending}
          failure={failure}
          snapshot={timers}
          onCreateTimer={createTimer}
          onUpdateTimer={updateTimer}
          onPauseTimer={pauseTimer}
          onCancelTimer={cancelTimer}
          onCreatePreset={createPreset}
          onUpdatePreset={updatePreset}
          onAdoptPreset={adoptPreset}
          onDeletePreset={deletePreset}
          onCreateAbsence={createAbsence}
          onUpdateAbsence={updateAbsence}
          onCancelAbsence={cancelAbsence}
        />
      ) : null}
    </div>
  )
}
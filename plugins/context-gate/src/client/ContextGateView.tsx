/**
 * Presentational context gate: one pure render of a loaded session snapshot,
 * with the subscription list on 事件 and the recent injection log on 日志.
 *
 * It owns no request, so a spec can drive every state by props.
 *
 * @module @elysia/context-gate/client/ContextGateView
 */

import { useState, type ReactNode } from 'react'
import type { ContextEntry, ContextSnapshot, EventLogEntry, EventOutcome } from '../types.ts'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import { OUTCOME_LABEL_KEYS, type ContextGateLocaleKey } from './locales.ts'
import css from './ContextGatePage.module.css'

/** The views' translate seat, narrowed to their own dictionary. */
export type ContextGateTranslate = Translate<ContextGateLocaleKey>

/** The panel's translate seat, narrowed to its own dictionary. */
type T = ContextGateTranslate

/** One top-level context tab. */
export type PanelTab = 'events' | 'log'

const PANEL_TABS: readonly { id: PanelTab; label: 'tabEvents' | 'tabLog' }[] = [
  { id: 'events', label: 'tabEvents' },
  { id: 'log', label: 'tabLog' },
]

function ttlText(t: T, ttlMs: number): string {
  if (ttlMs >= 60_000 && ttlMs % 60_000 === 0) return t('ttlMinutes', { count: String(ttlMs / 60_000) })
  return t('ttlSeconds', { count: String(Math.round(ttlMs / 1000)) })
}

/**
 * Render an epoch timestamp as a fixed UTC clock time, so the log reads the
 * same in every time zone the Host and browser could disagree on.
 * @param at - epoch milliseconds.
 * @returns `HH:MM:SS`.
 */
export function formatClock(at: number): string {
  return new Date(at).toISOString().slice(11, 19)
}

/**
 * Localized event-log outcome.
 * @param t - view copy.
 * @param outcome - the outcome from the Host.
 * @returns the localized outcome, or the raw value when unknown.
 */
export function outcomeText(t: T, outcome: EventOutcome): string {
  const key = OUTCOME_LABEL_KEYS[outcome]
  return key === undefined ? outcome : t(key)
}

/** Props of the whole context panel; the container supplies every value. */
export interface ContextGateViewProps {
  /** Localized copy. */
  readonly t: T
  /** Every context kind and log row the Host reports for this session. */
  readonly snapshot: ContextSnapshot
  /** Session the snapshot belongs to; the key of every `enabledBy` row. */
  readonly sessionId: string
  /** Native top tab this page renders; omit for the standalone in-page tabs. */
  readonly forcedTab?: PanelTab | undefined
  /** Unsaved subscription changes keyed by kind; wins over the snapshot until it confirms them. */
  readonly draft: Readonly<Record<string, boolean>>
  /** Kind whose subscription write is in flight. */
  readonly pendingKind?: string | undefined
  /** Change one context subscription. */
  readonly onToggle: (entry: ContextEntry, enabled: boolean) => void
}

/** One context event kind with its session subscription switch. */
function ContextRow({
  t, entry, checked, busy, onToggle,
}: {
  readonly t: T
  readonly entry: ContextEntry
  readonly checked: boolean
  readonly busy: boolean
  readonly onToggle: (entry: ContextEntry, enabled: boolean) => void
}): ReactNode {
  return (
    <li className={css.contextRow} data-context-kind={entry.kind} data-subscribed={checked}>
      <label className={css.switchRow}>
        <input
          type="checkbox"
          className={css.checkbox}
          checked={checked}
          disabled={busy}
          aria-label={t('contextToggleLabel', { kind: entry.nameZh })}
          onChange={(event) => { onToggle(entry, event.currentTarget.checked) }}
        />
        <span className={css.contextName}>{entry.nameZh}</span>
        <code className={css.contextId}>{entry.kind}</code>
      </label>
      <span className={css.badgeRow}>
        <span className={checked ? css.badgeOk : css.badgeMuted}>
          {t(checked ? 'contextSubscribed' : 'contextUnsubscribed')}
        </span>
        <span className={css.badgeMuted}>{ttlText(t, entry.ttlMs)}</span>
        {entry.backlog === 0 ? null : (
          <span className={css.badgeMuted}>{t('contextBacklog', { count: String(entry.backlog) })}</span>
        )}
      </span>
      <p className={css.contextDescription}>{entry.description}</p>
    </li>
  )
}

/** One log row: when the event ended up this way, its kind, and the detail. */
function EventRow({
  t, entry, label,
}: {
  readonly t: T
  readonly entry: EventLogEntry
  readonly label: string
}): ReactNode {
  return (
    <li className={css.eventRow} data-outcome={entry.outcome}>
      <time className={css.eventTime} dateTime={new Date(entry.at).toISOString()}>
        {formatClock(entry.at)}
      </time>
      <span className={entry.outcome === 'failed' ? css.badgeError : css.badgeMuted}>
        {outcomeText(t, entry.outcome)}
      </span>
      <span className={css.eventKind}>{label}</span>
      {entry.source === undefined ? null : <code className={css.eventSource}>{entry.source}</code>}
      {entry.detail === undefined ? null : <span className={css.eventDetail}>{entry.detail}</span>}
    </li>
  )
}

/** Render the views' loading state. */
export function ContextGateLoading({ t }: { readonly t: T }): ReactNode {
  return <p className={css.hint}>{t('loading')}</p>
}

/** Render the views' load-failure state with its retry action. */
export function ContextGateFailure({
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

/** Render the loaded context panel. */
export function ContextGateView({
  t, snapshot, sessionId, forcedTab, draft, pendingKind, onToggle,
}: ContextGateViewProps): ReactNode {
  const [stateTab, setActiveTab] = useState<PanelTab>('events')
  const activeTab = forcedTab ?? stateTab
  const names = new Map(snapshot.contexts.map(entry => [entry.kind, entry.nameZh]))
  return (
    <div className={css.page} data-context-gate-panel>
      {pendingKind === undefined ? null : <p className={css.notice}>{t('pending')}</p>}
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

          <div className={css.tabPanel} role="tabpanel" hidden={activeTab !== 'events'}>
            <p className={css.hint}>{t('subscriptionsHint')}</p>
            {snapshot.contexts.length === 0 ? <p className={css.hint}>{t('emptyContexts')}</p> : null}
            <ul className={css.contextList}>
              {snapshot.contexts.map(entry => (
                <ContextRow
                  key={entry.kind}
                  t={t}
                  entry={entry}
                  checked={draft[entry.kind] ?? entry.enabledBy[sessionId] ?? false}
                  busy={pendingKind !== undefined}
                  onToggle={onToggle}
                />
              ))}
            </ul>
          </div>

          <div className={css.tabPanel} role="tabpanel" hidden={activeTab !== 'log'}>
            <p className={css.hint}>{t('eventLogHint')}</p>
            {snapshot.events.length === 0 ? <p className={css.hint}>{t('emptyEvents')}</p> : null}
            <ul className={css.eventList}>
              {snapshot.events.map(entry => (
                <EventRow
                  key={entry.id}
                  t={t}
                  entry={entry}
                  label={names.get(entry.kind) ?? entry.kind}
                />
              ))}
            </ul>
          </div>
        </section>
    </div>
  )
}
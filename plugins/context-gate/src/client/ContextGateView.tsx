/**
 * Presentational views of the context gate: one view per native Conversation
 * tab (事件 / 定时 / 日志). Each view is a pure render of loaded Host data plus
 * the gestures the container wires, so a spec can drive every state by props.
 *
 * @module @elysia/context-gate/client/ContextGateView
 */

import { useState, type ReactNode } from 'react'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  AbsenceDraft, AbsenceTimer, ContextEntry, ContextSnapshot, EventLogEntry, EventOutcome, EventParameterSchema,
  EventParameterValues, EventRule, EventRuleDraft, InternalEventName, RuleTrigger, TimerDraft, TimerInstance,
  TimerPreset, TimerSchedule, TimerSnapshot,
} from '../types.ts'
import { OUTCOME_LABEL_KEYS, type ContextGateLocaleKey } from './locales.ts'
import css from './ContextGatePage.module.css'

/** The views' translate seat, narrowed to their own dictionary. */
export type ContextGateTranslate = Translate<ContextGateLocaleKey>

/** The panel's translate seat, narrowed to its own dictionary. */
type T = ContextGateTranslate

/** One native top-level context tab. */
export type PanelTab = 'events' | 'timers' | 'log'

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

/** Props shared by every loaded view. */
interface ViewShellProps {
  /** Localized copy. */
  readonly t: T
  /** A write is in flight. */
  readonly pending: boolean
  /** Latest failure text. */
  readonly failure?: string | undefined
}

function ViewShell({ t, pending, failure, children }: ViewShellProps & { readonly children: ReactNode }): ReactNode {
  return (
    <div className={css.shell} aria-busy={pending}>
      {failure === undefined ? null : <p className={css.failure} role="alert">{failure}</p>}
      {pending ? <p className={css.notice}>{t('pending')}</p> : null}
      {children}
    </div>
  )
}

/** Props of the 事件 view. */
export interface EventsViewProps extends ViewShellProps {
  readonly snapshot: ContextSnapshot
  readonly sessionId: string
  readonly draft: Readonly<Record<string, boolean>>
  readonly pendingKind?: string | undefined
  readonly onToggle: (entry: ContextEntry, enabled: boolean) => void
  readonly onParams: (kind: string, params: EventParameterValues) => void
  readonly onSubscribeFuture: (kind: string, params: EventParameterValues) => void
  readonly onRuleCreate: (draft: EventRuleDraft) => void
  readonly onRuleUpdate: (id: string, draft: EventRuleDraft, previous: EventRule) => void
  readonly onRuleTest: (id: string) => void
  readonly onRulePause: (id: string, paused: boolean) => void
  readonly onRuleCancel: (id: string) => void
  readonly ruleResult?: { readonly id: string; readonly detail: string } | undefined
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

/** Props of the 日志 view. */
export interface LogViewProps {
  readonly t: T
  readonly pending: boolean
  readonly failure?: string | undefined
  readonly snapshot: ContextSnapshot
}

/** Render the 日志 view. */
export function LogView({ t, pending, failure, snapshot }: LogViewProps): ReactNode {
  const names = new Map(snapshot.contexts.map(entry => [entry.kind, entry.nameZh]))
  return (
    <ViewShell t={t} pending={pending} failure={failure}>
      <div className={css.page} data-context-gate-panel>
        <p className={css.hint}>{t('logHint')}</p>
        {snapshot.events.length === 0 ? <p className={css.hint}>{t('emptyEvents')}</p> : null}
        <ul className={css.eventList}>
          {snapshot.events.map(entry => (
            <EventRow key={entry.id} t={t} entry={entry} label={names.get(entry.kind) ?? entry.kind} />
          ))}
        </ul>
      </div>
    </ViewShell>
  )
}

function initialParamText(parameter: EventParameterSchema, values: EventParameterValues): string {
  const value = values[parameter.key]
  if (Array.isArray(value)) return value.filter(entry => entry !== '*' && entry !== '+').join(', ')
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value)
  return ''
}

function paramTokens(parameter: EventParameterSchema, values: EventParameterValues): { all: boolean; future: boolean } {
  const value = values[parameter.key]
  return {
    all: parameter.allowAll === true && Array.isArray(value) && value.includes('*'),
    future: parameter.allowFuture === true && Array.isArray(value) && value.includes('+'),
  }
}

/** Editable subscription parameters of one kind. */
function ParameterEditor({
  t, entry, initial, disabled, onSave,
}: {
  readonly t: T
  readonly entry: ContextEntry
  readonly initial: EventParameterValues
  readonly disabled: boolean
  readonly onSave: (params: EventParameterValues) => void
}): ReactNode {
  const parameters = entry.parameters ?? []
  const [text, setText] = useState<Record<string, string>>(() => {
    const draft: Record<string, string> = {}
    for (const parameter of parameters) draft[parameter.key] = initialParamText(parameter, initial)
    return draft
  })
  const [checks, setChecks] = useState<Record<string, { all: boolean; future: boolean }>>(() => {
    const draft: Record<string, { all: boolean; future: boolean }> = {}
    for (const parameter of parameters) draft[parameter.key] = paramTokens(parameter, initial)
    return draft
  })
  if (parameters.length === 0) return null
  const save = (): void => {
    const values: Record<string, unknown> = {}
    for (const parameter of parameters) {
      const raw = text[parameter.key] ?? ''
      if (parameter.type === 'boolean') {
        if (raw !== '') values[parameter.key] = raw === 'true'
        continue
      }
      if (parameter.type === 'number') {
        if (raw.trim() !== '') values[parameter.key] = Number(raw)
        continue
      }
      if (parameter.type === 'enum') {
        if (raw !== '') values[parameter.key] = parameter.multiple === true ? raw.split(',').map(part => part.trim()).filter(Boolean) : raw
        continue
      }
      if (parameter.type === 'session' || parameter.type === 'source') {
        const list = raw.split(',').map(part => part.trim()).filter(Boolean)
        const state = checks[parameter.key]
        if (state?.all === true) list.push('*')
        if (state?.future === true) list.push('+')
        if (list.length > 0) values[parameter.key] = parameter.multiple === true ? list : list[0]
        continue
      }
      if (raw !== '') values[parameter.key] = raw
    }
    onSave(values)
  }
  return (
    <fieldset className={css.params} disabled={disabled}>
      <legend className={css.fieldLabel}>{t('paramsTitle')}</legend>
      <p className={css.hint}>{t('paramsHint')}</p>
      {parameters.map((parameter) => {
        const state = checks[parameter.key] ?? { all: false, future: false }
        return (
          <div key={parameter.key} className={css.field}>
            <label className={css.fieldLabel} htmlFor={`${entry.kind}-${parameter.key}`}>{parameter.labelZh}</label>
            {parameter.type === 'enum' && parameter.multiple !== true && parameter.options !== undefined && parameter.options.length > 0 ? (
              <select
                id={`${entry.kind}-${parameter.key}`}
                className={css.select}
                value={text[parameter.key] ?? ''}
                onChange={(event) => { setText(current => ({ ...current, [parameter.key]: event.currentTarget.value })) }}
              >
                <option value="">{t('paramNone')}</option>
                {parameter.options.map(option => (
                  <option key={option.value} value={option.value}>{option.labelZh}</option>
                ))}
              </select>
            ) : parameter.type === 'boolean' ? (
              <select
                id={`${entry.kind}-${parameter.key}`}
                className={css.select}
                value={text[parameter.key] ?? ''}
                onChange={(event) => { setText(current => ({ ...current, [parameter.key]: event.currentTarget.value })) }}
              >
                <option value="">{t('paramNone')}</option>
                <option value="true">true</option>
                <option value="false">false</option>
              </select>
            ) : (
              <input
                id={`${entry.kind}-${parameter.key}`}
                className={css.input}
                type={parameter.type === 'number' ? 'number' : 'text'}
                value={text[parameter.key] ?? ''}
                placeholder={parameter.multiple === true ? t('paramMultipleHint') : undefined}
                onChange={(event) => { setText(current => ({ ...current, [parameter.key]: event.currentTarget.value })) }}
              />
            )}
            {parameter.type === 'session' || parameter.type === 'source' ? (
              <span className={css.inline}>
                {parameter.allowAll === true ? (
                  <label className={css.inlineLabel}>
                    <input
                      type="checkbox"
                      checked={state.all}
                      onChange={(event) => {
                        const all = event.currentTarget.checked
                        setChecks(current => ({ ...current, [parameter.key]: { ...state, all } }))
                      }}
                    />
                    {t('paramAllCurrent')}
                  </label>
                ) : null}
                {parameter.allowFuture === true ? (
                  <label className={css.inlineLabel}>
                    <input
                      type="checkbox"
                      checked={state.future}
                      onChange={(event) => {
                        const future = event.currentTarget.checked
                        setChecks(current => ({ ...current, [parameter.key]: { ...state, future } }))
                      }}
                    />
                    {t('paramFuture')}
                  </label>
                ) : null}
              </span>
            ) : null}
          </div>
        )
      })}
      <button type="button" className={css.secondary} onClick={save}>{t('paramsSave')}</button>
    </fieldset>
  )
}

/** One context event kind with its subscription switch, parameters, and future rule. */
function ContextRow({
  t, entry, checked, busy, onToggle, onParams, onSubscribeFuture,
}: {
  readonly t: T
  readonly entry: ContextEntry
  readonly checked: boolean
  readonly busy: boolean
  readonly onToggle: (entry: ContextEntry, enabled: boolean) => void
  readonly onParams: (kind: string, params: EventParameterValues) => void
  readonly onSubscribeFuture: (kind: string, params: EventParameterValues) => void
}): ReactNode {
  const params = entry.params ?? {}
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
      {(entry.parameters?.length ?? 0) === 0 ? null : (
        <details className={css.details}>
          <summary className={css.summary}>{t('paramsTitle')}</summary>
          <ParameterEditor
            key={`${entry.kind}:${JSON.stringify(params)}`}
            t={t}
            entry={entry}
            initial={params}
            disabled={busy}
            onSave={(values) => { onParams(entry.kind, values) }}
          />
        </details>
      )}
      <span className={css.formActions}>
        <button type="button" className={css.secondary} disabled={busy} onClick={() => { onSubscribeFuture(entry.kind, params) }}>
          {t('futureSubscribe')}
        </button>
      </span>
      <p className={css.hint}>{t('futureHint')}</p>
    </li>
  )
}

/** Render one schedule as compact text. */
export function scheduleText(t: T, schedule: TimerSchedule): string {
  switch (schedule.kind) {
    case 'once':
      return `${t('kindTimeAbsolute')} ${new Date(schedule.at).toISOString()}`
    case 'after':
      return `${t('kindTimeAfter')} ${String(Math.round(schedule.afterMs / 1000))}s`
    case 'seconds':
      return t('kindTimeSeconds', { count: String(schedule.everySeconds) })
    case 'rrule':
      return `${t('kindTimeRrule')} ${schedule.rrule.split('\n').at(-1) ?? schedule.rrule}`
  }
}

/** Render one rule trigger as compact text. */
export function triggerText(t: T, trigger: RuleTrigger): string {
  switch (trigger.kind) {
    case 'internal': return `${t('triggerInternal')} · ${trigger.event}`
    case 'time': return `${t('triggerTime')} · ${scheduleText(t, trigger.schedule)}`
    case 'absence': return `${t('triggerAbsence')} · ${trigger.kinds.join(' / ')}`
    case 'webhook': return t('triggerWebhook')
    case 'http-poll': return `${t('triggerHttpPoll')} · ${trigger.url}`
    case 'composite': return `${t('triggerComposite')} · ${trigger.op}`
  }
}

/** Schedule fields shared by timers, presets, and time rules. */
function ScheduleFields({
  t, kind, onKind, schedule, onSchedule,
}: {
  readonly t: T
  readonly kind: 'at' | 'after' | 'every' | 'rrule'
  readonly onKind: (kind: 'at' | 'after' | 'every' | 'rrule') => void
  readonly schedule: { at: string; after: string; every: string; rrule: string; timeZone: string }
  readonly onSchedule: (next: { at: string; after: string; every: string; rrule: string; timeZone: string }) => void
}): ReactNode {
  return (
    <>
      <div className={css.field}>
        <label className={css.fieldLabel} htmlFor="schedule-kind">{t('scheduleKind')}</label>
        <select
          id="schedule-kind"
          className={css.select}
          value={kind}
          onChange={(event) => { onKind(event.currentTarget.value as 'at' | 'after' | 'every' | 'rrule') }}
        >
          <option value="after">{t('scheduleAfter')}</option>
          <option value="at">{t('scheduleAt')}</option>
          <option value="every">{t('scheduleEvery')}</option>
          <option value="rrule">{t('scheduleRrule')}</option>
        </select>
      </div>
      {kind === 'at' ? (
        <div className={css.field}>
          <label className={css.fieldLabel} htmlFor="schedule-at">{t('scheduleAt')}</label>
          <input
            id="schedule-at"
            className={css.input}
            type="datetime-local"
            value={schedule.at}
            onChange={(event) => { onSchedule({ ...schedule, at: event.currentTarget.value }) }}
          />
        </div>
      ) : null}
      {kind === 'after' ? (
        <div className={css.field}>
          <label className={css.fieldLabel} htmlFor="schedule-after">{t('scheduleAfter')}</label>
          <input
            id="schedule-after"
            className={css.input}
            type="number"
            min={1}
            value={schedule.after}
            onChange={(event) => { onSchedule({ ...schedule, after: event.currentTarget.value }) }}
          />
        </div>
      ) : null}
      {kind === 'every' ? (
        <div className={css.field}>
          <label className={css.fieldLabel} htmlFor="schedule-every">{t('scheduleEvery')}</label>
          <input
            id="schedule-every"
            className={css.input}
            type="number"
            min={1}
            value={schedule.every}
            onChange={(event) => { onSchedule({ ...schedule, every: event.currentTarget.value }) }}
          />
        </div>
      ) : null}
      {kind === 'rrule' ? (
        <>
          <div className={css.field}>
            <label className={css.fieldLabel} htmlFor="schedule-rrule">{t('scheduleRrule')}</label>
            <textarea
              id="schedule-rrule"
              className={css.textarea}
              value={schedule.rrule}
              onChange={(event) => { onSchedule({ ...schedule, rrule: event.currentTarget.value }) }}
            />
          </div>
          <div className={css.field}>
            <label className={css.fieldLabel} htmlFor="schedule-zone">{t('timeZone')}</label>
            <input
              id="schedule-zone"
              className={css.input}
              value={schedule.timeZone}
              onChange={(event) => { onSchedule({ ...schedule, timeZone: event.currentTarget.value }) }}
            />
          </div>
        </>
      ) : null}
    </>
  )
}

function scheduleFromForm(
  kind: 'at' | 'after' | 'every' | 'rrule',
  fields: { at: string; after: string; every: string; rrule: string; timeZone: string },
): TimerDraft {
  switch (kind) {
    case 'at':
      return { name: '', content: '', at: (fields.at === '' ? new Date() : new Date(fields.at)).toISOString() }
    case 'after':
      return { name: '', content: '', afterSeconds: Number(fields.after) }
    case 'every':
      return { name: '', content: '', everySeconds: Number(fields.every) }
    case 'rrule':
      return { name: '', content: '', rrule: fields.rrule, timeZone: fields.timeZone || 'UTC' }
  }
}

/** Convert an instant to a `datetime-local` value in the browser's zone. */
function toLocalInput(at: number): string {
  return new Date(at - new Date(at).getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
}

interface TimerFormInitial {
  readonly name: string
  readonly content: string
  readonly wake: boolean
  readonly schedule: TimerSchedule
}

function initialTimerForm(initial: TimerFormInitial | undefined): {
  kind: 'at' | 'after' | 'every' | 'rrule'
  fields: { at: string; after: string; every: string; rrule: string; timeZone: string }
} {
  const schedule = initial?.schedule
  if (schedule?.kind === 'once') {
    return {
      kind: 'at',
      fields: { at: toLocalInput(schedule.at), after: '60', every: '60', rrule: 'FREQ=DAILY', timeZone: 'UTC' },
    }
  }
  if (schedule?.kind === 'seconds') {
    return {
      kind: 'every',
      fields: { at: '', after: '60', every: String(schedule.everySeconds), rrule: 'FREQ=DAILY', timeZone: 'UTC' },
    }
  }
  if (schedule?.kind === 'rrule') {
    return {
      kind: 'rrule',
      fields: {
        at: '', after: '60', every: '60', rrule: schedule.rrule, timeZone: schedule.timeZone ?? 'UTC',
      },
    }
  }
  return {
    kind: 'after',
    fields: {
      at: '',
      after: String(Math.max(1, Math.round((schedule?.kind === 'after' ? schedule.afterMs : 60_000) / 1000))),
      every: '60',
      rrule: 'FREQ=DAILY',
      timeZone: 'UTC',
    },
  }
}

/** Timer creation/edit form shared by 定时器 and 预设. */
function TimerForm({
  t, submitLabel, withName, initial, onCancel, onSubmit,
}: {
  readonly t: T
  readonly submitLabel: string
  readonly withName: boolean
  readonly initial?: TimerFormInitial | undefined
  readonly onCancel: () => void
  readonly onSubmit: (draft: TimerDraft) => void
}): ReactNode {
  const start = initialTimerForm(initial)
  const [name, setName] = useState(initial?.name ?? '')
  const [content, setContent] = useState(initial?.content ?? '')
  const [wake, setWake] = useState(initial?.wake ?? true)
  const [kind, setKind] = useState<'at' | 'after' | 'every' | 'rrule'>(start.kind)
  const [schedule, setSchedule] = useState(start.fields)
  return (
    <form
      className={css.form}
      onSubmit={(event) => {
        event.preventDefault()
        const base = scheduleFromForm(kind, schedule)
        onSubmit({ ...base, name, content, wake })
      }}
    >
      {withName ? (
        <div className={css.field}>
          <label className={css.fieldLabel} htmlFor="timer-name">{t('timerName')}</label>
          <input id="timer-name" className={css.input} value={name} required onChange={(event) => { setName(event.currentTarget.value) }} />
        </div>
      ) : null}
      <div className={css.field}>
        <label className={css.fieldLabel} htmlFor="timer-content">{t('timerContent')}</label>
        <textarea id="timer-content" className={css.textarea} required value={content} onChange={(event) => { setContent(event.currentTarget.value) }} />
      </div>
      <ScheduleFields t={t} kind={kind} onKind={setKind} schedule={schedule} onSchedule={setSchedule} />
      <label className={css.inlineLabel}>
        <input type="checkbox" checked={wake} onChange={(event) => { setWake(event.currentTarget.checked) }} />
        {t('wakeLabel')}
      </label>
      <div className={css.formActions}>
        <button type="submit" className={css.secondary}>{submitLabel}</button>
        <button type="button" className={css.secondary} onClick={onCancel}>{t('cancel')}</button>
      </div>
    </form>
  )
}

/** Rule creation form. */
function RuleForm({
  t, initial, onCancel, onSubmit,
}: {
  readonly t: T
  readonly initial?: EventRule | undefined
  readonly onCancel: () => void
  readonly onSubmit: (draft: EventRuleDraft) => void
}): ReactNode {
  const supported = initial?.trigger.kind === 'internal' || initial?.trigger.kind === 'time'
    || initial?.trigger.kind === 'absence' || initial?.trigger.kind === 'webhook'
    || initial?.trigger.kind === 'http-poll'
  const initialTrigger = supported ? initial?.trigger : undefined
  const initialSchedule = initialTrigger?.kind === 'time' ? initialTrigger.schedule : undefined
  const timer = initialTimerForm(initialSchedule === undefined ? undefined : {
    name: '', content: '', wake: true, schedule: initialSchedule,
  })
  const [name, setName] = useState(initial?.name ?? '')
  const [triggerKind, setTriggerKind] = useState<'internal' | 'time' | 'absence' | 'webhook' | 'http-poll'>(
    initialTrigger?.kind === 'time' || initialTrigger?.kind === 'absence' || initialTrigger?.kind === 'webhook'
      || initialTrigger?.kind === 'http-poll'
      ? initialTrigger.kind
      : 'internal',
  )
  const [internalEvent, setInternalEvent] = useState<InternalEventName>(
    initialTrigger?.kind === 'internal' ? initialTrigger.event : 'turn/start',
  )
  const [kind, setKind] = useState<'at' | 'after' | 'every' | 'rrule'>(timer.kind)
  const [schedule, setSchedule] = useState(timer.fields)
  const [absenceKinds, setAbsenceKinds] = useState(
    initialTrigger?.kind === 'absence' ? initialTrigger.kinds.join(', ') : '*',
  )
  const [quiet, setQuiet] = useState(
    initialTrigger?.kind === 'absence' ? String(Math.max(1, Math.round(initialTrigger.quietMs / 1000))) : '300',
  )
  const [url, setUrl] = useState(initialTrigger?.kind === 'http-poll' ? initialTrigger.url : '')
  const [interval, setIntervalSeconds] = useState(
    initialTrigger?.kind === 'http-poll' ? String(Math.max(1, Math.round(initialTrigger.intervalMs / 1000))) : '60',
  )
  const [secret, setSecret] = useState('')
  const [content, setContent] = useState(initial?.contentTemplate ?? '')
  const [where, setWhere] = useState(initial === undefined || initial.where.length === 0 ? '' : JSON.stringify(initial.where))
  const [script, setScript] = useState(initial?.script?.source ?? '')
  const [wake, setWake] = useState(initial?.wake ?? true)
  const [error, setError] = useState<string | undefined>(undefined)
  const submit = (event: { preventDefault(): void }): void => {
    event.preventDefault()
    let trigger: RuleTrigger
    if (triggerKind === 'internal') trigger = { kind: 'internal', event: internalEvent as InternalEventName }
    else if (triggerKind === 'time') trigger = { kind: 'time', schedule: normalizeRuleSchedule(kind, schedule) }
    else if (triggerKind === 'absence') trigger = { kind: 'absence', kinds: absenceKinds.split(',').map(part => part.trim()).filter(Boolean), quietMs: Number(quiet) * 1000 }
    else if (triggerKind === 'webhook') trigger = { kind: 'webhook' }
    else trigger = { kind: 'http-poll', url, intervalMs: Number(interval) * 1000 }
    let conditions: EventRuleDraft['where']
    if (where.trim() !== '') {
      try {
        const parsed: unknown = JSON.parse(where)
        if (!Array.isArray(parsed)) throw new Error('not an array')
        conditions = parsed as EventRuleDraft['where']
      } catch {
        setError(t('errorRule'))
        return
      }
    }
    onSubmit({
      name,
      trigger,
      contentTemplate: content,
      ...(conditions === undefined ? {} : { where: conditions }),
      ...(script.trim() === '' ? {} : { script: { source: script } }),
      wake,
      ...(triggerKind === 'webhook' && secret !== '' ? { webhookSecret: secret } : {}),
    })
  }
  return (
    <form className={css.form} onSubmit={submit}>
      <div className={css.field}>
        <label className={css.fieldLabel} htmlFor="rule-name">{t('ruleName')}</label>
        <input id="rule-name" className={css.input} required value={name} onChange={(event) => { setName(event.currentTarget.value) }} />
      </div>
      <div className={css.field}>
        <label className={css.fieldLabel} htmlFor="rule-trigger">{t('ruleTrigger')}</label>
        <select id="rule-trigger" className={css.select} value={triggerKind} onChange={(event) => { setTriggerKind(event.currentTarget.value as typeof triggerKind) }}>
          <option value="internal">{t('triggerInternal')}</option>
          <option value="time">{t('triggerTime')}</option>
          <option value="absence">{t('triggerAbsence')}</option>
          <option value="webhook">{t('triggerWebhook')}</option>
          <option value="http-poll">{t('triggerHttpPoll')}</option>
        </select>
      </div>
      {triggerKind === 'internal' ? (
        <div className={css.field}>
          <label className={css.fieldLabel} htmlFor="rule-event">{t('internalEvent')}</label>
          <select id="rule-event" className={css.select} value={internalEvent} onChange={(event) => { setInternalEvent(event.currentTarget.value as InternalEventName) }}>
            <option value="session/event">session/event</option>
            <option value="tool/call">tool/call</option>
            <option value="tool/result">tool/result</option>
            <option value="turn/start">turn/start</option>
            <option value="turn/end">turn/end</option>
            <option value="job/registered">job/registered</option>
            <option value="job/settled">job/settled</option>
            <option value="subagent/start">subagent/start</option>
            <option value="subagent/end">subagent/end</option>
          </select>
        </div>
      ) : null}
      {triggerKind === 'time' ? (
        <ScheduleFields t={t} kind={kind} onKind={setKind} schedule={schedule} onSchedule={setSchedule} />
      ) : null}
      {triggerKind === 'absence' ? (
        <>
          <div className={css.field}>
            <label className={css.fieldLabel} htmlFor="rule-kinds">{t('absenceKinds')}</label>
            <input id="rule-kinds" className={css.input} value={absenceKinds} onChange={(event) => { setAbsenceKinds(event.currentTarget.value) }} />
          </div>
          <div className={css.field}>
            <label className={css.fieldLabel} htmlFor="rule-quiet">{t('quietSeconds')}</label>
            <input id="rule-quiet" className={css.input} type="number" min={1} value={quiet} onChange={(event) => { setQuiet(event.currentTarget.value) }} />
          </div>
        </>
      ) : null}
      {triggerKind === 'webhook' ? (
        <div className={css.field}>
          <label className={css.fieldLabel} htmlFor="rule-secret">{t('webhookSecret')}</label>
          <input
            id="rule-secret"
            className={css.input}
            type="password"
            required={initial?.trigger.kind !== 'webhook'}
            value={secret}
            onChange={(event) => { setSecret(event.currentTarget.value) }}
          />
        </div>
      ) : null}
      {triggerKind === 'http-poll' ? (
        <>
          <div className={css.field}>
            <label className={css.fieldLabel} htmlFor="rule-url">{t('pollUrl')}</label>
            <input id="rule-url" className={css.input} required value={url} onChange={(event) => { setUrl(event.currentTarget.value) }} />
          </div>
          <div className={css.field}>
            <label className={css.fieldLabel} htmlFor="rule-interval">{t('pollInterval')}</label>
            <input id="rule-interval" className={css.input} type="number" min={1} value={interval} onChange={(event) => { setIntervalSeconds(event.currentTarget.value) }} />
          </div>
        </>
      ) : null}
      <div className={css.field}>
        <label className={css.fieldLabel} htmlFor="rule-content">{t('contentTemplate')}</label>
        <textarea id="rule-content" className={css.textarea} required value={content} onChange={(event) => { setContent(event.currentTarget.value) }} />
        <p className={css.hint}>{t('contentTemplateHint')}</p>
      </div>
      <div className={css.field}>
        <label className={css.fieldLabel} htmlFor="rule-where">{t('whereJson')}</label>
        <textarea id="rule-where" className={css.textarea} value={where} placeholder={t('whereHint')} onChange={(event) => { setWhere(event.currentTarget.value) }} />
      </div>
      <div className={css.field}>
        <label className={css.fieldLabel} htmlFor="rule-script">{t('scriptSource')}</label>
        <textarea id="rule-script" className={css.textarea} value={script} onChange={(event) => { setScript(event.currentTarget.value) }} />
        <p className={css.hint}>{t('scriptHint')}</p>
      </div>
      <label className={css.inlineLabel}>
        <input type="checkbox" checked={wake} onChange={(event) => { setWake(event.currentTarget.checked) }} />
        {t('wakeLabel')}
      </label>
      {error === undefined ? null : <p className={css.failure} role="alert">{error}</p>}
      <div className={css.formActions}>
        <button type="submit" className={css.secondary}>{t('submit')}</button>
        <button type="button" className={css.secondary} onClick={onCancel}>{t('cancel')}</button>
      </div>
    </form>
  )
}

/** Inline absence edit form. */
function AbsenceEditForm({
  t, absence, onCancel, onSubmit,
}: {
  readonly t: T
  readonly absence: AbsenceTimer
  readonly onCancel: () => void
  readonly onSubmit: (draft: AbsenceDraft) => void
}): ReactNode {
  const [kinds, setKinds] = useState(absence.kinds.join(', '))
  const [quietSeconds, setQuietSeconds] = useState(String(Math.max(1, Math.round(absence.quietMs / 1000))))
  return (
    <form
      className={css.form}
      onSubmit={(event) => {
        event.preventDefault()
        onSubmit({
          ...(absence.name === undefined ? {} : { name: absence.name }),
          kinds: kinds.split(',').map(part => part.trim()).filter(Boolean),
          quietMs: Number(quietSeconds) * 1000,
        })
      }}
    >
      <div className={css.field}>
        <label className={css.fieldLabel} htmlFor={`absence-edit-kinds-${absence.id}`}>{t('absenceKinds')}</label>
        <input
          id={`absence-edit-kinds-${absence.id}`}
          className={css.input}
          value={kinds}
          onChange={(event) => { setKinds(event.currentTarget.value) }}
        />
      </div>
      <div className={css.field}>
        <label className={css.fieldLabel} htmlFor={`absence-edit-quiet-${absence.id}`}>{t('quietSeconds')}</label>
        <input
          id={`absence-edit-quiet-${absence.id}`}
          className={css.input}
          type="number"
          min={1}
          value={quietSeconds}
          onChange={(event) => { setQuietSeconds(event.currentTarget.value) }}
        />
      </div>
      <div className={css.formActions}>
        <button type="submit" className={css.secondary}>{t('save')}</button>
        <button type="button" className={css.secondary} onClick={onCancel}>{t('cancel')}</button>
      </div>
    </form>
  )
}

function normalizeRuleSchedule(
  kind: 'at' | 'after' | 'every' | 'rrule',
  fields: { at: string; after: string; every: string; rrule: string; timeZone: string },
): TimerSchedule {
  switch (kind) {
    case 'at': return { kind: 'once', at: Date.parse(fields.at) }
    case 'after': return { kind: 'after', afterMs: Number(fields.after) * 1000 }
    case 'every': return { kind: 'seconds', everySeconds: Number(fields.every) }
    case 'rrule': return { kind: 'rrule', rrule: fields.rrule, timeZone: fields.timeZone || 'UTC' }
  }
}

/** Render the 事件 view: subscriptions, parameters, and custom rules. */
export function EventsView({
  t, pending, failure, snapshot, sessionId, draft, pendingKind,
  onToggle, onParams, onSubscribeFuture, onRuleCreate, onRuleUpdate, onRuleTest, onRulePause, onRuleCancel, ruleResult,
}: EventsViewProps): ReactNode {
  const [creating, setCreating] = useState(false)
  const [editingRule, setEditingRule] = useState<EventRule | undefined>(undefined)
  const rules = snapshot.rules ?? []
  return (
    <ViewShell t={t} pending={pending || pendingKind !== undefined} failure={failure}>
      <div className={css.page} data-context-gate-panel>
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
              onParams={onParams}
              onSubscribeFuture={onSubscribeFuture}
            />
          ))}
        </ul>

        <section className={css.section}>
          <h2 className={css.sectionTitle}>{t('rulesTitle')}</h2>
          <p className={css.hint}>{t('rulesHint')}</p>
          {rules.length === 0 ? <p className={css.hint}>{t('emptyRules')}</p> : null}
          <ul className={css.contextList}>
            {rules.map(rule => (
              <li key={rule.id} className={css.contextRow} data-rule-id={rule.id} data-enabled={rule.enabled}>
                <span className={css.badgeRow}>
                  <span className={css.contextName}>{rule.name}</span>
                  <span className={rule.enabled ? css.badgeOk : css.badgeMuted}>
                    {rule.enabled ? t('ruleEnabled') : t('rulePaused')}
                  </span>
                  <span className={css.badgeMuted}>{t('ruleFireCount', { count: String(rule.fireCount) })}</span>
                </span>
                <p className={css.contextDescription}>{triggerText(t, rule.trigger)}</p>
                <span className={css.badgeRow}>
                  {rule.nextDueAt === undefined ? null : (
                    <span className={css.badgeMuted}>{t('ruleNextDue', { time: new Date(rule.nextDueAt).toISOString() })}</span>
                  )}
                  <code className={css.contextId}>{t('ruleGeneratedKind', { kind: `agent.script.${rule.id.replaceAll('-', '').toLowerCase()}` })}</code>
                </span>
                {rule.lastError === undefined ? null : <p className={css.failure}>{rule.lastError}</p>}
                {ruleResult?.id === rule.id ? <p className={css.notice}>{t('ruleTestResult', { detail: ruleResult.detail })}</p> : null}
                {rule.trigger.kind === 'composite' ? (
                  <p className={css.hint}>{t('editCompositeUnavailable')}</p>
                ) : null}
                <span className={css.formActions}>
                  {rule.trigger.kind === 'composite' ? null : (
                    <button type="button" className={css.secondary} disabled={pending} onClick={() => { setEditingRule(rule) }}>{t('edit')}</button>
                  )}
                  <button type="button" className={css.secondary} disabled={pending} onClick={() => { onRuleTest(rule.id) }}>{t('ruleTest')}</button>
                  <button type="button" className={css.secondary} disabled={pending} onClick={() => { onRulePause(rule.id, rule.enabled) }}>
                    {rule.enabled ? t('rulePause') : t('ruleResume')}
                  </button>
                  <button type="button" className={css.secondary} disabled={pending} onClick={() => { onRuleCancel(rule.id) }}>{t('ruleCancel')}</button>
                </span>
              </li>
            ))}
          </ul>
          {editingRule === undefined ? null : (
            <RuleForm
              key={editingRule.id}
              t={t}
              initial={editingRule}
              onCancel={() => { setEditingRule(undefined) }}
              onSubmit={(draftRule) => {
                const previous = editingRule
                setEditingRule(undefined)
                onRuleUpdate(previous.id, draftRule, previous)
              }}
            />
          )}
          {creating ? (
            <RuleForm
              t={t}
              onCancel={() => { setCreating(false) }}
              onSubmit={(draftRule) => { setCreating(false); onRuleCreate(draftRule) }}
            />
          ) : (
            <button type="button" className={css.secondary} onClick={() => { setCreating(true) }}>{t('ruleCreate')}</button>
          )}
        </section>
      </div>
    </ViewShell>
  )
}

/** Props of the 定时 view. */
export interface TimersViewProps extends ViewShellProps {
  readonly snapshot: TimerSnapshot
  readonly onCreateTimer: (draft: TimerDraft) => void
  readonly onUpdateTimer: (id: string, draft: TimerDraft) => void
  readonly onPauseTimer: (id: string, paused: boolean) => void
  readonly onCancelTimer: (id: string) => void
  readonly onCreatePreset: (draft: TimerDraft) => void
  readonly onUpdatePreset: (presetId: string, draft: TimerDraft) => void
  readonly onAdoptPreset: (presetId: string) => void
  readonly onDeletePreset: (presetId: string) => void
  readonly onCreateAbsence: (draft: AbsenceDraft) => void
  readonly onUpdateAbsence: (id: string, draft: AbsenceDraft) => void
  readonly onCancelAbsence: (id: string) => void
}

function timerTitle(t: T, timer: TimerInstance): string {
  return `${timer.name}${timer.enabled ? '' : t('disabledSuffix')}`
}

/** Render the 定时 view: timers, presets, and absence reminders. */
export function TimersView({
  t, pending, failure, snapshot, onCreateTimer, onUpdateTimer, onPauseTimer, onCancelTimer,
  onCreatePreset, onUpdatePreset, onAdoptPreset, onDeletePreset, onCreateAbsence, onUpdateAbsence, onCancelAbsence,
}: TimersViewProps): ReactNode {
  const [creatingTimer, setCreatingTimer] = useState(false)
  const [editingTimer, setEditingTimer] = useState<string | undefined>(undefined)
  const [creatingPreset, setCreatingPreset] = useState(false)
  const [editingPreset, setEditingPreset] = useState<string | undefined>(undefined)
  const [editingAbsence, setEditingAbsence] = useState<string | undefined>(undefined)
  const [absenceKinds, setAbsenceKinds] = useState('*')
  const [quiet, setQuiet] = useState('300')
  return (
    <ViewShell t={t} pending={pending} failure={failure}>
      <div className={css.page} data-context-gate-panel>
        <section className={css.section}>
          <h2 className={css.sectionTitle}>{t('timersTitle')}</h2>
          <p className={css.hint}>{t('timersHint')}</p>
          {snapshot.timers.length === 0 ? <p className={css.hint}>{t('emptyTimers')}</p> : null}
          <ul className={css.contextList}>
            {snapshot.timers.map(timer => (
              <li key={timer.id} className={css.contextRow} data-timer-id={timer.id} data-enabled={timer.enabled}>
                <span className={css.badgeRow}>
                  <span className={css.contextName}>{timerTitle(t, timer)}</span>
                  <span className={timer.enabled ? css.badgeOk : css.badgeMuted}>
                    {timer.nextDueAt === null
                      ? t('timerFinished')
                      : t('timerNextDue', { time: new Date(timer.nextDueAt).toISOString() })}
                  </span>
                  <span className={css.badgeMuted}>{scheduleText(t, timer.schedule)}</span>
                </span>
                <p className={css.contextDescription}>{timer.content}</p>
                <span className={css.formActions}>
                  <button type="button" className={css.secondary} disabled={pending} onClick={() => { setEditingTimer(timer.id) }}>{t('edit')}</button>
                  <button type="button" className={css.secondary} disabled={pending} onClick={() => { onPauseTimer(timer.id, timer.enabled) }}>
                    {timer.enabled ? t('timerPause') : t('timerResume')}
                  </button>
                  <button type="button" className={css.secondary} disabled={pending} onClick={() => { onCancelTimer(timer.id) }}>{t('timerCancel')}</button>
                </span>
                {editingTimer === timer.id ? (
                  <TimerForm
                    t={t}
                    submitLabel={t('save')}
                    withName
                    initial={{ name: timer.name, content: timer.content, wake: timer.wake, schedule: timer.schedule }}
                    onCancel={() => { setEditingTimer(undefined) }}
                    onSubmit={(draft) => { setEditingTimer(undefined); onUpdateTimer(timer.id, draft) }}
                  />
                ) : null}
              </li>
            ))}
          </ul>
          {creatingTimer ? (
            <TimerForm
              t={t}
              submitLabel={t('timerCreate')}
              withName
              onCancel={() => { setCreatingTimer(false) }}
              onSubmit={(draft) => { setCreatingTimer(false); onCreateTimer(draft) }}
            />
          ) : (
            <button type="button" className={css.secondary} onClick={() => { setCreatingTimer(true) }}>{t('timerCreate')}</button>
          )}
        </section>

        <section className={css.section}>
          <h2 className={css.sectionTitle}>{t('presetsTitle')}</h2>
          <p className={css.hint}>{t('presetsHint')}</p>
          {snapshot.presets.length === 0 ? <p className={css.hint}>{t('emptyPresets')}</p> : null}
          <ul className={css.contextList}>
            {snapshot.presets.map((preset: TimerPreset) => (
              <li key={preset.id} className={css.contextRow} data-preset-id={preset.id}>
                <span className={css.badgeRow}>
                  <span className={css.contextName}>{preset.name}</span>
                  <span className={css.badgeMuted}>{scheduleText(t, preset.schedule)}</span>
                </span>
                <p className={css.contextDescription}>{preset.content}</p>
                <span className={css.formActions}>
                  <button type="button" className={css.secondary} disabled={pending} onClick={() => { setEditingPreset(preset.id) }}>{t('edit')}</button>
                  <button type="button" className={css.secondary} disabled={pending} onClick={() => { onAdoptPreset(preset.id) }}>{t('presetAdopt')}</button>
                  <button type="button" className={css.secondary} disabled={pending} onClick={() => { onDeletePreset(preset.id) }}>{t('presetDelete')}</button>
                </span>
                {editingPreset === preset.id ? (
                  <TimerForm
                    t={t}
                    submitLabel={t('save')}
                    withName
                    initial={{ name: preset.name, content: preset.content, wake: preset.wake, schedule: preset.schedule }}
                    onCancel={() => { setEditingPreset(undefined) }}
                    onSubmit={(draft) => { setEditingPreset(undefined); onUpdatePreset(preset.id, draft) }}
                  />
                ) : null}
              </li>
            ))}
          </ul>
          {creatingPreset ? (
            <TimerForm
              t={t}
              submitLabel={t('presetCreate')}
              withName
              onCancel={() => { setCreatingPreset(false) }}
              onSubmit={(draft) => { setCreatingPreset(false); onCreatePreset(draft) }}
            />
          ) : (
            <button type="button" className={css.secondary} onClick={() => { setCreatingPreset(true) }}>{t('presetCreate')}</button>
          )}
        </section>

        <section className={css.section}>
          <h2 className={css.sectionTitle}>{t('absenceTitle')}</h2>
          <p className={css.hint}>{t('absenceHint')}</p>
          {snapshot.absences.length === 0 ? <p className={css.hint}>{t('emptyAbsences')}</p> : null}
          <ul className={css.contextList}>
            {snapshot.absences.map((absence: AbsenceTimer) => (
              <li key={absence.id} className={css.contextRow} data-absence-id={absence.id} data-fired={absence.fired}>
                <span className={css.badgeRow}>
                  <span className={css.contextName}>{absence.name ?? absence.kinds.join(' / ')}</span>
                  <span className={absence.fired ? css.badgeError : css.badgeMuted}>
                    {absence.fired ? t('absenceFired') : t('absenceArmed')}
                  </span>
                  <span className={css.badgeMuted}>{t('absenceLastSeen', { time: new Date(absence.lastSeenAt).toISOString() })}</span>
                </span>
                <p className={css.contextDescription}>{absence.kinds.join(' / ')} · {String(Math.round(absence.quietMs / 1000))}s</p>
                <span className={css.formActions}>
                  <button type="button" className={css.secondary} disabled={pending} onClick={() => { setEditingAbsence(absence.id) }}>{t('edit')}</button>
                  <button type="button" className={css.secondary} disabled={pending} onClick={() => { onCancelAbsence(absence.id) }}>{t('absenceCancel')}</button>
                </span>
                {editingAbsence === absence.id ? (
                  <AbsenceEditForm
                    t={t}
                    absence={absence}
                    onCancel={() => { setEditingAbsence(undefined) }}
                    onSubmit={(draft) => { setEditingAbsence(undefined); onUpdateAbsence(absence.id, draft) }}
                  />
                ) : null}
              </li>
            ))}
          </ul>
          <form
            className={css.form}
            onSubmit={(event) => {
              event.preventDefault()
              onCreateAbsence({
                kinds: absenceKinds.split(',').map(part => part.trim()).filter(Boolean),
                quietMs: Number(quiet) * 1000,
              })
            }}
          >
            <div className={css.field}>
              <label className={css.fieldLabel} htmlFor="absence-kinds">{t('absenceKinds')}</label>
              <input id="absence-kinds" className={css.input} value={absenceKinds} onChange={(event) => { setAbsenceKinds(event.currentTarget.value) }} />
            </div>
            <div className={css.field}>
              <label className={css.fieldLabel} htmlFor="absence-quiet">{t('quietSeconds')}</label>
              <input id="absence-quiet" className={css.input} type="number" min={1} value={quiet} onChange={(event) => { setQuiet(event.currentTarget.value) }} />
            </div>
            <div className={css.formActions}>
              <button type="submit" className={css.secondary}>{t('absenceCreate')}</button>
            </div>
          </form>
        </section>
      </div>
    </ViewShell>
  )
}

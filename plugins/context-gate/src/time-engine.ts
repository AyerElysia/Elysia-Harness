/**
 * The ContextGate time engine.
 *
 * It owns per-session timer instances, reusable timer presets, absence
 * watchers, and the recurrence arithmetic they share with custom-event rules.
 * It does not import the native DSH Schedule: recurring expressions use the
 * vendored general RRULE/Temporal wrapper (`@deepseek-ai/dsh-util-time`), and
 * the firing loop belongs to this plugin.
 *
 * Timers inject into their owner only. They are not subscribable kinds, and a
 * timer fire never feeds the absence `lastSeen` map.
 *
 * @module @elysia/context-gate/time-engine
 */

import { randomUUID } from 'node:crypto'
import { RRule, canonicalizeTimeZone } from '@deepseek-ai/dsh-util-time'
import type {
  AbsenceDraft, AbsencePatch, AbsenceTimer, EventRule, TimerDraft, TimerInstance, TimerPatch, TimerPreset,
  TimerSchedule, TimerSnapshot,
} from './types.ts'
import { ABSENCE_EVENT_KIND, ABSENCE_SOURCE, MAX_TIMER_SECONDS, MIN_TIMER_SECONDS, TIMER_EVENT_KIND, TIMER_SOURCE } from './constants.ts'
import type { ContextGateStore } from './state.ts'
import type { DirectEventInput } from './context-bus.ts'
import { ContextGateError, describeError } from './errors.ts'

/** Limits and timing the time engine observes. */
export interface TimeEngineOptions {
  /** Persisted timers, presets, absence watchers, and last-seen map. */
  readonly store: ContextGateStore
  /** Owner-only injection used by timers and absence watchers. */
  readonly deliver: (sessionId: string, input: DirectEventInput) => Promise<void>
  /** Diagnostics sink. */
  readonly onError: (message: string) => void
  /** Maximum timer instances one session may own. */
  readonly maxTimersPerSession: number
  /** Maximum presets in the shared library. */
  readonly maxPresets: number
  /** Maximum absence watchers one session may own. */
  readonly maxAbsencesPerSession: number
}

/** One computed schedule state at a point in time. */
export interface ScheduleState {
  /** Latest due occurrence at or before the decision, when one exists. */
  readonly dueAt: number | null
  /** First future occurrence, or null when the schedule is exhausted. */
  readonly nextDueAt: number | null
  /** Number of skipped occurrences collapsed into the single due firing. */
  readonly missed: number
}

function invalid(message: string, details?: Readonly<Record<string, unknown>>): ContextGateError {
  return new ContextGateError('TIMER_INVALID', message, details)
}

function positiveNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw invalid(`${label} must be a positive finite number`)
  }
  return value
}

/**
 * Format one instant as the basic local wall time an RRULE DTSTART needs.
 * @param epoch - instant in milliseconds.
 * @param timeZone - canonical IANA zone or UTC.
 * @returns `YYYYMMDDTHHMMSS`.
 */
function basicLocal(epoch: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(epoch))
  const pick = (type: string): string => parts.find(part => part.type === type)?.value ?? ''
  return `${pick('year')}${pick('month')}${pick('day')}T${pick('hour')}${pick('minute')}${pick('second')}`
}

/**
 * Validate an IANA zone or UTC.
 * @param value - caller-supplied zone.
 * @returns the canonical zone.
 */
function canonicalZone(value: string): string {
  const result = canonicalizeTimeZone(value)
  if (result.kind === 'rejected') {
    throw invalid(`time zone ${JSON.stringify(value)} is not a supported IANA zone`, { timeZone: value, reason: result.reason })
  }
  return result.timeZone
}

/**
 * Complete a bare RRULE line with a DTSTART in its zone.
 * @param expression - two-line DTSTART/RRULE text or one RRULE line.
 * @param timeZone - zone used when DTSTART is absent.
 * @param anchor - instant the generated DTSTART uses.
 * @returns the complete two-line expression.
 */
export function rruleExpression(expression: string, timeZone: string, anchor: number): string {
  const text = expression.trim()
  if (text === '') throw invalid('rrule must not be blank')
  if (text.startsWith('DTSTART')) return text
  const zone = canonicalZone(timeZone)
  const rule = text.startsWith('RRULE:') ? text : `RRULE:${text}`
  if (!rule.startsWith('RRULE:') || rule.length <= 'RRULE:'.length) throw invalid('rrule must contain an RRULE line')
  const start = zone === 'UTC'
    ? `DTSTART:${new Date(anchor).toISOString().replaceAll('-', '').replaceAll(':', '').slice(0, 15)}Z`
    : `DTSTART;TZID=${zone}:${basicLocal(anchor, zone)}`
  return `${start}\n${rule}`
}

/**
 * Parse and validate one recurrence expression.
 * @param expression - two-line or bare RRULE text.
 * @param timeZone - zone used when DTSTART is absent.
 * @param anchor - instant used by a generated DTSTART.
 * @returns the parsed rule.
 */
export function parseRRule(expression: string, timeZone: string, anchor: number): RRule {
  const complete = rruleExpression(expression, timeZone, anchor)
  const result = RRule.parse(complete)
  if (result.kind === 'rejected') {
    throw invalid(`rrule is not usable: ${result.detail}`, { reason: result.reason })
  }
  return result.rule
}

/**
 * Validate and normalize one timer schedule from caller fields.
 * @param schedule - persisted schedule candidate.
 * @returns the normalized schedule.
 */
export function normalizeSchedule(schedule: TimerSchedule): TimerSchedule {
  switch (schedule.kind) {
    case 'once': {
      const at = positiveNumber(schedule.at, 'schedule.at')
      return { kind: 'once', at }
    }
    case 'after': {
      const afterMs = positiveNumber(schedule.afterMs, 'schedule.afterMs')
      return { kind: 'after', afterMs }
    }
    case 'rrule': {
      const anchor = Date.now()
      parseRRule(schedule.rrule, schedule.timeZone ?? 'UTC', anchor)
      return {
        kind: 'rrule',
        rrule: schedule.rrule.trim(),
        ...(schedule.timeZone === undefined ? {} : { timeZone: canonicalZone(schedule.timeZone) }),
      }
    }
    case 'seconds': {
      const everySeconds = schedule.everySeconds
      if (!Number.isInteger(everySeconds) || everySeconds < MIN_TIMER_SECONDS || everySeconds > MAX_TIMER_SECONDS) {
        throw invalid(`schedule.everySeconds must be an integer from ${String(MIN_TIMER_SECONDS)} to ${String(MAX_TIMER_SECONDS)}`)
      }
      return { kind: 'seconds', everySeconds }
    }
    default:
      throw invalid('schedule.kind is not a timer schedule')
  }
}

/**
 * Compute the first firing at or after an anchor.
 * @param schedule - normalized schedule.
 * @param anchor - creation or update instant.
 * @returns first due instant, or null when exhausted.
 */
export function firstDue(schedule: TimerSchedule, anchor: number): number | null {
  switch (schedule.kind) {
    case 'once':
      return Math.max(schedule.at, anchor)
    case 'after':
      return anchor + schedule.afterMs
    case 'seconds':
      return anchor + schedule.everySeconds * 1000
    case 'rrule': {
      const rule = parseRRule(schedule.rrule, schedule.timeZone ?? 'UTC', anchor)
      const next = rule.next(anchor - 1)
      return next === undefined ? null : Date.parse(next)
    }
  }
}

/**
 * Compute the first firing strictly after one instant.
 * @param schedule - normalized schedule.
 * @param after - lower bound in milliseconds.
 * @param anchor - schedule anchor used by `seconds`.
 * @returns next due instant, or null when exhausted.
 */
export function nextAfter(schedule: TimerSchedule, after: number, anchor: number): number | null {
  switch (schedule.kind) {
    case 'once':
      return schedule.at > after ? schedule.at : null
    case 'after':
      return anchor + schedule.afterMs > after ? anchor + schedule.afterMs : null
    case 'seconds': {
      const interval = schedule.everySeconds * 1000
      if (anchor > after) return anchor
      return after + interval
    }
    case 'rrule': {
      const rule = parseRRule(schedule.rrule, schedule.timeZone ?? 'UTC', anchor)
      const next = rule.next(after)
      return next === undefined ? null : Date.parse(next)
    }
  }
}

/**
 * Resolve the latest due occurrence and the first future one.
 *
 * One missed run of a repeating schedule collapses into a single firing; the
 * count reports how many occurrences were skipped so the panel can explain it.
 * @param schedule - normalized schedule.
 * @param anchor - creation/update instant.
 * @param committed - previously scheduled instant, or null for a fresh timer.
 * @param now - decision instant.
 * @returns due and next instants.
 */
export function resolveSchedule(
  schedule: TimerSchedule,
  anchor: number,
  committed: number | null,
  now: number,
): ScheduleState {
  if (schedule.kind === 'once' || schedule.kind === 'after') {
    const target = schedule.kind === 'once' ? schedule.at : anchor + schedule.afterMs
    if (target > now) return { dueAt: null, nextDueAt: target, missed: 0 }
    return { dueAt: target, nextDueAt: null, missed: committed === null ? 0 : 1 }
  }
  if (schedule.kind === 'seconds') {
    const interval = schedule.everySeconds * 1000
    const base = committed ?? firstDue(schedule, anchor)
    if (base === null) return { dueAt: null, nextDueAt: null, missed: 0 }
    if (base > now) return { dueAt: null, nextDueAt: base, missed: 0 }
    const missed = Math.max(0, Math.floor((now - base) / interval))
    return { dueAt: base, nextDueAt: now + interval, missed }
  }
  const rule = parseRRule(schedule.rrule, schedule.timeZone ?? 'UTC', anchor)
  const base = committed ?? firstDue(schedule, anchor)
  if (base === null) return { dueAt: null, nextDueAt: null, missed: 0 }
  if (base > now) return { dueAt: null, nextDueAt: base, missed: 0 }
  const resolved = rule.resolve(new Date(base).toISOString(), now)
  const dueAt = Date.parse(resolved.occurrenceAt)
  const nextDueAt = resolved.nextScheduledAt === undefined ? null : Date.parse(resolved.nextScheduledAt)
  const span = nextDueAt === null ? now - base : nextDueAt - dueAt
  const missed = span <= 0 ? 0 : Math.max(0, Math.floor((now - dueAt) / span))
  return { dueAt, nextDueAt, missed }
}

/** The validating owner of timers, presets, and absence watchers. */
export class TimeEngine {
  private ticking = false
  private readonly options: TimeEngineOptions

  /** @param options - store, owner injection, limits, and diagnostics. */
  constructor(options: TimeEngineOptions) {
    this.options = options
  }

  /**
   * Rebuild every enabled timer's next due time and fire one catch-up round.
   * @param now - recovery instant.
   */
  async recover(now = Date.now()): Promise<void> {
    for (const timer of this.options.store.timers()) {
      if (!timer.enabled) continue
      try {
        const state = resolveSchedule(timer.schedule, anchorOf(timer), timer.nextDueAt, now)
        if (state.dueAt !== null) {
          await this.fire(timer, now, state.missed)
          continue
        }
        if (state.nextDueAt !== timer.nextDueAt) {
          await this.options.store.putTimer({ ...timer, nextDueAt: state.nextDueAt })
        }
      } catch (error: unknown) {
        await this.options.store.putTimer({ ...timer, lastError: describeError(error) })
        this.options.onError(`timer ${timer.id} recovery failed: ${describeError(error)}`)
      }
    }
    for (const absence of this.options.store.absences()) {
      if (!absence.enabled || absence.fired) continue
      await this.tickAbsence(absence, now)
    }
  }

  /**
   * Fire every due timer and absence watcher once.
   * @param now - decision instant.
   */
  async tick(now = Date.now()): Promise<void> {
    if (this.ticking) return
    this.ticking = true
    try {
      for (const timer of this.options.store.timers()) {
        if (!timer.enabled || timer.nextDueAt === null || timer.nextDueAt > now) continue
        try {
          const state = resolveSchedule(timer.schedule, anchorOf(timer), timer.nextDueAt, now)
          await this.fire(timer, now, state.dueAt === null ? 0 : state.missed)
        } catch (error: unknown) {
          const next = safeNext(timer, now)
          await this.options.store.putTimer({
            ...timer, lastError: describeError(error), nextDueAt: next,
          })
          this.options.onError(`timer ${timer.id} failed: ${describeError(error)}`)
        }
      }
      for (const absence of this.options.store.absences()) {
        if (!absence.enabled || absence.fired) continue
        await this.tickAbsence(absence, now)
      }
    } finally {
      this.ticking = false
    }
  }

  /**
   * Read one session's timer surface.
   * @param sessionId - owner session.
   * @returns owned timers, the shared preset library, and owned absence watchers.
   */
  snapshot(sessionId: string): TimerSnapshot {
    return {
      timers: this.options.store.timers().filter(timer => timer.ownerSessionId === sessionId),
      presets: this.options.store.presets(),
      absences: this.options.store.absences().filter(absence => absence.ownerSessionId === sessionId),
      now: Date.now(),
    }
  }

  /**
   * Create one timer owned by a session.
   * @param sessionId - owner session.
   * @param draft - name, content, and exactly one schedule field.
   * @returns the stored timer.
   * @throws ContextGateError `TIMER_INVALID` or `LIMIT_EXCEEDED`.
   */
  async createTimer(sessionId: string, draft: TimerDraft): Promise<TimerInstance> {
    const now = Date.now()
    return await this.createTimerWithSchedule(sessionId, draft, scheduleFromDraft(draft, now), now)
  }

  /**
   * Create one timer from an already-validated schedule.
   * @param sessionId - owner session.
   * @param draft - name, content, and wake choice.
   * @param schedule - validated schedule.
   * @param now - creation instant.
   * @returns the stored timer.
   */
  private async createTimerWithSchedule(
    sessionId: string,
    draft: TimerDraft,
    schedule: TimerSchedule,
    now: number,
    presetId?: string,
  ): Promise<TimerInstance> {
    const owned = this.options.store.timers().filter(timer => timer.ownerSessionId === sessionId)
    if (owned.length >= this.options.maxTimersPerSession) {
      throw new ContextGateError('LIMIT_EXCEEDED', `session ${JSON.stringify(sessionId)} already owns ${String(owned.length)} timers`, {
        sessionId, limit: this.options.maxTimersPerSession,
      })
    }
    const timer: TimerInstance = {
      id: randomUUID(),
      ownerSessionId: sessionId,
      ...(presetId === undefined ? {} : { presetId }),
      name: requireName(draft.name, 'timer'),
      schedule,
      content: requireContent(draft.content),
      wake: draft.wake ?? true,
      anchorAt: now,
      enabled: true,
      nextDueAt: firstDue(schedule, now),
      firedCount: 0,
      createdAt: now,
      updatedAt: now,
      ...(draft.expiresAt === undefined ? {} : { expiresAt: parseInstant(draft.expiresAt, 'expiresAt') }),
    }
    await this.options.store.putTimer(timer)
    return timer
  }

  /**
   * Change one timer owned by a session.
   * @param sessionId - owner session.
   * @param id - timer identity.
   * @param patch - fields to change; a schedule field replaces the schedule.
   * @returns the stored timer.
   */
  async updateTimer(sessionId: string, id: string, patch: TimerPatch): Promise<TimerInstance> {
    const timer = this.requireTimer(sessionId, id)
    const now = Date.now()
    const hasSchedule = patch.at !== undefined || patch.afterSeconds !== undefined
      || patch.rrule !== undefined || patch.everySeconds !== undefined
    const scheduleDraft: TimerDraft = {
      name: patch.name ?? timer.name,
      content: patch.content ?? timer.content,
      ...(patch.at === undefined ? {} : { at: patch.at }),
      ...(patch.afterSeconds === undefined ? {} : { afterSeconds: patch.afterSeconds }),
      ...(patch.rrule === undefined ? {} : { rrule: patch.rrule }),
      ...(patch.timeZone === undefined ? {} : { timeZone: patch.timeZone }),
      ...(patch.everySeconds === undefined ? {} : { everySeconds: patch.everySeconds }),
    }
    const schedule = hasSchedule ? scheduleFromDraft(scheduleDraft, now) : timer.schedule
    const enabled = patch.enabled ?? timer.enabled
    const resuming = enabled && !timer.enabled
    const anchorAt = hasSchedule || resuming ? now : timer.anchorAt
    const nextDueAt = !enabled
      ? timer.nextDueAt
      : hasSchedule || resuming
        ? firstDue(schedule, anchorAt)
        : timer.nextDueAt
    const expiresAt = patch.expiresAt === undefined
      ? timer.expiresAt
      : patch.expiresAt === null ? undefined : parseInstant(patch.expiresAt, 'expiresAt')
    const { expiresAt: _previousExpiresAt, ...base } = timer
    const next: TimerInstance = {
      ...base,
      ...(patch.name === undefined ? {} : { name: requireName(patch.name, 'timer') }),
      ...(patch.content === undefined ? {} : { content: requireContent(patch.content) }),
      ...(patch.wake === undefined ? {} : { wake: patch.wake }),
      enabled,
      schedule,
      anchorAt,
      nextDueAt,
      updatedAt: now,
      ...(expiresAt === undefined ? {} : { expiresAt }),
    }
    await this.options.store.putTimer(next)
    return next
  }

  /**
   * Pause or resume one timer.
   * @param sessionId - owner session.
   * @param id - timer identity.
   * @param enabled - false pauses.
   * @returns the stored timer.
   */
  async setTimerEnabled(sessionId: string, id: string, enabled: boolean): Promise<TimerInstance> {
    return await this.updateTimer(sessionId, id, { enabled })
  }

  /**
   * Remove one timer.
   * @param sessionId - owner session.
   * @param id - timer identity.
   */
  async cancelTimer(sessionId: string, id: string): Promise<void> {
    this.requireTimer(sessionId, id)
    await this.options.store.removeTimer(id)
  }

  /**
   * Create one reusable preset.
   * @param sessionId - creating session.
   * @param draft - template fields.
   * @returns the stored preset.
   */
  async createPreset(sessionId: string, draft: TimerDraft): Promise<TimerPreset> {
    if (this.options.store.presets().length >= this.options.maxPresets) {
      throw new ContextGateError('LIMIT_EXCEEDED', `the timer preset library already holds ${String(this.options.maxPresets)} presets`)
    }
    const now = Date.now()
    const preset: TimerPreset = {
      id: randomUUID(),
      ownerSessionId: sessionId,
      name: requireName(draft.name, 'timer preset'),
      schedule: scheduleFromDraft(draft, now),
      content: requireContent(draft.content),
      wake: draft.wake ?? true,
      createdAt: now,
      updatedAt: now,
    }
    await this.options.store.putPreset(preset)
    return preset
  }

  /**
   * Change one preset. Adopted instances keep their own content and schedule.
   * @param sessionId - session that owns or adopts the preset.
   * @param id - preset identity.
   * @param patch - fields to replace.
   * @returns the stored preset.
   */
  async updatePreset(sessionId: string, id: string, patch: TimerPatch): Promise<TimerPreset> {
    const preset = this.options.store.preset(id)
    if (preset === undefined) {
      throw new ContextGateError('PRESET_UNKNOWN', `timer preset ${JSON.stringify(id)} does not exist`, { presetId: id, sessionId })
    }
    const now = Date.now()
    const hasSchedule = patch.at !== undefined || patch.afterSeconds !== undefined
      || patch.rrule !== undefined || patch.everySeconds !== undefined
    const schedule = hasSchedule
      ? scheduleFromDraft({
        name: patch.name ?? preset.name,
        content: patch.content ?? preset.content,
        ...(patch.at === undefined ? {} : { at: patch.at }),
        ...(patch.afterSeconds === undefined ? {} : { afterSeconds: patch.afterSeconds }),
        ...(patch.rrule === undefined ? {} : { rrule: patch.rrule }),
        ...(patch.timeZone === undefined ? {} : { timeZone: patch.timeZone }),
        ...(patch.everySeconds === undefined ? {} : { everySeconds: patch.everySeconds }),
      }, now)
      : preset.schedule
    const next: TimerPreset = {
      ...preset,
      ...(patch.name === undefined ? {} : { name: requireName(patch.name, 'timer preset') }),
      ...(patch.content === undefined ? {} : { content: requireContent(patch.content) }),
      ...(patch.wake === undefined ? {} : { wake: patch.wake }),
      schedule,
      updatedAt: now,
    }
    await this.options.store.putPreset(next)
    return next
  }

  /**
   * Adopt one preset into an independent timer owned by the caller.
   * @param sessionId - adopting session.
   * @param presetId - template identity.
   * @returns the independent timer instance.
   */
  async adoptPreset(sessionId: string, presetId: string): Promise<TimerInstance> {
    const preset = this.options.store.preset(presetId)
    if (preset === undefined) {
      throw new ContextGateError('PRESET_UNKNOWN', `timer preset ${JSON.stringify(presetId)} does not exist`, { presetId, sessionId })
    }
    const now = Date.now()
    return await this.createTimerWithSchedule(sessionId, {
      name: preset.name,
      content: preset.content,
      wake: preset.wake,
    }, normalizeSchedule(preset.schedule), now, preset.id)
  }

  /**
   * Delete one preset. Already adopted timers keep running.
   * @param sessionId - deleting session.
   * @param presetId - template identity.
   */
  async deletePreset(sessionId: string, presetId: string): Promise<void> {
    const preset = this.options.store.preset(presetId)
    if (preset === undefined) {
      throw new ContextGateError('PRESET_UNKNOWN', `timer preset ${JSON.stringify(presetId)} does not exist`, { presetId, sessionId })
    }
    await this.options.store.removePreset(presetId)
  }

  /**
   * Create one absence watcher.
   * @param sessionId - owner session.
   * @param draft - watched kinds and quiet period.
   * @returns the stored watcher.
   */
  async createAbsence(sessionId: string, draft: AbsenceDraft): Promise<AbsenceTimer> {
    const owned = this.options.store.absences().filter(absence => absence.ownerSessionId === sessionId)
    if (owned.length >= this.options.maxAbsencesPerSession) {
      throw new ContextGateError('LIMIT_EXCEEDED', `session ${JSON.stringify(sessionId)} already owns ${String(owned.length)} absence watchers`, {
        sessionId, limit: this.options.maxAbsencesPerSession,
      })
    }
    const now = Date.now()
    const kinds = normalizeAbsenceKinds(draft.kinds)
    const quietMs = requireQuiet(draft.quietMs)
    const watcher: AbsenceTimer = {
      id: randomUUID(),
      ownerSessionId: sessionId,
      ...(draft.name === undefined ? {} : { name: requireName(draft.name, 'absence') }),
      kinds,
      quietMs,
      lastSeenAt: Math.max(now, latestSeen(this.options.store.lastSeenByKind(), kinds)),
      fired: false,
      enabled: true,
      createdAt: now,
      updatedAt: now,
    }
    await this.options.store.putAbsence(watcher)
    return watcher
  }

  /**
   * Change one absence watcher.
   * @param sessionId - owner session.
   * @param id - watcher identity.
   * @param patch - fields to change.
   * @returns the stored watcher.
   */
  async updateAbsence(sessionId: string, id: string, patch: AbsencePatch): Promise<AbsenceTimer> {
    const watcher = this.requireAbsence(sessionId, id)
    const now = Date.now()
    const kinds = patch.kinds === undefined ? watcher.kinds : normalizeAbsenceKinds(patch.kinds)
    const quietMs = patch.quietMs === undefined ? watcher.quietMs : requireQuiet(patch.quietMs)
    const next: AbsenceTimer = {
      ...watcher,
      ...(patch.name === undefined ? {} : { name: requireName(patch.name, 'absence') }),
      kinds,
      quietMs,
      enabled: patch.enabled ?? watcher.enabled,
      lastSeenAt: patch.kinds === undefined
        ? watcher.lastSeenAt
        : Math.max(now, latestSeen(this.options.store.lastSeenByKind(), kinds)),
      updatedAt: now,
    }
    await this.options.store.putAbsence(next)
    return next
  }

  /**
   * Remove one absence watcher.
   * @param sessionId - owner session.
   * @param id - watcher identity.
   */
  async cancelAbsence(sessionId: string, id: string): Promise<void> {
    this.requireAbsence(sessionId, id)
    await this.options.store.removeAbsence(id)
  }

  /**
   * Fire one due timer once and persist its next state.
   * @param timer - the due timer.
   * @param now - decision instant.
   * @param missed - skipped occurrences collapsed into this firing.
   */
  private async fire(timer: TimerInstance, now: number, missed: number): Promise<void> {
    if (timer.expiresAt !== undefined && now > timer.expiresAt) {
      await this.options.store.putTimer({ ...timer, enabled: false, nextDueAt: null })
      return
    }
    const highFrequency = timer.schedule.kind === 'seconds' && timer.schedule.everySeconds < 10
    const state = resolveSchedule(timer.schedule, anchorOf(timer), timer.nextDueAt, now)
    await this.options.deliver(timer.ownerSessionId, {
      kind: TIMER_EVENT_KIND,
      source: TIMER_SOURCE,
      summary: `定时器「${timer.name}」到点`,
      params: { timerId: timer.id, name: timer.name, content: timer.content, missed },
      content: [{ type: 'text', text: timer.content }],
      active: timer.wake && !highFrequency,
      dedupeKey: `${timer.id}:${String(state.dueAt ?? now)}`,
      ttlMs: Math.max(60_000, timer.schedule.kind === 'seconds' ? timer.schedule.everySeconds * 1000 : 0),
    })
    const finished = timer.schedule.kind === 'once' || timer.schedule.kind === 'after'
    await this.options.store.putTimer({
      ...timer,
      lastFiredAt: now,
      firedCount: timer.firedCount + 1,
      ...(missed === 0 ? {} : { missedCount: (timer.missedCount ?? 0) + missed }),
      enabled: finished ? false : timer.enabled,
      nextDueAt: finished ? null : state.nextDueAt,
      updatedAt: now,
    })
  }

  /**
   * Fire one absence watcher when its quiet period elapsed.
   * @param watcher - the watcher.
   * @param now - decision instant.
   */
  private async tickAbsence(watcher: AbsenceTimer, now: number): Promise<void> {
    if (now - watcher.lastSeenAt < watcher.quietMs) return
    try {
      await this.options.deliver(watcher.ownerSessionId, {
        kind: ABSENCE_EVENT_KIND,
        source: ABSENCE_SOURCE,
        summary: `安静提醒：${watcher.kinds.join(' / ')} 已 ${String(Math.round(watcher.quietMs / 1000))} 秒没有出现`,
        params: { absenceId: watcher.id, kinds: watcher.kinds, quietMs: watcher.quietMs },
        content: [{
          type: 'text',
          text: `[absence] 已超过 ${String(Math.round(watcher.quietMs / 1000))} 秒没有收到 ${watcher.kinds.join(' / ')}。`,
        }],
        active: true,
        dedupeKey: `${watcher.id}:${String(watcher.lastSeenAt)}`,
      })
      await this.options.store.putAbsence({
        ...watcher,
        fired: true,
        lastFiredAt: now,
        updatedAt: now,
      })
    } catch (error: unknown) {
      this.options.onError(`absence ${watcher.id} failed: ${describeError(error)}`)
    }
  }

  private requireTimer(sessionId: string, id: string): TimerInstance {
    const timer = this.options.store.timer(id)
    if (timer === undefined || timer.ownerSessionId !== sessionId) {
      throw new ContextGateError('TIMER_UNKNOWN', `timer ${JSON.stringify(id)} does not belong to session ${JSON.stringify(sessionId)}`, {
        timerId: id, sessionId,
      })
    }
    return timer
  }

  private requireAbsence(sessionId: string, id: string): AbsenceTimer {
    const watcher = this.options.store.absence(id)
    if (watcher === undefined || watcher.ownerSessionId !== sessionId) {
      throw new ContextGateError('ABSENCE_UNKNOWN', `absence ${JSON.stringify(id)} does not belong to session ${JSON.stringify(sessionId)}`, {
        absenceId: id, sessionId,
      })
    }
    return watcher
  }
}

/** Anchor used by relative schedules. */
function anchorOf(timer: TimerInstance): number {
  return timer.anchorAt
}

function safeNext(timer: TimerInstance, now: number): number | null {
  try {
    return nextAfter(timer.schedule, now, anchorOf(timer))
  } catch {
    return null
  }
}

function requireName(value: unknown, subject: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw invalid(`${subject} name must not be blank`)
  const name = value.trim()
  if (name.length > 200) throw invalid(`${subject} name may not exceed 200 characters`)
  return name
}

function requireContent(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') throw invalid('content must not be blank')
  if (Buffer.byteLength(value, 'utf8') > 16_384) throw invalid('content may not exceed 16384 bytes')
  return value
}

function requireQuiet(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) throw invalid('quietMs must be a positive number')
  return value
}

function parseInstant(value: string, label: string): number {
  const epoch = Date.parse(value)
  if (!Number.isFinite(epoch)) throw invalid(`${label} must be an ISO-8601 instant`)
  return epoch
}

/**
 * Normalize an absence watch set.
 * @param kinds - watched kinds, or `['*']`.
 * @returns the validated kind list.
 */
export function normalizeAbsenceKinds(kinds: readonly string[]): readonly string[] {
  if (!Array.isArray(kinds) || kinds.length === 0) {
    throw new ContextGateError('ABSENCE_INVALID', 'absence kinds must be a non-empty array')
  }
  if (kinds.includes('*') && kinds.length > 1) {
    throw new ContextGateError('ABSENCE_INVALID', 'absence kind "*" cannot be combined with explicit kinds')
  }
  for (const kind of kinds) {
    if (typeof kind !== 'string' || kind.trim() === '') {
      throw new ContextGateError('ABSENCE_INVALID', 'absence kinds must be non-empty strings')
    }
  }
  return [...kinds]
}

function latestSeen(lastSeenByKind: Readonly<Record<string, number>>, kinds: readonly string[]): number {
  const values = kinds.includes('*') ? Object.values(lastSeenByKind) : kinds.map(kind => lastSeenByKind[kind] ?? 0)
  return values.length === 0 ? 0 : Math.max(...values)
}

/**
 * Build one schedule from caller fields.
 * @param draft - timer or preset draft; accepts either a persisted schedule or the individual fields.
 * @param now - creation instant.
 * @returns the normalized schedule.
 */
export function scheduleFromDraft(draft: TimerDraft & { readonly schedule?: TimerSchedule }, now: number): TimerSchedule {
  if (draft.schedule !== undefined) return normalizeSchedule(draft.schedule)
  const candidates = [draft.at, draft.afterSeconds, draft.rrule, draft.everySeconds].filter(value => value !== undefined)
  if (candidates.length !== 1) {
    throw invalid('a timer needs exactly one of at, afterSeconds, rrule, or everySeconds')
  }
  if (draft.at !== undefined) {
    return normalizeSchedule({ kind: 'once', at: parseInstant(draft.at, 'at') })
  }
  if (draft.afterSeconds !== undefined) {
    return normalizeSchedule({ kind: 'after', afterMs: positiveNumber(draft.afterSeconds, 'afterSeconds') * 1000 })
  }
  if (draft.everySeconds !== undefined) {
    return normalizeSchedule({ kind: 'seconds', everySeconds: positiveNumber(draft.everySeconds, 'everySeconds') })
  }
  const zone = draft.timeZone ?? 'UTC'
  const expression = draft.rrule ?? ''
  parseRRule(expression, zone, now)
  return normalizeSchedule({ kind: 'rrule', rrule: expression, timeZone: zone })
}

/**
 * Resolve one rule's next due time and persist-friendly state.
 * @param rule - stored rule with a time trigger.
 * @param now - decision instant.
 * @returns due and next instants.
 */
export function ruleScheduleState(rule: EventRule, now: number): ScheduleState {
  if (rule.trigger.kind !== 'time') return { dueAt: null, nextDueAt: null, missed: 0 }
  const anchor = rule.anchorAt ?? rule.createdAt
  return resolveSchedule(rule.trigger.schedule, anchor, rule.nextDueAt ?? null, now)
}

/**
 * The state document of the context gate: subscriptions, parameter values,
 * queues, the event log, timers, absence watchers, and custom-event rules.
 * It is separate from any other plugin's state and never reads another
 * plugin's document.
 *
 * Every mutation rewrites the whole document through a temporary file and one
 * rename, so a reader never observes a partial write. Mutations are serialized
 * because publications, step injections, and timer ticks can interleave on the
 * event loop.
 *
 * Version 1 documents (subscriptions, queues, log only) are migrated on read.
 * Unknown document fields are ignored on read: a document written by a later
 * build that adds fields remains readable.
 *
 * @module @elysia/context-gate/state
 */

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type {
  AbsenceTimer, ContextEvent, ContextOrigin, EventLogEntry, EventOutcome, EventRule,
  EventParameterValues, FutureSubscription, GateDocument, InternalEventName, QueueRecord, RuleCondition,
  RuleScript, RuleTrigger, SessionRecord, TimerInstance, TimerPreset, TimerSchedule,
} from './types.ts'
import { INTERNAL_EVENT_NAMES } from './constants.ts'
import { ContextGateError, describeError } from './errors.ts'

/** File name of the gate document inside the configured state directory. */
export const DOCUMENT_FILE_NAME = 'context-gate-state.json'

/** Document generation this build writes. */
export const DOCUMENT_VERSION = 2

/** Retained event-log rows per session. */
export const EVENT_LOG_LIMIT = 50

/** Retained consumed ids and dedupe keys per session. */
export const QUEUE_HISTORY_LIMIT = 64

/** A session with no stored state. */
const EMPTY_SESSION: SessionRecord = { contexts: {}, events: [] }

/** A session with no queued events. */
const EMPTY_QUEUE: QueueRecord = { events: [], consumed: [], dedupe: {} }

/** A fresh, never-written document. */
function emptyDocument(): GateDocument {
  return {
    version: DOCUMENT_VERSION,
    sessions: {},
    queues: {},
    futureSubscriptions: [],
    timers: { instances: [], presets: [], absence: [], lastSeenByKind: {} },
    rules: { definitions: [] },
    updatedAt: new Date(0).toISOString(),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isMissingFile(error: unknown): boolean {
  return isRecord(error) && error['code'] === 'ENOENT'
}

function invalid(file: string, message: string): ContextGateError {
  return new ContextGateError('STATE_INVALID', `context-gate cannot use ${file}: ${message}`, { path: file })
}

function stringArray(value: unknown, label: string, file: string): string[] {
  if (!Array.isArray(value) || value.some(entry => typeof entry !== 'string')) {
    throw invalid(file, `${label} must be a string array`)
  }
  return [...value]
}

function booleanRecord(value: unknown, label: string, file: string): Record<string, boolean> {
  if (!isRecord(value) || Object.values(value).some(entry => typeof entry !== 'boolean')) {
    throw invalid(file, `${label} must be a boolean record`)
  }
  return { ...value } as Record<string, boolean>
}

function numberRecord(value: unknown, label: string, file: string): Record<string, number> {
  if (!isRecord(value) || Object.values(value).some(entry => typeof entry !== 'number' || !Number.isFinite(entry))) {
    throw invalid(file, `${label} must be a number record`)
  }
  return { ...value } as Record<string, number>
}

function requiredString(value: unknown, label: string, file: string): string {
  if (typeof value !== 'string') throw invalid(file, `${label} must be a string`)
  return value
}

function optionalString(value: unknown, label: string, file: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw invalid(file, `${label} must be a string`)
  return value
}

function requiredNumber(value: unknown, label: string, file: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw invalid(file, `${label} must be a finite number`)
  return value
}

function optionalNumber(value: unknown, label: string, file: string): number | undefined {
  if (value === undefined) return undefined
  return requiredNumber(value, label, file)
}



function parseOrigin(value: unknown, label: string, file: string): ContextOrigin | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value)) throw invalid(file, `${label} must be an object`)
  const instance = optionalString(value['instance'], `${label}.instance`, file)
  const sessionId = optionalString(value['sessionId'], `${label}.sessionId`, file)
  const channel = optionalString(value['channel'], `${label}.channel`, file)
  const conversation = optionalString(value['conversation'], `${label}.conversation`, file)
  return {
    plugin: requiredString(value['plugin'], `${label}.plugin`, file),
    ...(instance === undefined ? {} : { instance }),
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(channel === undefined ? {} : { channel }),
    ...(conversation === undefined ? {} : { conversation }),
  }
}

function isContentBlock(value: unknown): value is ContentBlock {
  if (!isRecord(value) || typeof value['type'] !== 'string' || value['type'] === '') return false
  if (value['type'] === 'text' && typeof value['text'] !== 'string') return false
  return true
}

function parseContent(value: unknown, label: string, file: string): readonly ContentBlock[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) throw invalid(file, `${label} must be a content-block array`)
  return value.map((entry, index) => {
    if (!isContentBlock(entry)) throw invalid(file, `${label}[${String(index)}] is not a content block`)
    return entry
  })
}

function parseJsonValue(value: unknown, label: string, file: string): unknown {
  try {
    return JSON.parse(JSON.stringify(value))
  } catch {
    throw invalid(file, `${label} is not JSON-serializable`)
  }
}

function parseParameterValues(value: unknown, label: string, file: string): EventParameterValues | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value)) throw invalid(file, `${label} must be an object`)
  const out: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value)) out[key] = parseJsonValue(entry, `${label}.${key}`, file)
  return out
}

function parseEvent(value: unknown, label: string, file: string): ContextEvent {
  if (!isRecord(value)) throw invalid(file, `${label} is not an object`)
  const visibility = value['visibility']
  if (!isRecord(visibility)) throw invalid(file, `${label}.visibility must be an object`)
  const sessionIds = visibility['sessionIds']
  const origin = parseOrigin(value['origin'], `${label}.origin`, file)
  const content = parseContent(value['content'], `${label}.content`, file)
  const params = value['params'] !== undefined ? value['params'] : value['payload']
  const causationId = optionalString(value['causationId'], `${label}.causationId`, file)
  return {
    id: requiredString(value['id'], `${label}.id`, file),
    kind: requiredString(value['kind'], `${label}.kind`, file),
    source: requiredString(value['source'], `${label}.source`, file),
    ...(origin === undefined ? {} : { origin }),
    summary: requiredString(value['summary'], `${label}.summary`, file),
    ...(params === undefined ? {} : { params }),
    ...(value['payload'] === undefined ? {} : { payload: value['payload'] }),
    ...(content === undefined ? {} : { content }),
    visibility: sessionIds === undefined ? {} : { sessionIds: stringArray(sessionIds, `${label}.visibility.sessionIds`, file) },
    active: value['active'] === true,
    dedupeKey: typeof value['dedupeKey'] === 'string' ? value['dedupeKey'] : '',
    ...(typeof value['ttlMs'] === 'number' ? { ttlMs: value['ttlMs'] } : {}),
    ...(typeof value['maxBytes'] === 'number' ? { maxBytes: value['maxBytes'] } : {}),
    ...(causationId === undefined ? {} : { causationId }),
    createdAt: typeof value['createdAt'] === 'number' ? value['createdAt'] : 0,
  }
}

function parseLogEntry(value: unknown, label: string, file: string): EventLogEntry {
  if (!isRecord(value)) throw invalid(file, `${label} is not an object`)
  const outcome = value['outcome']
  const outcomes: readonly EventOutcome[] = ['published', 'delivered', 'consumed', 'failed', 'dropped']
  if (typeof value['id'] !== 'string' || typeof value['kind'] !== 'string'
    || !outcomes.includes(outcome as EventOutcome) || typeof value['at'] !== 'number') {
    throw invalid(file, `${label} is not an event-log row`)
  }
  const origin = parseOrigin(value['origin'], `${label}.origin`, file)
  const eventId = optionalString(value['eventId'], `${label}.eventId`, file)
  const source = optionalString(value['source'], `${label}.source`, file)
  const summary = optionalString(value['summary'], `${label}.summary`, file)
  const causationId = optionalString(value['causationId'], `${label}.causationId`, file)
  return {
    id: value['id'],
    ...(eventId === undefined ? {} : { eventId }),
    kind: value['kind'],
    ...(source === undefined ? {} : { source }),
    ...(origin === undefined ? {} : { origin }),
    ...(summary === undefined ? {} : { summary }),
    ...(causationId === undefined ? {} : { causationId }),
    outcome: outcome as EventOutcome,
    at: value['at'],
    ...(typeof value['detail'] === 'string' ? { detail: value['detail'] } : {}),
  }
}

function parseSession(value: unknown, label: string, file: string): SessionRecord {
  if (!isRecord(value)) throw invalid(file, `${label} is not an object`)
  const params = value['params']
  const parsedParams: Record<string, EventParameterValues> = {}
  if (params !== undefined) {
    if (!isRecord(params)) throw invalid(file, `${label}.params must be an object`)
    for (const [kind, entry] of Object.entries(params)) {
      const values = parseParameterValues(entry, `${label}.params.${kind}`, file)
      if (values !== undefined) parsedParams[kind] = values
    }
  }
  return {
    contexts: value['contexts'] === undefined ? {} : booleanRecord(value['contexts'], `${label}.contexts`, file),
    events: Array.isArray(value['events'])
      ? value['events'].map((entry, index) => parseLogEntry(entry, `${label}.events[${String(index)}]`, file))
      : [],
    ...(Object.keys(parsedParams).length === 0 ? {} : { params: parsedParams }),
    ...(optionalNumber(value['firstSeenAt'], `${label}.firstSeenAt`, file) === undefined
      ? {}
      : { firstSeenAt: value['firstSeenAt'] as number }),
  }
}

function parseQueue(value: unknown, label: string, file: string): QueueRecord {
  if (!isRecord(value)) throw invalid(file, `${label} is not an object`)
  const events = value['events']
  if (!Array.isArray(events)) throw invalid(file, `${label}.events must be an array`)
  const dedupe = value['dedupe']
  if (dedupe !== undefined && (!isRecord(dedupe) || Object.values(dedupe).some(entry => typeof entry !== 'number'))) {
    throw invalid(file, `${label}.dedupe must be a number record`)
  }
  return {
    events: events.map((entry, index) => parseEvent(entry, `${label}.events[${String(index)}]`, file)),
    consumed: value['consumed'] === undefined ? [] : stringArray(value['consumed'], `${label}.consumed`, file),
    dedupe: dedupe === undefined ? {} : { ...dedupe } as Record<string, number>,
  }
}

function parseSchedule(value: unknown, label: string, file: string): TimerSchedule {
  if (!isRecord(value)) throw invalid(file, `${label} must be an object`)
  const kind = value['kind']
  switch (kind) {
    case 'once':
      return { kind, at: requiredNumber(value['at'], `${label}.at`, file) }
    case 'after':
      return { kind, afterMs: requiredNumber(value['afterMs'], `${label}.afterMs`, file) }
    case 'rrule': {
      const rrule = requiredString(value['rrule'], `${label}.rrule`, file)
      const timeZone = optionalString(value['timeZone'], `${label}.timeZone`, file)
      return { kind, rrule, ...(timeZone === undefined ? {} : { timeZone }) }
    }
    case 'seconds':
      return { kind, everySeconds: requiredNumber(value['everySeconds'], `${label}.everySeconds`, file) }
    default:
      throw invalid(file, `${label}.kind is not a timer schedule`)
  }
}

function parseTimerInstance(value: unknown, label: string, file: string): TimerInstance {
  if (!isRecord(value)) throw invalid(file, `${label} is not an object`)
  const presetId = optionalString(value['presetId'], `${label}.presetId`, file)
  const nextDueAt = value['nextDueAt'] === null ? null : requiredNumber(value['nextDueAt'], `${label}.nextDueAt`, file)
  const expiresAt = optionalNumber(value['expiresAt'], `${label}.expiresAt`, file)
  const createdAt = requiredNumber(value['createdAt'], `${label}.createdAt`, file)
  const anchorAt = optionalNumber(value['anchorAt'], `${label}.anchorAt`, file) ?? createdAt
  return {
    id: requiredString(value['id'], `${label}.id`, file),
    ownerSessionId: requiredString(value['ownerSessionId'], `${label}.ownerSessionId`, file),
    ...(presetId === undefined ? {} : { presetId }),
    name: requiredString(value['name'], `${label}.name`, file),
    schedule: parseSchedule(value['schedule'], `${label}.schedule`, file),
    content: requiredString(value['content'], `${label}.content`, file),
    wake: value['wake'] === true,
    anchorAt,
    enabled: value['enabled'] === true,
    nextDueAt,
    ...(optionalNumber(value['lastFiredAt'], `${label}.lastFiredAt`, file) === undefined
      ? {}
      : { lastFiredAt: value['lastFiredAt'] as number }),
    firedCount: value['firedCount'] === undefined ? 0 : requiredNumber(value['firedCount'], `${label}.firedCount`, file),
    ...(optionalNumber(value['missedCount'], `${label}.missedCount`, file) === undefined
      ? {}
      : { missedCount: value['missedCount'] as number }),
    ...(optionalString(value['lastError'], `${label}.lastError`, file) === undefined
      ? {}
      : { lastError: value['lastError'] as string }),
    createdAt,
    updatedAt: requiredNumber(value['updatedAt'], `${label}.updatedAt`, file),
    ...(expiresAt === undefined ? {} : { expiresAt }),
  }
}

function parseTimerPreset(value: unknown, label: string, file: string): TimerPreset {
  if (!isRecord(value)) throw invalid(file, `${label} is not an object`)
  const updatedAt = optionalNumber(value['updatedAt'], `${label}.updatedAt`, file)
  return {
    id: requiredString(value['id'], `${label}.id`, file),
    ownerSessionId: requiredString(value['ownerSessionId'], `${label}.ownerSessionId`, file),
    name: requiredString(value['name'], `${label}.name`, file),
    schedule: parseSchedule(value['schedule'], `${label}.schedule`, file),
    content: requiredString(value['content'], `${label}.content`, file),
    wake: value['wake'] === true,
    createdAt: requiredNumber(value['createdAt'], `${label}.createdAt`, file),
    ...(updatedAt === undefined ? {} : { updatedAt }),
  }
}

function parseAbsence(value: unknown, label: string, file: string): AbsenceTimer {
  if (!isRecord(value)) throw invalid(file, `${label} is not an object`)
  const name = optionalString(value['name'], `${label}.name`, file)
  const lastFiredAt = optionalNumber(value['lastFiredAt'], `${label}.lastFiredAt`, file)
  return {
    id: requiredString(value['id'], `${label}.id`, file),
    ownerSessionId: requiredString(value['ownerSessionId'], `${label}.ownerSessionId`, file),
    ...(name === undefined ? {} : { name }),
    kinds: stringArray(value['kinds'], `${label}.kinds`, file),
    quietMs: requiredNumber(value['quietMs'], `${label}.quietMs`, file),
    lastSeenAt: requiredNumber(value['lastSeenAt'], `${label}.lastSeenAt`, file),
    fired: value['fired'] === true,
    enabled: value['enabled'] === true,
    createdAt: requiredNumber(value['createdAt'], `${label}.createdAt`, file),
    updatedAt: requiredNumber(value['updatedAt'], `${label}.updatedAt`, file),
    ...(lastFiredAt === undefined ? {} : { lastFiredAt }),
  }
}

function parseCondition(value: unknown, label: string, file: string): RuleCondition {
  if (!isRecord(value)) throw invalid(file, `${label} is not an object`)
  const op = value['op']
  const ops: readonly RuleCondition['op'][] = ['eq', 'neq', 'contains', 'matches', 'gt', 'lt', 'exists']
  if (!ops.includes(op as RuleCondition['op'])) throw invalid(file, `${label}.op is not a condition operator`)
  return {
    field: requiredString(value['field'], `${label}.field`, file),
    op: op as RuleCondition['op'],
    ...(value['value'] === undefined ? {} : { value: value['value'] }),
  }
}

function parseScript(value: unknown, label: string, file: string): RuleScript | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value)) throw invalid(file, `${label} must be an object`)
  const timeoutMs = optionalNumber(value['timeoutMs'], `${label}.timeoutMs`, file)
  const memoryMb = optionalNumber(value['memoryMb'], `${label}.memoryMb`, file)
  return {
    source: requiredString(value['source'], `${label}.source`, file),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(memoryMb === undefined ? {} : { memoryMb }),
  }
}

function parseTrigger(value: unknown, label: string, file: string): RuleTrigger {
  if (!isRecord(value)) throw invalid(file, `${label} must be an object`)
  const kind = value['kind']
  switch (kind) {
    case 'time':
      return { kind, schedule: parseSchedule(value['schedule'], `${label}.schedule`, file) }
    case 'absence':
      return {
        kind,
        kinds: stringArray(value['kinds'], `${label}.kinds`, file),
        quietMs: requiredNumber(value['quietMs'], `${label}.quietMs`, file),
      }
    case 'internal': {
      const event = requiredString(value['event'], `${label}.event`, file)
      if (!(INTERNAL_EVENT_NAMES as readonly string[]).includes(event)) {
        throw invalid(file, `${label}.event is not an exposed internal event`)
      }
      return { kind, event: event as InternalEventName }
    }
    case 'http-poll': {
      const jsonPath = optionalString(value['jsonPath'], `${label}.jsonPath`, file)
      return {
        kind,
        url: requiredString(value['url'], `${label}.url`, file),
        intervalMs: requiredNumber(value['intervalMs'], `${label}.intervalMs`, file),
        ...(jsonPath === undefined ? {} : { jsonPath }),
      }
    }
    case 'webhook':
      return { kind }
    case 'composite': {
      const op = value['op']
      const ops: readonly ('all' | 'any' | 'not' | 'sequence')[] = ['all', 'any', 'not', 'sequence']
      if (!ops.includes(op as 'all')) throw invalid(file, `${label}.op is not a composite operator`)
      const triggers = value['triggers']
      if (!Array.isArray(triggers)) throw invalid(file, `${label}.triggers must be an array`)
      const windowMs = optionalNumber(value['windowMs'], `${label}.windowMs`, file)
      return {
        kind,
        op: op as 'all',
        triggers: triggers.map((entry, index) => parseTrigger(entry, `${label}.triggers[${String(index)}]`, file)),
        ...(windowMs === undefined ? {} : { windowMs }),
      }
    }
    default:
      throw invalid(file, `${label}.kind is not a rule trigger`)
  }
}

function parseRule(value: unknown, label: string, file: string): EventRule {
  if (!isRecord(value)) throw invalid(file, `${label} is not an object`)
  const visibility = value['visibility']
  if (visibility !== undefined && !isRecord(visibility)) throw invalid(file, `${label}.visibility must be an object`)
  const sessionIds = isRecord(visibility) ? visibility['sessionIds'] : undefined
  const where = value['where']
  if (where !== undefined && !Array.isArray(where)) throw invalid(file, `${label}.where must be an array`)
  const script = parseScript(value['script'], `${label}.script`, file)
  const expiresAt = optionalNumber(value['expiresAt'], `${label}.expiresAt`, file)
  return {
    id: requiredString(value['id'], `${label}.id`, file),
    ownerSessionId: requiredString(value['ownerSessionId'], `${label}.ownerSessionId`, file),
    name: requiredString(value['name'], `${label}.name`, file),
    trigger: parseTrigger(value['trigger'], `${label}.trigger`, file),
    where: where === undefined
      ? []
      : where.map((entry, index) => parseCondition(entry, `${label}.where[${String(index)}]`, file)),
    contentTemplate: requiredString(value['contentTemplate'], `${label}.contentTemplate`, file),
    ...(script === undefined ? {} : { script }),
    wake: value['wake'] === true,
    visibility: sessionIds === undefined
      ? {}
      : { sessionIds: stringArray(sessionIds, `${label}.visibility.sessionIds`, file) },
    cooldownMs: value['cooldownMs'] === undefined ? 0 : requiredNumber(value['cooldownMs'], `${label}.cooldownMs`, file),
    maxFires: value['maxFires'] === undefined ? 0 : requiredNumber(value['maxFires'], `${label}.maxFires`, file),
    ...(expiresAt === undefined ? {} : { expiresAt }),
    enabled: value['enabled'] !== false,
    ...(optionalString(value['webhookTokenHash'], `${label}.webhookTokenHash`, file) === undefined
      ? {}
      : { webhookTokenHash: value['webhookTokenHash'] as string }),
    fireCount: value['fireCount'] === undefined ? 0 : requiredNumber(value['fireCount'], `${label}.fireCount`, file),
    ...(optionalNumber(value['lastFiredAt'], `${label}.lastFiredAt`, file) === undefined
      ? {}
      : { lastFiredAt: value['lastFiredAt'] as number }),
    ...(optionalString(value['lastError'], `${label}.lastError`, file) === undefined
      ? {}
      : { lastError: value['lastError'] as string }),
    ...(optionalNumber(value['nextDueAt'], `${label}.nextDueAt`, file) === undefined
      ? {}
      : { nextDueAt: value['nextDueAt'] as number }),
    ...(optionalNumber(value['anchorAt'], `${label}.anchorAt`, file) === undefined
      ? {}
      : { anchorAt: value['anchorAt'] as number }),
    ...(optionalNumber(value['completedAt'], `${label}.completedAt`, file) === undefined
      ? {}
      : { completedAt: value['completedAt'] as number }),
    createdAt: requiredNumber(value['createdAt'], `${label}.createdAt`, file),
    updatedAt: requiredNumber(value['updatedAt'], `${label}.updatedAt`, file),
  }
}

function parseFutureSubscription(value: unknown, label: string, file: string): FutureSubscription {
  if (!isRecord(value)) throw invalid(file, `${label} is not an object`)
  const params = parseParameterValues(value['params'], `${label}.params`, file) ?? {}
  return {
    id: requiredString(value['id'], `${label}.id`, file),
    kind: requiredString(value['kind'], `${label}.kind`, file),
    params,
    createdAt: requiredNumber(value['createdAt'], `${label}.createdAt`, file),
  }
}

function parseDocument(value: unknown, file: string): GateDocument {
  if (!isRecord(value)) throw invalid(file, 'the document is not an object')
  const version = value['version']
  if (version !== 1 && version !== DOCUMENT_VERSION) {
    throw invalid(file, `unsupported document version ${String(version)}`)
  }
  const sessions: Record<string, SessionRecord> = {}
  const sessionSection = value['sessions']
  if (sessionSection !== undefined) {
    if (!isRecord(sessionSection)) throw invalid(file, '"sessions" must be an object')
    for (const [id, entry] of Object.entries(sessionSection)) sessions[id] = parseSession(entry, `sessions.${id}`, file)
  }
  const queues: Record<string, QueueRecord> = {}
  const queueSection = value['queues']
  if (queueSection !== undefined) {
    if (!isRecord(queueSection)) throw invalid(file, '"queues" must be an object')
    for (const [id, entry] of Object.entries(queueSection)) queues[id] = parseQueue(entry, `queues.${id}`, file)
  }
  const future: FutureSubscription[] = []
  const futureSection = value['futureSubscriptions']
  if (futureSection !== undefined) {
    if (!Array.isArray(futureSection)) throw invalid(file, '"futureSubscriptions" must be an array')
    for (const [index, entry] of futureSection.entries()) {
      future.push(parseFutureSubscription(entry, `futureSubscriptions[${String(index)}]`, file))
    }
  }
  const timersSection = value['timers']
  const instances: TimerInstance[] = []
  const presets: TimerPreset[] = []
  const absence: AbsenceTimer[] = []
  const lastSeenByKind: Record<string, number> = {}
  if (timersSection !== undefined) {
    if (!isRecord(timersSection)) throw invalid(file, '"timers" must be an object')
    const rawInstances = timersSection['instances']
    if (rawInstances !== undefined) {
      if (!Array.isArray(rawInstances)) throw invalid(file, 'timers.instances must be an array')
      for (const [index, entry] of rawInstances.entries()) {
        instances.push(parseTimerInstance(entry, `timers.instances[${String(index)}]`, file))
      }
    }
    const rawPresets = timersSection['presets']
    if (rawPresets !== undefined) {
      if (!Array.isArray(rawPresets)) throw invalid(file, 'timers.presets must be an array')
      for (const [index, entry] of rawPresets.entries()) {
        presets.push(parseTimerPreset(entry, `timers.presets[${String(index)}]`, file))
      }
    }
    const rawAbsence = timersSection['absence']
    if (rawAbsence !== undefined) {
      if (!Array.isArray(rawAbsence)) throw invalid(file, 'timers.absence must be an array')
      for (const [index, entry] of rawAbsence.entries()) {
        absence.push(parseAbsence(entry, `timers.absence[${String(index)}]`, file))
      }
    }
    const rawSeen = timersSection['lastSeenByKind']
    if (rawSeen !== undefined) Object.assign(lastSeenByKind, numberRecord(rawSeen, 'timers.lastSeenByKind', file))
  }
  const definitions: EventRule[] = []
  const rulesSection = value['rules']
  if (rulesSection !== undefined) {
    if (!isRecord(rulesSection)) throw invalid(file, '"rules" must be an object')
    const rawDefinitions = rulesSection['definitions']
    if (rawDefinitions !== undefined) {
      if (!Array.isArray(rawDefinitions)) throw invalid(file, 'rules.definitions must be an array')
      for (const [index, entry] of rawDefinitions.entries()) {
        definitions.push(parseRule(entry, `rules.definitions[${String(index)}]`, file))
      }
    }
  }
  return {
    version: DOCUMENT_VERSION,
    sessions,
    queues,
    futureSubscriptions: future,
    timers: { instances, presets, absence, lastSeenByKind },
    rules: { definitions },
    updatedAt: typeof value['updatedAt'] === 'string' ? value['updatedAt'] : new Date(0).toISOString(),
  }
}

/** One session's resolved subscription state. */
export interface ResolvedSubscription {
  /** Whether the kind is subscribed. */
  readonly enabled: boolean
  /** Stored parameter values, explicit ones first and a future rule's as fallback. */
  readonly params: EventParameterValues
  /** True when a future-session rule supplied the subscription. */
  readonly future: boolean
}

/** Persisted subscriptions, parameter values, queues, logs, timers, and rules. */
export class ContextGateStore {
  private document: GateDocument
  private writing: Promise<void> = Promise.resolve()
  private readonly file: string

  private constructor(file: string, document: GateDocument) {
    this.file = file
    this.document = document
  }

  /**
   * Open (or create, or migrate) the document in one state directory.
   * @param stateDir - absolute directory holding the document.
   * @returns the opened store.
   * @throws ContextGateError `STATE_INVALID` when the directory is relative or the document is unreadable.
   */
  static async open(stateDir: string): Promise<ContextGateStore> {
    if (!isAbsolute(stateDir)) {
      throw new ContextGateError('STATE_INVALID', `context-gate stateDir must be absolute, got ${JSON.stringify(stateDir)}`, {
        path: stateDir, reason: 'not-absolute',
      })
    }
    try {
      await mkdir(stateDir, { recursive: true })
    } catch (error: unknown) {
      throw new ContextGateError('STATE_INVALID', `context-gate cannot create ${stateDir}: ${describeError(error)}`, {
        path: stateDir, reason: 'mkdir',
      })
    }
    const file = join(stateDir, DOCUMENT_FILE_NAME)
    let raw: string | undefined
    try {
      raw = await readFile(file, 'utf8')
    } catch (error: unknown) {
      if (!isMissingFile(error)) {
        throw new ContextGateError('STATE_INVALID', `context-gate cannot read ${file}: ${describeError(error)}`, {
          path: file, reason: 'unreadable',
        })
      }
    }
    if (raw === undefined) return new ContextGateStore(file, emptyDocument())
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (error: unknown) {
      throw invalid(file, `not valid JSON: ${describeError(error)}`)
    }
    return new ContextGateStore(file, parseDocument(parsed, file))
  }

  /** ISO timestamp of the last committed write. */
  get updatedAt(): string {
    return this.document.updatedAt
  }

  /** Every session id the document knows. */
  sessionIds(): readonly string[] {
    return Object.keys(this.document.sessions)
  }

  /** One session's gate state; an unknown session reads as empty. */
  session(sessionId: string): SessionRecord {
    return this.document.sessions[sessionId] ?? EMPTY_SESSION
  }

  /** Context subscriptions of one session; a missing kind means off. */
  contexts(sessionId: string): Readonly<Record<string, boolean>> {
    return this.session(sessionId).contexts
  }

  /**
   * Resolve one session's subscription for a kind, including future rules.
   * @param sessionId - subscriber session.
   * @param kind - registered kind.
   * @returns the explicit state, or the future rule that applies.
   */
  subscription(sessionId: string, kind: string): ResolvedSubscription {
    const session = this.document.sessions[sessionId]
    const explicit = session?.contexts[kind]
    if (explicit !== undefined) {
      return { enabled: explicit, params: session?.params?.[kind] ?? {}, future: false }
    }
    const firstSeenAt = session?.firstSeenAt ?? 0
    const rule = this.document.futureSubscriptions.find(candidate => candidate.kind === kind && candidate.createdAt < firstSeenAt)
    if (rule !== undefined) return { enabled: true, params: rule.params, future: true }
    return { enabled: false, params: {}, future: false }
  }

  /** Every future-session subscription rule. */
  futureSubscriptions(): readonly FutureSubscription[] {
    return this.document.futureSubscriptions
  }

  /**
   * Subscribe or unsubscribe one context kind for one session.
   * @param sessionId - target session.
   * @param kind - registered kind.
   * @param enabled - false unsubscribes it and blocks a future rule for this session.
   * @returns after the document is durable.
   */
  async setContext(sessionId: string, kind: string, enabled: boolean): Promise<void> {
    await this.change((document) => {
      const current = document.sessions[sessionId] ?? EMPTY_SESSION
      return {
        ...document,
        sessions: {
          ...document.sessions,
          [sessionId]: { ...current, contexts: { ...current.contexts, [kind]: enabled } },
        },
      }
    })
  }

  /**
   * Store source-defined parameter values for one subscription.
   * @param sessionId - target session.
   * @param kind - registered kind.
   * @param params - parameter values.
   * @returns after the document is durable.
   */
  async setSubscriptionParams(sessionId: string, kind: string, params: EventParameterValues): Promise<void> {
    await this.change((document) => {
      const current = document.sessions[sessionId] ?? EMPTY_SESSION
      return {
        ...document,
        sessions: {
          ...document.sessions,
          [sessionId]: {
            ...current,
            params: { ...current.params, [kind]: params },
          },
        },
      }
    })
  }

  /**
   * Record that one session exists now in memory. Existing records keep their
   * first time. The next document write persists the observation.
   * @param sessionId - target session.
   * @param at - observation time.
   */
  markSessionSeen(sessionId: string, at: number): void {
    const current = this.document.sessions[sessionId]
    if (current?.firstSeenAt !== undefined) return
    this.document = {
      ...this.document,
      sessions: {
        ...this.document.sessions,
        [sessionId]: { contexts: {}, events: [], ...current, firstSeenAt: at },
      },
    }
  }

  /**
   * Record one session observation and persist it.
   * @param sessionId - target session.
   * @param at - observation time.
   * @returns after the document is durable when the record changed.
   */
  async noteSession(sessionId: string, at: number): Promise<void> {
    const previous = this.document.sessions[sessionId]?.firstSeenAt
    this.markSessionSeen(sessionId, at)
    if (previous !== undefined) return
    await this.change(document => ({ ...document }))
  }

  /**
   * Add a future-session subscription rule.
   * @param kind - kind future sessions subscribe.
   * @param params - parameter values applied to those subscriptions.
   * @param createdAt - rule creation time.
   * @returns the stored rule.
   */
  async addFutureSubscription(kind: string, params: EventParameterValues, createdAt: number): Promise<FutureSubscription> {
    const rule: FutureSubscription = { id: randomUUID(), kind, params, createdAt }
    await this.change(document => ({ ...document, futureSubscriptions: [...document.futureSubscriptions, rule] }))
    return rule
  }

  /**
   * Remove one future-session subscription rule.
   * @param id - rule identity.
   * @returns after the document is durable.
   */
  async removeFutureSubscription(id: string): Promise<void> {
    await this.change(document => ({
      ...document,
      futureSubscriptions: document.futureSubscriptions.filter(rule => rule.id !== id),
    }))
  }

  /**
   * Append one event-log row for one session, newest first.
   * @param sessionId - target session.
   * @param entry - the row.
   * @returns after the document is durable.
   */
  async logEvent(sessionId: string, entry: EventLogEntry): Promise<void> {
    await this.change((document) => {
      const latest = document.sessions[sessionId] ?? EMPTY_SESSION
      return {
        ...document,
        sessions: {
          ...document.sessions,
          [sessionId]: { ...latest, events: [entry, ...latest.events].slice(0, EVENT_LOG_LIMIT) },
        },
      }
    })
  }

  /** One session's recent event-log rows, newest first. */
  events(sessionId: string): readonly EventLogEntry[] {
    return this.session(sessionId).events
  }

  /** The queue of one session. */
  queue(sessionId: string): QueueRecord {
    return this.document.queues[sessionId] ?? EMPTY_QUEUE
  }

  /**
   * Replace one session's queue.
   * @param sessionId - target session.
   * @param mutate - receives the current queue and returns the next one.
   * @returns after the document is durable.
   */
  async mutateQueue(sessionId: string, mutate: (queue: QueueRecord) => QueueRecord): Promise<void> {
    const current = this.queue(sessionId)
    const next = mutate(current)
    if (next === current) return
    await this.change(document => ({ ...document, queues: { ...document.queues, [sessionId]: next } }))
  }

  /** Every timer instance. */
  timers(): readonly TimerInstance[] {
    return this.document.timers.instances
  }

  /** One timer instance by identity. */
  timer(id: string): TimerInstance | undefined {
    return this.document.timers.instances.find(timer => timer.id === id)
  }

  /**
   * Insert or replace one timer instance.
   * @param timer - complete instance.
   * @returns after the document is durable.
   */
  async putTimer(timer: TimerInstance): Promise<void> {
    await this.change((document) => {
      const rest = document.timers.instances.filter(entry => entry.id !== timer.id)
      return { ...document, timers: { ...document.timers, instances: [...rest, timer] } }
    })
  }

  /**
   * Remove one timer instance.
   * @param id - timer identity.
   * @returns after the document is durable.
   */
  async removeTimer(id: string): Promise<void> {
    await this.change(document => ({
      ...document,
      timers: { ...document.timers, instances: document.timers.instances.filter(timer => timer.id !== id) },
    }))
  }

  /** Every timer preset. */
  presets(): readonly TimerPreset[] {
    return this.document.timers.presets
  }

  /** One timer preset by identity. */
  preset(id: string): TimerPreset | undefined {
    return this.document.timers.presets.find(preset => preset.id === id)
  }

  /**
   * Insert or replace one timer preset.
   * @param preset - complete preset.
   * @returns after the document is durable.
   */
  async putPreset(preset: TimerPreset): Promise<void> {
    await this.change((document) => {
      const rest = document.timers.presets.filter(entry => entry.id !== preset.id)
      return { ...document, timers: { ...document.timers, presets: [...rest, preset] } }
    })
  }

  /**
   * Remove one timer preset. Adopted instances keep running.
   * @param id - preset identity.
   * @returns after the document is durable.
   */
  async removePreset(id: string): Promise<void> {
    await this.change(document => ({
      ...document,
      timers: { ...document.timers, presets: document.timers.presets.filter(preset => preset.id !== id) },
    }))
  }

  /** Every absence watcher. */
  absences(): readonly AbsenceTimer[] {
    return this.document.timers.absence
  }

  /** One absence watcher by identity. */
  absence(id: string): AbsenceTimer | undefined {
    return this.document.timers.absence.find(entry => entry.id === id)
  }

  /**
   * Insert or replace one absence watcher.
   * @param absence - complete watcher.
   * @returns after the document is durable.
   */
  async putAbsence(absence: AbsenceTimer): Promise<void> {
    await this.change((document) => {
      const rest = document.timers.absence.filter(entry => entry.id !== absence.id)
      return { ...document, timers: { ...document.timers, absence: [...rest, absence] } }
    })
  }

  /**
   * Remove one absence watcher.
   * @param id - watcher identity.
   * @returns after the document is durable.
   */
  async removeAbsence(id: string): Promise<void> {
    await this.change(document => ({
      ...document,
      timers: { ...document.timers, absence: document.timers.absence.filter(entry => entry.id !== id) },
    }))
  }

  /** Latest publication time of every observed kind. */
  lastSeenByKind(): Readonly<Record<string, number>> {
    return this.document.timers.lastSeenByKind
  }

  /**
   * Record publications of one or more kinds and re-arm every affected watcher.
   * @param kinds - published kinds.
   * @param at - publication time.
   * @returns after the document is durable.
   */
  async noteKindsSeen(kinds: readonly string[], at: number): Promise<void> {
    if (kinds.length === 0) return
    await this.change((document) => {
      const lastSeenByKind = { ...document.timers.lastSeenByKind }
      for (const kind of kinds) {
        const previous = lastSeenByKind[kind] ?? 0
        if (at > previous) lastSeenByKind[kind] = at
      }
      const presence = document.timers.absence.map((watcher) => {
        const watched = watcher.kinds.includes('*') || watcher.kinds.some(kind => kinds.includes(kind))
        if (!watched) return watcher
        return {
          ...watcher,
          lastSeenAt: Math.max(watcher.lastSeenAt, at),
          fired: false,
          updatedAt: at,
        }
      })
      return {
        ...document,
        timers: { ...document.timers, lastSeenByKind, absence: presence },
      }
    })
  }

  /** Every custom-event rule. */
  rules(): readonly EventRule[] {
    return this.document.rules.definitions
  }

  /** One rule by identity. */
  rule(id: string): EventRule | undefined {
    return this.document.rules.definitions.find(rule => rule.id === id)
  }

  /**
   * Insert or replace one rule.
   * @param rule - complete rule.
   * @returns after the document is durable.
   */
  async putRule(rule: EventRule): Promise<void> {
    await this.change((document) => {
      const rest = document.rules.definitions.filter(entry => entry.id !== rule.id)
      return { ...document, rules: { definitions: [...rest, rule] } }
    })
  }

  /**
   * Patch a stored rule and return the result.
   * @param id - rule identity.
   * @param patch - fields to replace.
   * @param updatedAt - change time.
   * @param unset - optional fields to remove entirely.
   * @returns the updated rule.
   * @throws ContextGateError `RULE_UNKNOWN` when no rule has the id.
   */
  async patchRule(
    id: string,
    patch: Partial<EventRule>,
    updatedAt: number,
    unset: readonly (keyof Pick<EventRule, 'nextDueAt' | 'lastError' | 'expiresAt' | 'script'>)[] = [],
  ): Promise<EventRule> {
    const current = this.rule(id)
    if (current === undefined) {
      throw new ContextGateError('RULE_UNKNOWN', `rule ${JSON.stringify(id)} does not exist`, { ruleId: id })
    }
    let next: EventRule = { ...current, ...patch, updatedAt }
    if (unset.includes('nextDueAt')) {
      const { nextDueAt: _nextDueAt, ...rest } = next
      next = rest
    }
    if (unset.includes('lastError')) {
      const { lastError: _lastError, ...rest } = next
      next = rest
    }
    if (unset.includes('expiresAt')) {
      const { expiresAt: _expiresAt, ...rest } = next
      next = rest
    }
    if (unset.includes('script')) {
      const { script: _script, ...rest } = next
      next = rest
    }
    await this.putRule(next)
    return next
  }

  /**
   * Remove one rule.
   * @param id - rule identity.
   * @returns after the document is durable.
   */
  async removeRule(id: string): Promise<void> {
    await this.change(document => ({
      ...document,
      rules: { definitions: document.rules.definitions.filter(rule => rule.id !== id) },
    }))
  }

  /**
   * Apply one read-modify-write mutation under the store's serialization.
   * @param mutate - receives the current document and returns the next one.
   * @returns after the document is durable.
   */
  async update(mutate: (document: GateDocument) => GateDocument): Promise<void> {
    await this.change(mutate)
  }

  /**
   * Serialize one read-modify-write mutation.
   * @param mutate - receives the current document and returns the next one.
   * @returns after the rename settles.
   */
  private async change(mutate: (document: GateDocument) => GateDocument): Promise<void> {
    const write = this.writing.then(async () => {
      const next = mutate(this.document)
      if (next === this.document) return
      const document: GateDocument = { ...next, updatedAt: new Date().toISOString() }
      const temporary = `${this.file}.${String(process.pid)}.${randomUUID()}.tmp`
      try {
        await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, 'utf8')
        await rename(temporary, this.file)
      } catch (error: unknown) {
        throw new ContextGateError('STATE_WRITE_FAILED', `context-gate cannot write ${this.file}: ${describeError(error)}`, {
          path: this.file, reason: 'write',
        })
      }
      this.document = document
    })
    this.writing = write.then(() => undefined, () => undefined)
    await write
  }
}

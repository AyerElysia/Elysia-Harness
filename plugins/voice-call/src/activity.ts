/** Shared infrastructure audit; never a persona, model transcript, or private cognition ledger. */
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'
import { defineDomain, domainTable, type Domain } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'
import { VOICE_SESSION_ID } from './session.ts'
import { PROVIDER_SETUP_PHASES, STARTUP_PHASES } from './startup-budget.ts'

const id = z.string().regex(/^[A-Za-z0-9_.:/-]{1,180}$/u)
const code = z.string().regex(/^[A-Za-z0-9_.:/-]{1,120}$/u)
const count = z.number().safe().nonnegative()
/** Intentionally closed engineering fields: no model text, SOUL, raw packets, PCM, keys, or credentials. */
export const VoiceActivityDetailsSchema = z.object({
  reason: code.optional(), code: code.optional(), action: code.optional(),
  httpStatus: z.number().int().min(400).max(599).optional(),
  startupPhase: z.enum(STARTUP_PHASES).optional(), providerSetupPhase: z.enum(PROVIDER_SETUP_PHASES).optional(),
  startupTimedOut: z.boolean().optional(),
  source: code.optional(),
  privacyMode: z.literal('no-raw-audio').optional(), contextPolicy: z.literal('current-call-only').optional(),
  provider: z.literal('openai-realtime').optional(), model: z.literal('gpt-realtime-2.1-mini').optional(),
  physicalAudibilityKnown: z.literal(false).optional(), characters: count.optional(), frames: count.optional(),
  responseId: id.optional(), requestId: id.optional(), itemId: id.optional(), segmentId: id.optional(),
  providerCallId: id.optional(), inputItemId: id.optional(), previousItemId: id.optional(),
  promptHash: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
  promptSource: z.literal('./standing-prompts/SOUL.md').optional(),
  nativeSeq: count.optional(), turn: count.optional(), step: count.optional(),
  plannedFrames: count.optional(), playedFrames: count.optional(), sampleRate: count.optional(),
  fullyPlayed: z.boolean().optional(), clientReported: z.boolean().optional(),
  playbackStatus: z.enum(['planned', 'unknown', 'partial', 'client-reported-full', 'stopped']).optional(),
  inputTokens: count.optional(), outputTokens: count.optional(), totalTokens: count.optional(),
  usageComplete: z.boolean().optional(), complete: z.boolean().optional(),
  agentRegistered: z.boolean().optional(), previousEpoch: count.optional(),
  startedAt: count.optional(), stoppedAt: count.optional(), expiresAt: count.optional(),
  retryable: z.boolean().optional(), rawAudioRecorded: z.literal(false).optional(),
  providerCreated: z.boolean().optional(), providerHangupConfirmed: z.boolean().optional(), cleanupFailed: z.boolean().optional(),
}).strict()
export type VoiceActivityDetails = z.infer<typeof VoiceActivityDetailsSchema>
export interface VoiceActivity {
  readonly type: string
  readonly callId: string
  readonly epoch: number
  readonly at?: number
  readonly sessionId?: string
  readonly occurrenceId?: string
  readonly source?: 'voice-call-controller'
  readonly details?: VoiceActivityDetails
}

export const VoiceInfrastructureRecordSchema = z.object({
  version: z.literal(1), actor: z.literal('infrastructure'), source: z.literal('elysia-voice-call/controller'),
  sessionId: z.literal(VOICE_SESSION_ID), occurrenceId: id,
  type: z.string().regex(/^[a-z][a-z0-9_/-]{0,79}$/u), callId: id, epoch: count, at: count,
  subjectState: z.enum(['attempt-only', 'native-agent-registered']),
  details: VoiceActivityDetailsSchema,
}).strict()
export type VoiceInfrastructureRecord = z.infer<typeof VoiceInfrastructureRecordSchema>
export const VOICE_INFRASTRUCTURE_DOMAIN_NAME = 'elysia_voice_infrastructure'
export const VoiceInfrastructureDomain = defineDomain({
  name: VOICE_INFRASTRUCTURE_DOMAIN_NAME,
  version: 1,
  layout: 'per-record',
  tables: { events: domainTable<string, VoiceInfrastructureRecord>(VoiceInfrastructureRecordSchema) },
})

/**
 * Global storageDomain is the public owner and reader, independent of any live Agent.
 * The returned single writer awaits backend durability before domain/changed.
 * Controller must await this hook before releasing the corresponding external effect.
 */
export function makeRecordActivity(ctx: Context): (event: VoiceActivity) => Promise<void> {
  let opening: Promise<Domain<typeof VoiceInfrastructureDomain>> | undefined
  const open = () => (opening ??= ctx.storageDomain.open(VoiceInfrastructureDomain))
  let tail: Promise<void> = Promise.resolve()
  let closing = false
  ctx.effect(() => async () => {
    closing = true
    await tail.catch(() => undefined)
    if (opening) await (await opening).close()
  }, 'voice-call.infrastructure-audit')
  return async (event) => {
    if (closing) return Promise.reject(new Error('Voice infrastructure audit is closing'))
    if (event.source !== undefined && event.source !== 'voice-call-controller') throw new Error('Invalid voice activity producer')
    const record = VoiceInfrastructureRecordSchema.parse({
      version: 1, actor: 'infrastructure', source: 'elysia-voice-call/controller',
      sessionId: event.sessionId ?? VOICE_SESSION_ID,
      occurrenceId: event.occurrenceId ?? randomUUID(),
      type: event.type, callId: event.callId, epoch: event.epoch, at: event.at ?? Date.now(),
      subjectState: event.details?.agentRegistered === true ? 'native-agent-registered' : 'attempt-only',
      details: event.details ?? {},
    })
    const snapshot = Object.freeze({ ...record, details: Object.freeze({ ...record.details }) })
    const write = tail.then(async () => {
      const table = (await open()).table('events')
      const previous = table.get(record.occurrenceId)
      if (previous) {
        if (!isDeepStrictEqual(previous, snapshot)) throw new Error('Voice infrastructure occurrence collision')
        return
      }
      await table.put(record.occurrenceId, snapshot)
    })
    tail = write.catch(() => undefined)
    return write
  }
}

/** Public bounded diagnostic reader; no private plugin map or model-history copy. */
export function readVoiceActivities(ctx: Context, options: { callId?: string; after?: string; limit?: number } = {}): {
  entries: VoiceInfrastructureRecord[]; nextCursor?: string
} {
  const limit = options.limit ?? 50
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid voice audit page limit')
  const domain = ctx.storageDomain.get(VOICE_INFRASTRUCTURE_DOMAIN_NAME)
  if (!domain) throw new Error('Voice infrastructure audit is not open')
  const entries = [...domain.table('events').entries()]
    .map(([, value]) => VoiceInfrastructureRecordSchema.parse(value))
    .filter(event => options.callId === undefined || event.callId === options.callId)
    .sort((a, b) => a.at - b.at || a.occurrenceId.localeCompare(b.occurrenceId))
  const after = options.after === undefined ? -1 : entries.findIndex(event => event.occurrenceId === options.after)
  if (options.after !== undefined && after < 0) throw new Error('Unknown voice audit cursor')
  const page = entries.slice(after + 1, after + 1 + limit)
  const last = page.at(-1)
  return { entries: page, ...(last && after + 1 + page.length < entries.length ? { nextCursor: last.occurrenceId } : {}) }
}

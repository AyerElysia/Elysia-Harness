/** Replay the retained surface into one consistent local context estimate. */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { lastAssistantStreamChunk } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-compaction'
import type {} from '@deepseek-ai/dsh-compaction-image-offload/projection'
import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import { canonicalHeader, deriveEventMessage, isSurfaceEvent } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type { ContextMetrics, ReportedRequestUsage } from '../metrics-types.ts'
import type { TextCounter } from './counter-types.ts'
import { countMessage, countTools, emptyPrice } from './pricing.ts'
import type { LocalPrice } from './pricing.ts'

const count = z.number().int().nonnegative()
const routeSchema = z.object({ provider: z.string().min(1), model: z.string().min(1) }).strict()
const priceSchema = z.object({
  tokenizerTokens: count, heuristicTokens: count, fallback: z.boolean(),
  tokenizerParts: count, fallbackParts: count, incompleteTypes: z.array(z.string()),
}).strict()
const estimateSchema = z.object({
  systemTokens: count, toolsTokens: count, messageTokens: count, totalTokens: count,
  method: z.enum(['tokenizer', 'heuristic', 'mixed']), tokenizerLabel: z.string().optional(),
  incomplete: z.boolean(), incompleteTypes: z.array(z.string()),
}).strict().refine(value => value.totalTokens === value.systemTokens + value.toolsTokens + value.messageTokens)
const reportRawSchema = z.object({
  inputTokens: z.number().int().positive(), uncachedInputTokens: count, cacheReadTokens: count,
  cacheWriteTokens: count, outputTokens: count, provider: z.string().optional(), model: z.string().optional(),
  recordedAt: z.string().datetime(), seq: count, turn: count.optional(), step: count.optional(),
  attemptId: z.string().optional(), requestId: z.string().optional(),
  purpose: z.enum(['conversation', 'compaction']).optional(),
  relationship: z.enum(['same-context', 'content-changed', 'route-changed', 'unknown']),
}).strict()
// Parsing checks durable/wire values; custom typing preserves exact optional fields.
const reportSchema = z.custom<ReportedRequestUsage>(value => reportRawSchema.safeParse(value).success)
const viewRawSchema = z.object({
  observedSeq: z.number().int().min(-1), route: routeSchema.optional(), contextWindow: z.number().int().positive().optional(),
  estimate: estimateSchema, latestReported: reportRawSchema.optional(),
}).strict()
const viewSchema = z.custom<ContextMetrics>(value => viewRawSchema.safeParse(value).success)
const stateBaseSchema = z.object({
  fingerprint: z.string(), representationRevision: z.number().int().min(-1), observedSeq: z.number().int().min(-1),
  nodes: z.array(priceSchema.extend({ seq: count, system: z.boolean() }).strict()),
  tools: priceSchema, route: routeSchema.optional(), contextWindow: z.number().int().positive().optional(),
  headerHash: z.string().optional(),
  reported: z.object({ value: reportSchema, inputHash: z.string().optional() }).strict().optional(),
  view: viewSchema,
}).strict()

/** Numeric-only checkpoint; no message, prompt, tool schema or original header text. */
export type ContextMetricsState = z.infer<typeof stateBaseSchema>

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap { elysiaContextMetrics: ContextMetricsState }
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

/** Immutable event identities and canonical envelope identify the retained input. */
function inputHash(state: ContextMetricsState): string | undefined {
  if (state.headerHash === undefined) return undefined
  return hash(JSON.stringify([state.headerHash, state.representationRevision, state.nodes.map(node => node.seq)]))
}

function reportedRelationship(state: ContextMetricsState): ReportedRequestUsage['relationship'] {
  const report = state.reported
  if (report === undefined) return 'unknown'
  const value = report.value
  if (state.route !== undefined && ((value.provider !== undefined && value.provider !== state.route.provider)
    || (value.model !== undefined && value.model !== state.route.model))) return 'route-changed'
  if (state.route === undefined || value.provider === undefined || value.model === undefined || report.inputHash === undefined) return 'unknown'
  return inputHash(state) === report.inputHash ? 'same-context' : 'content-changed'
}

function makeView(counter: TextCounter, state: ContextMetricsState): ContextMetrics {
  const supported = state.route !== undefined && counter.supports(state.route.provider, state.route.model)
  const price = (value: LocalPrice): number => supported ? value.tokenizerTokens : value.heuristicTokens
  const systemIndex = state.nodes.findLastIndex(node => node.system && price(node) > 0)
  let systemTokens = 0
  let messageTokens = 0
  let tokenizerParts = state.tools.tokenizerParts
  let fallbackParts = state.tools.fallbackParts
  const incompleteTypes = new Set(state.tools.incompleteTypes)
  for (const [index, node] of state.nodes.entries()) {
    if (index === systemIndex) systemTokens += price(node)
    else messageTokens += price(node)
    tokenizerParts += node.tokenizerParts
    fallbackParts += node.fallbackParts
    for (const type of node.incompleteTypes) incompleteTypes.add(type)
  }
  const toolsTokens = price(state.tools)
  const method = !supported || (fallbackParts > 0 && tokenizerParts === 0)
    ? 'heuristic'
    : fallbackParts > 0 ? 'mixed' : 'tokenizer'
  return {
    observedSeq: state.observedSeq,
    ...state.route === undefined ? {} : { route: state.route },
    ...state.contextWindow === undefined ? {} : { contextWindow: state.contextWindow },
    estimate: {
      systemTokens, toolsTokens, messageTokens, totalTokens: systemTokens + toolsTokens + messageTokens,
      method, ...method === 'heuristic' ? {} : { tokenizerLabel: counter.label },
      incomplete: incompleteTypes.size > 0, incompleteTypes: [...incompleteTypes].sort(),
    },
    ...state.reported === undefined ? {} : {
      latestReported: { ...state.reported.value, relationship: reportedRelationship(state) },
    },
  }
}

function usageFrom(event: SessionEvent): TokenUsage | undefined {
  if (event.type === 'compaction/summary') return event.data.usage
  if (event.type === 'assistant/message' && event.data.usage !== undefined) return event.data.usage
  if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') return undefined
  return lastAssistantStreamChunk(event.data.stream, 'usage')?.usage
}

function captureReport(state: ContextMetricsState, event: SessionEvent): ContextMetricsState['reported'] {
  if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt' && event.type !== 'compaction/summary') return undefined
  const usage = usageFrom(event)
  if (usage === undefined) return undefined
  const cacheReadTokens = usage.cacheReadTokens ?? 0
  const cacheWriteTokens = usage.cacheWriteTokens ?? 0
  const inputTokens = usage.inputTokens + cacheReadTokens + cacheWriteTokens
  // Failed SDK attempts can contain a synthetic all-zero sample. It is no new report.
  if (!Number.isSafeInteger(inputTokens) || inputTokens <= 0) return undefined
  const source = event.type === 'compaction/summary' ? event.data
    : event.type === 'assistant/message' ? event.data.message.source : state.route
  const provider = source?.provider || undefined
  const model = source?.model || undefined
  const finish = event.type === 'compaction/summary' ? undefined : lastAssistantStreamChunk(event.data.stream, 'finish')?.reason
  const requestId = finish?.kind === 'error' || finish?.kind === 'aborted' ? finish.failure.requestId : undefined
  // Compaction's auxiliary instruction is not the ordinary retained input.
  const signature = event.type === 'compaction/summary' ? undefined : inputHash(state)
  return {
    value: {
      inputTokens, uncachedInputTokens: usage.inputTokens, cacheReadTokens, cacheWriteTokens,
      outputTokens: usage.outputTokens,
      ...provider === undefined ? {} : { provider }, ...model === undefined ? {} : { model },
      recordedAt: new Date(event.time).toISOString(), seq: event.seq,
      ...event.type === 'compaction/summary' ? { purpose: 'compaction' as const } : { purpose: 'conversation' as const, turn: event.data.turn, step: event.data.step },
      ...requestId === undefined ? {} : { requestId }, relationship: 'unknown',
    },
    ...signature === undefined ? {} : { inputHash: signature },
  }
}

type ContextMetricsProjection = Omit<ProjectionDefinition<'elysiaContextMetrics', ContextMetricsState>, 'wire'> & {
  wire: NonNullable<ProjectionDefinition<'elysiaContextMetrics', ContextMetricsState>['wire']>
}

/**
 * Build one scope-owned metrics unit with a cache-invalidating counter identity.
 * Current totals are always recomputed from retained nodes, never old API residuals.
 * @param counter - initialized local counter retained for this registration.
 * @param fingerprint - counter/model asset/configuration identity for checkpoint validation.
 * @returns pure native projection definition; register through the caller's effect scope.
 */
export function createContextMetricsProjection(
  counter: TextCounter, fingerprint: string,
): ContextMetricsProjection {
  return {
    key: 'elysiaContextMetrics', stateVersion: 2,
    stateSchema: stateBaseSchema.extend({ fingerprint: z.literal(fingerprint) }),
    init: () => {
      const initial: ContextMetricsState = {
        fingerprint, representationRevision: -1, observedSeq: -1, nodes: [], tools: emptyPrice(),
        view: { observedSeq: -1, estimate: { systemTokens: 0, toolsTokens: 0, messageTokens: 0, totalTokens: 0,
          method: 'heuristic', incomplete: false, incompleteTypes: [] } },
      }
      return { ...initial, view: makeView(counter, initial) }
    },
    apply: (state, event) => {
      let next: ContextMetricsState = { ...state, observedSeq: event.seq }
      // Offloading changes request representation while preserving message seqs.
      if (event.type === 'image/offload') next = { ...next, representationRevision: event.seq }
      const reported = captureReport(state, event)
      if (reported !== undefined) next = { ...next, reported }
      if (event.type === 'request/header') {
        const header = canonicalHeader(event.data.header)
        const { provider, model } = header.config
        const { route: _oldRoute, ...withoutRoute } = next
        next = {
          ...withoutRoute, headerHash: hash(JSON.stringify(header)), tools: countTools(counter, header.tools),
          ...provider.length > 0 && model.length > 0 ? { route: { provider, model } } : {},
        }
      }
      if (event.type === 'request/context') {
        const { contextWindow: _oldWindow, ...withoutWindow } = next
        next = { ...withoutWindow, ...event.data.contextWindow === undefined ? {} : { contextWindow: event.data.contextWindow } }
      }
      if (isSurfaceEvent(event)) {
        const node = { ...countMessage(counter, deriveEventMessage(event)), seq: event.seq, system: event.type === 'system/message' }
        const op = event.surfaceOp
        if (op === 'append') next = { ...next, nodes: [...next.nodes, node] }
        else {
          const start = next.nodes.findIndex(value => value.seq === op.startSeq)
          const end = next.nodes.findIndex(value => value.seq === op.endSeq)
          if (start < 0 || end < start) throw new Error('Context metrics replacement references an unavailable surface range')
          next = { ...next, nodes: [...next.nodes.slice(0, start), node, ...next.nodes.slice(end + 1)] }
        }
      }
      return { ...next, view: makeView(counter, next) }
    },
    wire: { viewSchema, view: state => state.view },
  }
}

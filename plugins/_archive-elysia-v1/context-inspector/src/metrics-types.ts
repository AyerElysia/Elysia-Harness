/** Consistent estimates of the retained context, separate from actual past API usage. */
import type { CounterStatus, TokenizerFailure, TokenizerFailureCode } from './metrics/counter-types.ts'

export type { CounterStatus, TokenizerFailure, TokenizerFailureCode }

export interface MetricsRoute {
  provider: string
  model: string
}
export interface CurrentContextEstimate {
  systemTokens: number
  toolsTokens: number
  messageTokens: number
  /** Always exactly systemTokens + toolsTokens + messageTokens. */
  totalTokens: number
  method: 'tokenizer' | 'heuristic' | 'mixed'
  /** Name of the local reference tokenizer, never a claim of provider-exact counting. */
  tokenizerLabel?: string
  /** Attachments or extension blocks whose provider input representation is not fully priced. */
  incomplete: boolean
  incompleteTypes: string[]
}
export interface ReportedRequestUsage {
  /** Provider-reported prompt total: uncached + cache reads + cache writes; excludes output. */
  inputTokens: number
  purpose?: 'conversation' | 'compaction'
  uncachedInputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  outputTokens: number
  provider?: string
  model?: string
  recordedAt: string
  seq: number
  turn?: number
  step?: number
  attemptId?: string
  requestId?: string
  /** Exact report identity relative to the current retained input, not an estimated correction. */
  relationship: 'same-context' | 'content-changed' | 'route-changed' | 'unknown'
}
export interface ContextMetrics {
  observedSeq: number
  route?: MetricsRoute
  contextWindow?: number
  estimate: CurrentContextEstimate
  latestReported?: ReportedRequestUsage
  /** Counting quality for this mount; absent only on checkpoints written before it existed. */
  counter?: CounterStatus
}
declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    elysiaContextMetrics: ContextMetrics
  }
}

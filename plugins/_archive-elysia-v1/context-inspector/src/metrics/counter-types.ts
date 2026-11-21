/** Synchronous, initialized-once text counting used by the pure metrics projection. */
export type TokenizerFailureCode =
  | 'assets-missing'
  | 'assets-unreadable'
  | 'manifest-invalid'
  | 'asset-integrity'
  | 'asset-invalid'
  | 'asset-policy'
  | 'runtime-unavailable'

/** Why the pinned reference tokenizer could not be used this mount. */
export interface TokenizerFailure {
  code: TokenizerFailureCode
  /** Operator-facing reason; never contains a filesystem path or counted text. */
  message: string
  /** Pinned upstream asset revision when the manifest itself was readable. */
  assetRevision?: string
}

/** Observable counting mode, so consumers never present weighted estimates as exact. */
export interface CounterStatus {
  mode: 'tokenizer' | 'heuristic'
  /** Known multiplicative overestimate of the weighted fallback for English. */
  heuristicBiasRatio?: number
  failure?: TokenizerFailure
}

export interface TextTokenCounts {
  tokenizerTokens: number
  heuristicTokens: number
  /** Local tokenizer was budget-limited; complete text was still priced by the fallback. */
  fallback: boolean
}

export interface TextCounter {
  id: string
  label: string
  readonly status: CounterStatus
  supports(provider: string, model: string): boolean
  count(text: string): TextTokenCounts
}

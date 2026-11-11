/** Synchronous, initialized-once text counting used by the pure metrics projection. */
export interface TextTokenCounts {
  tokenizerTokens: number
  heuristicTokens: number
  /** Local tokenizer was budget-limited; complete text was still priced by the fallback. */
  fallback: boolean
}
export interface TextCounter {
  id: string
  label: string
  supports(provider: string, model: string): boolean
  count(text: string): TextTokenCounts
}

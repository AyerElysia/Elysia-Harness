/** Numeric-only local prices for durable messages and tool schemas. */
import type { ContentBlock, Message, ToolSchema } from '@deepseek-ai/dsh-llm'
import type { TextCounter } from './counter-types.ts'

/** Both local prices are retained so changing routes never requires cached source text. */
export interface LocalPrice {
  tokenizerTokens: number
  heuristicTokens: number
  fallback: boolean
  tokenizerParts: number
  fallbackParts: number
  incompleteTypes: string[]
}

const ROLE_TOKENS = 4
const BLOCK_TOKENS = 4

/** Empty complete price for a missing message or absent tool list. */
export function emptyPrice(): LocalPrice {
  return { tokenizerTokens: 0, heuristicTokens: 0, fallback: false, tokenizerParts: 0, fallbackParts: 0, incompleteTypes: [] }
}

function add(left: LocalPrice, right: LocalPrice): LocalPrice {
  return {
    tokenizerTokens: left.tokenizerTokens + right.tokenizerTokens,
    heuristicTokens: left.heuristicTokens + right.heuristicTokens,
    fallback: left.fallback || right.fallback,
    tokenizerParts: left.tokenizerParts + right.tokenizerParts,
    fallbackParts: left.fallbackParts + right.fallbackParts,
    incompleteTypes: [...new Set([...left.incompleteTypes, ...right.incompleteTypes])].sort(),
  }
}

function framing(tokens: number): LocalPrice {
  return { tokenizerTokens: tokens, heuristicTokens: tokens, fallback: false, tokenizerParts: 0, fallbackParts: 0, incompleteTypes: [] }
}

function textPrice(counter: TextCounter, text: string): LocalPrice {
  if (text.length === 0) return emptyPrice()
  const result = counter.count(text)
  return {
    ...result,
    tokenizerTokens: result.fallback ? result.heuristicTokens : result.tokenizerTokens,
    tokenizerParts: result.fallback ? 0 : 1, fallbackParts: result.fallback ? 1 : 0,
    incompleteTypes: [],
  }
}

function blockPrice(counter: TextCounter, block: ContentBlock): LocalPrice {
  switch (block.type) {
    case 'text':
    case 'reasoning':
      return add(textPrice(counter, block.text), framing(BLOCK_TOKENS))
    case 'tool-call':
      return add(add(textPrice(counter, block.name), textPrice(counter, block.arguments)), framing(BLOCK_TOKENS))
    default: {
      // Reference JSON prices structural text only; visual/file projections and
      // extension-specific rendering remain explicitly incomplete.
      return {
        ...add(textPrice(counter, JSON.stringify(block)), framing(BLOCK_TOKENS)),
        incompleteTypes: [block.type],
      }
    }
  }
}

/**
 * Count one retained message without storing its content in projection state.
 * Framing remains an estimate even when its text uses the local tokenizer.
 * @param counter - initialized synchronous counter.
 * @param message - durable model-facing message, or no derived message.
 * @returns two complete local prices plus unsupported-content markers.
 */
export function countMessage(counter: TextCounter, message: Message | null): LocalPrice {
  if (message === null || (message.role === 'system' && message.content.length === 0)) return emptyPrice()
  if (message.role === 'system' && message.content.every(block => block.type === 'text')) {
    const text = message.content.map(block => block.type === 'text' ? block.text : '').join('')
    return add(textPrice(counter, text), framing(ROLE_TOKENS))
  }
  return message.content.reduce((price, block) => add(price, blockPrice(counter, block)), framing(ROLE_TOKENS))
}

/**
 * Count the latest tool schemas; the serializer and framing are reference estimates.
 * @param counter - initialized synchronous counter.
 * @param tools - tools from the latest canonical request header.
 * @returns local schema price without retaining the schema text.
 */
export function countTools(counter: TextCounter, tools: readonly ToolSchema[] | undefined): LocalPrice {
  return tools === undefined || tools.length === 0
    ? emptyPrice()
    : add(textPrice(counter, JSON.stringify(tools)), framing(BLOCK_TOKENS))
}

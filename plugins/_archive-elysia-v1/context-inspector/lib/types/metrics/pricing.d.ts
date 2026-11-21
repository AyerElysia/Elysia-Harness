/** Numeric-only local prices for durable messages and tool schemas. */
import type { Message, ToolSchema } from '@deepseek-ai/dsh-llm';
import type { TextCounter } from './counter-types.ts';
/** Both local prices are retained so changing routes never requires cached source text. */
export interface LocalPrice {
    tokenizerTokens: number;
    heuristicTokens: number;
    fallback: boolean;
    tokenizerParts: number;
    fallbackParts: number;
    incompleteTypes: string[];
}
/** Empty complete price for a missing message or absent tool list. */
export declare function emptyPrice(): LocalPrice;
/**
 * Count one retained message without storing its content in projection state.
 * Framing remains an estimate even when its text uses the local tokenizer.
 * @param counter - initialized synchronous counter.
 * @param message - durable model-facing message, or no derived message.
 * @returns two complete local prices plus unsupported-content markers.
 */
export declare function countMessage(counter: TextCounter, message: Message | null): LocalPrice;
/**
 * Count the latest tool schemas; the serializer and framing are reference estimates.
 * @param counter - initialized synchronous counter.
 * @param tools - tools from the latest canonical request header.
 * @returns local schema price without retaining the schema text.
 */
export declare function countTools(counter: TextCounter, tools: readonly ToolSchema[] | undefined): LocalPrice;
//# sourceMappingURL=pricing.d.ts.map
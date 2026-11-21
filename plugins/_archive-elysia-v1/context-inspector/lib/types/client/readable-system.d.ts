/** Lossless display projection: unwrap JSON strings only, retaining every message and non-text value. */
export interface ReadableSystemBlock {
    readonly source: string;
    readonly text: string;
}
/**
 * Decode a complete system-section JSON without summarising, dropping messages
 * or interpreting their meaning. Unknown shapes keep their entire JSON value.
 */
export declare function readableSystemBlocks(text: string): readonly ReadableSystemBlock[];
//# sourceMappingURL=readable-system.d.ts.map
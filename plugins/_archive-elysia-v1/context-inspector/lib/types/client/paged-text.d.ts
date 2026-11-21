/** Bounded, cancellable text loading that never labels an incomplete prefix as the full request. */
export interface TextChunk {
    readonly offset: number;
    readonly nextOffset: number;
    readonly totalBytes: number;
    readonly text: string;
    readonly complete: boolean;
}
export interface TextSnapshot {
    readonly text: string;
    readonly loadedBytes: number;
    readonly totalBytes: number;
    readonly complete: boolean;
    readonly loading: boolean;
    readonly error: string | null;
}
export type ReadTextChunk = (offset: number, signal: AbortSignal) => Promise<TextChunk>;
/** An immutable request/section's view-owned reader; teardown cancels and releases its retained text. */
export declare class PagedTextReader {
    private readonly read;
    private state;
    private readonly listeners;
    private controller;
    private disposed;
    constructor(read: ReadTextChunk, totalBytes: number);
    readonly getSnapshot: () => TextSnapshot;
    readonly subscribe: (listener: () => void) => (() => void);
    /** Load one bounded page, or explicitly follow all remaining pages until complete/cancelled. */
    load(all?: boolean): Promise<void>;
    /** Stop a pending read while retaining its already validated prefix for a later continuation. */
    cancel(): void;
    /** Release all view-owned state; late transport replies cannot publish after disposal. */
    dispose(): void;
    private validate;
    private publish;
}
//# sourceMappingURL=paged-text.d.ts.map
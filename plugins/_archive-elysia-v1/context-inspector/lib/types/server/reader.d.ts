import type { LatestResponse, ReadRequest, ReadResponse, SnapshotMetadata } from '../types.ts';
export interface ReaderLimits {
    maxArchiveBytes: number;
    maxCacheBytes: number;
    maxWorkers: number;
    maxChunkBytes: number;
    workerTimeoutMs?: number;
}
export declare class SnapshotReader {
    readonly dir: string;
    readonly limits: ReaderLimits;
    private readonly index;
    private readonly cache;
    private readonly jobs;
    private readonly workers;
    private readonly terminations;
    private cachedBytes;
    private closed;
    constructor(dir: string, limits: ReaderLimits);
    latest(sessionId: string, signal: AbortSignal): Promise<LatestResponse>;
    read(request: ReadRequest, signal: AbortSignal): Promise<ReadResponse>;
    /** Explicit maintenance seed of one already-known file; never discovers archive bodies. */
    seed(sessionId: string, requestId: string, signal: AbortSignal): Promise<SnapshotMetadata>;
    dispose(): Promise<void>;
    private check;
    private load;
    private startJob;
}
//# sourceMappingURL=reader.d.ts.map
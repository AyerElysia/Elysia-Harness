/** Session-scoped Remote API; existing Gateway owns authentication and resource access. */
import type { Context } from '@deepseek-ai/cordis';
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import type { LatestRequest, LatestResponse, ReadRequest, ReadResponse } from '../types.ts';
import { SnapshotReader, type ReaderLimits } from './reader.ts';
export interface InspectorConfig extends ReaderLimits {
    dir: string;
}
declare module '@deepseek-ai/cordis' {
    interface Context {
        contextInspector: ContextInspector;
    }
}
export declare class ContextInspector extends TypertRemoteService {
    static inject: string[];
    readonly reader: SnapshotReader;
    constructor(ctx: Context, config: InspectorConfig);
    /** Read the selected session's latest indexed archived request without activating an agent. */
    latest(request: LatestRequest, signal: AbortSignal): Promise<LatestResponse>;
    /** Read one immutable archived section with an exact UTF-8 continuation cursor. */
    read(request: ReadRequest, signal: AbortSignal): Promise<ReadResponse>;
}
//# sourceMappingURL=controller.d.ts.map
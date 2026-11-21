/** Session-bound adapter over the existing authenticated DSH Gateway carrier. */
import type { ClientConnectionRpc } from '@deepseek-ai/dsh-client-connection/client';
import type { LatestResponse, ReadResponse, Section, SnapshotMetadata } from '../types.ts';
export declare const SECTIONS: readonly Section[];
export declare const PAGE_BYTES: number;
export interface InspectorApi {
    latest(signal: AbortSignal): Promise<LatestResponse>;
    read(request: SnapshotMetadata, section: Section, offset: number, signal: AbortSignal): Promise<ReadResponse>;
}
/** Bind the session selected by the official Conversation slot; never infer it from location or a global. */
export declare function createInspectorApi(rpc: Pick<ClientConnectionRpc, 'call'>, sessionId: string): InspectorApi;
//# sourceMappingURL=api.d.ts.map
/** Public failures never contain archive excerpts, credentials or filesystem paths. */
export type InspectionErrorCode = 'invalid-request' | 'index-unavailable' | 'archive-unavailable' | 'archive-invalid' | 'archive-too-large' | 'busy' | 'cancelled' | 'disposed';
export declare class InspectionError extends Error {
    readonly code: InspectionErrorCode;
    constructor(code: InspectionErrorCode);
}
/** Register sanitized plugin failures with the native Remote error contract. */
type InspectorRemoteErrors = Record<`contextInspector/${InspectionErrorCode}`, Record<string, never>>;
declare module '@deepseek-ai/dsh-typert-protocol' {
    interface RemoteErrorDetailsMap extends InspectorRemoteErrors {
    }
}
export {};
//# sourceMappingURL=errors.d.ts.map
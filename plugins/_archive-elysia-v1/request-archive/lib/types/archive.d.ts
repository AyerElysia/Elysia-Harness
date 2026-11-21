import { type GenerateOptions } from '@deepseek-ai/dsh-llm';
/** The archive could not be written, so the model call must not proceed. */
export declare class RequestArchiveError extends Error {
    constructor(message: string, options?: {
        cause?: unknown;
    });
}
/** One retained model request, independent of later session projection. */
export interface ArchivedRequest {
    id: string;
    recordedAt: string;
    /** Whether dsh-agent-loop assembled this exact object. */
    loop: boolean;
    request: {
        provider: string;
        model: string;
        messages: GenerateOptions['messages'];
        reasoningEffort?: GenerateOptions['reasoningEffort'];
        system?: string;
        tools?: GenerateOptions['tools'];
        toolHistory?: GenerateOptions['toolHistory'];
        temperature?: number;
        maxTokens?: number;
        stop?: string[];
        sessionId?: string;
        purpose?: GenerateOptions['purpose'];
    };
}
/** Copy the request fields that reach the adapter. The abort signal is not part of the prompt. */
export declare function snapshotRequest(options: GenerateOptions): ArchivedRequest['request'];
/**
 * Write one complete request as its own JSON file.
 * A crash during the write leaves only a `.partial` file, never a truncated final record.
 */
export declare function archiveRequest(dir: string, options: GenerateOptions): string;
//# sourceMappingURL=archive.d.ts.map
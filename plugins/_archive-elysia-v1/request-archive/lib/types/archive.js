import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { isAgentLoopRequest } from '@deepseek-ai/dsh-llm';
/** The archive could not be written, so the model call must not proceed. */
export class RequestArchiveError extends Error {
    constructor(message, options) {
        super(message, options);
        this.name = 'RequestArchiveError';
    }
}
/** Copy the request fields that reach the adapter. The abort signal is not part of the prompt. */
export function snapshotRequest(options) {
    return {
        provider: options.provider,
        model: options.model,
        messages: options.messages,
        ...options.reasoningEffort === undefined ? {} : { reasoningEffort: options.reasoningEffort },
        ...options.system === undefined ? {} : { system: options.system },
        ...options.tools === undefined ? {} : { tools: options.tools },
        ...options.toolHistory === undefined ? {} : { toolHistory: options.toolHistory },
        ...options.temperature === undefined ? {} : { temperature: options.temperature },
        ...options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens },
        ...options.stop === undefined ? {} : { stop: options.stop },
        ...options.sessionId === undefined ? {} : { sessionId: options.sessionId },
        ...options.purpose === undefined ? {} : { purpose: options.purpose },
    };
}
/**
 * Write one complete request as its own JSON file.
 * A crash during the write leaves only a `.partial` file, never a truncated final record.
 */
export function archiveRequest(dir, options) {
    const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomBytes(4).toString('hex')}`;
    const record = {
        id,
        recordedAt: new Date().toISOString(),
        loop: isAgentLoopRequest(options),
        request: snapshotRequest(options),
    };
    const finalPath = join(dir, `${id}.json`);
    const partialPath = `${finalPath}.partial`;
    try {
        mkdirSync(dir, { recursive: true });
        writeFileSync(partialPath, `${JSON.stringify(record, null, 2)}\n`);
        renameSync(partialPath, finalPath);
    }
    catch (error) {
        throw new RequestArchiveError(`failed to archive the model request: ${finalPath}`, { cause: error });
    }
    return finalPath;
}
//# sourceMappingURL=archive.js.map
/**
 * Retain every model request as its own JSON file before the adapter sends it.
 * The session log can later shadow or replace history; these files stay.
 * @module @elysia/request-archive
 */
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
export { RequestArchiveError, archiveRequest, snapshotRequest } from './archive.ts';
export type { ArchivedRequest } from './archive.ts';
/**
 * Default directory for retained requests. Prompt files stay beside it, not in this package.
 * `ELYSIA_ROOT` names the Elysium home; `ELYSIA_REQUESTS_DIR` overrides the directory outright.
 */
export declare const DEFAULT_REQUEST_DIR: any;
/** Cordis plugin name. */
export declare const name = "elysia-request-archive";
/** The streaming model call this archive observes. */
export declare const inject: string[];
/** Plugin config: where each complete request is written. */
export interface Config {
    /** Absolute directory, or a path relative to the process cwd at mount time. */
    dir?: string;
}
/** Runtime schema for the request archive. */
export declare const Config: z<Config>;
/**
 * Record `llm/stream` requests, then continue the call.
 * A write failure rejects the stream before the adapter runs.
 * @param ctx - context that already provides `llm`.
 * @param config - archive directory.
 */
export declare function apply(ctx: Context, config: Config): void;
//# sourceMappingURL=index.d.ts.map
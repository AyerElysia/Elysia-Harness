/**
 * Retain every model request as its own JSON file before the adapter sends it.
 * The session log can later shadow or replace history; these files stay.
 * @module @elysia/request-archive
 */
import z from '@deepseek-ai/schemastery';
import { isAbsolute, join, resolve } from 'node:path';
import { archiveRequest } from "./archive.js";
export { RequestArchiveError, archiveRequest, snapshotRequest } from "./archive.js";
/**
 * Default directory for retained requests. Prompt files stay beside it, not in this package.
 * `ELYSIA_ROOT` names the Elysium home; `ELYSIA_REQUESTS_DIR` overrides the directory outright.
 */
export const DEFAULT_REQUEST_DIR = process.env.ELYSIA_REQUESTS_DIR
    ?? join(process.env.ELYSIA_ROOT ?? '/home/ayerelysia/Elysia', 'Data/requests');
/** Cordis plugin name. */
export const name = 'elysia-request-archive';
/** The streaming model call this archive observes. */
export const inject = ['llm'];
/** Runtime schema for the request archive. */
export const Config = z.object({
    dir: z.string().default(DEFAULT_REQUEST_DIR),
});
/**
 * Record `llm/stream` requests, then continue the call.
 * A write failure rejects the stream before the adapter runs.
 * @param ctx - context that already provides `llm`.
 * @param config - archive directory.
 */
export function apply(ctx, config) {
    const configured = config.dir ?? DEFAULT_REQUEST_DIR;
    const dir = isAbsolute(configured) ? configured : resolve(process.cwd(), configured);
    ctx.on('llm/stream', (options, next) => {
        archiveRequest(dir, options);
        return next();
    });
}
//# sourceMappingURL=index.js.map
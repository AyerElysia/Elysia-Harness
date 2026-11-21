/**
 * Retain every model request as its own JSON file before the adapter sends it.
 * The session log can later shadow or replace history; these files stay.
 * @module @elysia/request-archive
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { isAbsolute, join, resolve } from 'node:path'
import type {} from '@deepseek-ai/dsh-llm'
import { archiveRequest } from './archive.ts'
import { RequestArchiveIndex } from './index-store.ts'
import {
  ArchiveRetention, DEFAULT_MAX_AGE_DAYS, DEFAULT_MAX_BYTES, DEFAULT_MAX_FILES, type RetentionLimits,
} from './retention.ts'

export { RequestArchiveError, archiveRequest, snapshotRequest, writeArchiveRequest } from './archive.ts'
export type { ArchiveFormat, ArchiveWrite, ArchivedRequest } from './archive.ts'
export { ArchiveRetention, DEFAULT_MAX_AGE_DAYS, DEFAULT_MAX_BYTES, DEFAULT_MAX_FILES } from './retention.ts'
export type { RetentionLimits, RetentionReport } from './retention.ts'

/**
 * Default directory for retained requests. Prompt files stay beside it, not in this package.
 * `ELYSIA_ROOT` names the Elysium home; `ELYSIA_REQUESTS_DIR` overrides the directory outright.
 */
export const DEFAULT_REQUEST_DIR = process.env.ELYSIA_REQUESTS_DIR
  ?? join(process.env.ELYSIA_ROOT ?? '/home/ayerelysia/Elysia', 'Data/requests')

/** Cordis plugin name. */
export const name = 'elysia-request-archive'

/** The streaming model call this archive observes. */
export const inject = ['llm']

/** Plugin config: where each complete request is written and what the directory keeps. */
export interface Config {
  /** Absolute directory, or a path relative to the process cwd at mount time. */
  dir?: string
  /** Archived files kept before the oldest are evicted; 0 keeps every file. */
  maxFiles?: number
  /** Total archived bytes kept before the oldest are evicted; 0 keeps every byte. */
  maxBytes?: number
  /** Days a record survives regardless of the other bounds; 0 keeps records forever. */
  maxAgeDays?: number
  /** Single-line JSON. Set false only when a human reads the files directly. */
  compact?: boolean
}

/** Runtime schema for the request archive. */
export const Config: z<Config> = z.object({
  dir: z.string().default(DEFAULT_REQUEST_DIR),
  maxFiles: z.natural().default(DEFAULT_MAX_FILES),
  maxBytes: z.natural().default(DEFAULT_MAX_BYTES),
  maxAgeDays: z.natural().default(DEFAULT_MAX_AGE_DAYS),
  compact: z.boolean().default(true),
})

/** Fill unset bounds with their documented defaults; the schema does the same for loaded config. */
function limitsOf(config: Config): RetentionLimits {
  return {
    maxFiles: config.maxFiles ?? DEFAULT_MAX_FILES,
    maxBytes: config.maxBytes ?? DEFAULT_MAX_BYTES,
    maxAgeDays: config.maxAgeDays ?? DEFAULT_MAX_AGE_DAYS,
  }
}

/**
 * Record `llm/stream` requests, then continue the call.
 * A write failure rejects the stream before the adapter runs. Retention runs after
 * the write and never blocks it.
 * @param ctx - context that already provides `llm`.
 * @param config - archive directory, retention bounds, and serialization.
 */
export function apply(ctx: Context, config: Config): void {
  const configured = config.dir ?? DEFAULT_REQUEST_DIR
  const dir = isAbsolute(configured) ? configured : resolve(process.cwd(), configured)
  const index = new RequestArchiveIndex(dir)
  const retention = new ArchiveRetention(dir, limitsOf(config))
  ctx.effect(() => async () => {
    await retention.dispose()
    await index.flush()
  }, 'request-archive.writes')
  // Enforce the bounds a previous run left behind, without delaying the first model call.
  void retention.prune().catch(() => {
    ctx.logger('request-archive').warn('Request archive retention pass failed; snapshots retained')
  })
  ctx.on('llm/stream', (options, next) => {
    const format = config.compact === undefined ? {} : { compact: config.compact }
    const written = archiveRequest(dir, options, entry => {
      void index.record(entry).catch(() => {
        ctx.logger('request-archive').warn('Request archive metadata index write failed; snapshot retained')
      })
    }, format)
    retention.afterWrite(written.bytes)
    return next()
  })
}

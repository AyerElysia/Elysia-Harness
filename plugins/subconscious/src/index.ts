import type { Context } from '@deepseek-ai/cordis'
import { Config } from './config.ts'
import { RouterRuntime } from './runtime.ts'

export { Config } from './config.ts'
export { MAIN_SESSION_ID, ROUTER_SESSION_CWD, ROUTER_SESSION_ID, batchContent, isExternalInput } from './model.ts'
export { RouterRuntime } from './runtime.ts'
export { RouterStore } from './store.ts'
export type { RouterHealth } from './store.ts'

export const name = 'elysia-subconscious'
export const inject = ['agents', 'agentDefaultModel', 'agentLoop', 'sessionPersistence', 'sessions']
export { Config as ConfigSchema }

/** Mount the durable surface collector and one lazily resumed long Router session. */
export function apply(ctx: Context, config: Config): void {
  const resolved: Required<Config> = {
    baseDir: config.baseDir,
    files: config.files,
    required: config.required ?? ['SOUL.md', 'SUBCONSCIOUS-ROUTER.md'],
    stateDir: config.stateDir ?? '/home/ayerelysia/Elysia/Data/subconscious/router',
    workspaceDir: config.workspaceDir ?? '/home/ayerelysia/Elysia/Data/workspace/subconscious/router',
    maxObservations: config.maxObservations ?? 20,
    maxBytes: config.maxBytes ?? 65536,
    collectMs: config.collectMs ?? 2000,
    skillsDir: config.skillsDir ?? '/home/ayerelysia/Elysia/Data/workspace/skills',
    backupDir: config.backupDir ?? `${config.stateDir ?? '/home/ayerelysia/Elysia/Data/subconscious/router'}/standing-prompt-backups`,
    maxBackgroundJobs: config.maxBackgroundJobs ?? 4,
    maxJobAgeMs: config.maxJobAgeMs ?? 1_800_000,
    jobSweepMs: config.jobSweepMs ?? 30_000,
    shellTimeoutMs: config.shellTimeoutMs ?? 120_000,
    shellMaxTimeoutMs: config.shellMaxTimeoutMs ?? 600_000,
    provider: config.provider ?? ctx.agentDefaultModel.currentSelection().provider,
    model: config.model ?? ctx.agentDefaultModel.currentSelection().model,
  }
  const runtime = new RouterRuntime(ctx, resolved)
  runtime.start()
  ctx.effect(() => () => runtime.dispose(), 'elysia-subconscious.runtime()')
}

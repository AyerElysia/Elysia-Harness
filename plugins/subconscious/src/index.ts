import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-commands'
import { Config } from './config.ts'
import { RouterRuntime } from './runtime.ts'

export { Config } from './config.ts'
export { MAIN_SESSION_ID, ROUTER_SESSION_CWD, ROUTER_SESSION_ID, batchContent, isExternalInput } from './model.ts'
export { MEMORY_SESSION_ID } from './dispatch.ts'
export type { DispatchHealth, SubconsciousTask, TaskAssignment, TaskMandate, TaskReport } from './dispatch.ts'
export { DispatchError, DispatchStore } from './dispatch-store.ts'
export { RouterRuntime } from './runtime.ts'
export { RouterStore } from './store.ts'
export type { RouterHealth } from './store.ts'

export const name = 'elysia-subconscious'
export const inject = ['agents', 'agentDefaultModel', 'agentLoop', 'sessionPersistence', 'sessions', 'commands']
export { Config as ConfigSchema }

/** Mount the durable collector, one long Router, and the long memory specialist. */
export function apply(ctx: Context, config: Config): void {
  const stateDir = config.stateDir ?? '/home/ayerelysia/Elysia/Data/subconscious/router'
  const resolved: Required<Config> = {
    baseDir: config.baseDir,
    files: config.files,
    required: config.required ?? ['SOUL.md', 'SUBCONSCIOUS-ROUTER.md'],
    stateDir,
    workspaceDir: config.workspaceDir ?? '/home/ayerelysia/Elysia/Data/workspace/subconscious/router',
    memoryWorkspaceDir: config.memoryWorkspaceDir ?? '/home/ayerelysia/Elysia/Data/workspace/subconscious/memory',
    memoryFiles: config.memoryFiles ?? ['SOUL.md', 'USER.md', 'MEMORY.md', 'SUBCONSCIOUS-MEMORY.md'],
    memoryRequired: config.memoryRequired ?? ['SOUL.md', 'SUBCONSCIOUS-MEMORY.md'],
    memoryBackupDir: config.memoryBackupDir ?? `${stateDir}/memory-standing-prompt-backups`,
    maxObservations: config.maxObservations ?? 20,
    maxBytes: config.maxBytes ?? 65536,
    collectMs: config.collectMs ?? 2000,
    triggerBatchCount: config.triggerBatchCount ?? 1,
    maxTasksPerTrigger: config.maxTasksPerTrigger ?? 3,
    maxQueuedTasks: config.maxQueuedTasks ?? 20,
    assignmentMaxRunMs: config.assignmentMaxRunMs ?? 900_000,
    skillsDir: config.skillsDir ?? '/home/ayerelysia/Elysia/Data/workspace/skills',
    readOnlyDirs: config.readOnlyDirs ?? [],
    backupDir: config.backupDir ?? `${stateDir}/standing-prompt-backups`,
    maxBackgroundJobs: config.maxBackgroundJobs ?? 4,
    maxJobAgeMs: config.maxJobAgeMs ?? 1_800_000,
    jobSweepMs: config.jobSweepMs ?? 30_000,
    shellTimeoutMs: config.shellTimeoutMs ?? 120_000,
    shellMaxTimeoutMs: config.shellMaxTimeoutMs ?? 600_000,
    provider: config.provider ?? ctx.agentDefaultModel.currentSelection().provider,
    model: config.model ?? ctx.agentDefaultModel.currentSelection().model,
  }
  const runtime = new RouterRuntime(ctx, resolved)
  ctx.effect(() => ctx.commands.register({
    name: 'subconscious',
    description: '查看潜意识中枢状态，或设置多少批合并研判一次',
    input: { hint: 'status | trigger <正整数>' },
    handler: invocation => runtime.executeCommand(invocation.rawInput),
  }), 'elysia-subconscious.command()')
  runtime.start()
  ctx.effect(() => () => runtime.dispose(), 'elysia-subconscious.runtime()')
}

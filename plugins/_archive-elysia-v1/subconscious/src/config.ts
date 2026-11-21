import { dirname, join } from 'node:path'
import z from '@deepseek-ai/schemastery'

export interface Config {
  baseDir: string
  files: string[]
  required?: string[]
  stateDir?: string
  workspaceDir?: string
  memoryWorkspaceDir?: string
  memoryFiles?: string[]
  memoryRequired?: string[]
  memoryBackupDir?: string
  maxObservations?: number
  maxBytes?: number
  collectMs?: number
  triggerBatchCount?: number
  maxTasksPerTrigger?: number
  maxQueuedTasks?: number
  maxBatchAttempts?: number
  maxDeliveryAttempts?: number
  maxReportRelayAttempts?: number
  assignmentMaxRunMs?: number
  skillsDir?: string
  readOnlyDirs?: string[]
  backupDir?: string
  maxBackgroundJobs?: number
  maxJobAgeMs?: number
  jobSweepMs?: number
  shellTimeoutMs?: number
  shellMaxTimeoutMs?: number
  provider?: string
  model?: string
}

export const Config: z<Config> = z.object({
  baseDir: z.string().required(),
  files: z.array(z.string()).default(['SOUL.md', 'USER.md', 'MEMORY.md', 'SUBCONSCIOUS-ROUTER.md']),
  required: z.array(z.string()).default(['SOUL.md', 'SUBCONSCIOUS-ROUTER.md']),
  // 部署路径必须由 profile 提供：插件不内置任何主机绝对路径，缺失时在挂载阶段明确失败。
  stateDir: z.string().required(),
  workspaceDir: z.string().required(),
  memoryWorkspaceDir: z.string(),
  memoryFiles: z.array(z.string()).default(['SOUL.md', 'USER.md', 'MEMORY.md', 'SUBCONSCIOUS-MEMORY.md']),
  memoryRequired: z.array(z.string()).default(['SOUL.md', 'SUBCONSCIOUS-MEMORY.md']),
  memoryBackupDir: z.string(),
  maxObservations: z.number().default(20),
  maxBytes: z.number().default(65536),
  collectMs: z.number().default(2000),
  triggerBatchCount: z.number().default(1),
  maxTasksPerTrigger: z.number().default(3),
  maxQueuedTasks: z.number().default(20),
  maxBatchAttempts: z.number().default(5),
  maxDeliveryAttempts: z.number().default(5),
  maxReportRelayAttempts: z.number().default(5),
  assignmentMaxRunMs: z.number().default(900000),
  skillsDir: z.string().required(),
  readOnlyDirs: z.array(z.string()).default([]),
  backupDir: z.string(),
  maxBackgroundJobs: z.number().default(4),
  maxJobAgeMs: z.number().default(1_800_000),
  jobSweepMs: z.number().default(30_000),
  shellTimeoutMs: z.number().default(120_000),
  shellMaxTimeoutMs: z.number().default(600_000),
  provider: z.string(),
  model: z.string(),
})

export class ConfigError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'ConfigError'
  }
}

/** 部署路径只能来自 profile：缺失时明确失败，而不是落到某个写死的主机目录。 */
export function requirePath(name: string, value: string | undefined): string {
  const trimmed = value?.trim()
  if (trimmed === undefined || trimmed.length === 0) {
    throw new ConfigError('CONFIG_PATH_REQUIRED', `Config.${name} 必须由 profile 显式提供；插件不内置部署路径默认值`)
  }
  return trimmed
}

export interface DeploymentPaths {
  stateDir: string
  workspaceDir: string
  skillsDir: string
  memoryWorkspaceDir: string
}

/**
 * 记忆工作区是 Router 工作区的兄弟目录。profile 未单独给出时按同一部署根推导，
 * 这样 Windows／Linux 都跟着显式配置走，不会退回任何写死的绝对路径。
 */
export function resolveDeploymentPaths(config: Config): DeploymentPaths {
  const stateDir = requirePath('stateDir', config.stateDir)
  const workspaceDir = requirePath('workspaceDir', config.workspaceDir)
  const skillsDir = requirePath('skillsDir', config.skillsDir)
  const memoryWorkspaceDir = config.memoryWorkspaceDir === undefined
    ? join(dirname(workspaceDir), 'memory')
    : requirePath('memoryWorkspaceDir', config.memoryWorkspaceDir)
  return { stateDir, workspaceDir, skillsDir, memoryWorkspaceDir }
}

import z from '@deepseek-ai/schemastery'

export interface Config {
  baseDir: string
  files: string[]
  required?: string[]
  stateDir?: string
  workspaceDir?: string
  maxObservations?: number
  maxBytes?: number
  collectMs?: number
  skillsDir?: string
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
  stateDir: z.string().default('/home/ayerelysia/Elysia/Data/subconscious/router'),
  workspaceDir: z.string().default('/home/ayerelysia/Elysia/Data/workspace/subconscious/router'),
  maxObservations: z.number().default(20),
  maxBytes: z.number().default(65536),
  collectMs: z.number().default(2000),
  skillsDir: z.string().default('/home/ayerelysia/Elysia/Data/workspace/skills'),
  backupDir: z.string(),
  maxBackgroundJobs: z.number().default(4),
  maxJobAgeMs: z.number().default(1_800_000),
  jobSweepMs: z.number().default(30_000),
  shellTimeoutMs: z.number().default(120_000),
  shellMaxTimeoutMs: z.number().default(600_000),
  provider: z.string(),
  model: z.string(),
})

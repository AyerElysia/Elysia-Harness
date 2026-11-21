/** Deployment-owned configuration; no subject files are created or rewritten. */
import z from '@deepseek-ai/schemastery'
import { join, resolve } from 'node:path'
import type { RuntimeConfig } from './dsh/runtime'

const home = process.env.DSH_HOME ?? '/home/ayerelysia/Elysia/Elysium/Elysia-Harness/homes/web'
export interface Config extends RuntimeConfig {}
export const Config: z<Config> = z.object({
  baseDir: z.string().default(process.env.ELYSIA_PROMPTS_DIR ?? join(home, 'standing-prompts')),
  files: z.array(z.string()).default(['SOUL.md', 'USER.md', 'MEMORY.md', 'EXISTENCE.md', 'TOOLS.md', 'LIVE.md']),
  required: z.array(z.string()).default(['SOUL.md']),
  dataDir: z.string().default(join(home, 'dsh-livestream')),
  stagePort: z.natural().max(65535).default(3300),
  publisher: z.union(['livehime', 'obs']).default('livehime'),
  allowedWriteActions: z.array(z.string()).default([]),
})
export function resolveConfig(config: Config): Config {
  const value = Config(config)
  return { ...value, baseDir: resolve(value.baseDir), dataDir: resolve(value.dataDir ?? join(home, 'dsh-livestream')) }
}

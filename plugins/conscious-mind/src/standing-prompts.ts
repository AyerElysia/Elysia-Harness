/**
 * Agent-scoped standing-prompt composition. The selected files are stable for
 * the agent's lifetime; their contents are re-read at every prompt assembly.
 * @module @elysia/conscious-mind/standing-prompts
 */

import type { Context } from '@deepseek-ai/cordis'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import z from '@deepseek-ai/schemastery'
import { isAbsolute, resolve } from 'node:path'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { StandingPromptError, assertStandingFileName, loadStandingPrompt } from './load.ts'

/** Section name restored as the whole system prompt in complete mode. */
export const STANDING_PROMPT_SECTION = 'elysia:standing-prompts'

/** Cordis plugin name. */
export const name = 'elysia-standing-prompts'

/** The prompt registry this row contributes to. */
export const inject = ['systemPrompt']

/** File selection for one agent's standing prompt. */
export interface Config {
  /** Absolute directory, or a path relative to the process cwd at mount time. */
  baseDir: string
  /** Ordered, unique file names inside `baseDir`. */
  files: string[]
  /** Files that abort assembly when missing or empty. Defaults to `SOUL.md`. */
  required?: string[]
  /** Whether the joined text is this agent's complete system prompt. Defaults to true. */
  complete?: boolean
}

/** Runtime schema for one scoped standing-prompt composition. */
export const Config: z<Config> = z.object({
  baseDir: z.string().required(),
  files: z.array(z.string()).required(),
  required: z.array(z.string()).default(['SOUL.md']),
  complete: z.boolean().default(true),
})

/**
 * Register the selected files in one agent scope, never deployment-wide.
 * @param ctx - scoped agent context that provides `systemPrompt`.
 * @param config - directory, ordered files, required files, and complete policy.
 */
export function apply(ctx: Context, config: Config): void {
  if (scopeOf(ctx) === undefined) {
    throw new StandingPromptError('standing prompts must be mounted in an agent scope')
  }
  if (config.baseDir.length === 0) throw new StandingPromptError('standing prompt baseDir must not be empty')
  if (config.files.length === 0) throw new StandingPromptError('standing prompt files must not be empty')
  if (new Set(config.files).size !== config.files.length) {
    throw new StandingPromptError('standing prompt files must not contain duplicates')
  }
  const required = config.required ?? ['SOUL.md']
  for (const fileName of config.files) assertStandingFileName(fileName)
  for (const fileName of required) {
    assertStandingFileName(fileName)
    if (!config.files.includes(fileName)) {
      throw new StandingPromptError(`required standing prompt is not listed: ${fileName}`)
    }
  }
  const baseDir = isAbsolute(config.baseDir) ? config.baseDir : resolve(process.cwd(), config.baseDir)
  const complete = config.complete ?? true
  ctx.effect(() => ctx.systemPrompt.section({
    name: STANDING_PROMPT_SECTION,
    order: 0,
    ...(complete ? { complete: true } : {}),
    interpolate: false,
    text: () => loadStandingPrompt(baseDir, config.files, required),
  }), 'elysia-standing-prompts.section()')
}

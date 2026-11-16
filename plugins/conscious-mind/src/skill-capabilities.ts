/**
 * Agent-scoped DSH filesystem skills for Elysia. This module only composes the
 * native provider and loader; it adds no execution, learning, or management API.
 * @module @elysia/conscious-mind/skill-capabilities
 */

import { isAbsolute } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import type {} from '@deepseek-ai/dsh-skill'
import * as SkillFilesystem from '@deepseek-ai/dsh-skill-filesystem'
import * as SkillTool from '@deepseek-ai/dsh-tool-skill'

/** One explicit, host-local skill root shared by the main agent and its preset. */
export interface Config {
  rootDir: string
}

export const Config: z<Config> = z.object({
  rootDir: z.string().required(),
})

export const name = 'elysia-skill-capabilities'
export const inject = ['skills']

/** Mount only DSH's native skill provider and `skill` tool in this Agent scope. */
export async function apply(ctx: Context, config: Config): Promise<void> {
  if (scopeOf(ctx) === undefined) throw new Error('elysia skill capabilities must be mounted in an agent scope')
  if (!isAbsolute(config.rootDir)) throw new Error('elysia skill rootDir must be an absolute path')
  const provider = await ctx.plugin(SkillFilesystem, {
    includeDefaultRoots: false,
    customSkillDirs: [config.rootDir],
    watch: true,
  })
  try {
    await ctx.plugin(SkillTool)
  } catch (error) {
    try {
      await provider.dispose()
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'elysia skill capabilities failed and its provider could not be disposed')
    }
    throw error
  }
}

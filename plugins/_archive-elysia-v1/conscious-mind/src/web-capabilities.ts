/**
 * Agent-scoped DSH web search and fetch for Elysia. Providers stay in the
 * existing host-wide ctx.web seam; only the model-facing tools enter her scope.
 * @module @elysia/conscious-mind/web-capabilities
 */

import type { Context } from '@deepseek-ai/cordis'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import * as ToolWeb from '@deepseek-ai/dsh-tool-web'
import type {} from '@deepseek-ai/dsh-web'

/** One contract shared by the real main agent and the Web elysia preset. */
export const WEB_TOOL_CONFIG = {
  search: true,
  fetch: true,
  searchMaxResults: 8,
  searchMaxQueries: 4,
  searchTimeoutMs: 60_000,
  fetchTimeoutMs: 30_000,
  fetchMaxOutputChars: 200_000,
} satisfies ToolWeb.Config

export const name = 'elysia-web-capabilities'
export const inject = ['web']

/** Mount native web tools without making them available to any other agent. */
export async function apply(ctx: Context): Promise<void> {
  if (scopeOf(ctx) === undefined) throw new Error('elysia web capabilities must be mounted in an agent scope')
  await ctx.plugin(ToolWeb, WEB_TOOL_CONFIG)
}

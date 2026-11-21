/** SOUL-only composition, scoped to the separate Realtime Agent. */
import type { Context } from '@deepseek-ai/cordis'
import { assembleContextFor, type Agent } from '@deepseek-ai/dsh-agent'
import { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import * as StandingPrompts from '@elysia/conscious-mind/standing-prompts'

/** Mount the existing file-backed component, not a second copy of the persona. */
export async function mountVoicePrompt(ctx: Context, promptsDir: string): Promise<void> {
  await ctx.plugin(StandingPrompts, {
    baseDir: promptsDir,
    files: ['SOUL.md'],
    required: ['SOUL.md'],
    complete: true,
  })
  // Required/global runtime context is excluded as well as optional context.
  // The contribution is scoped to this Agent and does not change main consciousness.
  ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
    const assembled = await next()
    return { ...assembled, contexts: [], tools: [], variables: {} }
  })
}

/** Re-read SOUL through standing-prompts before every provider response. */
export async function assembleVoicePrompt(agent: Agent, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted()
  const assembly = await agent.ctx.systemPrompt.assemble(assembleContextFor(agent, signal))
  // Global around middleware (notably WorkingDirectory) can add required
  // context after scoped middleware returns. Isolate at the final provider
  // boundary as well, without modifying the global assembly or its sections.
  const finalAssembly = { ...assembly, contexts: [], tools: [], variables: {} }
  if (finalAssembly.sections.length !== 1
    || finalAssembly.sections[0]?.name !== StandingPrompts.STANDING_PROMPT_SECTION
    || finalAssembly.sections[0]?.interpolate !== false
    || finalAssembly.contexts.length !== 0 || finalAssembly.tools.length !== 0) {
    throw new Error('Voice prompt must contain only the literal SOUL standing section, without tools or runtime context')
  }
  const text = renderPrompt(finalAssembly)
  if (text.trim().length === 0) throw new Error('Voice SOUL must not be empty')
  signal?.throwIfAborted()
  return text
}

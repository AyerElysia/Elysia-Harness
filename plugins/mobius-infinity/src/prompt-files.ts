/**
 * Preset child that owns a preset's prompt text: it renders the configured
 * files as the complete system prompt on every assembly, and reports file
 * changes to every session the preset serves.
 *
 * Mounted in a preset's scope (never deployment-wide), so one row serves each
 * Agent composed under that preset; the change notice follows each of them
 * separately. Mirrors `@deepseek-ai/dsh-time-context`'s preset-scope handling.
 *
 * @module @elysia/mobius-infinity/prompt-files
 */

import { statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContextFormed } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type { PromptChange, PromptFileSnapshot } from './types.ts'
import { describePromptChanges, diffPromptSnapshots, readPromptBundle, readPromptSnapshot } from './prompt-source.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'elysia-prompt-change': { kind: 'elysia-prompt-change' } & ContextFormed
  }
}

/** Message source kind of the change notice. */
export const CHANGE_SOURCE = 'elysia-prompt-change'

/** System-prompt section name this child registers. */
export const PROMPT_SECTION = 'elysia:preset-prompt-files'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'elysia-preset-prompt-files'

/** Registries this child contributes to. */
export const inject = ['systemPrompt']

/** One preset's prompt composition. */
export interface Config {
  /** Absolute directory holding the prompt files. */
  root: string
  /** Ordered, root-relative file list. */
  files: string[]
  /** Short identity prefix rendered before the file bodies. */
  identity?: string
}

/** Runtime schema for one preset's prompt composition. */
export const Config: z<Config> = z.object({
  root: z.string().required(),
  files: z.array(z.string()).required(),
  identity: z.string(),
})

/**
 * Read the Agent this row is mounted for, when it is mounted in one Agent's own
 * scope. A preset child mounts in the preset's scope instead: it has no single
 * owner and serves every Agent composed under that preset.
 * @param ctx - mounting context of this row.
 * @returns the owning Agent, or undefined for a preset-owned row.
 * @throws when the row is mounted outside both scopes.
 */
function scopedAgent(ctx: Context): Agent | undefined {
  const scope = scopeOf(ctx)
  if (scope === undefined) {
    throw new Error('elysia-preset-prompt-files must be mounted in an Agent or preset scope')
  }
  return 'session' in scope ? scope as Agent : undefined
}

/**
 * Validate the row configuration before anything is registered.
 * @param config - the child row's configuration.
 * @returns the normalized identity, or undefined when absent.
 * @throws when the root is not absolute, the file list is empty or duplicated, or a path is not relative.
 */
function validateConfig(config: Config): string | undefined {
  if (!isAbsolute(config.root)) {
    throw new Error(`preset prompt root must be absolute, got ${JSON.stringify(config.root)}`)
  }
  let isDirectory = false
  try {
    isDirectory = statSync(config.root).isDirectory()
  } catch (error: unknown) {
    throw new Error(`preset prompt root is unreadable: ${config.root}`, { cause: error })
  }
  if (!isDirectory) throw new Error(`preset prompt root is not a directory: ${config.root}`)
  if (config.files.length === 0) throw new Error('preset prompt files must not be empty')
  if (new Set(config.files).size !== config.files.length) {
    throw new Error('preset prompt files must not contain duplicates')
  }
  for (const path of config.files) {
    if (path === '' || isAbsolute(path) || path.split('/').includes('..')) {
      throw new Error(`preset prompt file must be a relative path inside the root: ${JSON.stringify(path)}`)
    }
  }
  const identity = config.identity?.trim()
  return identity === undefined || identity === '' ? undefined : identity
}

/**
 * Retire every notice this child already put on one Agent's surface.
 *
 * The previous notice is replaced in place rather than left behind: a notice is
 * a snapshot of what changed, and keeping the old one would make the model read
 * stale facts next to current prompt text.
 * @param agent - Agent whose surface is rewritten.
 */
function retireNotices(agent: Agent): void {
  for (const seq of [...agent.session.surface.nodes]) {
    // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
    const event = agent.session.eventAt(seq)
    if (event?.type !== 'user/message' || event.data.source.kind !== CHANGE_SOURCE) continue
    agent.session.append('user/message', createUserMessage({
      content: [],
      source: { kind: CHANGE_SOURCE, form: 'snapshot', sections: [] },
    }), {
      surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq },
      sourceEventSeqs: [seq],
    })
  }
}

/**
 * Build the model-facing notice for one batch of changes.
 * @param changes - changes detected since the previous read.
 * @returns the user message carrying the snapshot-form account.
 */
function createChangeNotice(changes: readonly PromptChange[]) {
  const text = `[prompt-files] Prompt files changed: ${describePromptChanges(changes)}. `
    + 'Their current contents are already in your system prompt; use that version rather than an earlier copy.'
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: CHANGE_SOURCE, form: 'snapshot', sections: [{ name: CHANGE_SOURCE, text }] },
  })
}

/**
 * Build the visible notice for a session's first prompt observation.
 * @param snapshot - the files read on that first observation.
 * @returns the user message that makes the initial injection visible in Chat.
 */
function createLoadedNotice(snapshot: readonly PromptFileSnapshot[]) {
  const names = snapshot.length === 0 ? 'no configured files could be read' : snapshot.map(file => file.path).join(', ')
  const text = `[prompt-files] System prompt loaded: ${names}. `
    + 'Their contents are already in your system prompt; use them as the current version.'
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: CHANGE_SOURCE, form: 'snapshot', sections: [{ name: CHANGE_SOURCE, text }] },
  })
}

/**
 * Register the prompt section and the change notice for the lifetime of `ctx`.
 * @param ctx - preset- or Agent-scoped context that provides `systemPrompt`.
 * @param config - prompt root, ordered files, and optional identity prefix.
 */
export function apply(ctx: Context, config: Config): void {
  const identity = validateConfig(config)
  const root = config.root
  const files = [...config.files]
  const owner = scopedAgent(ctx)

  // A complete section is restored after the assembly waterfall as the sole
  // prompt section, so the placement only decides what other complete section
  // would conflict with it.
  const order = ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX')
  ctx.effect(() => ctx.systemPrompt.section({
    name: PROMPT_SECTION,
    order,
    complete: true,
    interpolate: false,
    text: () => readPromptBundle(root, files, identity).text,
  }), 'elysia-preset-prompt-files.section')

  /** Content identities each session was last told about, keyed by session. */
  const baselines = new Map<SessionId, readonly PromptFileSnapshot[]>()
  ctx.effect(() => () => { baselines.clear() }, 'elysia-preset-prompt-files.baselines')

  ctx.on('agent/pre-step', async ({ agent, signal }, next): Promise<PreStepDecision> => {
    const decision = await next()
    // Scoped events also reach ancestor listeners: a row mounted in one Agent's
    // scope reports only that Agent, while a preset row reports each Agent
    // routed to it.
    if (owner !== undefined && agent !== owner) return decision
    if (decision.kind === 'reject' || signal.aborted) return decision
    const current = readPromptSnapshot(root, files)
    const previous = baselines.get(agent.session.id)
    if (previous === undefined) {
      // The first observation establishes the baseline and publishes one visible
      // notice so the operator can see which files the system prompt loaded.
      baselines.set(agent.session.id, current)
      return { ...decision, messages: [...decision.messages, createLoadedNotice(current)] }
    }
    const changes = diffPromptSnapshots(previous, current)
    if (changes.length === 0) return decision
    baselines.set(agent.session.id, current)
    retireNotices(agent)
    return { ...decision, messages: [...decision.messages, createChangeNotice(changes)] }
  }, { prepend: true })
}

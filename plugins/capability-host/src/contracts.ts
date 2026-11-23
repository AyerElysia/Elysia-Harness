/**
 * Host-side registration contracts. A provider declares what it contributes
 * once; the Host owns gating, ordering, and disposal. Nothing here is
 * JSON-serializable, so this module never reaches a browser half — the panel
 * reads {@link @elysia/capability-host/types} instead.
 *
 * v1.2 boundary: only **dynamic** tools are declared here. A preset's static
 * tool face is owned by preset-manager and read through
 * {@link @elysia/capability-host/static-tools}; the panel never registers,
 * unregisters, or switches it.
 *
 * @module @elysia/capability-host/contracts
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { ToolScope } from './types.ts'

/**
 * Tool ids one preset composition module contributes.
 *
 * Only verified mappings belong here. An unmapped module is still displayed
 * from the preset composition, with a diagnostic, rather than guessed.
 */
export const STATIC_TOOL_MODULES: Readonly<Record<string, readonly string[]>> = {
  '@deepseek-ai/dsh-tool-web': ['web_search', 'web_fetch'],
  '@deepseek-ai/dsh-tool-fs': ['read', 'write', 'edit', 'read_image', 'apply_patch'],
  '@deepseek-ai/dsh-tool-fs-search': ['glob', 'grep'],
  '@deepseek-ai/dsh-tool-bash': ['bash'],
  '@deepseek-ai/dsh-tool-pwsh': ['pwsh'],
  '@deepseek-ai/dsh-tool-todo': ['todo_write'],
  '@deepseek-ai/dsh-tool-ask-user': ['ask_user_question'],
  '@deepseek-ai/dsh-tool-skill': ['skill'],
  '@deepseek-ai/dsh-tool-jobs': ['job_list', 'job_output', 'job_kill'],
  '@deepseek-ai/dsh-tool-goal': ['get_goal', 'create_goal', 'update_goal'],
  '@deepseek-ai/dsh-tool-subagent': ['subagent', 'subagent_fork', 'list_subagent_models'],
  '@deepseek-ai/dsh-tool-subagent-control': ['interrupt_agent', 'list_agents', 'wait_agent', 'send_message'],
  '@deepseek-ai/dsh-plan-mode': ['exit_plan_mode'],
  '@deepseek-ai/dsh-tool-agent-team': ['team_task_create', 'team_task_list', 'team_task_get', 'team_task_update'],
  '@deepseek-ai/dsh-tool-present': ['present'],
  '@deepseek-ai/dsh-tool-office': ['office_render', 'office_convert', 'office_recalculate'],
  '@deepseek-ai/dsh-tool-workflow': ['workflow'],
  '@deepseek-ai/dsh-tool-schedule': ['schedule_create', 'schedule_list', 'schedule_view', 'schedule_edit'],
  '@deepseek-ai/dsh-plugin-manager/tools': ['plugin_manager'],
}

/**
 * How a gate failure for one entry affects the step.
 *
 * `closed` hides the tool and records a diagnostic; `loud` fails step
 * preparation, which is what the `reply` safety baseline requires.
 */
export type ToolFailureMode = 'closed' | 'loud'

/**
 * Build one definition for the scope that will own it.
 *
 * A global entry receives the Host context. An agent-scoped entry receives the
 * context of the Capability Set row that mounts it, so the definition captures
 * that scope's services rather than the deployment's. Factories are synchronous
 * because `ctx.tools.register()` is a load-time contribution.
 */
export type ToolFactory = (ctx: Context) => ToolDefinition

/** One dynamic tool the panel may switch. */
export interface ToolCatalogEntry {
  /** Catalog id and registration name; must be unique. */
  readonly id: string
  /** Where it is registered. Unknown values are refused at registration. */
  readonly scope: ToolScope
  /** Model-facing description, also shown in the panel. */
  readonly description: string
  /** Host services the definition reads; a missing one makes it unavailable. */
  readonly required?: readonly string[]
  /** Extension group such as `reply`, which the panel must not split. */
  readonly group?: string
  /** Module that mounts the definition, for entries owned by another plugin. */
  readonly provider?: string
  /** Gate failure behavior; defaults to `closed`. */
  readonly failureMode?: ToolFailureMode
  /** Builds the definition. */
  readonly factory: ToolFactory
}

/** A dynamic catalog entry after registration, including what the Host observed. */
export interface CatalogRecord {
  /** The declared entry. */
  readonly entry: ToolCatalogEntry
  /** Model-facing definition the factory built, when it was built. */
  readonly schema?: ToolDefinition
  /** Whether the definition is registered in this Host process. */
  readonly registered: boolean
  /** Why the entry is not registered, when it is not. */
  readonly reason?: string
}

/** One context kind a provider may publish. */
export interface ContextKindRegistration {
  /** Kind name publications carry. */
  readonly kind: string
  /** One line describing what the kind carries. */
  readonly description: string
  /** Whether publications wake a turn when the event omits `active`. */
  readonly activeByDefault?: boolean
  /** Age after which an undelivered event is dropped. */
  readonly ttlMs?: number
  /** Per-event size ceiling. */
  readonly maxBytes?: number
  /** Undelivered events retained per session before the oldest is dropped. */
  readonly maxQueueDepth?: number
}

/** Resolved delivery limits of one registered kind. */
export interface ResolvedContextKind {
  /** Kind name. */
  readonly kind: string
  /** One line description. */
  readonly description: string
  /** Default `active` for publications that omit it. */
  readonly activeByDefault: boolean
  /** Effective age ceiling. */
  readonly ttlMs: number
  /** Effective size ceiling. */
  readonly maxBytes: number
  /** Effective per-session queue depth. */
  readonly maxQueueDepth: number
}

/** Host traffic defaults for one context kind. */
export interface ContextDefaults {
  /** Default age ceiling in milliseconds. */
  readonly ttlMs: number
  /** Default per-event size ceiling in bytes. */
  readonly maxBytes: number
  /** Default per-session queue depth. */
  readonly maxQueueDepth: number
}

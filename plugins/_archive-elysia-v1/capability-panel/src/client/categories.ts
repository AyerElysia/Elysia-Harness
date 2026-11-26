/**
 * Functional categories for the dynamic tool list. The Host reports one flat
 * universe; the panel groups it by what each tool is for so a long list stays
 * navigable. Order is stable and each category is independently collapsible.
 *
 * @module @elysia/capability-panel/client/categories
 */

import type { ToolEntry } from './types.ts'
import type { ControlPanelLocaleKey } from './locales.ts'

/** One functional category of dynamic tools. */
export interface ToolCategory {
  /** Stable category id used for collapse state and DOM markers. */
  readonly id: string
  /** Locale key of the category title. */
  readonly label: ControlPanelLocaleKey
  /** Members in source order. */
  readonly tools: readonly ToolEntry[]
}

/** Display order; `other` always last. */
const ORDER = [
  'files', 'terminal', 'tasks', 'agents', 'goals', 'context', 'office', 'plugins', 'web', 'other',
] as const

const LABELS: Readonly<Record<string, ControlPanelLocaleKey>> = {
  files: 'categoryFiles',
  terminal: 'categoryTerminal',
  tasks: 'categoryTasks',
  agents: 'categoryAgents',
  goals: 'categoryGoals',
  context: 'categoryContext',
  office: 'categoryOffice',
  plugins: 'categoryPlugins',
  web: 'categoryWeb',
  other: 'categoryOther',
}

/**
 * Core tools mounted by the DSH base bundle rather than a preset row. The
 * authoritative preset-owned set comes from the `standard` preset's static
 * rows; this list covers the host-global rows that preset does not restate.
 */
export const DSH_CORE_GLOBAL_TOOL_IDS: ReadonlySet<string> = new Set([
  'working_directory',
  'compress',
  'decompress',
  'search_context',
  'team_task_create',
  'team_task_get',
  'team_task_list',
  'team_task_update',
  'acp_status',
  'acp_cache',
  'acp_read_original_image',
  'exit_plan_mode',
])

const TOOL_CATEGORY: Readonly<Record<string, string>> = {
  read: 'files',
  write: 'files',
  edit: 'files',
  glob: 'files',
  grep: 'files',
  read_image: 'files',
  pwsh: 'terminal',
  bash: 'terminal',
  job_list: 'tasks',
  job_output: 'tasks',
  job_kill: 'tasks',
  team_task_create: 'tasks',
  team_task_list: 'tasks',
  team_task_get: 'tasks',
  team_task_update: 'tasks',
  todo_write: 'tasks',
  workflow: 'tasks',
  subagent: 'agents',
  subagent_fork: 'agents',
  list_agents: 'agents',
  wait_agent: 'agents',
  send_message: 'agents',
  list_subagent_models: 'agents',
  get_goal: 'goals',
  create_goal: 'goals',
  update_goal: 'goals',
  exit_plan_mode: 'goals',
  working_directory: 'context',
  compress: 'context',
  decompress: 'context',
  search_context: 'context',
  office_render: 'office',
  office_convert: 'office',
  office_recalculate: 'office',
  present: 'office',
  skill: 'plugins',
  plugin_manager: 'plugins',
  plugin_market: 'plugins',
  cordis_inspect_list: 'plugins',
  cordis_inspect_query: 'plugins',
  web_search: 'web',
  web_fetch: 'web',
}

/**
 * Category of one tool id.
 * @param id - tool id.
 * @returns its functional category, or `other`.
 */
export function categoryOfTool(id: string): string {
  return TOOL_CATEGORY[id] ?? 'other'
}

/**
 * Group dynamic tools by function, preserving the configured order.
 * @param tools - dynamic tools of the current scope, already shadow-filtered.
 * @returns non-empty categories with their members.
 */
export function toolCategories(tools: readonly ToolEntry[]): readonly ToolCategory[] {
  const buckets = new Map<string, ToolEntry[]>()
  for (const tool of tools) {
    const id = categoryOfTool(tool.id)
    const bucket = buckets.get(id) ?? []
    bucket.push(tool)
    buckets.set(id, bucket)
  }
  return ORDER.flatMap((id) => {
    const members = buckets.get(id)
    if (members === undefined || members.length === 0) return []
    return [{ id, label: LABELS[id] ?? 'categoryOther', tools: members }]
  })
}
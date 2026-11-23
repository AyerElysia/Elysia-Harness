/**
 * Label resolution for Host-owned ids. A known id renders its localized name; an
 * id this build does not know renders verbatim, because it is Host data the
 * panel must not hide.
 *
 * @module @elysia/capability-host/client/labels
 */

import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import type { EventOutcome, StepGate } from './types.ts'
import {
  CONTEXT_LABEL_KEYS, GROUP_LABEL_KEYS, OUTCOME_LABEL_KEYS, STEP_LABEL_KEYS, TOOL_LABEL_KEYS,
  type ControlPanelLocaleKey,
} from './locales.ts'

/** The panel's translate seat, narrowed to its own dictionary. */
export type ControlPanelTranslate = Translate<ControlPanelLocaleKey>

/**
 * Localized name of one tool group.
 * @param t - panel copy.
 * @param id - group id from the Host.
 * @returns the localized label, or the id when this build does not know it.
 */
export function groupLabel(t: ControlPanelTranslate, id: string): string {
  const key = GROUP_LABEL_KEYS[id]
  return key === undefined ? id : t(key)
}

/** Semantic Chinese names for tools the static dictionary does not cover. */
const TOOL_NAME_OVERRIDES: Readonly<Record<string, string>> = {
  working_directory: '工作目录',
  team_task_create: '创建团队任务',
  team_task_list: '团队任务列表',
  team_task_get: '读取团队任务',
  team_task_update: '更新团队任务',
  compress: '压缩上下文',
  decompress: '展开上下文',
  search_context: '搜索上下文',
  acp_status: 'ACP 状态',
  acp_cache: 'ACP 缓存',
  acp_read_original_image: '读取原始图片',
  job_output: '读取后台任务输出',
  job_list: '后台任务列表',
  job_kill: '终止后台任务',
  pwsh: 'PowerShell',
  plugin_manager: '插件管理器',
  plugin_market: '插件市场',
  cordis_inspect_list: '列出 Cordis 检查项',
  cordis_inspect_query: '查询 Cordis 检查项',
  read_image: '读取图片',
  get_goal: '获取目标',
  create_goal: '创建目标',
  update_goal: '更新目标',
  ask_user_question: '向用户提问',
  todo_write: '更新待办',
  workflow: '运行工作流',
  exit_plan_mode: '退出计划模式',
  list_agents: '列出代理成员',
  wait_agent: '等待代理成员',
  send_message: '发送代理消息',
  list_subagent_models: '列出子代理模型',
  subagent: '创建子代理',
  subagent_fork: '派生分支子代理',
  office_render: '渲染办公文档',
  office_convert: '转换办公文档',
  office_recalculate: '重算办公表格',
  present: '展示文件',
}

/**
 * Localized name of one tool.
 * @param t - panel copy.
 * @param id - tool id from the Host.
 * @param translate - false shows the raw id instead of a semantic name.
 * @returns the localized label, the semantic override, or the id.
 */
export function toolLabel(t: ControlPanelTranslate, id: string, translate = true): string {
  if (!translate) return id
  const key = TOOL_LABEL_KEYS[id]
  if (key !== undefined) return t(key)
  return TOOL_NAME_OVERRIDES[id] ?? id
}

/**
 * Localized name of one context event kind.
 * @param t - panel copy.
 * @param kind - event kind from the Host.
 * @returns the localized label, or the kind when this build does not know it.
 */
export function contextLabel(t: ControlPanelTranslate, kind: string): string {
  const key = CONTEXT_LABEL_KEYS[kind]
  return key === undefined ? kind : t(key)
}

/**
 * Localized current-step verdict.
 * @param t - panel copy.
 * @param gate - the tool's or group's verdict; absent reads as active.
 * @returns the localized verdict.
 */
export function stepText(t: ControlPanelTranslate, gate: StepGate | undefined): string {
  const key = STEP_LABEL_KEYS[gate ?? 'active']
  return key === undefined ? gate ?? 'active' : t(key)
}

/**
 * Localized event-log outcome.
 * @param t - panel copy.
 * @param outcome - the outcome from the Host.
 * @returns the localized outcome, or the raw value when unknown.
 */
export function outcomeText(t: ControlPanelTranslate, outcome: EventOutcome): string {
  const key = OUTCOME_LABEL_KEYS[outcome]
  return key === undefined ? outcome : t(key)
}
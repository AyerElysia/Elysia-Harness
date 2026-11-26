/**
 * Label resolution for Host-owned tool ids. A known id renders its localized
 * name; an id this build does not know renders verbatim, because it is Host
 * data the panel must not hide.
 *
 * @module @elysia/villv-helix/client/labels
 */

import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import type { StepGate } from '../types.ts'
import {
  STEP_LABEL_KEYS, TOOL_LABEL_KEYS, type ControlPanelLocaleKey,
} from './locales.ts'

/** The panel's translate seat, narrowed to its own dictionary. */
export type ControlPanelTranslate = Translate<ControlPanelLocaleKey>

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
  preset_create: '创建预设',
  preset_list: '列出预设',
}

/**
 * Localized name of one tool.
 * @param t - panel copy.
 * @param id - tool id from the Host.
 * @param translate - false shows the raw id instead of a semantic name.
 * @param nameZh - provider-supplied Chinese display name, preferred when present.
 * @returns the provider name, localized label, semantic override, or id.
 */
export function toolLabel(t: ControlPanelTranslate, id: string, translate = true, nameZh?: string): string {
  if (!translate) return id
  if (nameZh !== undefined && nameZh.trim() !== '') return nameZh
  const key = TOOL_LABEL_KEYS[id]
  if (key !== undefined) return t(key)
  return TOOL_NAME_OVERRIDES[id] ?? id
}

/**
 * Localized current-step verdict.
 * @param t - panel copy.
 * @param gate - the tool's verdict; absent reads as active.
 * @returns the localized verdict.
 */
export function stepText(t: ControlPanelTranslate, gate: StepGate | undefined): string {
  const key = STEP_LABEL_KEYS[gate ?? 'active']
  return key === undefined ? gate ?? 'active' : t(key)
}
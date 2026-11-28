/**
 * Model-facing tools of the context gate: timers, timer presets, absence
 * watchers, and custom-event rules.
 *
 * The semantic split is explicit in every description: a pure time event uses
 * `timer_*`; a condition or script over internal/external events uses
 * `event_rule_*`. A pure time rule must not be modelled as an event rule.
 *
 * @module @elysia/context-gate/tools
 */

import type { Context } from '@deepseek-ai/cordis'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ParameterSchemaSpec, ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import type {
  AbsenceDraft, AbsencePatch, AbsenceTimer, EventRule, EventRuleDraft, EventRulePatch, EventParameterValues,
  RuleCondition, RuleScript, RuleTestResult, RuleTrigger, TimerDraft, TimerInstance, TimerPatch, TimerPreset,
  TimerSchedule, TimerSnapshot,
} from './types.ts'
import { ContextGateError, describeError } from './errors.ts'

/** Manager operations the tools read and write. */
export interface ContextGateToolManager {
  /** Read one session's timer surface. */
  timers(sessionId: string): Promise<TimerSnapshot>
  /** Create one timer. */
  createTimer(sessionId: string, draft: TimerDraft): Promise<TimerInstance>
  /** Change one timer. */
  updateTimer(sessionId: string, id: string, patch: TimerPatch): Promise<TimerInstance>
  /** Pause or resume one timer. */
  pauseTimer(sessionId: string, id: string, paused: boolean): Promise<TimerInstance>
  /** Remove one timer. */
  cancelTimer(sessionId: string, id: string): Promise<void>
  /** Create one timer preset. */
  createTimerPreset(sessionId: string, draft: TimerDraft): Promise<TimerPreset>
  /** Adopt one timer preset. */
  adoptTimerPreset(sessionId: string, presetId: string): Promise<TimerInstance>
  /** Create one absence watcher. */
  createAbsence(sessionId: string, draft: AbsenceDraft): Promise<AbsenceTimer>
  /** Change one absence watcher. */
  updateAbsence(sessionId: string, id: string, patch: AbsencePatch): Promise<AbsenceTimer>
  /** Remove one absence watcher. */
  cancelAbsence(sessionId: string, id: string): Promise<void>
  /** List one session's custom-event rules. */
  rulesFor(sessionId: string): Promise<readonly EventRule[]>
  /** Create one custom-event rule. */
  createRule(sessionId: string, draft: EventRuleDraft): Promise<EventRule>
  /** Change one custom-event rule. */
  updateRule(sessionId: string, id: string, patch: EventRulePatch): Promise<EventRule>
  /** Evaluate one rule without publishing. */
  testRule(sessionId: string, id: string): Promise<RuleTestResult>
  /** Pause or resume one rule. */
  pauseRule(sessionId: string, id: string, paused: boolean): Promise<EventRule>
  /** Remove one rule. */
  cancelRule(sessionId: string, id: string): Promise<void>
}

/** Chinese display name of every tool, registered with the orchestrator when present. */
export const TOOL_NAME_ZH: Readonly<Record<string, string>> = {
  timer_create: '创建定时器',
  timer_list: '列出定时器',
  timer_update: '修改定时器',
  timer_pause: '暂停或恢复定时器',
  timer_cancel: '取消定时器',
  timer_preset_create: '创建定时预设',
  timer_preset_list: '列出定时预设',
  timer_preset_adopt: '采用定时预设',
  absence_create: '创建安静提醒',
  absence_list: '列出安静提醒',
  absence_update: '修改安静提醒',
  absence_cancel: '取消安静提醒',
  event_rule_create: '创建事件规则',
  event_rule_list: '列出事件规则',
  event_rule_update: '修改事件规则',
  event_rule_test: '测试事件规则',
  event_rule_pause: '暂停事件规则',
  event_rule_resume: '恢复事件规则',
  event_rule_cancel: '取消事件规则',
}

/** Standard tool output declaration. */
const OUTPUT = {
  schema: {
    type: 'object' as const,
    additionalProperties: false,
    properties: {
      ok: { type: 'boolean' as const, required: true as const },
      message: { type: 'string' as const, required: true as const },
      data: { type: 'json' as const },
    },
  },
  render: (_args: unknown, value: unknown): { type: 'text'; text: string }[] => {
    const message = typeof value === 'object' && value !== null
      && typeof (value as { message?: unknown }).message === 'string'
      ? (value as { message: string }).message
      : '完成。'
    return [{ type: 'text', text: message }]
  },
}

/** The canonical value type a tool output renders. */
type ToolValue = Parameters<ToolDefinition['output']['render']>[1]

interface ToolRun {
  /** Model-facing text. */
  readonly message: string
  /** Structured detail for the caller. */
  readonly data?: ToolValue
}

/**
 * Build one tool definition over the shared output declaration.
 * @param name - tool id.
 * @param description - model-facing Chinese description.
 * @param parameters - parameter schema.
 * @param run - execution callback.
 * @returns the registered definition.
 */
function tool<S extends ParameterSchemaSpec>(
  name: string,
  description: string,
  parameters: S,
  run: (args: Record<string, unknown>, exec: ToolRunContext) => Promise<ToolRun>,
): ToolDefinition {
  return defineTool({
    name,
    description,
    parameters,
    output: OUTPUT,
    async execute(args, exec) {
      exec.signal.throwIfAborted()
      const outcome = await run(args, exec)
      return {
        ok: true,
        message: outcome.message,
        ...(outcome.data === undefined ? {} : { data: outcome.data }),
      }
    },
  })
}

/** Refuse a tool call with the manager's stable code. */
function refusal(error: unknown): never {
  if (error instanceof ContextGateError) {
    throw new HarnessError(error.message, `CONTEXT_GATE_${error.code}`, { cause: error })
  }
  throw error
}

/** Resolve the calling session; the gate tools require one. */
function sessionOf(exec: ToolRunContext): string {
  const session = exec.agent?.session.id
  if (session === undefined) {
    throw new HarnessError('context-gate 的工具必须在会话内调用。', 'CONTEXT_GATE_NO_SESSION')
  }
  return session
}

function json(value: unknown): ToolValue {
  return JSON.parse(JSON.stringify(value)) as ToolValue
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ContextGateError('RULE_INVALID', `${label} 必须是对象`)
  }
  return value as Record<string, unknown>
}

function asStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some(entry => typeof entry !== 'string')) {
    throw new ContextGateError('RULE_INVALID', `${label} 必须是字符串数组`)
  }
  return [...value]
}

/**
 * Build every ContextGate tool.
 * @param manager - the Host manager implementing the operations.
 * @returns the 19 model-facing definitions.
 */
export function buildContextGateTools(manager: ContextGateToolManager): readonly ToolDefinition[] {
  const scheduleParameters: ParameterSchemaSpec = {
    at: { type: 'string', description: '绝对时间（ISO-8601）。与 afterSeconds / rrule / everySeconds 四选一。' },
    afterSeconds: { type: 'number', description: '相对秒数。四选一。' },
    rrule: { type: 'string', description: 'RRULE 文本，可带 DTSTART 行。四选一。支持到秒。' },
    timeZone: { type: 'string', description: 'RRULE 的 IANA 时区；省略时使用 UTC。' },
    everySeconds: { type: 'integer', description: '固定秒级间隔。四选一。' },
    expiresAt: { type: 'string', description: '可选的过期时间（ISO-8601）。' },
  }

  return [
    tool(
      'timer_create',
      '创建一个属于当前会话的定时器。纯时间事件使用本工具；条件或脚本请使用 event_rule_*。'
        + ' 到点只注入当前会话，不会注册成可被其他会话订阅的事件。',
      {
        name: { type: 'string', required: true, description: '定时器名称。' },
        content: { type: 'string', required: true, description: '到点时注入的正文。' },
        wake: { type: 'boolean', description: '到点是否唤醒一轮；默认 true。高频秒级定时器会自动合并。' },
        ...scheduleParameters,
      },
      async (args, exec) => {
        try {
          const timer = await manager.createTimer(sessionOf(exec), timerDraft(args))
          return { message: `已创建定时器「${timer.name}」，下次触发：${formatInstant(timer.nextDueAt)}。`, data: json(timer) }
        } catch (error: unknown) {
          refusal(error)
        }
      },
    ),
    tool(
      'timer_list',
      '列出当前会话的定时器、可采用的定时预设和安静提醒。纯时间事件使用 timer_*；条件或脚本请使用 event_rule_*。',
      {},
      async (_args, exec) => {
        try {
          const snapshot = await manager.timers(sessionOf(exec))
          return {
            message: `当前会话有 ${String(snapshot.timers.length)} 个定时器、${String(snapshot.presets.length)} 个定时预设、`
              + `${String(snapshot.absences.length)} 个安静提醒。`,
            data: json(snapshot),
          }
        } catch (error: unknown) {
          refusal(error)
        }
      },
    ),
    tool(
      'timer_update',
      '修改当前会话的定时器。修改时间字段会替换整个时间计划并重新计算下次触发。',
      {
        id: { type: 'string', required: true, description: '定时器 id。' },
        name: { type: 'string', description: '新名称。' },
        content: { type: 'string', description: '新注入正文。' },
        wake: { type: 'boolean', description: '新的唤醒策略。' },
        enabled: { type: 'boolean', description: '暂停或恢复。' },
        at: { type: 'string', description: '新的绝对时间；与 afterSeconds / rrule / everySeconds 四选一。' },
        afterSeconds: { type: 'number', description: '新的相对秒数。' },
        rrule: { type: 'string', description: '新的 RRULE 文本。' },
        timeZone: { type: 'string', description: '新的 IANA 时区。' },
        everySeconds: { type: 'integer', description: '新的秒级间隔。' },
        expiresAt: { type: 'string', description: '新的过期时间；传空字符串清除。' },
      },
      async (args, exec) => {
        try {
          const timer = await manager.updateTimer(sessionOf(exec), String(args['id']), timerPatch(args))
          return { message: `已更新定时器「${timer.name}」，下次触发：${formatInstant(timer.nextDueAt)}。`, data: json(timer) }
        } catch (error: unknown) {
          refusal(error)
        }
      },
    ),
    tool(
      'timer_pause',
      '暂停或恢复当前会话的定时器。暂停保留时间计划，恢复后从当前时间重新计算。',
      {
        id: { type: 'string', required: true, description: '定时器 id。' },
        paused: { type: 'boolean', required: true, description: 'true 暂停，false 恢复。' },
      },
      async (args, exec) => {
        try {
          const timer = await manager.pauseTimer(sessionOf(exec), String(args['id']), args['paused'] === true)
          return { message: `定时器「${timer.name}」已${timer.enabled ? '恢复' : '暂停'}。`, data: json(timer) }
        } catch (error: unknown) {
          refusal(error)
        }
      },
    ),
    tool(
      'timer_cancel',
      '取消当前会话的定时器。定时器从文档中移除，之后不会再注入。',
      { id: { type: 'string', required: true, description: '定时器 id。' } },
      async (args, exec) => {
        try {
          await manager.cancelTimer(sessionOf(exec), String(args['id']))
          return { message: '定时器已取消。' }
        } catch (error: unknown) {
          refusal(error)
        }
      },
    ),
    tool(
      'timer_preset_create',
      '创建一个共享的定时预设。其他会话采用后生成各自独立的定时器；修改预设不会改动已采用实例。',
      {
        name: { type: 'string', required: true, description: '预设名称。' },
        content: { type: 'string', required: true, description: '采用后注入的正文。' },
        wake: { type: 'boolean', description: '采用时默认是否唤醒；默认 true。' },
        ...scheduleParameters,
      },
      async (args, exec) => {
        try {
          const preset = await manager.createTimerPreset(sessionOf(exec), timerDraft(args))
          return { message: `已创建定时预设「${preset.name}」。`, data: json(preset) }
        } catch (error: unknown) {
          refusal(error)
        }
      },
    ),
    tool(
      'timer_preset_list',
      '列出可采用的定时预设。预设只保存时间与内容模板，不保存任何会话实例状态。',
      {},
      async (_args, exec) => {
        try {
          const snapshot = await manager.timers(sessionOf(exec))
          return {
            message: snapshot.presets.length === 0 ? '当前没有定时预设。' : `共有 ${String(snapshot.presets.length)} 个定时预设。`,
            data: json(snapshot.presets),
          }
        } catch (error: unknown) {
          refusal(error)
        }
      },
    ),
    tool(
      'timer_preset_adopt',
      '采用一个定时预设，为当前会话生成独立定时器。每个实例有自己的下次触发、暂停和状态，不会 fan-out。',
      { presetId: { type: 'string', required: true, description: '定时预设 id。' } },
      async (args, exec) => {
        try {
          const timer = await manager.adoptTimerPreset(sessionOf(exec), String(args['presetId']))
          return { message: `已采用预设计时器「${timer.name}」，下次触发：${formatInstant(timer.nextDueAt)}。`, data: json(timer) }
        } catch (error: unknown) {
          refusal(error)
        }
      },
    ),
    tool(
      'absence_create',
      '创建一个安静提醒：指定事件类型一段时间没有发布时，向当前会话注入一次提醒。'
        + ' 它观察全局发布记录，不需要当前会话订阅该事件。纯时间事件仍请使用 timer_*。',
      {
        name: { type: 'string', description: '提醒名称。' },
        kinds: { type: 'array', required: true, items: { type: 'string' }, description: '事件类型列表；传 ["*"] 表示任意类型。' },
        quietSeconds: { type: 'number', required: true, description: '安静多少秒后提醒。' },
      },
      async (args, exec) => {
        try {
          const absence = await manager.createAbsence(sessionOf(exec), {
            ...(args['name'] === undefined ? {} : { name: String(args['name']) }),
            kinds: asStringArray(args['kinds'], 'kinds'),
            quietMs: Number(args['quietSeconds']) * 1000,
          })
          return { message: `已创建安静提醒，观察 ${absence.kinds.join(' / ')}。`, data: json(absence) }
        } catch (error: unknown) {
          refusal(error)
        }
      },
    ),
    tool(
      'absence_list',
      '列出当前会话的安静提醒。每个提醒在触发后会等待被观察的事件再次出现才重新武装。',
      {},
      async (_args, exec) => {
        try {
          const snapshot = await manager.timers(sessionOf(exec))
          return {
            message: snapshot.absences.length === 0 ? '当前没有安静提醒。' : `共有 ${String(snapshot.absences.length)} 个安静提醒。`,
            data: json(snapshot.absences),
          }
        } catch (error: unknown) {
          refusal(error)
        }
      },
    ),
    tool(
      'absence_update',
      '修改当前会话的安静提醒。修改观察类型会重新按全局最近发布时间和当前时间计算等待。',
      {
        id: { type: 'string', required: true, description: '安静提醒 id。' },
        name: { type: 'string', description: '新名称。' },
        kinds: { type: 'array', items: { type: 'string' }, description: '新的事件类型列表。' },
        quietSeconds: { type: 'number', description: '新的安静秒数。' },
        enabled: { type: 'boolean', description: '暂停或恢复。' },
      },
      async (args, exec) => {
        try {
          const absence = await manager.updateAbsence(sessionOf(exec), String(args['id']), {
            ...(args['name'] === undefined ? {} : { name: String(args['name']) }),
            ...(args['kinds'] === undefined ? {} : { kinds: asStringArray(args['kinds'], 'kinds') }),
            ...(args['quietSeconds'] === undefined ? {} : { quietMs: Number(args['quietSeconds']) * 1000 }),
            ...(args['enabled'] === undefined ? {} : { enabled: args['enabled'] === true }),
          })
          return { message: `安静提醒已更新，观察 ${absence.kinds.join(' / ')}。`, data: json(absence) }
        } catch (error: unknown) {
          refusal(error)
        }
      },
    ),
    tool(
      'absence_cancel',
      '取消当前会话的安静提醒。',
      { id: { type: 'string', required: true, description: '安静提醒 id。' } },
      async (args, exec) => {
        try {
          await manager.cancelAbsence(sessionOf(exec), String(args['id']))
          return { message: '安静提醒已取消。' }
        } catch (error: unknown) {
          refusal(error)
        }
      },
    ),
    tool(
      'event_rule_create',
      '创建复杂条件下才使用的事件规则。纯时间事件请使用 timer_*，不要用本工具重复调度。'
        + ' 规则可观察内部 DSH 事件、HTTP 轮询、webhook、时间或安静条件，并生成可订阅的 agent.script.* 事件。',
      {
        name: { type: 'string', required: true, description: '规则名称。' },
        trigger: { type: 'json', required: true, description: '触发源对象：{kind: "internal"|"time"|"absence"|"http-poll"|"webhook"|"composite", ...}。' },
        where: { type: 'json', description: '条件数组，元素形如 {field, op, value}。' },
        contentTemplate: { type: 'string', required: true, description: '生成事件正文，可使用 {{params.foo}} 插值。' },
        script: { type: 'json', description: '可选的隔离脚本 {source, timeoutMs?, memoryMb?}，返回真值才触发。' },
        wake: { type: 'boolean', description: '生成事件是否唤醒一轮；默认 true。' },
        visibilitySessionIds: { type: 'array', items: { type: 'string' }, description: '可选的可见会话范围，只可收窄。' },
        cooldownMs: { type: 'number', description: '最小触发间隔（毫秒）。' },
        maxFires: { type: 'integer', description: '最大触发次数；0 表示不限。' },
        expiresAt: { type: 'string', description: '可选的过期时间（ISO-8601）。' },
        webhookSecret: { type: 'string', description: 'webhook 触发时必填的共享密钥；只保存哈希。' },
      },
      async (args, exec) => {
        try {
          const rule = await manager.createRule(sessionOf(exec), ruleDraft(args))
          return { message: `已创建规则「${rule.name}」，生成事件类型 ${ruleGeneratedKind(rule.id)}。`, data: json(rule) }
        } catch (error: unknown) {
          refusal(error)
        }
      },
    ),
    tool(
      'event_rule_list',
      '列出当前会话的事件规则及其运行状态。原始内部事件不会出现在订阅面板，只有规则生成的 agent.script.* 事件可订阅。',
      {},
      async (_args, exec) => {
        try {
          const rules = await manager.rulesFor(sessionOf(exec))
          return {
            message: rules.length === 0 ? '当前没有事件规则。' : `共有 ${String(rules.length)} 条事件规则。`,
            data: json(rules),
          }
        } catch (error: unknown) {
          refusal(error)
        }
      },
    ),
    tool(
      'event_rule_update',
      '修改当前会话的事件规则并热重载触发关系。时间字段会重新计算下次触发。',
      {
        id: { type: 'string', required: true, description: '规则 id。' },
        name: { type: 'string', description: '新名称。' },
        trigger: { type: 'json', description: '新的触发源对象。' },
        where: { type: 'json', description: '新的条件数组。' },
        contentTemplate: { type: 'string', description: '新的生成正文。' },
        script: { type: 'json', description: '新的隔离脚本；传 null 清除。' },
        wake: { type: 'boolean', description: '新的唤醒策略。' },
        visibilitySessionIds: { type: 'array', items: { type: 'string' }, description: '新的可见范围。' },
        cooldownMs: { type: 'number', description: '新的冷却毫秒数。' },
        maxFires: { type: 'integer', description: '新的最大触发次数。' },
        expiresAt: { type: 'string', description: '新的过期时间；传空字符串清除。' },
        webhookSecret: { type: 'string', description: '新的 webhook 密钥。' },
      },
      async (args, exec) => {
        try {
          const rule = await manager.updateRule(sessionOf(exec), String(args['id']), rulePatch(args))
          return { message: `规则「${rule.name}」已更新。`, data: json(rule) }
        } catch (error: unknown) {
          refusal(error)
        }
      },
    ),
    tool(
      'event_rule_test',
      '用合成的触发上下文测试事件规则，不发布事件、不消耗触发次数。脚本仍会在隔离环境中执行。',
      { id: { type: 'string', required: true, description: '规则 id。' } },
      async (args, exec) => {
        try {
          const result = await manager.testRule(sessionOf(exec), String(args['id']))
          return { message: `${result.detail}${result.content === undefined ? '' : `；将发布：${result.content}`}`, data: json(result) }
        } catch (error: unknown) {
          refusal(error)
        }
      },
    ),
    tool(
      'event_rule_pause',
      '暂停当前会话的事件规则。暂停保留定义和已注册的生成事件类型。',
      { id: { type: 'string', required: true, description: '规则 id。' } },
      async (args, exec) => {
        try {
          const rule = await manager.pauseRule(sessionOf(exec), String(args['id']), true)
          return { message: `规则「${rule.name}」已暂停。`, data: json(rule) }
        } catch (error: unknown) {
          refusal(error)
        }
      },
    ),
    tool(
      'event_rule_resume',
      '恢复当前会话的事件规则。',
      { id: { type: 'string', required: true, description: '规则 id。' } },
      async (args, exec) => {
        try {
          const rule = await manager.pauseRule(sessionOf(exec), String(args['id']), false)
          return { message: `规则「${rule.name}」已恢复。`, data: json(rule) }
        } catch (error: unknown) {
          refusal(error)
        }
      },
    ),
    tool(
      'event_rule_cancel',
      '取消当前会话的事件规则并注销其生成事件类型。',
      { id: { type: 'string', required: true, description: '规则 id。' } },
      async (args, exec) => {
        try {
          await manager.cancelRule(sessionOf(exec), String(args['id']))
          return { message: '事件规则已取消。' }
        } catch (error: unknown) {
          refusal(error)
        }
      },
    ),
  ]
}

/**
 * Register ContextGate tools with the tool service.
 * @param ctx - Host context.
 * @param manager - the manager the tools use.
 */
export function registerContextGateTools(ctx: Context, manager: ContextGateToolManager): void {
  const definitions = buildContextGateTools(manager)
  ctx.inject(['tools'], (scoped) => {
    for (const definition of definitions) {
      scoped.effect(() => scoped.tools.register(definition), `context-gate.tool.${definition.name}`)
    }
  })
}

function timerDraft(args: Record<string, unknown>): TimerDraft & { readonly schedule?: TimerSchedule } {
  return {
    name: String(args['name']),
    content: String(args['content']),
    ...(args['wake'] === undefined ? {} : { wake: args['wake'] === true }),
    ...scheduleFields(args),
  }
}

function timerPatch(args: Record<string, unknown>): TimerPatch {
  return {
    ...(args['name'] === undefined ? {} : { name: String(args['name']) }),
    ...(args['content'] === undefined ? {} : { content: String(args['content']) }),
    ...(args['wake'] === undefined ? {} : { wake: args['wake'] === true }),
    ...(args['enabled'] === undefined ? {} : { enabled: args['enabled'] === true }),
    ...(args['at'] === undefined ? {} : { at: String(args['at']) }),
    ...(args['afterSeconds'] === undefined ? {} : { afterSeconds: Number(args['afterSeconds']) }),
    ...(args['rrule'] === undefined ? {} : { rrule: String(args['rrule']) }),
    ...(args['timeZone'] === undefined ? {} : { timeZone: String(args['timeZone']) }),
    ...(args['everySeconds'] === undefined ? {} : { everySeconds: Number(args['everySeconds']) }),
    ...(args['expiresAt'] === undefined ? {} : { expiresAt: String(args['expiresAt']) === '' ? null : String(args['expiresAt']) }),
  }
}

function scheduleFields(args: Record<string, unknown>): Partial<TimerDraft> {
  return {
    ...(args['at'] === undefined ? {} : { at: String(args['at']) }),
    ...(args['afterSeconds'] === undefined ? {} : { afterSeconds: Number(args['afterSeconds']) }),
    ...(args['rrule'] === undefined ? {} : { rrule: String(args['rrule']) }),
    ...(args['timeZone'] === undefined ? {} : { timeZone: String(args['timeZone']) }),
    ...(args['everySeconds'] === undefined ? {} : { everySeconds: Number(args['everySeconds']) }),
    ...(args['expiresAt'] === undefined ? {} : { expiresAt: String(args['expiresAt']) }),
  }
}

function ruleDraft(args: Record<string, unknown>): EventRuleDraft {
  const where = args['where'] === undefined ? undefined : asConditions(args['where'])
  const script = args['script'] === undefined ? undefined : asScript(args['script'])
  const visibility = args['visibilitySessionIds'] === undefined
    ? undefined
    : { sessionIds: asStringArray(args['visibilitySessionIds'], 'visibilitySessionIds') }
  return {
    name: String(args['name']),
    trigger: asTrigger(args['trigger']),
    ...(where === undefined ? {} : { where }),
    contentTemplate: String(args['contentTemplate']),
    ...(script === undefined ? {} : { script }),
    ...(args['wake'] === undefined ? {} : { wake: args['wake'] === true }),
    ...(visibility === undefined ? {} : { visibility }),
    ...(args['cooldownMs'] === undefined ? {} : { cooldownMs: Number(args['cooldownMs']) }),
    ...(args['maxFires'] === undefined ? {} : { maxFires: Number(args['maxFires']) }),
    ...(args['expiresAt'] === undefined ? {} : { expiresAt: String(args['expiresAt']) }),
    ...(args['webhookSecret'] === undefined ? {} : { webhookSecret: String(args['webhookSecret']) }),
  }
}

function rulePatch(args: Record<string, unknown>): EventRulePatch {
  return {
    ...(args['name'] === undefined ? {} : { name: String(args['name']) }),
    ...(args['trigger'] === undefined ? {} : { trigger: asTrigger(args['trigger']) }),
    ...(args['where'] === undefined ? {} : { where: asConditions(args['where']) }),
    ...(args['contentTemplate'] === undefined ? {} : { contentTemplate: String(args['contentTemplate']) }),
    ...(args['script'] === undefined ? {} : { script: args['script'] === null ? null : asScript(args['script']) }),
    ...(args['wake'] === undefined ? {} : { wake: args['wake'] === true }),
    ...(args['visibilitySessionIds'] === undefined
      ? {}
      : { visibility: { sessionIds: asStringArray(args['visibilitySessionIds'], 'visibilitySessionIds') } }),
    ...(args['cooldownMs'] === undefined ? {} : { cooldownMs: Number(args['cooldownMs']) }),
    ...(args['maxFires'] === undefined ? {} : { maxFires: Number(args['maxFires']) }),
    ...(args['expiresAt'] === undefined
      ? {}
      : { expiresAt: String(args['expiresAt']) === '' ? null : String(args['expiresAt']) }),
    ...(args['webhookSecret'] === undefined ? {} : { webhookSecret: String(args['webhookSecret']) }),
  }
}

function asTrigger(value: unknown): RuleTrigger {
  const record = asRecord(value, 'trigger')
  const kind = record['kind']
  if (typeof kind !== 'string') throw new ContextGateError('RULE_INVALID', 'trigger.kind 必须是字符串')
  return { ...record, kind } as RuleTrigger
}

function asConditions(value: unknown): readonly RuleCondition[] {
  if (!Array.isArray(value)) throw new ContextGateError('RULE_INVALID', 'where 必须是条件数组')
  return value.map((entry, index) => {
    const record = asRecord(entry, `where[${String(index)}]`)
    return { ...record, field: String(record['field']), op: String(record['op']) } as RuleCondition
  })
}

function asScript(value: unknown): RuleScript {
  const record = asRecord(value, 'script')
  if (typeof record['source'] !== 'string') throw new ContextGateError('RULE_INVALID', 'script.source 必须是字符串')
  return {
    source: record['source'],
    ...(record['timeoutMs'] === undefined ? {} : { timeoutMs: Number(record['timeoutMs']) }),
    ...(record['memoryMb'] === undefined ? {} : { memoryMb: Number(record['memoryMb']) }),
  }
}

function ruleGeneratedKind(ruleId: string): string {
  return `agent.script.${ruleId.replaceAll('-', '').toLowerCase()}`
}

function formatInstant(at: number | null): string {
  return at === null ? '无（计划已结束）' : new Date(at).toISOString()
}

/** Re-exported for callers that render a tool failure. */
export { describeError as describeToolError }

/** Re-exported parameter-value payload type used by the client. */
export type { EventParameterValues }
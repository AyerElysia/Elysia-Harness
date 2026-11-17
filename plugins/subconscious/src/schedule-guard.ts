import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { formatScheduleLocalTime, ScheduleId } from '@deepseek-ai/dsh-schedule'
import type { ScheduleCatalogEntry } from '@deepseek-ai/dsh-schedule'
import type {} from '@deepseek-ai/dsh-tools'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { ROUTER_SESSION_ID } from './model.ts'

const SCHEDULE_TOOLS = new Set(['schedule_create', 'schedule_list', 'schedule_view', 'schedule_edit'])
const MAX_LIST_LIMIT = 500

interface ScheduleArgs {
  id?: unknown
  target?: unknown
  active?: unknown
  limit?: unknown
  offset?: unknown
}

function denial(exec: ToolExecution, reason: string) {
  return { kind: 'deny' as const, reason, info: { name: exec.name, code: 'ELYSIA_SCHEDULE_DENIED' } }
}

function routerCaller(exec: ToolExecution): Agent | undefined {
  return exec.agent?.session.id === ROUTER_SESSION_ID ? exec.agent : undefined
}

function ownedByRouter(task: ScheduleCatalogEntry): boolean {
  return task.target.kind === 'session' && task.target.sessionId === ROUTER_SESSION_ID
}

/** Match the native tool's public projection without exposing Host bookkeeping. */
function modelTask(task: ScheduleCatalogEntry): JsonValue {
  const { involvedSessionIds: _involved, createdAt: _created, executionActive: _execution,
    deliveryFloorEndsAt: _floor, lastDelivery, ...record } = task
  return {
    ...record,
    scheduledAtLocal: formatScheduleLocalTime(task, task.scheduledAt),
    ...lastDelivery === undefined ? {} : { lastDelivery: {
      scheduledAt: lastDelivery.scheduledAt,
      deliveredAt: lastDelivery.deliveredAt,
      targetSessionId: lastDelivery.targetSessionId,
    } },
  } as unknown as JsonValue
}

/**
 * Keep DSH's native Schedule tools and service, but narrow this Agent's view to
 * tasks that actually deliver to the long-lived Router Session. List filtering
 * happens before a fresh page is cut, so neither foreign rows nor Host totals leak.
 */
export function installScheduleGuard(ctx: Context): void {
  ctx.on('tools/pre-execute', async (exec, next) => {
    if (!SCHEDULE_TOOLS.has(exec.name)) return next()
    const caller = routerCaller(exec)
    if (caller === undefined) return denial(exec, 'Schedule 工具只允许潜意识中枢 Session 使用')
    const args = exec.arguments as ScheduleArgs
    if ((exec.name === 'schedule_create' || exec.name === 'schedule_edit')
      && args.target !== undefined && args.target !== 'this_session') {
      return denial(exec, '潜意识中枢只能创建或保留 this_session 日程，不能新建或改投其他 Session')
    }
    if (exec.name !== 'schedule_view' && exec.name !== 'schedule_edit') return next()
    if (typeof args.id !== 'string' || args.id.length === 0) return next()
    const current = await ctx.schedule.view({ id: ScheduleId(args.id) })
    if ('kind' in current && !ownedByRouter(current)) {
      return denial(exec, '该日程不属于潜意识中枢，不能查看或修改')
    }
    return next()
  })

  ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next()
    if (exec.name !== 'schedule_list' || result.isError || decision.kind !== 'accept') return decision
    const args = exec.arguments as ScheduleArgs
    const active = typeof args.active === 'boolean' ? args.active : undefined
    const limit = typeof args.limit === 'number' ? args.limit : 100
    const offset = typeof args.offset === 'number' ? args.offset : 0
    const owned: ScheduleCatalogEntry[] = []
    let sourceOffset = 0
    for (;;) {
      const page = await ctx.schedule.list({
        ...active === undefined ? {} : { active }, limit: MAX_LIST_LIMIT, offset: sourceOffset,
      })
      owned.push(...page.items.filter(ownedByRouter))
      sourceOffset += page.items.length
      if (sourceOffset >= page.total || page.items.length === 0) break
    }
    const items = owned.slice(offset, offset + limit).map(modelTask)
    return {
      kind: 'accept',
      value: { items, shown: items.length, total: owned.length, limit, offset } as unknown as JsonValue,
    }
  })
}

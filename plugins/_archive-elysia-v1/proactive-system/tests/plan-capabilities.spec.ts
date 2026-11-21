import { Context, type Fiber } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { createScope, type Scope } from '@deepseek-ai/dsh-scope'
import { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import { ScheduleId, type ScheduleCatalogEntry } from '@deepseek-ai/dsh-schedule'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as NativeToolExecutor from '../../../dsh/packages/core/tool-executor-native/src/index.ts'
import * as PlanTools from '../src/plan-tools.ts'
import * as PlanHost from '../src/plan-host.ts'

const host = vi.hoisted(() => ({
  mounted: vi.fn(),
  disposed: vi.fn(async () => {}),
  onMounted: undefined as (() => void) | undefined,
  startup: undefined as Promise<void> | undefined,
}))

vi.mock('@deepseek-ai/dsh-schedule', async importOriginal => {
  const actual = await importOriginal<typeof import('@deepseek-ai/dsh-schedule')>()
  return {
    ...actual,
    default: async function fixtureNativeSchedule(ctx: Context, config: unknown) {
      host.mounted(config)
      ctx.effect(() => () => host.disposed(), 'fixture-native-schedule()')
      host.onMounted?.()
      await host.startup
    },
  }
})

const roots: Context[] = []
beforeEach(() => {
  host.mounted.mockClear()
  host.disposed.mockClear()
  host.disposed.mockImplementation(async () => {})
  host.onMounted = undefined
  host.startup = undefined
})
afterEach(async () => {
  await Promise.all(roots.splice(0).map(ctx => ctx.fiber.dispose()))
})

function context(): Context {
  const ctx = new Context()
  roots.push(ctx)
  return ctx
}

function agent(ctx: Context, id: string): Agent {
  const sessionId = SessionId(id)
  return { id: sessionId, ctx, options: {}, session: { id: sessionId, header: {} } } as Agent
}

function registry(ctx: Context, owner: Agent): Map<Agent['id'], Agent> {
  const live = new Map([[owner.id, owner]])
  ctx.provide('agents', { get: (id: Agent['id']) => live.get(id) } as Context['agents'])
  return live
}

describe('scoped native plan capabilities', () => {
  it('rejects global mounting without changing global tools', async () => {
    const ctx = context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(NativeToolExecutor)
    await expect(ctx.plugin(PlanTools)).rejects.toThrow('Agent-scoped')
    expect(ctx.tools.schemas()).toEqual([])
  })

  it('keeps all four native tools scoped and disposable, with reminders targeting the caller session', async () => {
    const ctx = context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(NativeToolExecutor)
    ctx.tools.register(defineTool({
      name: 'ordinary', description: 'fixture capability', parameters: {},
      output: { schema: { type: 'string' }, render: () => [] },
      execute: async () => 'ok',
    }))
    ctx.tools.register(defineTool({
      name: 'other_global', description: 'fixture capability', parameters: {},
      output: { schema: { type: 'string' }, render: () => [] },
      execute: async () => 'ok',
    }))
    const owner = agent(ctx, 'fixture-main')
    const foreign = agent(ctx, 'fixture-foreign')
    let scope!: Scope
    let foreignScope!: Scope
    await ctx.plugin(Object.assign((scoped: Context) => {
      scope = createScope(scoped, owner)
      foreignScope = createScope(scoped, foreign)
    }, { inject: ['tools'] }))
    Object.assign(owner, { ctx: scope.ctx })
    Object.assign(foreign, { ctx: foreignScope.ctx })
    scope.ctx.tools.restrict({ allow: ['ordinary'] })
    const rrule = 'DTSTART:20991114T160000Z\nRRULE:FREQ=DAILY;COUNT=1'
    const target = { kind: 'session', sessionId: owner.session.id } as const
    const record: ScheduleCatalogEntry = {
      id: ScheduleId('fixture-plan'), title: 'fixture title', prompt: 'fixture instruction',
      kind: 'rrule', rrule, scheduledAt: '2099-11-14T16:00:00.000Z',
      target, involvedSessionIds: [owner.session.id], status: 'active',
    }
    const schedule: Pick<Context['schedule'], 'create' | 'list' | 'view' | 'edit' | 'deliveryLimits'> = {
      create: vi.fn<Context['schedule']['create']>(async () => record),
      list: vi.fn<Context['schedule']['list']>(async () => ({ items: [record], shown: 1, total: 1, limit: 20, offset: 0 })),
      view: vi.fn<Context['schedule']['view']>(async () => record),
      edit: vi.fn<Context['schedule']['edit']>(async request => request.action === 'delete'
        ? { id: request.id, deleted: true }
        : { ...record, title: request.patch.title ?? record.title }),
      deliveryLimits: () => ({ newSessionIntervalSeconds: 60 }),
    }
    ctx.provide('schedule', schedule as Context['schedule'])
    const child = await scope.ctx.plugin(PlanTools)
    const names = ['schedule_create', 'schedule_edit', 'schedule_list', 'schedule_view']
    expect(ctx.tools.schemas(owner).map(tool => tool.name).sort()).toEqual(['ordinary', ...names].sort())
    expect(ctx.tools.schemas().map(tool => tool.name).sort()).toEqual(['ordinary', 'other_global'])
    expect(ctx.tools.schemas(foreign).map(tool => tool.name).sort()).toEqual(['ordinary', 'other_global'])
    const run = async (name: string, args: object) => {
      const batch = await ctx.tools.execute({
        calls: [{ type: 'tool-call', id: ToolCallId('fixture-call'), name, arguments: JSON.stringify(args) }],
        agent: owner, signal: new AbortController().signal,
      })
      expect(batch.results).toHaveLength(1)
      return batch.results[0]!.result
    }
    const created = await run('schedule_create', { title: record.title, prompt: record.prompt, rrule, target: 'this_session' })
    if (created.isError) throw new Error(JSON.stringify(created))
    expect(created.isError).toBe(false)
    expect(created.value).toMatchObject({ id: record.id, target })
    expect(schedule.create).toHaveBeenCalledWith({
      title: record.title, prompt: record.prompt, timing: { kind: 'rrule', rrule }, target,
    }, owner.session.id, expect.any(AbortSignal))
    expect((await run('schedule_list', {})).isError).toBe(false)
    expect(schedule.list).toHaveBeenCalledWith({})
    expect((await run('schedule_view', { id: record.id })).isError).toBe(false)
    expect(schedule.view).toHaveBeenCalledExactlyOnceWith({ id: record.id })
    expect((await run('schedule_edit', { id: record.id, action: 'update', title: 'changed fixture title' })).isError).toBe(false)
    expect(schedule.edit).toHaveBeenCalledWith({ id: record.id, action: 'update', patch: { title: 'changed fixture title' } }, owner.session.id, expect.any(AbortSignal))
    expect((await run('schedule_edit', { id: record.id, action: 'delete' })).isError).toBe(false)
    expect(schedule.edit).toHaveBeenCalledWith({ id: record.id, action: 'delete' }, owner.session.id, expect.any(AbortSignal))
    await child.dispose()
    expect(ctx.tools.schemas(owner).map(tool => tool.name)).toEqual(['ordinary'])
    expect(ctx.tools.schemas().map(tool => tool.name).sort()).toEqual(['ordinary', 'other_global'])
    await scope.dispose()
    await foreignScope.dispose()
  })
})

describe('native plan Host readiness and ownership', () => {
  it('mounts without waiting for readiness and never starts after early disposal', async () => {
    const ctx = context()
    const owner = agent(ctx, 'fixture-main')
    registry(ctx, owner)
    const ready = Promise.withResolvers<Agent>()
    const child = await ctx.plugin(PlanHost, { ready: ready.promise })
    expect(host.mounted).not.toHaveBeenCalled()
    await child.dispose()
    ready.resolve(owner)
    await ready.promise
    expect(host.mounted).not.toHaveBeenCalled()
  })

  it('starts the default native Host once only after readiness', async () => {
    const ctx = context()
    const owner = agent(ctx, 'fixture-main')
    registry(ctx, owner)
    const ready = Promise.withResolvers<Agent>()
    const started = Promise.withResolvers<void>()
    host.onMounted = () => started.resolve()
    const child = await ctx.plugin(PlanHost, { ready: ready.promise })
    expect(host.mounted).not.toHaveBeenCalled()
    ready.resolve(owner)
    await started.promise
    expect(host.mounted).toHaveBeenCalledExactlyOnceWith({})
    ready.resolve(owner)
    await ready.promise
    expect(host.mounted).toHaveBeenCalledTimes(1)
    await child.dispose()
    expect(host.disposed).toHaveBeenCalledTimes(1)
  })

  it('closes only for the exact ready Agent, not another object with the same id', async () => {
    const ctx = context()
    const owner = agent(ctx, 'fixture-main')
    registry(ctx, owner)
    const ready = Promise.withResolvers<Agent>()
    const started = Promise.withResolvers<void>()
    const closed = Promise.withResolvers<void>()
    host.onMounted = () => started.resolve()
    host.disposed.mockImplementation(async () => { closed.resolve() })
    const child = await ctx.plugin(PlanHost, { ready: ready.promise })
    ready.resolve(owner)
    await started.promise
    ctx.emit('agent/disposed', { agent: agent(ctx, 'fixture-main') })
    expect(host.disposed).not.toHaveBeenCalled()
    ctx.emit('agent/disposed', { agent: owner })
    await closed.promise
    expect(host.disposed).toHaveBeenCalledTimes(1)
    await child.dispose()
    expect(host.disposed).toHaveBeenCalledTimes(1)
  })

  it('does not start a stale ready owner and reports only safe diagnostic metadata', async () => {
    const ctx = context()
    const owner = agent(ctx, 'fixture-main')
    const live = registry(ctx, owner)
    live.set(owner.id, agent(ctx, 'fixture-main'))
    const reported = Promise.withResolvers<void>()
    const log = vi.spyOn(ctx.logger, 'error').mockImplementation(() => { reported.resolve() })
    const child = await ctx.plugin(PlanHost, { ready: Promise.resolve(owner) })
    await reported.promise
    expect(host.mounted).not.toHaveBeenCalled()
    expect(log).toHaveBeenCalledWith('elysia-plan-host: %s failed (%s)', 'owner validation', 'Error')
    await child.dispose()
    log.mockRestore()
  })

  it('contains readiness rejection and does not echo its private error message', async () => {
    const ctx = context()
    const owner = agent(ctx, 'fixture-main')
    registry(ctx, owner)
    const ready = Promise.withResolvers<Agent>()
    const reported = Promise.withResolvers<void>()
    const log = vi.spyOn(ctx.logger, 'error').mockImplementation(() => { reported.resolve() })
    const child = await ctx.plugin(PlanHost, { ready: ready.promise })
    ready.reject(new Error('private fixture error body'))
    await reported.promise
    expect(host.mounted).not.toHaveBeenCalled()
    expect(log).toHaveBeenCalledWith('elysia-plan-host: %s failed (%s)', 'readiness', 'Error')
    expect(JSON.stringify(log.mock.calls)).not.toContain('private fixture error body')
    await child.dispose()
    log.mockRestore()
  })

  it('joins native cleanup already claimed by parent teardown', async () => {
    const ctx = context()
    const owner = agent(ctx, 'fixture-main')
    registry(ctx, owner)
    const started = Promise.withResolvers<void>()
    const cleanupEntered = Promise.withResolvers<void>()
    const releaseCleanup = Promise.withResolvers<void>()
    host.onMounted = () => started.resolve()
    host.disposed.mockImplementation(async () => { cleanupEntered.resolve(); await releaseCleanup.promise })
    await ctx.plugin(PlanHost, { ready: Promise.resolve(owner) })
    await started.promise
    let done = false
    const stopping = ctx.fiber.dispose().then(() => { done = true })
    await cleanupEntered.promise
    expect(done).toBe(false)
    releaseCleanup.resolve()
    await stopping
    expect(done).toBe(true)
    expect(host.disposed).toHaveBeenCalledTimes(1)
  })

  it('refuses an existing Host without disposing or replacing that service', async () => {
    const ctx = context()
    const owner = agent(ctx, 'fixture-main')
    registry(ctx, owner)
    const existing = {} as Context['schedule']
    ctx.provide('schedule', existing)
    const reported = Promise.withResolvers<void>()
    const log = vi.spyOn(ctx.logger, 'error').mockImplementation(() => { reported.resolve() })
    const child = await ctx.plugin(PlanHost, { ready: Promise.resolve(owner) })
    await reported.promise
    expect(host.mounted).not.toHaveBeenCalled()
    expect(ctx.schedule).toBe(existing)
    await child.dispose()
    expect(host.disposed).not.toHaveBeenCalled()
    log.mockRestore()
  })

  it('keeps a rejected late readiness inert after disposal', async () => {
    const ctx = context()
    const owner = agent(ctx, 'fixture-main')
    registry(ctx, owner)
    const ready = Promise.withResolvers<Agent>()
    const log = vi.spyOn(ctx.logger, 'error')
    const child = await ctx.plugin(PlanHost, { ready: ready.promise })
    await child.dispose()
    ready.reject(new Error('late private fixture error'))
    await ready.promise.catch(() => undefined)
    expect(host.mounted).not.toHaveBeenCalled()
    expect(host.disposed).not.toHaveBeenCalled()
    expect(log).not.toHaveBeenCalled()
    log.mockRestore()
  })

  it('reclaims a native child published during reentrant owner disposal', async () => {
    const ctx = context()
    const owner = agent(ctx, 'fixture-main')
    registry(ctx, owner)
    const published = Promise.withResolvers<Fiber>()
    ctx.on('internal/plugin', fiber => {
      if (fiber.name !== 'fixtureNativeSchedule') return
      ctx.emit('agent/disposed', { agent: owner })
      published.resolve(fiber)
    })
    const child = await ctx.plugin(PlanHost, { ready: Promise.resolve(owner) })
    const native = await published.promise
    await native.await()
    expect(native.uid).toBeNull()
    await child.dispose()
  })
})

/**
 * Readiness and lifetime boundary around DSH's existing Host scheduler.
 * No reminder queue, timer, storage, delivery or model implementation lives here.
 */
import type { Context, Fiber } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import NativeSchedule from '@deepseek-ai/dsh-schedule'
import { scopeOf } from '@deepseek-ai/dsh-scope'

export const name = 'elysia-plan-host'
export const inject = ['agents']

export interface Config {
  /** The assembled, published main Agent; rejection leaves scheduling stopped. */
  ready: Promise<Agent>
}

/**
 * Admit the native Host exactly once after its live owner is ready.
 * Unloading cancels only this gate and drains only its native child. The caller
 * owns ready, so an unresolved readiness promise is never awaited on disposal.
 */
export function apply(ctx: Context, config: Config): void {
  if (scopeOf(ctx) !== undefined) {
    throw new Error('elysia-plan-host requires an unscoped Host context')
  }

  const cancelled = Promise.withResolvers<undefined>()
  let stopped = false
  let owner: Agent | undefined
  let native: Fiber | undefined
  let stopping: Promise<void> | undefined
  let settled: Promise<void> = Promise.resolve()
  let stage = 'readiness'

  const closeNative = async (): Promise<void> => {
    if (native === undefined) return
    await native.dispose()
    // Cordis public disposers are single-shot. Join a transition already claimed
    // by a concurrent parent teardown rather than treating that call as complete.
    while (native.inertia !== undefined) await native.inertia
  }

  const stop = (): Promise<void> => {
    stopped = true
    cancelled.resolve(undefined)
    return stopping ??= (async () => {
      await closeNative()
      await settled
    })()
  }

  const removeOwnerListener = ctx.on('agent/disposed', ({ agent }) => {
    if (agent === owner) return stop()
  }, { global: true })

  ctx.effect(() => () => {
    const closing = stop()
    removeOwnerListener()
    return closing
  }, 'elysia-plan-host.lifetime()')

  settled = Promise.race([config.ready, cancelled.promise]).then(async (agent) => {
    if (stopped || agent === undefined) return
    stage = 'owner validation'
    if (agent.id !== agent.session.id || ctx.agents.get(agent.id) !== agent) {
      throw new Error('ready Agent is no longer the exact live owner')
    }
    stage = 'Host ownership'
    if (ctx.get('schedule') !== undefined) {
      throw new Error('native Schedule is already mounted')
    }
    owner = agent
    stage = 'native startup'
    native = ctx.plugin(NativeSchedule, {})
    // Plugin publication can synchronously dispose the owner before plugin()
    // returns its child handle. Reclaim that exact late handle as well.
    if (stopped) {
      await closeNative()
      return
    }
    await native.await()
  }).catch(async (error: unknown) => {
    stopped = true
    cancelled.resolve(undefined)
    try {
      await closeNative()
    } catch (cleanupError: unknown) {
      const kind = cleanupError instanceof Error ? cleanupError.name : 'non-Error'
      ctx.logger.error('elysia-plan-host: native cleanup failed (%s)', kind)
    }
    // Readiness can reject with private provider/context details. Expose only
    // the engineering stage and error type, never the external error body.
    const kind = error instanceof Error ? error.name : 'non-Error'
    ctx.logger.error('elysia-plan-host: %s failed (%s)', stage, kind)
  })
}

/**
 * Subscription parameter schema and future-session subscriptions.
 */
import { describe, expect, it, onTestFinished } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import * as gate from '../src/index.ts'
import { firePreStep, textOf } from './helpers.ts'

interface Env {
  readonly ctx: Context
  readonly agent: Agent
  readonly harness: Awaited<ReturnType<typeof mountAgentLoopTestHarness>>
}

async function setup(): Promise<Env> {
  const stateDir = await mkdtemp(join(tmpdir(), 'context-gate-subscriptions-'))
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx, { systemPrompt: { personaPrefix: '', personaSuffix: '' } })
  const harness = await mountAgentLoopTestHarness(ctx)
  await ctx.plugin(gate, { stateDir, batchMs: 20, maxWaitMs: 100, tickMs: 20 })
  const agent = await harness.create(SessionId('s1'), { provider: 'mock', model: 'mock' })
  onTestFinished(async () => {
    await ctx.fiber.dispose()
    await rm(stateDir, { recursive: true, force: true })
  })
  return { ctx, agent, harness }
}

function registerParams(env: Env): () => void {
  return env.ctx.contextGate.registerContextKind({
    kind: 'demo.params',
    nameZh: '参数事件',
    description: 'A kind with subscription parameters.',
    parameters: [
      {
        key: 'sources', labelZh: '来源会话', type: 'session', multiple: true, allowAll: true, allowFuture: true,
        optionsProvider: sessionId => [{ value: sessionId, labelZh: '当前会话' }],
      },
      {
        key: 'level', labelZh: '级别', type: 'enum',
        options: [{ value: 'low', labelZh: '低' }, { value: 'high', labelZh: '高' }],
      },
      { key: 'live', labelZh: '仅实时', type: 'boolean' },
      { key: 'limit', labelZh: '上限', type: 'number' },
    ],
  })
}

describe('subscription parameters', () => {
  it('stores validated parameter values and renders the schema', async () => {
    const env = await setup()
    const dispose = registerParams(env)
    onTestFinished(() => { dispose() })
    await env.ctx.contextGate.setContext('s1', 'demo.params', true)
    await env.ctx.contextGate.setSubscriptionParams('s1', 'demo.params', {
      sources: ['s1', '*'], level: 'high', live: true, limit: 5,
    })
    const snapshot = await env.ctx.contextGate.list('s1')
    const entry = snapshot.contexts.find(context => context.kind === 'demo.params')
    expect(entry?.subscribed).toBe(true)
    expect(entry?.params).toEqual({ sources: ['s1', '*'], level: 'high', live: true, limit: 5 })
    expect(entry?.parameters?.map(parameter => parameter.key)).toEqual(['sources', 'level', 'live', 'limit'])
    expect(entry?.parameters?.find(parameter => parameter.key === 'sources')?.options)
      .toEqual([{ value: 's1', labelZh: '当前会话' }])
  })

  it('refuses an undeclared key and a wrong value type', async () => {
    const env = await setup()
    const dispose = registerParams(env)
    onTestFinished(() => { dispose() })
    await env.ctx.contextGate.setContext('s1', 'demo.params', true)
    await expect(env.ctx.contextGate.setSubscriptionParams('s1', 'demo.params', { nope: 1 }))
      .rejects.toMatchObject({ code: 'contextGate/PARAM_UNKNOWN' })
    await expect(env.ctx.contextGate.setSubscriptionParams('s1', 'demo.params', { level: 'medium' }))
      .rejects.toMatchObject({ code: 'contextGate/PARAM_INVALID' })
    await expect(env.ctx.contextGate.setSubscriptionParams('s1', 'demo.params', { live: 'yes' }))
      .rejects.toMatchObject({ code: 'contextGate/PARAM_INVALID' })
    await expect(env.ctx.contextGate.setSubscriptionParams('s1', 'demo.params', { sources: [] }))
      .rejects.toMatchObject({ code: 'contextGate/PARAM_INVALID' })
  })

  it('refuses allCurrent when the schema does not allow it', async () => {
    const env = await setup()
    const dispose = env.ctx.contextGate.registerContextKind({
      kind: 'demo.strict', nameZh: '严格来源', description: 'session param without allowAll',
      parameters: [{ key: 'sources', labelZh: '来源会话', type: 'session', multiple: true }],
    })
    onTestFinished(() => { dispose() })
    await env.ctx.contextGate.setContext('s1', 'demo.strict', true)
    await expect(env.ctx.contextGate.setSubscriptionParams('s1', 'demo.strict', { sources: ['*'] }))
      .rejects.toMatchObject({ code: 'contextGate/PARAM_INVALID' })
  })
})

describe('future-session subscriptions', () => {
  it('auto-subscribes sessions observed after the rule and injects into them', async () => {
    const env = await setup()
    const dispose = env.ctx.contextGate.registerContextKind({
      kind: 'demo.future', nameZh: '未来事件', description: 'future subscription source',
    })
    onTestFinished(() => { dispose() })
    await env.ctx.contextGate.subscribeFuture('s1', 'demo.future', {})
    const second = await env.harness.create(SessionId('s2'), { provider: 'mock', model: 'mock' })
    const receipt = await env.ctx.contextGate.publish({
      kind: 'demo.future', source: 'test', summary: 'for future sessions', params: {},
    })
    expect(receipt.delivered).toBe(2)
    const snapshot = await env.ctx.contextGate.list('s2')
    expect(snapshot.contexts.find(context => context.kind === 'demo.future')?.subscribed).toBe(true)
    const { injected } = await firePreStep(env.ctx, second)
    expect(textOf(injected[0] as NonNullable<typeof injected[0]>)).toContain('for future sessions')
  })

  it('lets an explicit unsubscribe override a future rule for that session', async () => {
    const env = await setup()
    const dispose = env.ctx.contextGate.registerContextKind({
      kind: 'demo.override', nameZh: '未来覆盖事件', description: 'future subscription source',
    })
    onTestFinished(() => { dispose() })
    await env.ctx.contextGate.subscribeFuture('s1', 'demo.override', {})
    const second = await env.harness.create(SessionId('s2'), { provider: 'mock', model: 'mock' })
    await env.ctx.contextGate.setContext(second.session.id, 'demo.override', false)
    const receipt = await env.ctx.contextGate.publish({
      kind: 'demo.override', source: 'test', summary: 'only s1', params: {},
    })
    expect(receipt.delivered).toBe(1)
  })
})
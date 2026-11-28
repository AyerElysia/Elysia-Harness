/**
 * Merged custom-event rules: internal triggers, generated subscriptions,
 * conditions, isolated scripts, webhook authentication, and failure isolation.
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
import { ruleKind } from '../src/rules.ts'
import { firePreStep, sleep, textOf } from './helpers.ts'

interface Env {
  readonly ctx: Context
  readonly agent: Agent
  readonly harness: Awaited<ReturnType<typeof mountAgentLoopTestHarness>>
}

async function setup(): Promise<Env> {
  const stateDir = await mkdtemp(join(tmpdir(), 'context-gate-rules-'))
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

describe('custom event rules', () => {
  it('generates a subscribable event from an internal turn trigger', async () => {
    const env = await setup()
    const rule = await env.ctx.contextGate.createRule('s1', {
      name: '回合提醒',
      trigger: { kind: 'internal', event: 'turn/start' },
      contentTemplate: '第 {{turn}} 回合开始了',
      wake: false,
    })
    await env.ctx.contextGate.setContext('s1', ruleKind(rule.id), true)
    env.agent.session.append('turn/start', { turn: 7 })
    await sleep(120)
    const { injected } = await firePreStep(env.ctx, env.agent)
    expect(injected).toHaveLength(1)
    expect(textOf(injected[0] as NonNullable<typeof injected[0]>)).toContain('第 7 回合开始了')
    const snapshot = await env.ctx.contextGate.list('s1')
    expect(snapshot.rules?.find(entry => entry.id === rule.id)?.fireCount).toBe(1)
    expect(snapshot.contexts.some(context => context.kind === ruleKind(rule.id))).toBe(true)
  })

  it('makes a generated event subscribable by another session', async () => {
    const env = await setup()
    const second = await env.harness.create(SessionId('s2'), { provider: 'mock', model: 'mock' })
    const rule = await env.ctx.contextGate.createRule('s1', {
      name: '跨会话生成',
      trigger: { kind: 'internal', event: 'turn/start' },
      contentTemplate: '跨会话内容',
      wake: false,
    })
    await env.ctx.contextGate.setContext('s2', ruleKind(rule.id), true)
    env.agent.session.append('turn/start', { turn: 1 })
    await sleep(120)
    const { injected } = await firePreStep(env.ctx, second)
    expect(injected).toHaveLength(1)
    expect(textOf(injected[0] as NonNullable<typeof injected[0]>)).toContain('跨会话内容')
    // The generated event never carries the raw internal payload.
    const generated = (await env.ctx.contextGate.list('s2')).events.find(entry => entry.kind === ruleKind(rule.id))
    expect(generated?.kind).toBe(ruleKind(rule.id))
  })

  it('evaluates declarative conditions before firing', async () => {
    const env = await setup()
    const rule = await env.ctx.contextGate.createRule('s1', {
      name: '条件规则',
      trigger: { kind: 'internal', event: 'turn/start' },
      where: [{ field: 'turn', op: 'gt', value: 5 }],
      contentTemplate: '大回合 {{turn}}',
      wake: false,
    })
    await env.ctx.contextGate.setContext('s1', ruleKind(rule.id), true)
    env.agent.session.append('turn/start', { turn: 2 })
    await sleep(80)
    expect((await env.ctx.contextGate.list('s1')).rules?.[0]?.fireCount).toBe(0)
    env.agent.session.append('turn/start', { turn: 9 })
    await sleep(100)
    const { injected } = await firePreStep(env.ctx, env.agent)
    expect(textOf(injected[0] as NonNullable<typeof injected[0]>)).toContain('大回合 9')
  })

  it('runs an isolated script as an extra condition', async () => {
    const env = await setup()
    const rule = await env.ctx.contextGate.createRule('s1', {
      name: '脚本规则',
      trigger: { kind: 'internal', event: 'turn/start' },
      contentTemplate: '脚本通过',
      script: { source: 'return context.trigger.params.test === true', timeoutMs: 2_000 },
      wake: false,
    })
    const result = await env.ctx.contextGate.testRule('s1', rule.id)
    expect(result.matched).toBe(true)
    expect(result.fired).toBe(true)
  })

  it('refuses a failing or timing-out script without breaking the rule engine', async () => {
    const env = await setup()
    const failing = await env.ctx.contextGate.createRule('s1', {
      name: '失败脚本',
      trigger: { kind: 'internal', event: 'turn/start' },
      contentTemplate: '不会触发',
      script: { source: 'throw new Error("boom")' },
    })
    const result = await env.ctx.contextGate.testRule('s1', failing.id)
    expect(result.matched).toBe(false)
    expect(result.detail).toContain('脚本失败')
    const healthy = await env.ctx.contextGate.createRule('s1', {
      name: '健康规则',
      trigger: { kind: 'internal', event: 'turn/start' },
      contentTemplate: '仍然工作',
    })
    expect((await env.ctx.contextGate.testRule('s1', healthy.id)).fired).toBe(true)
  })

  it('combines a time child with an internal child using all', async () => {
    const env = await setup()
    const rule = await env.ctx.contextGate.createRule('s1', {
      name: '时间加回合',
      trigger: {
        kind: 'composite', op: 'all', windowMs: 5_000,
        triggers: [
          { kind: 'time', schedule: { kind: 'after', afterMs: 100 } },
          { kind: 'internal', event: 'turn/start' },
        ],
      },
      contentTemplate: '时间与回合都满足',
      wake: false,
    })
    await env.ctx.contextGate.setContext('s1', ruleKind(rule.id), true)
    env.agent.session.append('turn/start', { turn: 2 })
    await sleep(350)
    const { injected } = await firePreStep(env.ctx, env.agent)
    expect(injected).toHaveLength(1)
    expect(textOf(injected[0] as NonNullable<typeof injected[0]>)).toContain('时间与回合都满足')
    expect((await env.ctx.contextGate.list('s1')).rules?.[0]?.fireCount).toBe(1)
  })

  it('combines an absence child with an internal child using all', async () => {
    const env = await setup()
    const rule = await env.ctx.contextGate.createRule('s1', {
      name: '安静加回合',
      trigger: {
        kind: 'composite', op: 'all', windowMs: 5_000,
        triggers: [
          { kind: 'absence', kinds: ['demo.composite'], quietMs: 80 },
          { kind: 'internal', event: 'turn/start' },
        ],
      },
      contentTemplate: '安静与回合都满足',
      wake: false,
    })
    await env.ctx.contextGate.setContext('s1', ruleKind(rule.id), true)
    env.agent.session.append('turn/start', { turn: 2 })
    await sleep(300)
    const { injected } = await firePreStep(env.ctx, env.agent)
    expect(injected).toHaveLength(1)
    expect(textOf(injected[0] as NonNullable<typeof injected[0]>)).toContain('安静与回合都满足')
    expect((await env.ctx.contextGate.list('s1')).rules?.[0]?.fireCount).toBe(1)
  })

  it('fires sequence only when children satisfy in order', async () => {
    const env = await setup()
    const rule = await env.ctx.contextGate.createRule('s1', {
      name: '顺序组合',
      trigger: {
        kind: 'composite', op: 'sequence', windowMs: 5_000,
        triggers: [
          { kind: 'time', schedule: { kind: 'after', afterMs: 80 } },
          { kind: 'internal', event: 'turn/start' },
        ],
      },
      contentTemplate: '顺序满足',
      wake: false,
    })
    await env.ctx.contextGate.setContext('s1', ruleKind(rule.id), true)
    await sleep(150)
    env.agent.session.append('turn/start', { turn: 2 })
    await sleep(180)
    const { injected } = await firePreStep(env.ctx, env.agent)
    expect(injected).toHaveLength(1)
    expect(textOf(injected[0] as NonNullable<typeof injected[0]>)).toContain('顺序满足')
  })

  it('fires not when an internal event does not match the child trigger', async () => {
    const env = await setup()
    const rule = await env.ctx.contextGate.createRule('s1', {
      name: '否定组合',
      trigger: {
        kind: 'composite', op: 'not',
        triggers: [{ kind: 'internal', event: 'turn/end' }],
      },
      contentTemplate: '不是回合结束',
      wake: false,
    })
    await env.ctx.contextGate.setContext('s1', ruleKind(rule.id), true)
    env.agent.session.append('turn/start', { turn: 1 })
    await sleep(120)
    expect((await env.ctx.contextGate.list('s1')).rules?.[0]?.fireCount).toBe(1)
    env.agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await sleep(120)
    expect((await env.ctx.contextGate.list('s1')).rules?.[0]?.fireCount).toBe(1)
  })

  it('accepts a webhook child inside a composite rule', async () => {
    const env = await setup()
    const rule = await env.ctx.contextGate.createRule('s1', {
      name: 'Webhook 组合',
      trigger: {
        kind: 'composite', op: 'any',
        triggers: [
          { kind: 'webhook' },
          { kind: 'internal', event: 'turn/start' },
        ],
      },
      contentTemplate: '组合 webhook 触发',
      webhookSecret: 'composite-secret',
      wake: false,
    })
    await env.ctx.contextGate.setContext('s1', ruleKind(rule.id), true)
    const result = await env.ctx.contextGate.webhook(rule.id, 'composite-secret', { value: 1 })
    expect(result.matched).toBe(true)
    await sleep(120)
    const { injected } = await firePreStep(env.ctx, env.agent)
    expect(injected).toHaveLength(1)
    expect(textOf(injected[0] as NonNullable<typeof injected[0]>)).toContain('组合 webhook 触发')
  })

  it('fires a time rule from the shared time engine', async () => {
    const env = await setup()
    const rule = await env.ctx.contextGate.createRule('s1', {
      name: '时间规则',
      trigger: { kind: 'time', schedule: { kind: 'after', afterMs: 100 } },
      contentTemplate: '时间规则触发',
      wake: false,
    })
    await env.ctx.contextGate.setContext('s1', ruleKind(rule.id), true)
    await sleep(300)
    const { injected } = await firePreStep(env.ctx, env.agent)
    expect(injected).toHaveLength(1)
    expect(textOf(injected[0] as NonNullable<typeof injected[0]>)).toContain('时间规则触发')
    expect((await env.ctx.contextGate.list('s1')).rules?.[0]?.fireCount).toBe(1)
  })

  it('fires an absence rule once after its quiet period', async () => {
    const env = await setup()
    const rule = await env.ctx.contextGate.createRule('s1', {
      name: '安静规则',
      trigger: { kind: 'absence', kinds: ['demo.quiet'], quietMs: 80 },
      contentTemplate: '安静规则触发',
      wake: false,
    })
    await env.ctx.contextGate.setContext('s1', ruleKind(rule.id), true)
    await sleep(250)
    const { injected } = await firePreStep(env.ctx, env.agent)
    expect(injected).toHaveLength(1)
    expect(textOf(injected[0] as NonNullable<typeof injected[0]>)).toContain('安静规则触发')
    await sleep(150)
    expect((await env.ctx.contextGate.list('s1')).rules?.[0]?.fireCount).toBe(1)
  })

it('reloads a rule trigger on update without restarting the plugin', async () => {
    const env = await setup()
    const rule = await env.ctx.contextGate.createRule('s1', {
      name: '热重载',
      trigger: { kind: 'internal', event: 'turn/start' },
      contentTemplate: '热重载事件',
      wake: false,
    })
    await env.ctx.contextGate.setContext('s1', ruleKind(rule.id), true)
    await env.ctx.contextGate.updateRule('s1', rule.id, { trigger: { kind: 'internal', event: 'turn/end' } })
    env.agent.session.append('turn/start', { turn: 1 })
    await sleep(100)
    expect((await env.ctx.contextGate.list('s1')).rules?.[0]?.fireCount).toBe(0)
    env.agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await sleep(120)
    expect((await env.ctx.contextGate.list('s1')).rules?.[0]?.fireCount).toBe(1)
  })

it('authenticates a webhook rule and fires it', async () => {
    const env = await setup()
    const rule = await env.ctx.contextGate.createRule('s1', {
      name: 'Webhook 规则',
      trigger: { kind: 'webhook' },
      contentTemplate: '收到外部载荷 {{params.value}}',
      webhookSecret: 'top-secret',
      wake: false,
    })
    await expect(env.ctx.contextGate.webhook(rule.id, 'wrong', { value: 'x' }))
      .rejects.toMatchObject({ code: 'contextGate/WEBHOOK_INVALID' })
    await env.ctx.contextGate.setContext('s1', ruleKind(rule.id), true)
    const result = await env.ctx.contextGate.webhook(rule.id, 'top-secret', { value: 'ok' })
    expect(result.fired).toBe(true)
    await sleep(60)
    const { injected } = await firePreStep(env.ctx, env.agent)
    expect(textOf(injected[0] as NonNullable<typeof injected[0]>)).toContain('收到外部载荷 ok')
  })

  it('updates a webhook rule without requiring the secret again', async () => {
    const env = await setup()
    const rule = await env.ctx.contextGate.createRule('s1', {
      name: 'Webhook 更新',
      trigger: { kind: 'webhook' },
      contentTemplate: '旧内容',
      webhookSecret: 'keep-me',
    })
    const updated = await env.ctx.contextGate.updateRule('s1', rule.id, {
      trigger: { kind: 'webhook' },
      contentTemplate: '新内容',
    })
    expect(updated.contentTemplate).toBe('新内容')
    const result = await env.ctx.contextGate.webhook(rule.id, 'keep-me', { value: 1 })
    expect(result.matched).toBe(true)
  })

it('refuses an HTTP poll host outside the allowlist', async () => {
    const env = await setup()
    await expect(env.ctx.contextGate.createRule('s1', {
      name: '轮询',
      trigger: { kind: 'http-poll', url: 'https://example.com/feed', intervalMs: 1_000 },
      contentTemplate: 'x',
    })).rejects.toMatchObject({ code: 'contextGate/RULE_INVALID' })
  })

  it('pauses, resumes, and cancels a rule and its generated kind', async () => {
    const env = await setup()
    const rule = await env.ctx.contextGate.createRule('s1', {
      name: '生命周期',
      trigger: { kind: 'internal', event: 'turn/start' },
      contentTemplate: '生命周期事件',
    })
    const paused = await env.ctx.contextGate.pauseRule('s1', rule.id, true)
    expect(paused.enabled).toBe(false)
    env.agent.session.append('turn/start', { turn: 1 })
    await sleep(80)
    expect((await env.ctx.contextGate.list('s1')).rules?.[0]?.fireCount).toBe(0)
    await env.ctx.contextGate.pauseRule('s1', rule.id, false)
    await env.ctx.contextGate.cancelRule('s1', rule.id)
    const snapshot = await env.ctx.contextGate.list('s1')
    expect(snapshot.rules).toEqual([])
    expect(snapshot.contexts.some(context => context.kind === ruleKind(rule.id))).toBe(false)
  })
})
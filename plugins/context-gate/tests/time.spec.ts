/**
 * Time engine behavior: per-session timers, presets, absence watchers,
 * restart recovery, and RRULE arithmetic. Native DSH Schedule is not involved.
 */
import { describe, expect, it, onTestFinished } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import * as gate from '../src/index.ts'
import { firstDue, resolveSchedule, TimeEngine } from '../src/time-engine.ts'
import { ContextGateStore, DOCUMENT_FILE_NAME } from '../src/state.ts'
import { firePreStep, sleep, textOf } from './helpers.ts'

interface Env {
  readonly ctx: Context
  readonly stateDir: string
  readonly agent: Agent
  readonly harness: Awaited<ReturnType<typeof mountAgentLoopTestHarness>>
  readonly fiber: { dispose(): Promise<void> }
}

async function setup(stateDir?: string): Promise<Env> {
  const dir = stateDir ?? await mkdtemp(join(tmpdir(), 'context-gate-time-'))
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx, { systemPrompt: { personaPrefix: '', personaSuffix: '' } })
  const harness = await mountAgentLoopTestHarness(ctx)
  const fiber = await ctx.plugin(gate, { stateDir: dir, batchMs: 20, maxWaitMs: 100, tickMs: 20 })
  const agent = await harness.create(SessionId('s1'), { provider: 'mock', model: 'mock' })
  onTestFinished(async () => {
    await ctx.fiber.dispose()
    await rm(dir, { recursive: true, force: true })
  })
  return { ctx, stateDir: dir, agent, harness, fiber }
}

describe('timer schedules', () => {
  it('computes an absolute and a relative due time', () => {
    const now = Date.UTC(2026, 0, 1, 0, 0, 0)
    expect(firstDue({ kind: 'once', at: now + 5_000 }, now)).toBe(now + 5_000)
    expect(firstDue({ kind: 'after', afterMs: 2_000 }, now)).toBe(now + 2_000)
    expect(firstDue({ kind: 'seconds', everySeconds: 3 }, now)).toBe(now + 3_000)
  })

  it('computes RRULE occurrences in an IANA zone with second precision', () => {
    const now = Date.UTC(2026, 0, 1, 0, 0, 0)
    const next = firstDue({
      kind: 'rrule',
      rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=30;BYSECOND=15',
      timeZone: 'Asia/Shanghai',
    }, now)
    expect(next).not.toBeNull()
    const iso = new Date(next as number).toISOString()
    // 09:30:15 Asia/Shanghai is 01:30:15 UTC.
    expect(iso).toContain('01:30:15')
  })

  it('collapses missed repeating rounds into one catch-up firing', () => {
    const now = Date.UTC(2026, 0, 1, 0, 0, 0)
    const state = resolveSchedule({ kind: 'seconds', everySeconds: 1 }, now - 10_000, now - 10_000, now)
    expect(state.dueAt).toBe(now - 10_000)
    expect(state.nextDueAt).toBe(now + 1_000)
    expect(state.missed).toBeGreaterThan(5)
  })

  it('fires a timer into its owner only and marks it consumed', async () => {
    const env = await setup()
    const timer = await env.ctx.contextGate.createTimer('s1', {
      name: '喝水', content: '该喝水了。', afterSeconds: 0.1, wake: false,
    })
    expect(timer.ownerSessionId).toBe('s1')
    await sleep(200)
    const { injected } = await firePreStep(env.ctx, env.agent)
    expect(injected).toHaveLength(1)
    expect(textOf(injected[0] as NonNullable<typeof injected[0]>)).toContain('该喝水了。')
    const snapshot = await env.ctx.contextGate.timers('s1')
    const stored = snapshot.timers.find(entry => entry.id === timer.id)
    expect(stored?.firedCount).toBe(1)
    expect(stored?.enabled).toBe(false)
  })

  it('supports several independent timers in one session', async () => {
    const env = await setup()
    const one = await env.ctx.contextGate.createTimer('s1', { name: '一', content: '一', afterSeconds: 3_600 })
    const two = await env.ctx.contextGate.createTimer('s1', { name: '二', content: '二', afterSeconds: 7_200 })
    expect(one.id).not.toBe(two.id)
    const snapshot = await env.ctx.contextGate.timers('s1')
    expect(snapshot.timers.map(timer => timer.id).sort()).toEqual([one.id, two.id].sort())
  })

  it('pauses and resumes a timer', async () => {
    const env = await setup()
    const timer = await env.ctx.contextGate.createTimer('s1', { name: '暂停', content: 'x', afterSeconds: 3_600 })
    const paused = await env.ctx.contextGate.pauseTimer('s1', timer.id, true)
    expect(paused.enabled).toBe(false)
    const resumed = await env.ctx.contextGate.pauseTimer('s1', timer.id, false)
    expect(resumed.enabled).toBe(true)
    expect(resumed.nextDueAt).toBeGreaterThan(Date.now())
  })

  it('persists the version 2 document with the timer and last-seen sections', async () => {
    const env = await setup()
    await env.ctx.contextGate.createTimer('s1', { name: '持久化', content: 'x', afterSeconds: 60 })
    await env.ctx.contextGate.createAbsence('s1', { kinds: ['*'], quietMs: 60_000 })
    const raw = JSON.parse(await readFile(join(env.stateDir, DOCUMENT_FILE_NAME), 'utf8')) as Record<string, unknown>
    expect(raw['version']).toBe(2)
    const timers = raw['timers'] as Record<string, unknown>
    expect(Array.isArray(timers['instances'])).toBe(true)
    expect((timers['instances'] as unknown[]).length).toBe(1)
    expect(Array.isArray(timers['absence'])).toBe(true)
    expect(raw['rules']).toBeTruthy()
  })

  it('rejects an invalid schedule and an unknown owner', async () => {
    const env = await setup()
    await expect(env.ctx.contextGate.createTimer('s1', {
      name: '坏', content: 'x', everySeconds: 0,
    })).rejects.toMatchObject({ code: 'contextGate/TIMER_INVALID' })
    await expect(env.ctx.contextGate.createTimer('s1', {
      name: '无计划', content: 'x',
    })).rejects.toMatchObject({ code: 'contextGate/TIMER_INVALID' })
    await expect(env.ctx.contextGate.cancelTimer('s1', 'missing'))
      .rejects.toMatchObject({ code: 'contextGate/TIMER_UNKNOWN' })
  })
})

describe('timer presets', () => {
  it('creates independent instances when adopted', async () => {
    const env = await setup()
    const preset = await env.ctx.contextGate.createTimerPreset('s1', {
      name: '每日提醒', content: '每日提醒正文', afterSeconds: 3_600,
    })
    const first = await env.ctx.contextGate.adoptTimerPreset('s1', preset.id)
    const second = await env.ctx.contextGate.adoptTimerPreset('s1', preset.id)
    expect(first.id).not.toBe(second.id)
    expect(first.presetId).toBe(preset.id)
    expect(second.presetId).toBe(preset.id)
    await env.ctx.contextGate.pauseTimer('s1', first.id, true)
    const updatedPreset = await env.ctx.contextGate.updateTimerPreset('s1', preset.id, { content: '新模板正文' })
    expect(updatedPreset.content).toBe('新模板正文')
    const snapshot = await env.ctx.contextGate.timers('s1')
    expect(snapshot.timers.find(entry => entry.id === first.id)?.enabled).toBe(false)
    expect(snapshot.timers.find(entry => entry.id === first.id)?.content).toBe('每日提醒正文')
    expect(snapshot.timers.find(entry => entry.id === second.id)?.enabled).toBe(true)
    expect(snapshot.timers.find(entry => entry.id === second.id)?.content).toBe('每日提醒正文')
    expect(snapshot.presets.find(entry => entry.id === preset.id)?.content).toBe('新模板正文')
  })

  it('refuses an unknown preset', async () => {
    const env = await setup()
    await expect(env.ctx.contextGate.adoptTimerPreset('s1', 'missing'))
      .rejects.toMatchObject({ code: 'contextGate/PRESET_UNKNOWN' })
  })
})

describe('absence', () => {
  it('fires once after the quiet period even without a subscription', async () => {
    const env = await setup()
    const disposeKind = env.ctx.contextGate.registerContextKind({
      kind: 'demo.absence', nameZh: '安静事件', description: 'absence source',
    })
    onTestFinished(() => { disposeKind() })
    await env.ctx.contextGate.publish({ kind: 'demo.absence', source: 'test', summary: 'seen', params: {} })
    const absence = await env.ctx.contextGate.createAbsence('s1', { kinds: ['demo.absence'], quietMs: 80 })
    await sleep(200)
    // The absent wake opens one turn by itself; observe the committed log
    // instead of draining the queue again by hand.
    const consumed = (await env.ctx.contextGate.list('s1')).events
      .filter(entry => entry.kind === 'agent.absence' && entry.outcome === 'consumed')
    expect(consumed).toHaveLength(1)
    const snapshot = await env.ctx.contextGate.timers('s1')
    expect(snapshot.absences.find(entry => entry.id === absence.id)?.fired).toBe(true)
    // No new publication: it must not fire again.
    await sleep(150)
    const again = (await env.ctx.contextGate.list('s1')).events
      .filter(entry => entry.kind === 'agent.absence' && entry.outcome === 'consumed')
    expect(again).toHaveLength(1)
  })

  it('re-arms only when a watched kind is published again', async () => {
    const env = await setup()
    const disposeKind = env.ctx.contextGate.registerContextKind({
      kind: 'demo.rearm', nameZh: '重新武装事件', description: 'absence source',
    })
    onTestFinished(() => { disposeKind() })
    const absence = await env.ctx.contextGate.createAbsence('s1', { kinds: ['demo.rearm'], quietMs: 60 })
    await sleep(150)
    expect((await env.ctx.contextGate.timers('s1')).absences.find(entry => entry.id === absence.id)?.fired).toBe(true)
    await env.ctx.contextGate.publish({ kind: 'demo.rearm', source: 'test', summary: 'again', params: {} })
    expect((await env.ctx.contextGate.timers('s1')).absences.find(entry => entry.id === absence.id)?.fired).toBe(false)
    await sleep(150)
    const consumed = (await env.ctx.contextGate.list('s1')).events
      .filter(entry => entry.kind === 'agent.absence' && entry.outcome === 'consumed')
    expect(consumed.length).toBeGreaterThanOrEqual(2)
  })
})

describe('recurring anchor', () => {
  it('does not re-anchor a bare RRULE after each firing', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'context-gate-anchor-'))
    const store = await ContextGateStore.open(stateDir)
    const delivered: string[] = []
    const engine = new TimeEngine({
      store,
      deliver: async (sessionId, input) => { delivered.push(`${sessionId}:${input.summary}`) },
      onError: () => {},
      maxTimersPerSession: 8,
      maxPresets: 8,
      maxAbsencesPerSession: 8,
    })
    onTestFinished(async () => { await rm(stateDir, { recursive: true, force: true }) })
    const timer = await engine.createTimer('s1', {
      name: '日常', content: 'x', timeZone: 'UTC',
      rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0;BYSECOND=0',
    })
    const anchor = timer.anchorAt
    expect(anchor).toBe(timer.createdAt)

    for (let round = 1; round <= 2; round += 1) {
      const current = store.timer(timer.id)
      if (current === undefined) throw new Error('timer disappeared')
      await store.putTimer({ ...current, nextDueAt: Date.now() - 1 })
      await engine.tick(Date.now())
    }
    const stored = store.timer(timer.id)
    expect(stored?.firedCount).toBe(2)
    expect(stored?.anchorAt).toBe(anchor)
    expect(stored?.nextDueAt).toBeGreaterThan(Date.now())
    expect(delivered).toHaveLength(2)

    // Both firings must resolve to the same daily successor of the fixed anchor.
    const expected = firstDue({
      kind: 'rrule',
      rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0;BYSECOND=0',
      timeZone: 'UTC',
    }, anchor)
    expect(expected).not.toBeNull()
    expect((stored?.nextDueAt ?? 0) - (expected ?? 0)).toBe(0)
  })

  it('migrates a version 2 timer that predates the anchor field', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'context-gate-anchor-migrate-'))
    const store = await ContextGateStore.open(stateDir)
    const engine = new TimeEngine({
      store,
      deliver: async () => {},
      onError: () => {},
      maxTimersPerSession: 8,
      maxPresets: 8,
      maxAbsencesPerSession: 8,
    })
    onTestFinished(async () => { await rm(stateDir, { recursive: true, force: true }) })
    const timer = await engine.createTimer('s1', { name: '旧文档', content: 'x', afterSeconds: 3_600 })
    const file = join(stateDir, DOCUMENT_FILE_NAME)
    const document = JSON.parse(await readFile(file, 'utf8')) as {
      timers: { instances: Array<Record<string, unknown>> }
    }
    delete document.timers.instances[0]?.['anchorAt']
    await writeFile(file, `${JSON.stringify(document, null, 2)}\n`, 'utf8')
    const reopened = await ContextGateStore.open(stateDir)
    expect(reopened.timer(timer.id)?.anchorAt).toBe(timer.createdAt)
  })

it('moves the anchor only when the schedule is replaced or resumed', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'context-gate-anchor-update-'))
    const store = await ContextGateStore.open(stateDir)
    const engine = new TimeEngine({
      store,
      deliver: async () => {},
      onError: () => {},
      maxTimersPerSession: 8,
      maxPresets: 8,
      maxAbsencesPerSession: 8,
    })
    onTestFinished(async () => { await rm(stateDir, { recursive: true, force: true }) })
    const timer = await engine.createTimer('s1', { name: '更新', content: 'x', afterSeconds: 3_600 })
    const original = timer.anchorAt
    await new Promise(resolve => setTimeout(resolve, 5))
    const replaced = await engine.updateTimer('s1', timer.id, { afterSeconds: 7_200 })
    expect(replaced.anchorAt).toBeGreaterThan(original)
    const replacedAnchor = replaced.anchorAt
    await engine.setTimerEnabled('s1', timer.id, false)
    await engine.setTimerEnabled('s1', timer.id, true)
    const resumed = store.timer(timer.id)
    expect(resumed?.anchorAt).toBeGreaterThanOrEqual(replacedAnchor)
    expect(resumed?.nextDueAt).toBeGreaterThan(Date.now())
  })
})

describe('restart recovery', () => {
  it('fires one catch-up round after a missed timer', async () => {
    const env = await setup()
    const timer = await env.ctx.contextGate.createTimer('s1', {
      name: '重启', content: '恢复后补一次', afterSeconds: 0.15,
    })
    await env.fiber.dispose()
    await sleep(250)
    const fiber = await env.ctx.plugin(gate, { stateDir: env.stateDir, batchMs: 20, maxWaitMs: 100, tickMs: 20 })
    onTestFinished(async () => { await fiber.dispose() })
    const { injected } = await firePreStep(env.ctx, env.agent)
    expect(injected).toHaveLength(1)
    expect(textOf(injected[0] as NonNullable<typeof injected[0]>)).toContain('恢复后补一次')
    expect((await env.ctx.contextGate.timers('s1')).timers.find(entry => entry.id === timer.id)?.firedCount).toBe(1)
  })
})
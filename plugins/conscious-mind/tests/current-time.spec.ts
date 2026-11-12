import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { agentEvents, type Agent } from '@deepseek-ai/dsh-agent'
import { unsupportedInbox } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { createScope, type Scope } from '@deepseek-ai/dsh-scope'
import SessionStore, { SessionId, type Session } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as NativeTimeContext from '@deepseek-ai/dsh-time-context'
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from 'vitest'
import * as CurrentTime from '../src/current-time.ts'
import { MAIN_SESSION_ID, isolateMainAgentContext } from '../src/main-session.ts'

beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }) })
afterEach(() => { vi.useRealTimers() })

async function fixture() {
  const ctx = new Context()
  const scopes: Scope[] = []
  onTestFinished(async () => {
    const closed = await Promise.allSettled(scopes.toReversed().map(scope => scope.dispose()))
    await ctx.fiber.dispose()
    const failures = closed.filter(result => result.status === 'rejected')
    if (failures.length > 0) throw new AggregateError(failures.map(result => result.reason), 'Clock fixture cleanup failed')
  })
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SystemPrompt)
  const agents = new Map<string, Agent>()
  await ctx.plugin(Object.assign((injected: Context) => {
    for (const id of [MAIN_SESSION_ID, SessionId('ordinary-clock-fixture')]) {
      const session = ctx.sessions.create(id)
      let agentCtx = injected
      const agent: Agent = {
        id, session, get ctx() { return agentCtx }, options: {}, status: 'running', inbox: unsupportedInbox(),
        send() {}, followup() {}, steer() {}, inject() {}, cancel() {},
        whenIdle: async () => {},
        runMaintenance: operation => operation(new AbortController().signal),
      }
      const scope = createScope(injected, agent)
      scopes.push(scope)
      agentCtx = scope.ctx
      agents.set(id, agent)
    }
  }, { inject: ['agents', 'sessions', 'sessionProjections', 'systemPrompt'] }))
  const main = agents.get(MAIN_SESSION_ID)
  const ordinary = agents.get('ordinary-clock-fixture')
  if (main === undefined || ordinary === undefined) throw new Error('Clock fixture did not create its isolated scopes')
  return { ctx, main, ordinary }
}

function openTurn(session: Session, turn: number, source: UserMessage['source'] = { kind: 'user' }): void {
  session.append('turn/start', { turn })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'public clock fixture input' }], source,
  }), { surfaceOp: 'append' })
}

function readings(session: Session, kind: 'time-context' | 'elysia-calendar-context' = 'time-context'): UserMessage[] {
  return session.snapshotEvents().flatMap(event => event.type === 'user/message' && event.data.source.kind === kind
    ? [event.data] : [])
}

function readingText(message: UserMessage | undefined): string {
  return message?.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n') ?? ''
}

async function step(ctx: Context, agent: Agent, turn: number, number: number): Promise<UserMessage[]> {
  const proposal = createUserMessage({ content: [{ type: 'text', text: 'public step proposal' }], source: { kind: 'user' } })
  const noise = createUserMessage({ content: [{ type: 'text', text: 'fixture generic runtime context' }], source: { kind: 'runtime-context' } as never })
  const proposed = [proposal, noise]
  const decision = await agentEvents(ctx, agent).waterfall(
    'agent/pre-step', { messages: proposed, turn, step: number, signal: new AbortController().signal },
    () => Promise.resolve({ kind: 'enter' as const, messages: proposed }),
  )
  if (decision.kind !== 'enter') throw new Error('Clock fixture step was rejected')
  for (const message of decision.messages) {
    if (message !== proposal && message !== noise) agent.session.append('user/message', message, { surfaceOp: 'append' })
  }
  return decision.messages
}

it('requires an Agent scope and rejects an invalid explicit IANA zone without leaving a projection', async () => {
  const { ctx, main } = await fixture()
  expect(() => CurrentTime.Config({} as never)).toThrow()
  await expect(ctx.plugin(CurrentTime, { timeZone: 'Asia/Shanghai' })).rejects.toThrow('Agent-scoped')
  expect(ctx.sessionProjections.stateOf(main.session, 'timeContext')).toBeUndefined()
  await expect(main.ctx.plugin(CurrentTime, { timeZone: 'Not/A_Zone' })).rejects.toThrow('invalid IANA timeZone')
  expect(ctx.sessionProjections.stateOf(main.session, 'timeContext')).toBeUndefined()
})

it('samples Beijing time at each real pre-step across midnight without changing the complete prompt or another scope', async () => {
  vi.setSystemTime(new Date('2026-11-11T15:59:59.000Z'))
  const { ctx, main, ordinary } = await fixture()
  const complete = 'Exact isolated complete prompt {{kept literal}}'
  main.ctx.systemPrompt.section({ name: 'fixture:standing', order: 0, complete: true, interpolate: false, text: complete })
  ctx.systemPrompt.context({ name: 'fixture:generic-runtime', order: 1, text: 'not a clock' })
  const disposeIsolation = isolateMainAgentContext(main.ctx, main)
  onTestFinished(disposeIsolation)
  const mounted = await main.ctx.plugin(CurrentTime, { timeZone: 'Asia/Shanghai' })
  const before = await ctx.systemPrompt.assemble({ scope: main })
  openTurn(main.session, 1)
  const first = await step(ctx, main, 1, 1)
  expect(first.map(message => message.source.kind)).not.toContain('runtime-context')
  expect(readingText(readings(main.session).at(-1))).toContain('2026-11-11T23:59:59+08:00[Asia/Shanghai]')
  expect(readings(main.session).at(-1)?.source).toMatchObject({ kind: 'time-context', form: 'snapshot' })
  const firstCalendar = readings(main.session, 'elysia-calendar-context').at(-1)
  expect(firstCalendar?.source).toMatchObject({ kind: 'elysia-calendar-context', form: 'snapshot' })
  expect(readingText(firstCalendar)).toContain('日期 2026-11-11；星期三；时间 23:59:59；时区 Asia/Shanghai；UTC 偏移 GMT+08:00')
  expect(readingText(firstCalendar)).toContain('2026-11-11T15:59:59.000Z')
  vi.setSystemTime(new Date('2026-11-11T16:00:01.000Z'))
  await step(ctx, main, 1, 2)
  expect(readings(main.session)).toHaveLength(2)
  expect(readingText(readings(main.session).at(-1))).toContain('2026-11-12T00:00:01+08:00[Asia/Shanghai]')
  expect(readingText(readings(main.session).at(-1))).toContain('step 2')
  expect(readings(main.session, 'elysia-calendar-context')).toHaveLength(2)
  const nextCalendar = readingText(readings(main.session, 'elysia-calendar-context').at(-1))
  expect(nextCalendar).toContain('日期 2026-11-12；星期四；时间 00:00:01')
  expect(nextCalendar).toContain('2026-11-11T16:00:01.000Z')
  const after = await ctx.systemPrompt.assemble({ scope: main })
  expect(after.sections).toEqual([{ name: 'fixture:standing', text: complete, interpolate: false }])
  expect(after).toEqual(before)
  openTurn(ordinary.session, 1)
  await step(ctx, ordinary, 1, 1)
  expect(readings(ordinary.session)).toEqual([])
  expect(readings(ordinary.session, 'elysia-calendar-context')).toEqual([])
  await mounted.dispose()
  vi.setSystemTime(new Date('2026-11-11T16:00:05.000Z'))
  await step(ctx, main, 1, 3)
  expect(readings(main.session)).toHaveLength(2)
  expect(readings(main.session, 'elysia-calendar-context')).toHaveLength(2)
  expect(ctx.sessionProjections.stateOf(main.session, 'timeContext')).toBeUndefined()
})

it('keeps a browser Shanghai zone and uses the explicit Shanghai fallback for a schedule turn without browser metadata', async () => {
  vi.setSystemTime(new Date('2026-11-11T20:39:00.000Z'))
  const { ctx, main } = await fixture()
  await main.ctx.plugin(CurrentTime, { timeZone: 'Asia/Shanghai' })
  // Exact metadata emitted by the validated user-rpc ingress; no browser or channel is contacted.
  openTurn(main.session, 1, { kind: 'user', rpcId: 'clock-fixture-rpc', clientTimeZone: 'Asia/Shanghai' } as never)
  await step(ctx, main, 1, 1)
  expect(readingText(readings(main.session).at(-1))).toContain('2026-11-12T04:39:00+08:00[Asia/Shanghai]')
  expect(readingText(readings(main.session).at(-1))).toContain('Browser time zone for this request: Asia/Shanghai.')
  main.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  vi.setSystemTime(new Date('2026-11-11T20:39:02.000Z'))
  openTurn(main.session, 2, { kind: 'schedule' } as never)
  await step(ctx, main, 2, 1)
  expect(readingText(readings(main.session).at(-1))).toContain('2026-11-12T04:39:02+08:00[Asia/Shanghai]')
  expect(readingText(readings(main.session).at(-1))).toContain('Browser time zone for this request: unavailable.')
  expect(readingText(readings(main.session, 'elysia-calendar-context').at(-1))).toContain('日期 2026-11-12；星期四；时间 04:39:02')
})

it.each(['main', 'standard'] as const)('shares the native projection safely when the %s clock owner unloads first', async first => {
  vi.setSystemTime(new Date('2026-11-11T20:39:00.000Z'))
  const { ctx, main, ordinary } = await fixture()
  // Both use native key timeContext/stateVersion 2; only their scope and display config differ.
  const mainClock = await main.ctx.plugin(CurrentTime, { timeZone: 'Asia/Shanghai' })
  const standardClock = await ordinary.ctx.plugin(NativeTimeContext, { timeZone: 'UTC', refreshIntervalMs: 0 })
  openTurn(main.session, 1)
  openTurn(ordinary.session, 1)
  await step(ctx, main, 1, 1)
  await step(ctx, ordinary, 1, 1)
  expect(readingText(readings(main.session).at(-1))).toContain('2026-11-12T04:39:00+08:00[Asia/Shanghai]')
  expect(readingText(readings(ordinary.session).at(-1))).toContain('2026-11-11T20:39:00+00:00[UTC]')
  await (first === 'main' ? mainClock : standardClock).dispose()
  expect(ctx.sessionProjections.stateOf(main.session, 'timeContext')).toBeDefined()
  const remaining = first === 'main' ? ordinary : main
  const removed = first === 'main' ? main : ordinary
  vi.setSystemTime(new Date('2026-11-11T20:39:03.000Z'))
  await step(ctx, remaining, 1, 2)
  await step(ctx, removed, 1, 2)
  expect(readings(remaining.session)).toHaveLength(2)
  expect(readingText(readings(remaining.session).at(-1))).toContain(first === 'main'
    ? '2026-11-11T20:39:03+00:00[UTC]' : '2026-11-12T04:39:03+08:00[Asia/Shanghai]')
  expect(readings(removed.session)).toHaveLength(1)
  await (first === 'main' ? standardClock : mainClock).dispose()
  expect(ctx.sessionProjections.stateOf(main.session, 'timeContext')).toBeUndefined()
  expect(ctx.sessionProjections.stateOf(ordinary.session, 'timeContext')).toBeUndefined()
})


it('preserves native browser-zone priority while identifying the configured calendar zone explicitly', async () => {
  vi.setSystemTime(new Date('2026-11-11T20:39:00.000Z'))
  const { ctx, main } = await fixture()
  await main.ctx.plugin(CurrentTime, { timeZone: 'Asia/Shanghai' })
  openTurn(main.session, 1, { kind: 'user', rpcId: 'utc-browser-fixture', clientTimeZone: 'UTC' } as never)
  await step(ctx, main, 1, 1)
  expect(readingText(readings(main.session).at(-1))).toContain('2026-11-11T20:39:00+00:00[UTC]')
  expect(readingText(readings(main.session).at(-1))).toContain('Browser time zone for this request: UTC.')
  const text = readingText(readings(main.session, 'elysia-calendar-context').at(-1))
  expect(text).toContain('日期 2026-11-12；星期四；时间 04:39:00；时区 Asia/Shanghai；UTC 偏移 GMT+08:00')
  expect(text).toContain('各自独立采样')
})

it('does not leak the calendar supplement into a descendant Agent scope', async () => {
  vi.setSystemTime(new Date('2026-11-11T20:39:00.000Z'))
  const { ctx, main } = await fixture()
  await main.ctx.plugin(CurrentTime, { timeZone: 'Asia/Shanghai' })
  let childCtx = main.ctx
  const child: Agent = {
    ...main, id: SessionId('descendant-clock-fixture'),
    session: ctx.sessions.create(SessionId('descendant-clock-fixture')),
    get ctx() { return childCtx },
  }
  const childScope = createScope(main.ctx, child)
  childCtx = childScope.ctx
  onTestFinished(() => childScope.dispose())
  openTurn(child.session, 1)
  await step(ctx, child, 1, 1)
  expect(readings(child.session, 'elysia-calendar-context')).toEqual([])
  openTurn(main.session, 1)
  await step(ctx, main, 1, 1)
  expect(readings(main.session, 'elysia-calendar-context')).toHaveLength(1)
})

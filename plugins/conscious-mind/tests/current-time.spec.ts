import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { agentEvents, type Agent } from '@deepseek-ai/dsh-agent'
import { unsupportedInbox } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { createScope, type Scope } from '@deepseek-ai/dsh-scope'
import SessionStore, { SessionId, type Session } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
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

function readings(session: Session, kind: 'time-context' | 'elysia-calendar-context' = 'elysia-calendar-context'): UserMessage[] {
  return session.snapshotEvents().flatMap(event => event.type === 'user/message' && event.data.source.kind === kind
    ? [event.data] : [])
}

function visibleReadings(
  session: Session,
  kind?: 'time-context' | 'elysia-calendar-context',
): UserMessage[] {
  const kinds = kind === undefined ? ['time-context', 'elysia-calendar-context'] : [kind]
  return [...session.surface.nodes].flatMap(seq => {
    const event = session.eventAt(seq)
    return event?.type === 'user/message'
      && kinds.includes(event.data.source.kind)
      && event.data.content.length > 0
      ? [event.data] : []
  })
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

it('requires an Agent scope and validates the configured IANA zone without a native projection', async () => {
  const { ctx, main } = await fixture()
  expect(() => CurrentTime.Config({} as never)).toThrow()
  await expect(ctx.plugin(CurrentTime, { timeZone: 'Asia/Shanghai' })).rejects.toThrow('Agent-scoped')
  await expect(main.ctx.plugin(CurrentTime, { timeZone: 'Not/A_Zone' })).rejects.toThrow('invalid IANA timeZone')
  expect(ctx.sessionProjections.stateOf(main.session, 'timeContext')).toBeUndefined()
})

it('adds one minimal clock per turn and reuses it across tool steps without changing the prompt or another scope', async () => {
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
  expect(first.filter(message => ['time-context', 'elysia-calendar-context'].includes(message.source.kind))).toHaveLength(1)
  expect(visibleReadings(main.session)).toHaveLength(1)
  expect(readingText(visibleReadings(main.session).at(-1))).toBe('2026/11/11 23:59')
  expect(readings(main.session, 'time-context')).toEqual([])
  expect(visibleReadings(main.session).at(-1)?.source).toMatchObject({ kind: 'elysia-calendar-context', form: 'snapshot' })

  vi.setSystemTime(new Date('2026-11-11T16:00:01.000Z'))
  const toolStep = await step(ctx, main, 1, 2)
  expect(toolStep.filter(message => ['time-context', 'elysia-calendar-context'].includes(message.source.kind))).toHaveLength(0)
  expect(readings(main.session)).toHaveLength(1)
  expect(visibleReadings(main.session)).toHaveLength(1)
  expect(readingText(visibleReadings(main.session).at(-1))).toBe('2026/11/11 23:59')

  main.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  openTurn(main.session, 2)
  const nextTurn = await step(ctx, main, 2, 1)
  expect(nextTurn.filter(message => ['time-context', 'elysia-calendar-context'].includes(message.source.kind))).toHaveLength(1)
  expect(visibleReadings(main.session)).toHaveLength(1)
  expect(readingText(visibleReadings(main.session).at(-1))).toBe('2026/11/12 00:00')
  expect(readingText(visibleReadings(main.session).at(-1))).not.toContain('UTC')
  const after = await ctx.systemPrompt.assemble({ scope: main })
  expect(after.sections).toEqual([{ name: 'fixture:standing', text: complete, interpolate: false }])
  expect(after).toEqual(before)

  openTurn(ordinary.session, 1)
  await step(ctx, ordinary, 1, 1)
  expect(visibleReadings(ordinary.session)).toEqual([])
  await mounted.dispose()
  vi.setSystemTime(new Date('2026-11-11T16:00:05.000Z'))
  await step(ctx, main, 2, 2)
  expect(visibleReadings(main.session)).toEqual([])
  expect(ctx.sessionProjections.stateOf(main.session, 'timeContext')).toBeUndefined()
})

it('uses the same minimal configured-zone clock for browser and schedule turns', async () => {
  vi.setSystemTime(new Date('2026-11-11T20:39:00.000Z'))
  const { ctx, main } = await fixture()
  await main.ctx.plugin(CurrentTime, { timeZone: 'Asia/Shanghai' })
  openTurn(main.session, 1, { kind: 'user', rpcId: 'utc-browser-fixture', clientTimeZone: 'UTC' } as never)
  await step(ctx, main, 1, 1)
  expect(visibleReadings(main.session)).toHaveLength(1)
  expect(readingText(visibleReadings(main.session).at(-1))).toBe('2026/11/12 04:39')
  main.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  vi.setSystemTime(new Date('2026-11-11T20:39:02.000Z'))
  openTurn(main.session, 2, { kind: 'schedule' } as never)
  await step(ctx, main, 2, 1)
  expect(visibleReadings(main.session)).toHaveLength(1)
  expect(readingText(visibleReadings(main.session).at(-1))).toBe('2026/11/12 04:39')
  expect(readings(main.session, 'time-context')).toEqual([])
})

it('retires legacy native and Elysia detailed clocks from the visible surface without deleting history', async () => {
  const { ctx, main } = await fixture()
  openTurn(main.session, 1)
  const legacyCases = [
    { kind: 'time-context', text: 'Time sampled while preparing turn 1, step 1: 2026-11-11T20:39:00+00:00[UTC]' },
    { kind: 'elysia-calendar-context', text: '2026年11月12日 星期四 04:39:00 GMT+8；UTC 2026-11-11T20:39:00.000Z' },
  ] as const
  const legacySeqs = new Map<string, number>()
  for (const legacyCase of legacyCases) {
    const legacy = createUserMessage({
      content: [{ type: 'text', text: legacyCase.text }],
      source: { kind: legacyCase.kind, form: 'snapshot', sections: [{ name: legacyCase.kind, text: legacyCase.text }] } as never,
    })
    main.session.append('user/message', legacy, { surfaceOp: 'append' })
    legacySeqs.set(legacyCase.kind, main.session.seq - 1)
  }
  await main.ctx.plugin(CurrentTime, { timeZone: 'Asia/Shanghai' })
  expect(visibleReadings(main.session)).toEqual([])
  for (const legacyCase of legacyCases) {
    const legacySeq = legacySeqs.get(legacyCase.kind)
    expect(readings(main.session, legacyCase.kind)).toHaveLength(2)
    const replacement = main.session.snapshotEvents().find(event => event.sourceEventSeqs?.includes(legacySeq as number))
    expect(replacement).toMatchObject({
      type: 'user/message', sourceEventSeqs: [legacySeq],
      surfaceOp: { op: 'replace', startSeq: legacySeq, endSeq: legacySeq },
      data: { content: [], source: { kind: legacyCase.kind } },
    })
    expect(JSON.stringify(main.session.snapshotEvents())).toContain(legacyCase.text)
  }
})

it('does not leak the minimal clock into a descendant Agent scope', async () => {
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
  expect(visibleReadings(child.session)).toEqual([])
  openTurn(main.session, 1)
  await step(ctx, main, 1, 1)
  expect(visibleReadings(main.session)).toHaveLength(1)
  expect(readingText(visibleReadings(main.session).at(-1))).toBe('2026/11/12 04:39')
})

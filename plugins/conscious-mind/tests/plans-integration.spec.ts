import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { ApiSessionAgentController } from '@deepseek-ai/dsh-api-session-controller/src/agent.ts'
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import { LlmAdapter, ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import * as ToolFs from '@deepseek-ai/dsh-tool-fs'
import { defineTool } from '@deepseek-ai/dsh-tools'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import WebRuntime from '@deepseek-ai/dsh-web'
import * as PlanHost from '@elysia/proactive-system/plan-host'
import { PLAN_TOOL_GUIDANCE } from '../../proactive-system/src/plan-guidance.ts'
import { expect, it, onTestFinished, vi } from 'vitest'
import { MAIN_SESSION_ID, composeMainAgent, createMainSessionTurn } from '../src/main-session.ts'

const PLAN_TOOLS = ['schedule_create', 'schedule_delete', 'schedule_list', 'schedule_update']

async function waitFor(test: () => boolean | Promise<boolean>, timeout = 5000): Promise<void> {
  const deadline = Date.now() + timeout
  while (!await test()) {
    if (Date.now() >= deadline) throw new Error('Isolated plan fixture deadline exceeded')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

class LocalAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  firstRequestGate: Promise<void> | undefined

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    if (this.requests.length === 1) await this.firstRequestGate
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'isolated fixture complete' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'isolated fixture complete' } }
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

async function temporaryHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'elysia-plans-integration-'))
  await mkdir(join(home, 'standing-prompts'))
  await mkdir(join(home, 'workspace'))
  await writeFile(join(home, 'standing-prompts', 'SOUL.md'), 'Isolated engineering fixture; no real subject material.')
  onTestFinished(async () => { await rm(home, { recursive: true, force: true }) })
  return home
}

async function fixture(home: string) {
  const ctx = new Context()
  const handles: AgentHandle[] = []
  let host: Fiber | undefined
  let stopped = false
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
  // Native file/search registration needs this seam; these tests never execute subprocess tools.
  ctx.provide('subprocess', {} as never)
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(TokenMeter)
  await ctx.plugin(WebRuntime)
  await ctx.plugin(LocalAttachmentStore, { dshHome: home })
  await ctx.plugin(ToolFs, { read: false, readImage: true, write: false, edit: false })
  for (const name of ['send_text', 'send_voice']) {
    ctx.tools.register(defineTool({
      name, description: 'Isolated unavailable platform fixture', parameters: {},
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      execute: async () => { throw new Error('No platform calls are authorized in this fixture') },
    }))
  }
  await ctx.plugin(JsonlPersistence, { root: join(home, 'sessions'), compression: 'none' })
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root: join(home, 'storage') })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  await ctx.plugin(TypertRegistry)
  const controller = new ApiSessionAgentController(ctx)
  const resolve = vi.fn((id: Parameters<typeof controller.resolveAgent>[0]) => controller.resolveAgent(id))
  // Use the real native Agent resolver without mounting unrelated HTTP/UI controllers.
  ctx.provide('sessionController', { resolveAgent: resolve } as never)
  ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'mock', model: 'fixture' }) } as never)
  await mountAgentLoopTestHarness(ctx)
  const adapter = new LocalAdapter()
  ctx.llm.registerAdapter(['mock'], adapter)
  const create = ctx.agents.create.bind(ctx.agents)
  const createSpy = vi.spyOn(ctx.agents, 'create').mockImplementation(async options => {
    const handle = await create(options)
    handles.push(handle)
    return handle
  })
  const resume = ctx.agents.resume.bind(ctx.agents)
  const resumeOwned = async (options: Parameters<Context['agents']['resume']>[0]): Promise<AgentHandle> => {
    const handle = await resume(options)
    handles.push(handle)
    return handle
  }
  const resumeSpy = vi.spyOn(ctx.agents, 'resume').mockImplementation(resumeOwned)
  const config = {
    baseDir: join(home, 'standing-prompts'), files: ['SOUL.md'], required: ['SOUL.md'], complete: true,
    workspaceDir: join(home, 'workspace'), backupDir: join(home, 'backups'), scheduledPlans: true,
  }
  const stop = async (): Promise<void> => {
    if (stopped) return
    stopped = true
    await host?.dispose()
    for (const handle of handles.toReversed()) await handle.dispose()
    await ctx.fiber.dispose()
  }
  onTestFinished(stop)
  return {
    ctx, adapter, config, resolve, createSpy, resumeSpy, resume: resumeOwned, stop,
    mountHost: async (ready: Promise<Agent>) => { host = await ctx.plugin(PlanHost, { ready }); return host },
  }
}

function isScheduleInput(message: { readonly source: { readonly kind: string } }): boolean {
  return message.source.kind === 'schedule'
}

function scheduleInputs(agent: Agent) {
  return agent.session.snapshotEvents().filter(event => {
    if (event.type === 'user/message') return isScheduleInput(event.data)
    if (event.type === 'agent/inbox/spliced') return event.data.inserted.some(isScheduleInput)
    return false
  })
}

async function createPlan(ctx: Context, agent: Agent, prompt: string): Promise<void> {
  const result = await ctx.tools.execute({
    callId: ToolCallId('isolated-plan-create'), name: 'schedule_create',
    arguments: { title: 'Isolated delayed plan', prompt, after_seconds: 1 }, agent,
    signal: new AbortController().signal,
  })
  if (result.isError) throw new Error(JSON.stringify(result))
  expect(result.isError).toBe(false)
  expect(await ctx.schedule.list({ sessionId: MAIN_SESSION_ID })).toHaveLength(1)
}

it('composes all four real native plan tools only in the main Agent scope', async () => {
  const home = await temporaryHome()
  const test = await fixture(home)
  const main = await test.ctx.agents.create({
    sessionId: MAIN_SESSION_ID, agentOptions: { provider: 'mock', model: 'fixture' }, meta: { cwd: home },
    setup: (agentCtx, agent) => composeMainAgent(agentCtx, test.config, agent),
  })
  await test.mountHost(Promise.resolve(main.agent))
  await waitFor(() => PLAN_TOOLS.every(name => test.ctx.tools.get(name, main.agent) !== undefined))
  const ordinary = await test.ctx.agents.create({
    sessionId: SessionId('ordinary-plans-fixture'), agentOptions: { provider: 'mock', model: 'fixture' }, meta: { cwd: home },
  })
  expect(test.ctx.tools.schemas(main.agent).map(tool => tool.name)).toEqual(expect.arrayContaining(PLAN_TOOLS))
  for (const name of PLAN_TOOLS) {
    expect(test.ctx.tools.get(name)).toBeUndefined()
    expect(test.ctx.tools.get(name, ordinary.agent)).toBeUndefined()
  }
  expect(test.adapter.requests).toHaveLength(0)
  await main.dispose()
  await waitFor(() => test.ctx.get('schedule') === undefined)
  expect(test.ctx.tools.schemas(ordinary.agent).map(tool => tool.name)).not.toEqual(expect.arrayContaining(PLAN_TOOLS))
})

it('delivers a real after_seconds plan durably into the busy original main Session without waiting for idle', async () => {
  const home = await temporaryHome()
  const test = await fixture(home)
  const turn = createMainSessionTurn(test.ctx, test.config)
  await test.mountHost(turn.ready)
  const agent = await turn.ready
  expect(test.ctx.agents.get(MAIN_SESSION_ID)).toBe(agent)
  await waitFor(() => test.ctx.tools.get('schedule_create', agent) !== undefined)
  expect(test.ctx.tools.schemas(agent).map(tool => tool.name)).toEqual(expect.arrayContaining([
    ...PLAN_TOOLS, 'pass', 'read', 'write', 'edit', 'glob', 'grep', 'web_search', 'web_fetch',
    'read_image', 'send_text', 'send_voice',
  ]))
  await createPlan(test.ctx, agent, 'A public fixture reminder delivered while busy')
  const gate = Promise.withResolvers<void>()
  test.adapter.firstRequestGate = gate.promise
  onTestFinished(() => { gate.resolve() })
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'public fixture: keep the first request busy' }], source: { kind: 'user' } }))
  await waitFor(() => test.adapter.requests.length === 1)
  const clock = test.adapter.requests[0]?.messages.find(message => message.role === 'user' && message.source?.kind === 'time-context')
  if (clock?.role !== 'user') throw new Error('The scoped clock must reach the real model adapter')
  expect(clock.source).toMatchObject({ kind: 'time-context', form: 'snapshot' })
  const clockText = clock.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
  expect(clockText).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+08:00\[Asia\/Shanghai\]/)
  expect(clockText).toContain('Browser time zone for this request: unavailable.')
  const calendar = test.adapter.requests[0]?.messages.find(message => message.role === 'user' && message.source?.kind === 'elysia-calendar-context')
  if (calendar?.role !== 'user') throw new Error('The scoped calendar facts must reach the real model adapter')
  expect(calendar.source).toMatchObject({ kind: 'elysia-calendar-context', form: 'snapshot' })
  const calendarText = calendar.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
  expect(calendarText).toContain('时区 Asia/Shanghai；UTC 偏移 GMT+08:00')
  expect(calendarText).toMatch(/星期[一二三四五六日]/)
  expect(calendarText).toContain('独立采样时刻（UTC ISO）')
  for (const name of PLAN_TOOLS) {
    const guidance = PLAN_TOOL_GUIDANCE.get(name)
    const sent = test.adapter.requests[0]?.tools?.find(tool => tool.name === name)
    const native = test.ctx.tools.schemas(agent).find(tool => tool.name === name)
    if (guidance === undefined || sent === undefined || native === undefined) throw new Error('Four plan descriptions must reach the real model adapter')
    expect(sent.description).toBe(`${native.description}\n\n${guidance}`)
    expect(sent.parameters).toEqual(native.parameters)
  }
  const idle = vi.spyOn(agent, 'whenIdle')
  const flush = vi.spyOn(test.ctx.sessions, 'flush')
  try {
    await waitFor(async () => (await test.ctx.schedule.catalog()).some(task => task.lastDelivery !== undefined))
    expect(idle).not.toHaveBeenCalled()
    expect(test.adapter.requests).toHaveLength(1)
    expect(test.ctx.agents.get(MAIN_SESSION_ID)).toBe(agent)
    expect(test.resolve).toHaveBeenCalledWith(MAIN_SESSION_ID)
    expect(flush).toHaveBeenCalledWith(agent.session)
    expect(scheduleInputs(agent).length).toBeGreaterThan(0)
    const reader = await test.ctx.sessionPersistence.open(MAIN_SESSION_ID, 'read')
    try {
      const persisted = await reader.read()
      expect(JSON.stringify(persisted.events)).toContain('A public fixture reminder delivered while busy')
      expect(JSON.stringify(persisted.events)).toContain('"kind":"schedule"')
    } finally { await reader.close() }
  } finally { gate.resolve() }
  await agent.whenIdle()
  expect(test.adapter.requests.length).toBeGreaterThanOrEqual(2)
  expect(JSON.stringify(test.adapter.requests.at(-1)?.messages)).toContain('A public fixture reminder delivered while busy')
})

it('restores an overdue durable plan only after createMainSessionTurn publishes its correctly composed owner', async () => {
  const home = await temporaryHome()
  const first = await fixture(home)
  const firstTurn = createMainSessionTurn(first.ctx, first.config)
  await first.mountHost(firstTurn.ready)
  const firstAgent = await firstTurn.ready
  await waitFor(() => first.ctx.tools.get('schedule_create', firstAgent) !== undefined)
  await createPlan(first.ctx, firstAgent, 'Public fixture reminder retained across restart')
  expect(await first.ctx.sessions.flush(firstAgent.session)).toBe(true)
  await first.stop()
  await new Promise(resolve => setTimeout(resolve, 1100))
  const before = await readFile(join(home, 'storage', 'schedule.json'), 'utf8')
  const second = await fixture(home)
  const gate = Promise.withResolvers<void>()
  second.resumeSpy.mockImplementation(async options => {
    await gate.promise
    const handle = await second.resume(options)
    return handle
  })
  const turn = createMainSessionTurn(second.ctx, second.config)
  await second.mountHost(turn.ready)
  onTestFinished(() => { gate.resolve() })
  await new Promise(resolve => setTimeout(resolve, 30))
  expect(second.ctx.get('schedule')).toBeUndefined()
  expect(second.ctx.agents.get(MAIN_SESSION_ID)).toBeUndefined()
  expect(second.resolve).not.toHaveBeenCalled()
  expect(second.adapter.requests).toHaveLength(0)
  expect(await readFile(join(home, 'storage', 'schedule.json'), 'utf8')).toBe(before)
  gate.resolve()
  const agent = await turn.ready
  expect(second.ctx.agents.get(MAIN_SESSION_ID)).toBe(agent)
  await waitFor(async () => {
    const schedule = second.ctx.get('schedule')
    return schedule !== undefined && (await schedule.catalog()).some(task => task.lastDelivery !== undefined)
  })
  await agent.whenIdle()
  expect(second.resumeSpy).toHaveBeenCalledTimes(1)
  expect(second.createSpy).not.toHaveBeenCalled()
  expect(second.resumeSpy).toHaveBeenCalledWith(expect.objectContaining({ resumeSessionId: MAIN_SESSION_ID, setup: expect.any(Function) }))
  expect(second.ctx.tools.schemas(agent).map(tool => tool.name)).toEqual(expect.arrayContaining(PLAN_TOOLS))
  expect(second.resolve).toHaveBeenCalledWith(MAIN_SESSION_ID)
  expect(scheduleInputs(agent).length).toBeGreaterThan(0)
  expect(JSON.stringify(second.adapter.requests)).toContain('Public fixture reminder retained across restart')
})

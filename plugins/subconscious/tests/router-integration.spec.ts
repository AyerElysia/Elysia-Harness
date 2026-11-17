import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'
import { LlmAdapter, ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import ScheduleService, { ScheduleId } from '@deepseek-ai/dsh-schedule'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import { executeModelToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import WebRuntime from '@deepseek-ai/dsh-web'
import { expect, it, onTestFinished, vi } from 'vitest'
import * as StandingPrompt from '@elysia/conscious-mind/standing-prompts'
import * as Subconscious from '../src/index.ts'
import { MAIN_SESSION_ID, ROUTER_SESSION_ID } from '../src/model.ts'

function call(id: string, name: string, args: object): StreamChunk[] {
  const block = { type: 'tool-call' as const, id: ToolCallId(id), name, arguments: JSON.stringify(args) }
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id: block.id, name, argumentsDelta: block.arguments },
    { type: 'block-end', index: 0, block },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

function batchId(options: GenerateOptions): string {
  const text = JSON.stringify(options.messages)
  const id = Array.from(text.matchAll(/batch_id: (batch_[a-f0-9-]+)/g)).at(-1)?.[1]
  if (id === undefined) throw new Error(`No Router batch in request: ${text.slice(0, 300)}`)
  return id
}

class RouterAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }
  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: '已接收并阅读本批观察' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: '已接收并阅读本批观察' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

async function harness(overrides: Partial<Subconscious.Config> = {}) {
  const home = await mkdtemp(join(tmpdir(), 'elysia-router-integration-'))
  const prompts = join(home, 'prompts')
  const skills = join(home, 'skills')
  await mkdir(prompts)
  await mkdir(join(skills, 'router-fixture'), { recursive: true })
  await Promise.all([
    ['SOUL.md', 'Shared soul fixture'], ['USER.md', 'Shared user fixture'],
    ['MEMORY.md', 'Shared memory fixture'], ['SUBCONSCIOUS-ROUTER.md', 'Read the observation and route it.'],
  ].map(([name, text]) => writeFile(join(prompts, name!), text!)))
  await writeFile(join(skills, 'router-fixture', 'SKILL.md'), [
    '---', 'name: router-fixture', 'description: Router integration fixture skill.', '---',
    'Load the companion note before answering.', 'Read `note.txt` for the fixture fact.',
  ].join('\n'))
  await writeFile(join(skills, 'router-fixture', 'note.txt'), 'Skill companion resource fixture')
  const ctx = new Context()
  onTestFinished(async () => {
    await ctx.fiber.dispose()
    await rm(home, { recursive: true, force: true })
  })
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
  await ctx.plugin(LocalAttachmentStore, { dshHome: join(home, 'dsh') })
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(SkillRegistry)
  await ctx.plugin(WebRuntime, {})
  ctx.web.registerSearchProvider({
    id: 'fixture', available: () => true,
    search: async request => ({ sources: [{ url: 'https://example.test/search', title: request.query }], truncated: false }),
  })
  ctx.web.registerFetchProvider({
    id: 'fixture', available: () => true,
    fetch: async request => ({ url: request.url, statusCode: 200, body: { kind: 'text', content: 'Web fetch fixture' }, truncated: false }),
  })
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root: join(home, 'storage') })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  await ctx.plugin(TokenMeter)
  await ctx.plugin(JsonlPersistence, { root: join(home, 'sessions'), compression: 'none' })
  await ctx.plugin(BasicCompactionEngine, { auto: true })
  ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'mock', model: 'fixture' }) } as never)
  await mountAgentLoopTestHarness(ctx)
  await ctx.plugin(ScheduleService, {})
  ctx.on('schedule/resolve-agent', async sessionId => {
    const agent = ctx.agents.get(sessionId)
    if (agent === undefined) throw new Error(`Missing fixture Agent: ${sessionId}`)
    return agent
  })
  const adapter = new RouterAdapter()
  ctx.llm.registerAdapter(['mock'], adapter)
  const main = await ctx.agents.create({
    sessionId: MAIN_SESSION_ID, agentOptions: { provider: 'mock', model: 'fixture' }, meta: { cwd: home },
    setup: async agentCtx => {
      await agentCtx.plugin(StandingPrompt, { baseDir: prompts, files: ['SOUL.md'] })
    },
  })
  main.agent.session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: '安装前历史不应回放' }], source: { kind: 'user', rpcId: 'baseline' },
  }), { surfaceOp: 'append' })
  const config = {
    baseDir: prompts, stateDir: join(home, 'state'), workspaceDir: join(home, 'router'), collectMs: 5,
    skillsDir: skills, backupDir: join(home, 'backups'), provider: 'mock', model: 'router-fixture', ...overrides,
  }
  return { home, ctx, adapter, main, config }
}

async function readyRouter(overrides: Partial<Subconscious.Config> = {}) {
  const test = await harness(overrides)
  const fiber = await test.ctx.plugin(Subconscious, test.config)
  await vi.waitFor(() => expect(test.ctx.subconsciousRouter).toBeDefined())
  await test.ctx.subconsciousRouter.whenIdle()
  test.main.agent.session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: '启动通用工具集成测试' }], source: { kind: 'user', rpcId: 'capability-start' },
  }), { surfaceOp: 'append' })
  await vi.waitFor(() => expect(test.adapter.requests, JSON.stringify(test.ctx.subconsciousRouter.health())).toHaveLength(1))
  await test.ctx.subconsciousRouter.whenIdle()
  const router = test.ctx.agents.get(ROUTER_SESSION_ID)
  expect(router).toBeDefined()
  return { ...test, fiber, router: router! }
}

async function execute(_ctx: Context, agent: Agent, name: string, args: object) {
  const signal = new AbortController().signal
  const toolSet = await agent.ctx.tools.resolve({
    agent, modelSelection: { provider: 'mock', model: 'router-fixture' }, signal,
  })
  try {
    return await executeModelToolFixture(agent.ctx, {
      callId: ToolCallId(`fixture-${name}`), signal, name, arguments: args, agent, toolSet,
    })
  } finally {
    toolSet.dispose()
  }
}

function futureRule(offsetMs = 3_600_000): string {
  const stamp = new Date(Date.now() + offsetMs).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
  return `DTSTART:${stamp}\nRRULE:FREQ=DAILY`
}

it('feeds real main Session input through a real Router AgentLoop with scoped tools and delivery evidence', async () => {
  const { ctx, adapter, main, config } = await harness()
  let routerFiber = await ctx.plugin(Subconscious, config)
  await vi.waitFor(() => expect(ctx.subconsciousRouter).toBeDefined())
  await ctx.subconsciousRouter.whenIdle()
  expect(ctx.subconsciousRouter.health().observations).toBe(0)
  main.agent.session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: '真实的统一 Session 输入 fixture' }],
    source: { kind: 'user', rpcId: 'router-integration' },
  }), { surfaceOp: 'append' })
  await vi.waitFor(() => expect(adapter.requests).toHaveLength(1))
  await ctx.subconsciousRouter.whenIdle()
  expect(ctx.agents.get(ROUTER_SESSION_ID)).toBeDefined()
  expect(ctx.subconsciousRouter.health()).toMatchObject({ observations: 1, pendingObservations: 0, completedBatches: 1 })
  const firstBatchId = batchId(adapter.requests[0]!)
  expect(ctx.subconsciousRouter.store.getBatch(firstBatchId)).toMatchObject({
    state: 'decided', acceptedAt: expect.any(Number), presentedTurn: expect.any(Number),
    presentedStep: expect.any(Number), completedTurn: expect.any(Number), completedAt: expect.any(Number),
  })
  const request = adapter.requests[0]!
  expect(JSON.stringify(request.messages)).toContain('真实的统一 Session 输入 fixture')
  expect(JSON.stringify(request.messages)).toContain('Shared soul fixture')
  expect(JSON.stringify(request.messages)).toContain('Shared user fixture')
  expect(JSON.stringify(request.messages)).toContain('Shared memory fixture')
  expect(JSON.stringify(request.messages)).toContain('Read the observation and route it.')
  expect(JSON.stringify(request.messages)).not.toContain('CONSCIOUS-MIND.md')
  expect(request.tools?.map(tool => tool.name).sort()).toEqual([
    'bash', 'edit', 'glob', 'grep', 'job_kill', 'job_list', 'job_output', 'read', 'read_image',
    'schedule_create', 'schedule_edit', 'schedule_list', 'schedule_view', 'skill',
    'web_fetch', 'web_search', 'write',
  ])
  let routerEvents = ctx.agents.get(ROUTER_SESSION_ID)!.session.snapshotEvents()
  expect(routerEvents.some(event => event.type === 'request/header'
    && event.data.header.config.provider === 'mock' && event.data.header.config.model === 'router-fixture')).toBe(true)

  main.agent.session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: '后续收到的新图片' }, {
      type: 'image', attachment: {
        attachmentId: 'router-image' as never, mediaType: 'image/png', bytes: 8, width: 1, height: 1,
      },
    }], source: { kind: 'user', rpcId: 'router-image-input' },
  }), { surfaceOp: 'append' })
  await vi.waitFor(() => expect(adapter.requests).toHaveLength(2))
  await ctx.subconsciousRouter.whenIdle()
  expect(JSON.stringify(adapter.requests[1]!.messages)).toContain('后续收到的新图片')
  expect(JSON.stringify(adapter.requests[1]!.messages)).toContain('router-image')
  expect(ctx.subconsciousRouter.health()).toMatchObject({ observations: 2, pendingObservations: 0, completedBatches: 2 })

  // Simulate a stop after DSH persisted its turn, before SQLite completion was marked.
  await routerFiber.dispose()
  const db = new DatabaseSync(join(config.stateDir, 'router.sqlite'))
  try {
    db.exec(`
      UPDATE batches SET state = 'presenting', completed_at = NULL, completed_turn = NULL
      WHERE id = (SELECT id FROM batches ORDER BY created_at DESC LIMIT 1);
      UPDATE surface_observations SET review_state = 'in_batch'
      WHERE ingest_seq = (SELECT MAX(ingest_seq) FROM surface_observations);
    `)
  } finally { db.close() }
  main.agent.session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: '卸载期间的离线补漏输入' }], source: { kind: 'user', rpcId: 'router-offline' },
  }), { surfaceOp: 'append' })
  await new Promise(resolve => setTimeout(resolve, 20))
  expect(adapter.requests).toHaveLength(2)
  routerFiber = await ctx.plugin(Subconscious, config)
  await vi.waitFor(() => expect(ctx.subconsciousRouter).toBeDefined())
  await vi.waitFor(() => expect(adapter.requests.length, JSON.stringify({
    health: ctx.subconsciousRouter.health(), observations: ctx.subconsciousRouter.store.listObservations().map(item => item.eventSeq),
  })).toBe(3), { timeout: 5000 })
  await ctx.subconsciousRouter.whenIdle()
  expect(JSON.stringify(adapter.requests[2]!.messages)).toContain('卸载期间的离线补漏输入')
  expect(ctx.subconsciousRouter.health()).toMatchObject({ observations: 3, pendingObservations: 0, completedBatches: 3 })
  expect(adapter.requests).toHaveLength(3)
  routerEvents = ctx.agents.get(ROUTER_SESSION_ID)!.session.snapshotEvents()
  await routerFiber.dispose()
  await main.dispose()
}, 20000)

it('executes file, Skill, and Web tools through the real scoped tool pipeline', async () => {
  const { ctx, router, config } = await readyRouter()
  const note = join(config.workspaceDir, 'note.txt')
  expect((await execute(ctx, router, 'write', { file_path: note, content: 'first version' })).isError).toBe(false)
  expect(await readFile(note, 'utf8')).toBe('first version')
  const read = await execute(ctx, router, 'read', { file_path: note })
  expect(read.isError).toBe(false)
  expect(JSON.stringify(read)).toContain('first version')
  expect((await execute(ctx, router, 'edit', {
    file_path: note, old_string: 'first version', new_string: 'second version',
  })).isError).toBe(false)
  expect(await readFile(note, 'utf8')).toBe('second version')
  expect(JSON.stringify(await execute(ctx, router, 'glob', { path: config.workspaceDir, pattern: '**/*.txt' }))).toContain('note.txt')
  expect(JSON.stringify(await execute(ctx, router, 'grep', { path: config.workspaceDir, pattern: 'second version' }))).toContain('note.txt')

  const promptWrite = await execute(ctx, router, 'write', { file_path: join(config.baseDir, 'SOUL.md'), content: 'overwritten' })
  expect(promptWrite.isError).toBe(true)
  expect(JSON.stringify(promptWrite)).toContain('ELYSIA_ROUTER_PROMPT_READ_ONLY')
  expect(await readFile(join(config.baseDir, 'SOUL.md'), 'utf8')).toBe('Shared soul fixture')
  const outsideRead = await execute(ctx, router, 'read', { file_path: join(config.workspaceDir, '..', 'outside.txt') })
  expect(outsideRead.isError).toBe(true)
  expect(JSON.stringify(outsideRead)).toContain('ELYSIA_PATH_DENIED')

  const skill = await execute(ctx, router, 'skill', { name: 'router-fixture' })
  expect(skill.isError).toBe(false)
  expect(JSON.stringify(skill)).toContain('Load the companion note before answering.')
  const unknownSkill = await execute(ctx, router, 'skill', { name: 'missing-fixture' })
  expect(JSON.stringify(unknownSkill)).not.toContain('<skill_content')
  const skillResource = join(config.skillsDir, 'router-fixture', 'note.txt')
  const companion = await execute(ctx, router, 'read', { file_path: skillResource })
  expect(companion.isError).toBe(false)
  expect(JSON.stringify(companion)).toContain('Skill companion resource fixture')
  const companionWrite = await execute(ctx, router, 'write', { file_path: skillResource, content: 'overwritten' })
  expect(companionWrite.isError).toBe(true)
  expect(await readFile(skillResource, 'utf8')).toBe('Skill companion resource fixture')

  const search = await execute(ctx, router, 'web_search', { queries: ['Router fixture query'] })
  expect(search.isError).toBe(false)
  expect(JSON.stringify(search)).toContain('https://example.test/search')
  const fetched = await execute(ctx, router, 'web_fetch', { url: 'https://example.test/article' })
  expect(fetched.isError).toBe(false)
  expect(JSON.stringify(fetched)).toContain('Web fetch fixture')
  expect(ctx.tools.get('send_text', router)).toBeUndefined()
  expect(ctx.tools.get('send_voice', router)).toBeUndefined()
}, 30000)

it('runs sandboxed Shell and owns the complete background Job lifecycle', async () => {
  const { ctx, router, config } = await readyRouter()
  const shell = await execute(ctx, router, 'bash', { command: 'printf "cwd=%s" "$PWD"', description: 'Verify Router shell cwd' })
  expect(shell.isError).toBe(false)
  expect(shell.value).toMatchObject({ cwd: config.workspaceDir, exitCode: 0, timedOut: false })

  const outside = join('/var/tmp', `elysia-router-sandbox-${process.pid}.txt`)
  onTestFinished(() => rm(outside, { force: true }))
  const denied = await execute(ctx, router, 'bash', {
    command: `printf denied > ${JSON.stringify(outside)}`, description: 'Verify sandbox rejects an outside write',
  })
  expect(JSON.stringify(denied)).toMatch(/sandbox|denied|exitCode\\?":1/i)
  await expect(readFile(outside, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  const escalation = await execute(ctx, router, 'bash', {
    command: 'true', description: 'Reject escalation', sandbox_permissions: 'danger-full-access', justification: 'fixture',
  })
  expect(escalation.isError).toBe(true)
  expect(JSON.stringify(escalation)).toContain('ELYSIA_SHELL_ESCALATION_DENIED')

  const started = await execute(ctx, router, 'bash', {
    command: "printf 'job-fixture'", description: 'Run background output fixture', run_in_background: true,
  })
  expect(started.isError).toBe(false)
  const jobId = (started.value as { jobId: string }).jobId
  expect(jobId).toMatch(/^bash-/)
  expect(JSON.stringify(await execute(ctx, router, 'job_list', {}))).toContain(jobId)
  const output = await execute(ctx, router, 'job_output', { job_id: jobId, wait: true, timeout_ms: 5000 })
  expect(output.isError).toBe(false)
  expect(JSON.stringify(output)).toContain('job-fixture')

  const sleeping = await execute(ctx, router, 'bash', {
    command: 'sleep 30', description: 'Run background cancellation fixture', run_in_background: true,
  })
  const sleepingId = (sleeping.value as { jobId: string }).jobId
  expect((await execute(ctx, router, 'job_kill', { job_id: sleepingId, reason: 'integration cleanup' })).isError).toBe(false)
  await vi.waitFor(() => expect(ctx.jobs.list(ROUTER_SESSION_ID).find(job => job.id === sleepingId)?.status).toBe('killed'))
}, 30000)

it('enforces foreground timeout and reaps over-age Router background Jobs', async () => {
  const timeout = await readyRouter({ shellTimeoutMs: 150, shellMaxTimeoutMs: 500 })
  const timedOut = await execute(timeout.ctx, timeout.router, 'bash', {
    command: 'sleep 2', description: 'Verify foreground timeout is not promoted', timeoutMs: 150,
  })
  expect(timedOut.value).toMatchObject({ timedOut: true })
  expect(timeout.ctx.jobs.list(ROUTER_SESSION_ID).filter(job => job.status === 'running' || job.status === 'stopping')).toEqual([])
  await timeout.fiber.dispose()

  const watchdog = await readyRouter({ maxJobAgeMs: 150, jobSweepMs: 20 })
  const started = await execute(watchdog.ctx, watchdog.router, 'bash', {
    command: 'sleep 30', description: 'Verify over-age background Job cleanup', run_in_background: true,
  })
  const id = (started.value as { jobId: string }).jobId
  await vi.waitFor(() => expect(watchdog.ctx.jobs.list(ROUTER_SESSION_ID).find(job => job.id === id)?.status).toBe('killed'))
}, 30000)

it('isolates Schedule ownership and delivers a real scheduled prompt to the Router AgentLoop', async () => {
  const { ctx, adapter, router } = await readyRouter()
  const created = await execute(ctx, router, 'schedule_create', {
    title: 'Router fixture reminder', prompt: '真实 Schedule 投递 fixture', rrule: futureRule(), target: 'this_session',
  })
  expect(created.isError).toBe(false)
  const id = (created.value as { id: string }).id
  expect((created.value as { target: unknown }).target).toEqual({ kind: 'session', sessionId: ROUTER_SESSION_ID })

  const foreign = await ctx.schedule.create({
    title: 'Foreign fixture', prompt: 'Must stay invisible', timing: { kind: 'rrule', rrule: futureRule(7_200_000) },
    target: { kind: 'session', sessionId: MAIN_SESSION_ID },
  }, SessionId(MAIN_SESSION_ID))
  const list = await execute(ctx, router, 'schedule_list', {})
  expect(list.value).toMatchObject({ total: 1, shown: 1, items: [{ id }] })
  expect(JSON.stringify(list)).not.toContain(foreign.id)
  expect(JSON.stringify(await execute(ctx, router, 'schedule_list', { limit: 1, offset: 1 })))
    .toContain('"total":1')

  for (const result of [
    await execute(ctx, router, 'schedule_view', { id: foreign.id }),
    await execute(ctx, router, 'schedule_edit', { id: foreign.id, action: 'update', title: 'stolen' }),
    await execute(ctx, router, 'schedule_edit', { id: foreign.id, action: 'delete' }),
    await execute(ctx, router, 'schedule_create', {
      title: 'Invalid target', prompt: 'No other Session', rrule: futureRule(), target: 'new_once',
    }),
    await execute(ctx, router, 'schedule_edit', { id, action: 'update', target: 'new' }),
  ]) {
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result)).toContain('ELYSIA_SCHEDULE_DENIED')
  }
  expect(await ctx.schedule.view({ id: ScheduleId(foreign.id) })).toMatchObject({ title: 'Foreign fixture' })

  expect((await execute(ctx, router, 'schedule_edit', { id, action: 'update', active: false })).value)
    .toMatchObject({ status: 'paused' })
  expect((await execute(ctx, router, 'schedule_edit', { id, action: 'update', active: true })).value)
    .toMatchObject({ status: 'active' })
  expect((await execute(ctx, router, 'schedule_view', { id })).value).toMatchObject({ id, title: 'Router fixture reminder' })

  const requestsBefore = adapter.requests.length
  await ctx.schedule.run({ id: ScheduleId(id) })
  await router.whenIdle()
  expect(adapter.requests).toHaveLength(requestsBefore + 1)
  expect(JSON.stringify(adapter.requests.at(-1)?.messages)).toContain('真实 Schedule 投递 fixture')
  expect((await ctx.schedule.view({ id: ScheduleId(id) })).lastDelivery).toMatchObject({ targetSessionId: ROUTER_SESSION_ID })
  expect((await execute(ctx, router, 'schedule_edit', { id, action: 'delete' })).value).toEqual({ id, deleted: true })
}, 30000)

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { agentEvents, type Agent } from '@deepseek-ai/dsh-agent'
import { provideWorkingDirectoryFixture, unsupportedInbox, unsupportedModel } from '@deepseek-ai/dsh-agent-loop-testkit'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { createScope, type Scope } from '@deepseek-ai/dsh-scope'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import { SESSION_FORMAT_VERSION, Session, SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import { afterEach, describe, expect, it } from 'vitest'
import * as SkillCapabilities from '../src/skill-capabilities.ts'

const tempDirs: string[] = []
const scopes: Scope[] = []

afterEach(async () => {
  for (const scope of scopes.splice(0).reverse()) await scope.dispose()
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function tempDir(name: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `elysia-skill-${name}-`))
  tempDirs.push(dir)
  return dir
}

async function writeSkill(root: string, name: string, description: string, body: string): Promise<void> {
  const dir = join(root, name)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`)
}

function agentForCwd(cwd: string, id = `skill-agent-${cwd}`): Agent {
  const sessionId = SessionId(id)
  const session = Session.create(sessionId, [], {
    version: SESSION_FORMAT_VERSION, id: sessionId, createdAt: 0, cwd, isSeeded: false,
  })
  return {
    ctx: new Context(), id: sessionId, options: {}, session,
    model: unsupportedModel(), inbox: unsupportedInbox(), status: 'idle',
    send: () => {}, followup: () => {}, steer: () => {},
    inject: () => { throw new Error('catalog must not use agent.inject()') },
    cancel() {}, runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
}

async function setup(home: string): Promise<Context> {
  const ctx = new Context()
  provideWorkingDirectoryFixture(ctx, home)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(NativeToolExecutor)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SkillRegistry)
  return ctx
}

async function agentScope(ctx: Context, agent: Agent): Promise<Scope> {
  let scope!: Scope
  await ctx.plugin(Object.assign((inner: Context) => { scope = createScope(inner, agent) }, { inject: ['tools'] }))
  scopes.push(scope)
  return scope
}

async function fireStep(ctx: Context, agent: Agent, turn: number, step: number): Promise<void> {
  const decision = await agentEvents(ctx, agent).waterfall('agent/pre-step', {
    modelSelection: { provider: 'mock', model: 'mock' }, messages: [], turn, step,
    signal: new AbortController().signal,
  }, () => Promise.resolve({ kind: 'enter' as const, messages: [] }))
  if (decision.kind === 'enter') {
    for (const message of decision.messages) agent.session.append('user/message', message, { surfaceOp: 'append' })
  }
}

function catalogs(session: Session): Extract<SessionEvent, { type: 'user/message' }>[] {
  return session.snapshotEvents().filter((event): event is Extract<SessionEvent, { type: 'user/message' }> =>
    event.type === 'user/message' && event.data.source.kind === 'skill-catalog')
}

async function loadSkill(ctx: Context, agent: Agent, name: string) {
  return await executeToolFixture(ctx, {
    signal: new AbortController().signal,
    callId: ToolCallId(`load-${name}`), name: 'skill', arguments: { name }, agent,
  })
}

describe('elysia skill capabilities', () => {
  it('rejects host mounting and relative roots', async () => {
    const home = await tempDir('validation')
    const ctx = await setup(home)
    await expect(ctx.plugin(SkillCapabilities, { rootDir: join(home, 'skills') }))
      .rejects.toThrow('must be mounted in an agent scope')
    const scope = await agentScope(ctx, agentForCwd(home, 'relative-root'))
    await expect(scope.ctx.plugin(SkillCapabilities, { rootDir: 'skills' }))
      .rejects.toThrow('must be an absolute path')
    expect(scope.ctx.tools.get('skill')).toBeUndefined()
  })

  it('isolates the native catalog and loader to one agent and one custom root', async () => {
    const home = await tempDir('scoped')
    const root = join(home, 'workspace/skills')
    await mkdir(join(home, '.git'), { recursive: true })
    await writeSkill(join(home, '.dsh/skills'), 'project-secret', 'Must not be discovered', 'Project body.')
    await writeSkill(root, 'journal-helper', 'Help with journal entries', 'First body.')
    const ctx = await setup(home)
    const target = agentForCwd(home, 'skill-target')
    const other = agentForCwd(home, 'skill-other')
    const targetScope = await agentScope(ctx, target)
    await agentScope(ctx, other)
    const fiber = await targetScope.ctx.plugin(SkillCapabilities, { rootDir: root })

    expect(ctx.tools.get('skill', target)?.name).toBe('skill')
    expect(ctx.tools.get('skill', other)).toBeUndefined()
    expect(ctx.tools.get('skill')).toBeUndefined()

    await fireStep(ctx, target, 1, 1)
    await fireStep(ctx, target, 1, 2)
    await fireStep(ctx, other, 1, 1)
    expect(catalogs(target.session)).toHaveLength(1)
    expect(catalogs(other.session)).toHaveLength(0)
    const catalogText = JSON.stringify(catalogs(target.session)[0]?.data.content)
    expect(catalogText).toContain('journal-helper')
    expect(catalogText).not.toContain('project-secret')
    expect(catalogText).toContain('<system-reminder>')
    expect(catalogText).toContain('<available_skills>')

    const loaded = await loadSkill(ctx, target, 'journal-helper')
    expect(loaded.isError).toBe(false)
    if (loaded.isError) throw new Error('expected native skill load to succeed')
    expect(loaded.value).toEqual({
      name: 'journal-helper', provider: 'filesystem',
      resourceBase: { kind: 'directory', path: join(root, 'journal-helper') },
      content: 'First body.',
    })
    const loadedBlock = loaded.content[0]
    expect(loadedBlock?.type).toBe('text')
    if (loadedBlock?.type !== 'text') throw new Error('expected native skill text')
    expect(loadedBlock.text).toContain('<skill_content name="journal-helper">')
    expect(loadedBlock.text).toContain('First body.')
    expect((await loadSkill(ctx, other, 'journal-helper')).isError).toBe(true)

    await writeSkill(root, 'journal-helper', 'Help with journal entries', 'Second body.')
    await fireStep(ctx, target, 1, 3)
    expect(catalogs(target.session)).toHaveLength(1)
    const reloaded = await loadSkill(ctx, target, 'journal-helper')
    expect(JSON.stringify(reloaded.content)).toContain('Second body.')
    expect(JSON.stringify(reloaded.content)).not.toContain('First body.')

    await fiber.dispose()
    expect(ctx.tools.get('skill', target)).toBeUndefined()
    await fireStep(ctx, target, 1, 4)
    expect(catalogs(target.session)).toHaveLength(1)
  })

  it('publishes a replacement catalog after a watched frontmatter change', async () => {
    const home = await tempDir('watch')
    const root = join(home, 'skills')
    await writeSkill(root, 'changing-skill', 'Original description', 'Stable body.')
    const ctx = await setup(home)
    const agent = agentForCwd(home, 'skill-watch')
    const scope = await agentScope(ctx, agent)
    await scope.ctx.plugin(SkillCapabilities, { rootDir: root })
    await fireStep(ctx, agent, 1, 1)
    expect(catalogs(agent.session)).toHaveLength(1)

    await writeSkill(root, 'changing-skill', 'Updated description', 'Stable body.')
    await new Promise(resolve => setTimeout(resolve, 700))
    await fireStep(ctx, agent, 1, 2)

    expect(catalogs(agent.session)).toHaveLength(2)
    expect(catalogs(agent.session)[1]?.data.source).toMatchObject({
      kind: 'skill-catalog', update: true,
      entries: [{ name: 'changing-skill', description: 'Updated description' }],
    })
    expect(JSON.stringify(catalogs(agent.session)[1]?.data.content)).toContain('Updated description')
  })
})

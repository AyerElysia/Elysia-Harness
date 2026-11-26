/**
 * Behavior of the session-scoped tool-panel Host: the snapshot, real
 * `tools.restrict()` masks, static-tool locks, tool-group presets, state
 * persistence (including legacy context fields), and teardown.
 *
 * The AgentLoop testkit mounts the real tool registry and Agent scope, so these
 * specs assert the registry's own visibility rather than a hand-built stub.
 */
import { describe, expect, it, onTestFinished } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  mountAgentLoopTestDependencies, mountAgentLoopTestHarness,
} from '@deepseek-ai/dsh-agent-loop-testkit'
import * as helix from '../src/index.ts'
import { DOCUMENT_FILE_NAME } from '../src/state.ts'
import { readFile } from 'node:fs/promises'

const text = (value: string): { type: 'text'; text: string }[] => [{ type: 'text', text: value }]

function alphaTool(): ReturnType<typeof defineTool> {
  return defineTool({
    name: 'alpha_tool',
    description: 'Alpha test operation.',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => text(String(value)) },
    async execute() { return 'alpha' },
  })
}

interface Env {
  readonly ctx: Context
  readonly stateDir: string
  readonly agent: Awaited<ReturnType<Awaited<ReturnType<typeof mountAgentLoopTestHarness>>['create']>>
  readonly fiber: { dispose(): Promise<void> }
}

async function setup(options: { stateDir?: string; sessionId?: string; enableTools?: boolean } = {}): Promise<Env> {
  const stateDir = options.stateDir ?? await mkdtemp(join(tmpdir(), 'villv-helix-'))
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx, { systemPrompt: { personaPrefix: '', personaSuffix: '' } })
  const harness = await mountAgentLoopTestHarness(ctx)
  ctx.tools.register(alphaTool())
  const fiber = await ctx.plugin(helix, { stateDir })
  const agent = await harness.create(SessionId(options.sessionId ?? 's1'), { provider: 'mock', model: 'mock' })
  await ctx.villvHelix.setMode(agent.session.id, true)
  if (options.enableTools !== false) await ctx.villvHelix.setTool(agent.session.id, 'alpha_tool', true)
  onTestFinished(async () => {
    await ctx.fiber.dispose()
    await rm(stateDir, { recursive: true, force: true })
  })
  return { ctx, stateDir, agent, fiber }
}

describe('snapshot', () => {
  it('reports one live session and its enabled global tools', async () => {
    const env = await setup()
    const snapshot = await env.ctx.villvHelix.list('s1')
    expect(snapshot.sessions.map(row => row.id)).toEqual(['s1'])
    expect(snapshot.sessions[0]?.live).toBe(true)
    const alpha = snapshot.tools.find(tool => tool.id === 'alpha_tool')
    expect(alpha?.origin).toBe('dynamic')
    expect(alpha?.locked).toBe(false)
    expect(alpha?.enabledBy?.['session:s1']).toBe(true)
    expect(alpha?.stepBy?.['session:s1']).toBe('active')
    expect('contexts' in snapshot).toBe(false)
    expect('events' in snapshot).toBe(false)
  })

  it('refuses an unknown session', async () => {
    const env = await setup()
    await expect(env.ctx.villvHelix.list('missing')).rejects.toMatchObject({ code: 'villvHelix/SESSION_NOT_FOUND' })
  })
})

describe('tool restrictions', () => {
  it('disables one global tool through the real registry mask', async () => {
    const env = await setup()
    expect(env.ctx.tools.schemas(env.agent).map(tool => tool.name)).toContain('alpha_tool')
    await env.ctx.villvHelix.setTool('s1', 'alpha_tool', false)
    expect(env.ctx.tools.schemas(env.agent).map(tool => tool.name)).not.toContain('alpha_tool')
    const snapshot = await env.ctx.villvHelix.list('s1')
    const alpha = snapshot.tools.find(tool => tool.id === 'alpha_tool')
    expect(alpha?.enabledBy?.['session:s1']).toBe(false)
    expect(alpha?.stepBy?.['session:s1']).toBe('hidden')

    await env.ctx.villvHelix.setTool('s1', 'alpha_tool', true)
    expect(env.ctx.tools.schemas(env.agent).map(tool => tool.name)).toContain('alpha_tool')
  })

  it('turns a stale global call into UNKNOWN_TOOL after the switch is off', async () => {
    const env = await setup()
    const signal = new AbortController().signal
    const admitted = await env.ctx.tools.resolve({
      agent: env.agent,
      modelSelection: { provider: 'mock', model: 'mock' },
      signal,
    })
    await env.ctx.villvHelix.setTool('s1', 'alpha_tool', false)
    const result = await env.ctx.tools.execute({
      agent: env.agent,
      signal,
      toolSet: admitted,
      calls: [{
        type: 'tool-call', id: ToolCallId('stale-alpha'), name: 'alpha_tool', arguments: '{}',
      }],
    })
    expect(result.results[0]?.result.error?.info?.code).toBe('UNKNOWN_TOOL')
  })

  it('refuses a tool the Host does not register globally', async () => {
    const env = await setup()
    await expect(env.ctx.villvHelix.setTool('s1', 'ghost_tool', false))
      .rejects.toMatchObject({ code: 'villvHelix/TOOL_UNKNOWN' })
  })

  it('keeps a preset-scoped tool read-only', async () => {
    const env = await setup()
    await env.agent.ctx.plugin({
      name: 'test-static-tool',
      inject: ['tools'],
      apply(scope: Context) {
        scope.tools.register(defineTool({
          name: 'preset_tool',
          description: 'Preset-owned operation.',
          parameters: {},
          output: { schema: { type: 'string' }, render: (_args, value) => text(String(value)) },
          async execute() { return 'preset' },
        }))
      },
    })
    const snapshot = await env.ctx.villvHelix.list('s1')
    const presetRow = snapshot.tools.find(tool => tool.id === 'preset_tool')
    expect(presetRow?.origin).toBe('static')
    expect(presetRow?.locked).toBe(true)
    await expect(env.ctx.villvHelix.setTool('s1', 'preset_tool', false))
      .rejects.toMatchObject({ code: 'villvHelix/TOOL_STATIC_LOCKED' })
  })

  it('allows a custom preset static read tool to be switched', async () => {
    const env = await setup()
    await env.agent.ctx.plugin({
      name: 'test-static-read',
      inject: ['tools'],
      apply(scope: Context) {
        scope.tools.register(defineTool({
          name: 'read',
          description: 'Preset-owned read.',
          parameters: {},
          output: { schema: { type: 'string' }, render: (_args, value) => text(String(value)) },
          async execute() { return 'static-read' },
        }))
      },
    })
    const snapshot = await env.ctx.villvHelix.list('s1')
    expect(snapshot.tools.find(tool => tool.id === 'read')).toMatchObject({
      group: 'managed', origin: 'dynamic', scope: 'agent', locked: false,
      enabledBy: { 'session:s1': false }, stepBy: { 'session:s1': 'hidden' },
    })
    await expect(env.ctx.villvHelix.setTool('s1', 'read', false)).resolves.toBeUndefined()
    const signal = new AbortController().signal
    const toolSet = await env.ctx.tools.resolve({
      agent: env.agent,
      modelSelection: { provider: 'mock', model: 'mock' },
      signal,
    })
    const disabled = await env.ctx.tools.execute({
      agent: env.agent,
      signal,
      toolSet,
      calls: [{ type: 'tool-call', id: ToolCallId('custom-static-read'), name: 'read', arguments: '{}' }],
    })
    expect(disabled.results[0]?.result.error?.info?.code).toBe('UNKNOWN_TOOL')
    await expect(env.ctx.villvHelix.setTool('s1', 'read', true)).resolves.toBeUndefined()
    const enabled = await env.ctx.tools.execute({
      agent: env.agent,
      signal,
      toolSet,
      calls: [{ type: 'tool-call', id: ToolCallId('custom-static-read-on'), name: 'read', arguments: '{}' }],
    })
    expect(enabled.results[0]?.result.isError).toBe(false)
  })

  it('lifts every installed mask when the plugin unloads', async () => {
    const env = await setup()
    await env.ctx.villvHelix.setTool('s1', 'alpha_tool', false)
    expect(env.ctx.tools.schemas(env.agent).map(tool => tool.name)).not.toContain('alpha_tool')
    await env.fiber.dispose()
    expect(env.ctx.tools.schemas(env.agent).map(tool => tool.name)).toContain('alpha_tool')
  })

  it('keeps the disabled mask across a remount', async () => {
    const first = await setup()
    const { stateDir } = first
    await first.ctx.villvHelix.setTool('s1', 'alpha_tool', false)
    await first.ctx.fiber.dispose()
    const document = await readFile(join(stateDir, DOCUMENT_FILE_NAME), 'utf8')
    expect(document).toContain('"enabledTools": []')

    const second = await setup({ stateDir, enableTools: false })
    const snapshot = await second.ctx.villvHelix.list('s1')
    expect(snapshot.tools.find(tool => tool.id === 'alpha_tool')?.enabledBy?.['session:s1']).toBe(false)
    expect(second.ctx.tools.schemas(second.agent).map(tool => tool.name)).not.toContain('alpha_tool')
  })
})

describe('state document', () => {
  it('ignores legacy context, queue, and event fields and drops them on write', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'villv-helix-legacy-'))
    const legacy = {
      version: 1,
      sessions: {
        s1: {
          orchestrated: true,
          enabledTools: ['alpha_tool'],
          disabledTools: [],
          contexts: { 'demo.ping': true },
          events: [{ id: 'event-1', kind: 'demo.ping', outcome: 'delivered', at: 1 }],
        },
      },
      queues: { s1: { events: [], consumed: [], dedupe: {} } },
      toolPresets: [],
      updatedAt: new Date(0).toISOString(),
    }
    await writeFile(join(stateDir, DOCUMENT_FILE_NAME), `${JSON.stringify(legacy, null, 2)}\n`, 'utf8')

    const env = await setup({ stateDir, enableTools: false })
    const snapshot = await env.ctx.villvHelix.list('s1')
    expect(snapshot.tools.find(tool => tool.id === 'alpha_tool')?.enabledBy?.['session:s1']).toBe(true)
    expect(env.ctx.tools.schemas(env.agent).map(tool => tool.name)).toContain('alpha_tool')

    const written = JSON.parse(await readFile(join(stateDir, DOCUMENT_FILE_NAME), 'utf8')) as {
      readonly queues?: unknown
      readonly sessions: Record<string, Record<string, unknown>>
    }
    expect(written).not.toHaveProperty('queues')
    expect(written.sessions['s1']).not.toHaveProperty('contexts')
    expect(written.sessions['s1']).not.toHaveProperty('events')
  })
})

describe('tool-group presets', () => {
  it('creates, lists, applies, and deletes a saved selection', async () => {
    const env = await setup()
    const created = await env.ctx.villvHelix.createToolPreset('全部工具', ['alpha_tool', 'ghost_tool'])
    expect(created.tools).toEqual(['alpha_tool'])
    const snapshot = await env.ctx.villvHelix.list('s1')
    expect(snapshot.toolPresets.map(preset => preset.name)).toEqual(['全部工具'])
    await env.ctx.villvHelix.deleteToolPreset(created.id)
    expect((await env.ctx.villvHelix.list('s1')).toolPresets).toEqual([])
  })

  it('refuses an empty selection', async () => {
    const env = await setup()
    await expect(env.ctx.villvHelix.createToolPreset('空', ['ghost_tool']))
      .rejects.toMatchObject({ code: 'villvHelix/TOOL_UNKNOWN' })
  })
})

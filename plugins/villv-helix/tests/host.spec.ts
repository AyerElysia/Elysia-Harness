/**
 * Behavior of the session-scoped orchestrator Host: the snapshot, real
 * `tools.restrict()` masks, static-tool locks, context subscriptions and
 * publication, tool-group presets, persistence, and teardown.
 *
 * The AgentLoop testkit mounts the real tool registry and Agent scope, so these
 * specs assert the registry's own visibility rather than a hand-built stub.
 */
import { describe, expect, it, onTestFinished } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
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
  it('reports one live session, its global tools enabled, and writable status', async () => {
    const env = await setup()
    const snapshot = await env.ctx.villvHelix.list('s1')
    expect(snapshot.sessions.map(row => row.id)).toEqual(['s1'])
    expect(snapshot.sessions[0]?.live).toBe(true)
    const alpha = snapshot.tools.find(tool => tool.id === 'alpha_tool')
    expect(alpha?.origin).toBe('dynamic')
    expect(alpha?.locked).toBe(false)
    expect(alpha?.enabledBy?.['session:s1']).toBe(true)
    expect(alpha?.stepBy?.['session:s1']).toBe('active')
    expect(snapshot.events).toEqual([])
    const status = await env.ctx.villvHelix.status('s1')
    expect(status.writable).toBe(true)
    expect(status.mode).toBe('live')
    expect(status.health.tools).toMatchObject({ registered: 1, enabled: 1, global: 1, static: 0 })
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
    await expect(env.ctx.villvHelix.setTool('s1', 'read', false)).resolves.toBeUndefined()
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

describe('context events', () => {
  it('delivers a subscribed publication and logs it for the session', async () => {
    const env = await setup()
    const disposeKind = env.ctx.villvHelix.registerContextKind({
      kind: 'demo.ping',
      nameZh: '示例事件',
      description: 'A test event.',
      activeByDefault: false,
    })
    onTestFinished(() => { disposeKind() })
    await env.ctx.villvHelix.setContext('s1', 'demo.ping', true)
    const receipt = await env.ctx.villvHelix.publish({
      kind: 'demo.ping', source: 'test', summary: 'hello', payload: { n: 1 },
    })
    expect(receipt).toMatchObject({ delivered: 1, failed: 0 })

    const snapshot = await env.ctx.villvHelix.list('s1')
    expect(snapshot.contexts.find(entry => entry.kind === 'demo.ping')).toMatchObject({
      nameZh: '示例事件', active: false, backlog: 1,
      enabledBy: { 'session:s1': true },
    })
    expect(snapshot.events.map(entry => entry.outcome)).toContain('delivered')
    const status = await env.ctx.villvHelix.status('s1')
    expect(status.health.contexts.queueDepth).toBe(1)
  })

  it('suppresses a publication the session did not subscribe', async () => {
    const env = await setup()
    const disposeKind = env.ctx.villvHelix.registerContextKind({
      kind: 'demo.silent', nameZh: '静默事件', description: 'A test event.',
    })
    onTestFinished(() => { disposeKind() })
    const receipt = await env.ctx.villvHelix.publish({
      kind: 'demo.silent', source: 'test', summary: 'ignored', payload: null,
    })
    expect(receipt.delivered).toBe(0)
    expect(receipt.suppressed).toBeGreaterThanOrEqual(1)
  })

  it('refuses an unregistered kind and an unsubscribed write', async () => {
    const env = await setup()
    await expect(env.ctx.villvHelix.publish({
      kind: 'demo.absent', source: 'test', summary: 'x', payload: null,
    })).rejects.toMatchObject({ code: 'villvHelix/CONTEXT_UNKNOWN' })
    await expect(env.ctx.villvHelix.setContext('s1', 'demo.absent', true))
      .rejects.toMatchObject({ code: 'villvHelix/CONTEXT_UNKNOWN' })
  })

  it('requires a Chinese display name from the provider', async () => {
    const env = await setup()
    expect(() => env.ctx.villvHelix.registerContextKind({
      kind: 'demo.noname', nameZh: '  ', description: 'x',
    })).toThrow(/Chinese display name/)
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
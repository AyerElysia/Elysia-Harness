/**
 * The special tool suites are mounted into an Agent's scope, never the root.
 * Every orchestrated session sees the stable declarations; only the enabled
 * subset executes, and every disabled name fails as UNKNOWN_TOOL.
 */
import { describe, expect, it, onTestFinished } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import { renderContextSnapshot } from '@deepseek-ai/dsh-system-prompt'
import { MANAGED_TOOL_IDS } from '../src/tool-mounts.ts'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  mountAgentLoopTestDependencies, mountAgentLoopTestHarness,
} from '@deepseek-ai/dsh-agent-loop-testkit'
import * as helix from '../src/index.ts'



describe('per-session tool mounts', () => {
  it('keeps all special declarations stable and gates execution', async () => {
    expect([...MANAGED_TOOL_IDS]).toEqual(expect.arrayContaining(['bash', 'pwsh', 'read', 'glob']))
    const stateDir = await mkdtemp(join(tmpdir(), 'villv-helix-mount-'))
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx, {
      workingDirectory: true,
      systemPrompt: { personaPrefix: '', personaSuffix: '' },
    })
    // Registration only needs the services to exist; their operations are
    // covered by the packages' own tests.
    ctx.provide('pluginMarket', { listIndexes: () => [] })
    ctx.provide('pluginManager', { listVersionExemptions: () => ({ exemptions: [] }) })
    ctx.provide('sandboxPolicy', { resolve: () => ({ mode: 'read-only', approval: 'never' }) })
    const harness = await mountAgentLoopTestHarness(ctx)
    const fiber = await ctx.plugin(helix, { stateDir })
    const first = await harness.create(SessionId('mount-one'), { provider: 'mock', model: 'mock' })
    const second = await harness.create(SessionId('mount-two'), { provider: 'mock', model: 'mock' })
    onTestFinished(async () => {
      await ctx.fiber.dispose()
      await rm(stateDir, { recursive: true, force: true })
    })

    await ctx.villvHelix.setMode('mount-one', true)
    await ctx.villvHelix.setMode('mount-two', true)
    // A session that has never enabled a special tool does not expose it to the
    // model, but a hard call still fails closed rather than falling through.
    const signal = new AbortController().signal
    const resolveFor = (agent: typeof first) => ctx.tools.resolve({
      agent,
      modelSelection: { provider: 'mock', model: 'mock' },
      signal,
    })
    const faceFor = async (agent: typeof first): Promise<string> =>
      renderContextSnapshot(await ctx.systemPrompt.assemble({ scope: scopeOf(agent.ctx)! }))
    const beforeEnable = await resolveFor(first)
    const beforeSecond = await resolveFor(second)
    expect(ctx.tools.schemas(first, beforeEnable).some(tool => tool.name === 'read')).toBe(false)
    expect(ctx.tools.schemas(second, beforeSecond).some(tool => tool.name === 'read')).toBe(false)
    expect(await faceFor(first)).toContain('读取文件（read）')
    const beforeResult = await ctx.tools.execute({
      agent: first,
      signal,
      toolSet: beforeEnable,
      calls: [{ type: 'tool-call', id: ToolCallId('never-read'), name: 'read', arguments: JSON.stringify({ path: 'README.md' }) }],
    })
    expect(beforeResult.results[0]?.result.error?.info?.code).toBe('UNKNOWN_TOOL')

    await ctx.villvHelix.setTool('mount-one', 'read', true)

    // The Remote write awaits the optional mount, so the schema is already
    // live when the caller can start its next model step.
    const firstEnabled = await resolveFor(first)
    const secondAfterFirst = await resolveFor(second)
    expect(ctx.tools.schemas(first, firstEnabled).some(tool => tool.name === 'read')).toBe(true)
    expect(ctx.tools.schemas(second, secondAfterFirst).some(tool => tool.name === 'read')).toBe(false)
    expect(await faceFor(first)).toContain('读取文件（read）')

    await ctx.villvHelix.setTool('mount-one', 'plugin_market', true)
    await ctx.villvHelix.setTool('mount-one', 'plugin_manager', true)
    const firstAllEnabled = await resolveFor(first)
    const secondBeforeAny = await resolveFor(second)
    expect(ctx.tools.schemas(first, firstAllEnabled).some(tool => tool.name === 'plugin_market')).toBe(true)
    expect(ctx.tools.schemas(first, firstAllEnabled).some(tool => tool.name === 'plugin_manager')).toBe(true)
    expect(ctx.tools.schemas(second, secondBeforeAny).some(tool => tool.name === 'plugin_market')).toBe(false)
    expect(ctx.tools.schemas(second, secondBeforeAny).some(tool => tool.name === 'plugin_manager')).toBe(false)

    // A mounted suite must remain stable after its own tools/change burst.
    await new Promise(resolve => setTimeout(resolve, 250))
    expect(ctx.tools.schemas(first).some(tool => tool.name === 'read')).toBe(true)

    const staleToolSet = await ctx.tools.resolve({
      agent: first,
      modelSelection: { provider: 'mock', model: 'mock' },
      signal,
    })
    expect(ctx.tools.schemas(first, staleToolSet).some(tool => tool.name === 'read')).toBe(true)

    await ctx.villvHelix.setTool('mount-one', 'read', false)
    // The suite stays mounted, while the next model-visible face excludes it.
    expect(await faceFor(first)).toContain('未启用/不可用')
    expect(await faceFor(first)).toContain('读取文件（read）')
    const toolSet = await ctx.tools.resolve({
      agent: first,
      modelSelection: { provider: 'mock', model: 'mock' },
      signal,
    })
    // The enabled-only declaration disappears from the next model surface, but
    // the live guard makes both the stale and current sets fail closed.
    expect(ctx.tools.schemas(first, toolSet).some(tool => tool.name === 'read')).toBe(false)
    for (const admitted of [staleToolSet, toolSet]) {
      const result = await ctx.tools.execute({
        agent: first,
        signal,
        toolSet: admitted,
        calls: [{ type: 'tool-call', id: ToolCallId('disabled-read'), name: 'read', arguments: JSON.stringify({ path: 'README.md' }) }],
      })
      expect(result.results[0]?.result.error?.info?.code).toBe('UNKNOWN_TOOL')
    }
    expect(ctx.tools.schemas(second, await resolveFor(second)).some(tool => tool.name === 'read')).toBe(false)
    await fiber.dispose()
  }, 20_000)
})

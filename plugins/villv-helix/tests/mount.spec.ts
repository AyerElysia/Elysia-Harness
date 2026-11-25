/**
 * The optional tool suites are mounted into one Agent's scope, never the root.
 * This spec checks the real registry: enabling `read` on one session must make
 * the real `tool-fs` definition visible there and absent from a second session.
 */
import { describe, expect, it, onTestFinished } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  mountAgentLoopTestDependencies, mountAgentLoopTestHarness,
} from '@deepseek-ai/dsh-agent-loop-testkit'
import * as helix from '../src/index.ts'



describe('per-session tool mounts', () => {
  it('mounts tool-fs only in the Agent that enabled it', async () => {
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
    expect(ctx.tools.schemas(first).some(tool => tool.name === 'read')).toBe(false)

    await ctx.villvHelix.setTool('mount-one', 'read', true)

    // The Remote write awaits the optional mount, so the schema is already
    // live when the caller can start its next model step.
    expect(ctx.tools.schemas(first).some(tool => tool.name === 'read')).toBe(true)
    expect(ctx.tools.schemas(second).some(tool => tool.name === 'read')).toBe(false)

    await ctx.villvHelix.setTool('mount-one', 'plugin_market', true)
    await ctx.villvHelix.setTool('mount-one', 'plugin_manager', true)
    expect(ctx.tools.schemas(first).some(tool => tool.name === 'plugin_market')).toBe(true)
    expect(ctx.tools.schemas(first).some(tool => tool.name === 'plugin_manager')).toBe(true)
    expect(ctx.tools.schemas(second).some(tool => tool.name === 'plugin_market')).toBe(false)
    expect(ctx.tools.schemas(second).some(tool => tool.name === 'plugin_manager')).toBe(false)

    // A mounted suite must remain stable after its own tools/change burst.
    await new Promise(resolve => setTimeout(resolve, 250))
    expect(ctx.tools.schemas(first).some(tool => tool.name === 'read')).toBe(true)

    await ctx.villvHelix.setTool('mount-one', 'read', false)
    expect(ctx.tools.schemas(first).some(tool => tool.name === 'read')).toBe(false)
    expect(ctx.tools.schemas(second).some(tool => tool.name === 'read')).toBe(false)
    await fiber.dispose()
  }, 20_000)
})
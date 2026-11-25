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
    // A session that has never enabled a special tool still sees its stable
    // declaration; calling it must fail as UNKNOWN_TOOL rather than vanish and
    // invite a web/search substitute.
    expect(ctx.tools.schemas(first).some(tool => tool.name === 'read')).toBe(true)
    expect(ctx.tools.schemas(second).some(tool => tool.name === 'read')).toBe(true)

    const signal = new AbortController().signal
    const beforeEnable = await ctx.tools.resolve({
      agent: first,
      modelSelection: { provider: 'mock', model: 'mock' },
      signal,
    })
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
    expect(ctx.tools.schemas(first).some(tool => tool.name === 'read')).toBe(true)
    expect(ctx.tools.schemas(second).some(tool => tool.name === 'read')).toBe(true)

    await ctx.villvHelix.setTool('mount-one', 'plugin_market', true)
    await ctx.villvHelix.setTool('mount-one', 'plugin_manager', true)
    expect(ctx.tools.schemas(first).some(tool => tool.name === 'plugin_market')).toBe(true)
    expect(ctx.tools.schemas(first).some(tool => tool.name === 'plugin_manager')).toBe(true)
    expect(ctx.tools.schemas(second).some(tool => tool.name === 'plugin_market')).toBe(true)
    expect(ctx.tools.schemas(second).some(tool => tool.name === 'plugin_manager')).toBe(true)

    // A mounted suite must remain stable after its own tools/change burst.
    await new Promise(resolve => setTimeout(resolve, 250))
    expect(ctx.tools.schemas(first).some(tool => tool.name === 'read')).toBe(true)

    const staleToolSet = await ctx.tools.resolve({
      agent: first,
      modelSelection: { provider: 'mock', model: 'mock' },
      signal,
    })
    expect(ctx.tools.schemas(first, staleToolSet).some(tool => tool.name === 'read')).toBe(true)

    const noticeBefore = first.session.snapshotEvents()
      .filter(event => event.type === 'developer/message').length
    await ctx.villvHelix.setTool('mount-one', 'read', false)
    // The suite stays mounted: its registration is stable, while the step gate
    // hides the tool. A late call must therefore be a real UNKNOWN_TOOL.
    expect(first.session.snapshotEvents()
      .filter(event => event.type === 'developer/message').length).toBe(noticeBefore)
    await ctx.waterfall('agent/pre-step', {
      agent: first,
      messages: [],
      turn: 2,
      step: 1,
      signal,
      modelSelection: { provider: 'mock', model: 'mock' },
    }, async () => ({ kind: 'enter', messages: [] }))
    const notices = first.session.snapshotEvents()
      .filter(event => event.type === 'developer/message')
      .slice(noticeBefore)
    expect(notices.some(event => event.data.message.content
      .some(block => block.type === 'tool-removal' && block.toolName === 'read'))).toBe(true)
    expect(notices.some(event => event.data.message.content
      .some(block => block.type === 'text' && block.text.includes('特殊工具面已更新')))).toBe(true)
    expect(ctx.tools.get('read', first)).toBeDefined()
    const toolSet = await ctx.tools.resolve({
      agent: first,
      modelSelection: { provider: 'mock', model: 'mock' },
      signal,
    })
    // The declaration stays visible; the live guard is what makes an off
    // tool fail, so the model has a name to call and receives UNKNOWN_TOOL.
    expect(ctx.tools.schemas(first, toolSet).some(tool => tool.name === 'read')).toBe(true)
    for (const admitted of [staleToolSet, toolSet]) {
      const result = await ctx.tools.execute({
        agent: first,
        signal,
        toolSet: admitted,
        calls: [{ type: 'tool-call', id: ToolCallId('disabled-read'), name: 'read', arguments: JSON.stringify({ path: 'README.md' }) }],
      })
      expect(result.results[0]?.result.error?.info?.code).toBe('UNKNOWN_TOOL')
    }
    expect(ctx.tools.schemas(second).some(tool => tool.name === 'read')).toBe(true)
    await fiber.dispose()
  }, 20_000)
})
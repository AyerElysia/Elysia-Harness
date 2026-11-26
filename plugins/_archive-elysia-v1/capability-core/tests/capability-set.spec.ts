/**
 * The generic Capability Set bridge: it mounts the agent-scoped entries switched
 * on in its scope, owns their disposal, and re-syncs on a Host change.
 *
 * The bridge contains no tool list, so these assertions read the same catalog
 * the Host publishes.
 */

import { describe, expect, it } from 'vitest'
import * as capabilitySet from '../src/capability-set.ts'
import { AGENT_PROBE_TOOL, GLOBAL_PROBE_TOOL } from '../src/index.ts'
import { createEnv, findToolResult, settle, textResponse, toolCallResponse } from './harness.ts'

describe('capability set', () => {
  it('mounts the switched-on agent tools, disposes on unmount, remounts, and re-syncs on a switch change', async () => {
    const env = await createEnv()
    await env.mountHost()
    env.host().registerTool(GLOBAL_PROBE_TOOL)
    env.host().registerTool(AGENT_PROBE_TOOL)
    const agent = await env.createAgent('cs-1', 'preset-agent')
    await env.host().setTool({ kind: 'session', id: 'cs-1' }, 'elysia_agent_probe', true)
    expect(env.host().agentToolEntries({ kind: 'session', id: 'cs-1' }).map(entry => entry.id))
      .toEqual(['elysia_agent_probe'])

    const bridge = await agent.ctx.plugin(capabilitySet)
    env.adapter.enqueue(toolCallResponse('cs-ok', 'elysia_agent_probe', {}), textResponse('done'))
    await env.send(agent, 'use it')
    expect(JSON.stringify(findToolResult(agent, 'cs-ok')?.data)).toContain('probe:agent')

    // Unmount while the switch stays on: only the bridge registered the tool.
    await bridge.dispose()
    env.adapter.enqueue(toolCallResponse('cs-gone', 'elysia_agent_probe', {}), textResponse('done'))
    await env.send(agent, 'after unmount')
    expect(findToolResult(agent, 'cs-gone')?.data).toMatchObject({ error: { code: 'UNKNOWN_TOOL' } })

    // Remount: the same switch mounts it again, so composition is repeatable.
    const remounted = await agent.ctx.plugin(capabilitySet)
    env.adapter.enqueue(toolCallResponse('cs-back', 'elysia_agent_probe', {}), textResponse('done'))
    await env.send(agent, 'after remount')
    expect(JSON.stringify(findToolResult(agent, 'cs-back')?.data)).toContain('probe:agent')

    // Switch off: the bridge re-syncs from the Host change event.
    await env.host().setTool({ kind: 'session', id: 'cs-1' }, 'elysia_agent_probe', false)
    await settle()
    env.adapter.enqueue(toolCallResponse('cs-off', 'elysia_agent_probe', {}), textResponse('done'))
    await env.send(agent, 'after switch off')
    expect(findToolResult(agent, 'cs-off')?.data).toMatchObject({ error: { code: 'UNKNOWN_TOOL' } })
    await remounted.dispose()
  })
})

/**
 * Gate, catalog, static-tool, and state behavior of the capability Host (v1.2).
 *
 * Static tools come from a preset composition and are locked; dynamic tools are
 * catalog entries the panel switches. The step gate is driven through a real
 * AgentLoop and a scripted model: the request's tool list is the observable, and
 * a hard call after a switch-off is the hard-block check.
 */

import { describe, expect, it } from 'vitest'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { AGENT_PROBE_TOOL, DOCUMENT_FILE_NAME, GLOBAL_PROBE_TOOL } from '../src/index.ts'
import { createEnv, textResponse, toolCallResponse } from './harness.ts'

/** The code a refused operation carries. */
async function refusalOf(operation: () => Promise<unknown>): Promise<string> {
  try {
    await operation()
  } catch (error: unknown) {
    if (typeof error === 'object' && error !== null && 'code' in error) return String(error['code'])
    throw error
  }
  throw new Error('expected the operation to be refused')
}

/** One tool result event by call id. */
function toolResult(agent: Agent, callId: string) {
  return agent.session.snapshotEvents().find(event => event.type === 'tool/result' && event.data.message.toolCallId === callId)
}

describe('dynamic tool gate', () => {
  it('exposes the provider Chinese name for a directly registered tool', async () => {
    const env = await createEnv()
    await env.mountHost()
    env.host().registerTool(GLOBAL_PROBE_TOOL)
    env.host().registerToolName('elysia_probe', '探针工具')
    const snapshot = await env.host().list()
    expect(snapshot.tools.find(tool => tool.id === 'elysia_probe')?.nameZh).toBe('探针工具')
  })

  it('reports a global catalog tool as off by default and turns it on with the global switch', async () => {
    const env = await createEnv()
    await env.mountHost()
    env.host().registerTool(GLOBAL_PROBE_TOOL)
    await env.createAgent('default-on-1', 'elysia-conscious')

    const before = await env.host().list()
    const presetBefore = before.scopes.find(scope => scope.ref.kind === 'preset' && scope.ref.id === 'elysia-conscious')
    expect(presetBefore?.tools['elysia_probe']).toBe(false)
    expect(before.tools.filter(tool => tool.id === 'elysia_probe')).toHaveLength(1)

    await env.host().setTool({ kind: 'global' }, 'elysia_probe', true)
    const after = await env.host().list()
    const presetAfter = after.scopes.find(scope => scope.ref.kind === 'preset' && scope.ref.id === 'elysia-conscious')
    expect(presetAfter?.tools['elysia_probe']).toBe(true)
  })

  it('adds a switched-on tool at the next step and blocks a hard call after it is switched off', async () => {
    const env = await createEnv()
    await env.mountHost()
    env.host().registerTool(GLOBAL_PROBE_TOOL)
    const agent = await env.createAgent('gate-1', 'elysia-conscious')

    await env.host().setTool({ kind: 'session', id: 'gate-1' }, 'elysia_probe', true)
    env.adapter.enqueue(textResponse('first'))
    await env.send(agent, 'first')
    expect(env.adapter.requests[0]?.tools?.map(tool => tool.name)).toEqual(['elysia_probe'])

    await env.host().setTool({ kind: 'session', id: 'gate-1' }, 'elysia_probe', false)
    env.adapter.enqueue(toolCallResponse('removed', 'elysia_probe', {}), textResponse('done'))
    await env.send(agent, 'second')
    // The switch is read while the next step is prepared, so the schema is gone.
    expect(env.adapter.requests[1]?.tools ?? []).toEqual([])
    expect(toolResult(agent, 'removed')?.data).toMatchObject({ error: { code: 'UNKNOWN_TOOL' } })
  })

  it('inherits a preset switch and lets a session override it with an explicit false', async () => {
    const env = await createEnv()
    await env.mountHost()
    env.host().registerTool(GLOBAL_PROBE_TOOL)
    await env.createAgent('inherit-1', 'elysia-conscious')

    await env.host().setTool({ kind: 'preset', id: 'elysia-conscious' }, 'elysia_probe', true)
    const snapshot = await env.host().list()
    const presetScope = snapshot.scopes.find(scope => scope.ref.kind === 'preset' && scope.ref.id === 'elysia-conscious')
    const sessionScope = snapshot.scopes.find(scope => scope.ref.kind === 'session' && scope.ref.id === 'inherit-1')
    expect(presetScope?.tools['elysia_probe']).toBe(true)
    expect(sessionScope?.tools['elysia_probe']).toBe(true)

    await env.host().setTool({ kind: 'session', id: 'inherit-1' }, 'elysia_probe', false)
    const overridden = await env.host().list()
    expect(overridden.scopes.find(scope => scope.ref.kind === 'session')?.tools['elysia_probe']).toBe(false)
    // The preset switch itself is unchanged: only the session overrode it.
    expect(overridden.scopes.find(scope => scope.ref.kind === 'preset')?.tools['elysia_probe']).toBe(true)
  })
})

describe('global tool scope', () => {
  it('switches a global catalog tool for every session and lets a session explicit-off win', async () => {
    const env = await createEnv()
    await env.mountHost()
    env.host().registerTool(GLOBAL_PROBE_TOOL)
    const agent = await env.createAgent('global-1', 'elysia-conscious')

    expect(env.host().isEnabled(agent, 'elysia_probe')).toBe(false)
    await env.host().setTool({ kind: 'global' }, 'elysia_probe', true)
    expect(env.host().isEnabled(agent, 'elysia_probe')).toBe(true)
    expect(await env.host().globalTools()).toEqual({
      elysia_probe: { enabled: true, stored: true },
    })

    await env.host().setTool({ kind: 'preset', id: 'elysia-conscious' }, 'elysia_probe', false)
    expect(env.host().isEnabled(agent, 'elysia_probe')).toBe(false)
    const presetScope = (await env.host().list()).scopes.find(scope =>
      scope.ref.kind === 'preset' && scope.ref.id === 'elysia-conscious')
    expect(presetScope?.tools['elysia_probe']).toBe(false)

    await env.host().setTool({ kind: 'session', id: 'global-1' }, 'elysia_probe', true)
    expect(env.host().isEnabled(agent, 'elysia_probe')).toBe(true)

    await env.host().setTool({ kind: 'session', id: 'global-1' }, 'elysia_probe', false)
    expect(env.host().isEnabled(agent, 'elysia_probe')).toBe(false)
  })

  it('persists the global switch across a Host restart', async () => {
    const first = await createEnv()
    const mounted = await first.mountHost()
    first.host().registerTool(GLOBAL_PROBE_TOOL)
    await first.host().setTool({ kind: 'global' }, 'elysia_probe', true)
    await mounted.dispose()

    const second = await createEnv({ stateDir: first.stateDir })
    await second.mountHost()
    second.host().registerTool(GLOBAL_PROBE_TOOL)
    expect(await second.host().globalTools()).toEqual({
      elysia_probe: { enabled: true, stored: true },
    })
    const agent = await second.createAgent('global-2', 'elysia-conscious')
    expect(second.host().isEnabled(agent, 'elysia_probe')).toBe(true)
  })

  it('refuses a global switch for an agent-scope entry', async () => {
    const env = await createEnv()
    await env.mountHost()
    env.host().registerTool(AGENT_PROBE_TOOL)
    expect(await refusalOf(() => env.host().setTool({ kind: 'global' }, 'elysia_agent_probe', true)))
      .toBe('capabilityHost/TOOL_UNKNOWN')
  })

  it('removes a globally enabled tool from the next step and refuses a late call', async () => {
    const env = await createEnv()
    await env.mountHost()
    env.host().registerTool(GLOBAL_PROBE_TOOL)
    const agent = await env.createAgent('global-3', 'elysia-conscious')
    await env.host().setTool({ kind: 'global' }, 'elysia_probe', true)

    env.adapter.enqueue(textResponse('first'))
    await env.send(agent, 'first')
    expect(env.adapter.requests[0]?.tools?.map(tool => tool.name)).toEqual(['elysia_probe'])

    await env.host().setTool({ kind: 'global' }, 'elysia_probe', false)
    env.adapter.enqueue(toolCallResponse('removed-global', 'elysia_probe', {}), textResponse('done'))
    await env.send(agent, 'second')
    expect(env.adapter.requests[1]?.tools ?? []).toEqual([])
    expect(toolResult(agent, 'removed-global')?.data).toMatchObject({ error: { code: 'UNKNOWN_TOOL' } })
  })
})

describe('static tools', () => {
  it('shows the preset tool face as locked and refuses every write to it', async () => {
    const env = await createEnv()
    env.presets.declare('elysia-conscious', ['@deepseek-ai/dsh-tool-web'])
    await env.mountHost()
    const snapshot = await env.host().list()

    const staticRows = snapshot.tools.filter(tool => tool.origin === 'static')
    expect(staticRows.map(tool => [tool.id, tool.locked, tool.sourcePresetId, tool.registered])).toEqual([
      ['web_search', true, 'elysia-conscious', true],
      ['web_fetch', true, 'elysia-conscious', true],
    ])
    // The static face is not a dynamic catalog entry.
    expect(snapshot.tools.some(tool => tool.origin === 'dynamic' && tool.id === 'web_search')).toBe(false)
    // v1.2 has no Base scope: every scope is a preset or a session.
    expect(snapshot.scopes.map(scope => scope.ref.kind)).toEqual(['preset'])
    expect(snapshot.scopes.find(scope => scope.ref.kind === 'preset')?.tools['web_search']).toBe(true)

    await env.createAgent('static-1', 'elysia-conscious')
    expect(await refusalOf(() => env.host().setTool({ kind: 'preset', id: 'elysia-conscious' }, 'web_search', false)))
      .toBe('capabilityHost/TOOL_STATIC_LOCKED')
    await expect(env.host().setTool({ kind: 'session', id: 'static-1' }, 'web_fetch', false))
      .rejects.toThrow('预设默认工具，不能关闭')
    // A refused write leaves no switch behind.
    const after = await env.host().list()
    expect(after.scopes.find(scope => scope.ref.kind === 'preset')?.overrides.tools).toEqual({})
  })

  it('refuses a stale Base scope, unknown tools, unknown kinds, and unknown scopes', async () => {
    const env = await createEnv()
    env.presets.declare('elysia-conscious', ['@deepseek-ai/dsh-tool-web'])
    await env.mountHost()
    env.host().registerTool(GLOBAL_PROBE_TOOL)
    await env.createAgent('refuse-1', 'elysia-conscious')

    expect(await refusalOf(() => env.host().setTool({ kind: 'base' } as never, 'web_search', false)))
      .toBe('capabilityHost/SCOPE_READ_ONLY')
    expect(await refusalOf(() => env.host().setTool({ kind: 'session', id: 'refuse-1' }, 'no_such_tool', true)))
      .toBe('capabilityHost/TOOL_UNKNOWN')
    expect(await refusalOf(() => env.host().setContext({ kind: 'preset', id: 'elysia-conscious' }, 'no.such.kind', true)))
      .toBe('capabilityHost/CONTEXT_UNKNOWN')
    expect(await refusalOf(() => env.host().setTool({ kind: 'session', id: 'absent-session' }, 'elysia_probe', true)))
      .toBe('capabilityHost/SCOPE_NOT_FOUND')
    expect(await refusalOf(() => env.host().setTool({ kind: 'nonsense' } as never, 'elysia_probe', true)))
      .toBe('capabilityHost/SCOPE_INVALID')
  })

  it('shadows a same-name dynamic tool only for the preset that composes it', async () => {
    const env = await createEnv()
    env.presets.declare('preset-a', ['@deepseek-ai/dsh-tool-web'])
    env.presets.declare('preset-b')
    await env.mountHost()
    env.host().registerTool({
      id: 'web_search',
      scope: 'global',
      description: 'A dynamic tool that shares an id with preset A\'s static tool.',
      factory: () => defineTool({
        name: 'web_search',
        description: 'A dynamic tool that shares an id with preset A\'s static tool.',
        parameters: {},
        output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
        execute: async () => 'dynamic:web_search',
      }),
    })
    await env.createAgent('shadow-a', 'preset-a')
    const b = await env.createAgent('shadow-b', 'preset-b')

    const snapshot = await env.host().list()
    // The global dynamic registration is kept, not uninstalled by another preset.
    expect(snapshot.tools.find(tool => tool.origin === 'dynamic' && tool.id === 'web_search'))
      .toMatchObject({ registered: true, locked: false })
    // Static rows belong to preset A only; preset B composes no web tool.
    expect(snapshot.tools.filter(tool => tool.origin === 'static' && tool.id === 'web_search')
      .map(tool => tool.sourcePresetId)).toEqual(['preset-a'])

    // Preset B has no static web_search, so the dynamic tool opens and is visible.
    await env.host().setTool({ kind: 'session', id: 'shadow-b' }, 'web_search', true)
    env.adapter.enqueue(textResponse('ok'))
    await env.send(b, 'search')
    expect(env.adapter.requests[0]?.tools?.map(tool => tool.name)).toContain('web_search')
    const after = await env.host().list()
    expect(after.scopes.find(scope => scope.ref.kind === 'session' && scope.ref.id === 'shadow-b')
      ?.tools['web_search']).toBe(true)

    // Preset A composes the static tool, so the switch is refused in that scope.
    expect(await refusalOf(() => env.host().setTool({ kind: 'session', id: 'shadow-a' }, 'web_search', true)))
      .toBe('capabilityHost/TOOL_STATIC_LOCKED')
    // The static row is still locked for preset A.
    expect((await env.host().list()).tools.find(tool => tool.origin === 'static' && tool.id === 'web_search')
      ?.locked).toBe(true)
  })

  it("relies on DSH's scoped shadowing when a nearer definition carries the same name", async () => {
    const env = await createEnv()
    await env.mountHost()
    env.host().registerTool({
      id: 'web_search',
      scope: 'global',
      description: 'global dynamic',
      factory: () => defineTool({
        name: 'web_search',
        description: 'global dynamic',
        parameters: {},
        output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
        execute: async () => 'dynamic',
      }),
    })
    const agent = await env.createAgent('shadow-scope')
    await env.host().setTool({ kind: 'session', id: 'shadow-scope' }, 'web_search', true)
    // Stand-in for a preset row mounting the static definition in a nearer scope.
    agent.ctx.tools.register(defineTool({
      name: 'web_search',
      description: 'static shadow',
      parameters: {},
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      execute: async () => 'static',
    }))

    const schemas = env.ctx.tools.schemas(agent)
    expect(schemas.filter(schema => schema.name === 'web_search')).toHaveLength(1)
    expect(env.ctx.tools.get('web_search', agent)?.description).toBe('static shadow')
  })

  it('shows an unmapped static module as a locked row with a diagnostic', async () => {
    const env = await createEnv()
    env.presets.declare('elysia-conscious', ['@deepseek-ai/dsh-tool-unknown-preview'])
    await env.mountHost()
    const snapshot = await env.host().list()

    expect(snapshot.tools.find(tool => tool.id === '@deepseek-ai/dsh-tool-unknown-preview'))
      .toMatchObject({ origin: 'static', locked: true, registered: true, sourcePresetId: 'elysia-conscious' })
    expect(snapshot.diagnostics.some(diagnostic => diagnostic.code === 'STATIC_TOOL_UNMAPPED')).toBe(true)
  })

  it('treats only tool modules as static tools, skipping prompt, clock, and compaction rows', async () => {
    const env = await createEnv()
    env.presets.declare('elysia-conscious', [
      '@elysia/preset-manager/prompt-files',
      '@deepseek-ai/dsh-time-context',
      '@deepseek-ai/dsh-compaction-basic',
      '@deepseek-ai/dsh-command-compact',
      '@deepseek-ai/dsh-compaction-tool-result-pruner',
      '@deepseek-ai/dsh-tool-web',
    ])
    await env.mountHost()
    const snapshot = await env.host().list()

    expect(snapshot.tools.filter(tool => tool.origin === 'static').map(tool => tool.id))
      .toEqual(['web_search', 'web_fetch'])
    // Non-tool contributions are not tools and are not reported as unmapped tools.
    expect(snapshot.tools.some(tool => /prompt-files|time-context|compaction|command-compact/.test(tool.id))).toBe(false)
    expect(snapshot.diagnostics.some(diagnostic => diagnostic.code === 'STATIC_TOOL_UNMAPPED')).toBe(false)
  })
})

describe('dynamic catalog', () => {
  it('marks a global entry unavailable when a required service is missing and refuses an unknown scope', async () => {
    const env = await createEnv()
    await env.mountHost()
    env.host().registerTool({
      id: 'needs_service',
      scope: 'global',
      description: 'Needs a service this deployment does not mount.',
      required: ['noSuchService'],
      factory: () => { throw new Error('the factory must not run when a required service is missing') },
    })
    const snapshot = await env.host().list()
    expect(snapshot.tools.find(tool => tool.id === 'needs_service')).toMatchObject({
      origin: 'dynamic',
      registered: false,
      reason: expect.stringContaining('noSuchService'),
    })
    expect(snapshot.diagnostics.some(diagnostic => diagnostic.code === 'TOOL_REGISTRATION_FAILED')).toBe(true)
    expect(() => env.host().registerTool({
      id: 'bad_scope',
      scope: 'preset' as never,
      description: 'unknown scope',
      factory: () => { throw new Error('unreachable') },
    })).toThrow(/unknown scope/)
  })
})

describe('tool groups', () => {
  it('creates, lists, and deletes a saved dynamic-tool selection', async () => {
    const env = await createEnv()
    await env.mountHost()
    env.host().registerTool(GLOBAL_PROBE_TOOL)
    await env.host().list()

    const created = await env.host().createToolPreset('probe group', ['elysia_probe'])
    expect(created).toMatchObject({ name: 'probe group', tools: ['elysia_probe'] })
    expect((await env.host().list()).toolPresets).toContainEqual(created)

    await env.host().deleteToolPreset(created.id)
    expect((await env.host().list()).toolPresets).toEqual([])
  })
})

describe('state store', () => {
  it('persists dynamic switches and the session mapping, then restores them on a new Host instance', async () => {
    const env = await createEnv()
    env.presets.declare('elysia-conscious', ['@deepseek-ai/dsh-tool-web'])
    const first = await env.mountHost()
    env.host().registerTool(GLOBAL_PROBE_TOOL)
    env.host().registerContextKind({ kind: 'app.message', description: 'Inbound app message' })
    await env.createAgent('restart-1', 'elysia-conscious')
    await env.host().setTool({ kind: 'preset', id: 'elysia-conscious' }, 'elysia_probe', true)
    await env.host().setTool({ kind: 'session', id: 'restart-1' }, 'elysia_probe', false)
    await env.host().setContext({ kind: 'preset', id: 'elysia-conscious' }, 'app.message', false)
    await env.host().status()
    await first.dispose()

    const document = JSON.parse(await readFile(join(env.stateDir, DOCUMENT_FILE_NAME), 'utf8'))
    expect(document).toMatchObject({
      version: 1,
      presets: { 'elysia-conscious': { tools: { elysia_probe: true }, contexts: { 'app.message': false } } },
      sessions: { 'restart-1': { tools: { elysia_probe: false } } },
      sessionPresets: { 'restart-1': 'elysia-conscious' },
    })
    // Static tools are never stored.
    expect(JSON.stringify(document)).not.toContain('web_search')

    await env.mountHost()
    env.host().registerTool(GLOBAL_PROBE_TOOL)
    const snapshot = await env.host().list()
    expect(snapshot.version).toBe(2)
    expect(snapshot.scopes.find(scope => scope.ref.kind === 'preset')?.overrides.tools['elysia_probe']).toBe(true)
    const sessionScope = snapshot.scopes.find(scope => scope.ref.kind === 'session' && scope.ref.id === 'restart-1')
    expect(sessionScope?.overrides.tools['elysia_probe']).toBe(false)
    // The explicit false still wins after the reopen.
    expect(sessionScope?.tools['elysia_probe']).toBe(false)
    // Static tools are restored from the preset composition, not from the document.
    expect(snapshot.tools.filter(tool => tool.origin === 'static').map(tool => tool.id))
      .toEqual(['web_search', 'web_fetch'])
    expect((await env.host().status()).stateVersion).toBe(1)
  })

  it('reports stored ids this build no longer offers instead of failing the mount', async () => {
    const env = await createEnv()
    await writeFile(join(env.stateDir, DOCUMENT_FILE_NAME), JSON.stringify({
      version: 1,
      presets: { 'elysia-conscious': { tools: { retired_tool: true }, contexts: { 'retired.kind': true } } },
      sessions: {},
      sessionPresets: {},
      queues: {},
      updatedAt: '2026-11-22T00:00:00.000Z',
    }), 'utf8')
    await env.mountHost()
    const snapshot = await env.host().list()
    expect(snapshot.diagnostics.map(diagnostic => diagnostic.code).sort())
      .toEqual(['CONTEXT_UNKNOWN', 'TOOL_UNKNOWN'])
    expect(snapshot.diagnostics.find(diagnostic => diagnostic.code === 'TOOL_UNKNOWN')?.toolId).toBe('retired_tool')
    // The rest of the document still applies.
    expect(snapshot.scopes.find(scope => scope.ref.kind === 'preset')?.overrides.tools['retired_tool']).toBe(true)
  })

  it('refuses a document generation this build cannot read', async () => {
    const env = await createEnv()
    await writeFile(join(env.stateDir, DOCUMENT_FILE_NAME), '{"version":9}', 'utf8')
    await expect(env.mountHost()).rejects.toThrow(/unsupported version/)
  })
})
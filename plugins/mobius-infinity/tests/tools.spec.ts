/**
 * Behavior of the two model-facing tools: the schemas the model receives, the
 * registration lifetime, auto-discovery of prompt files, the refusal codes, and
 * the permission gate that stands between a create call and the document write.
 *
 * The tools are ordinary global tools: these specs assert that mounting the
 * plugin registers them, unloading it disposes them, a missing orchestrator
 * changes nothing, and the optional display names leave with either side.
 *
 * The manager's own validation and persistence are covered by `host.spec.ts`;
 * these specs drive the tool surface over the same in-memory seams.
 */
import { describe, expect, it, onTestFinished } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { entryListProblem, type AgentPreset, type PresetDefinition } from '@deepseek-ai/dsh-agent-preset-registry'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { ToolDefinition, ToolExecutionToken, ToolRunContext } from '@deepseek-ai/dsh-tools'
import * as presetManager from '../src/index.ts'
import type { PresetManager } from '../src/index.ts'
import { DOCUMENT_FILE_NAME } from '../src/document.ts'
import type { ToolFaceCatalog } from '../src/types.ts'
import { TOOL_CATALOG } from '../src/tool-catalog.ts'

/** One plugin row of a definition, flattened out of groups. */
interface FlatRow {
  readonly id?: string
  readonly name: string
}

/** Flatten a definition's plugin rows, descending into groups. */
function flatRows(plugins: PresetDefinition['plugins']): FlatRow[] {
  const rows: FlatRow[] = []
  for (const row of plugins) {
    if (row.group === true) {
      rows.push(...flatRows(row.config as PresetDefinition['plugins']))
      continue
    }
    rows.push({ ...(row.id === undefined ? {} : { id: row.id }), name: row.name })
  }
  return rows
}

/** The part of the preset registry the manager and the tools use. */
class FakePresets {
  readonly definitions = new Map<string, PresetDefinition>()
  readonly broken = new Map<string, string>()
  /** Module specifier to the service it waits for; its preset reports a pending row. */
  readonly pendingModules = new Map<string, string>()

  private pendingLine(definition: PresetDefinition): string | undefined {
    for (const row of flatRows(definition.plugins)) {
      const waiting = this.pendingModules.get(row.name)
      if (waiting !== undefined) return `${row.id ?? row.name} (${row.name}): waiting for ${waiting}`
    }
    return undefined
  }

  async list(): Promise<AgentPreset[]> {
    return [...this.definitions.entries()].map(([id, definition]) => {
      const broken = this.broken.get(id) ?? this.pendingLine(definition)
      return broken === undefined ? { id } : { id, broken }
    })
  }

  async resolve(id: string): Promise<AgentPreset> {
    const definition = this.definitions.get(id)
    const broken = this.broken.get(id) ?? (definition === undefined ? undefined : this.pendingLine(definition))
    return broken === undefined ? { id } : { id, broken }
  }

  async compositionInventory(): Promise<readonly {
    id: string
    name?: string
    isDefault: boolean
    broken?: string
    rows: readonly { entryId: string | null; moduleName: string; enabled: boolean }[]
  }[]> {
    return [...this.definitions.entries()].map(([id, definition]) => {
      const broken = this.broken.get(id) ?? this.pendingLine(definition)
      return {
        id,
        isDefault: false,
        ...(broken === undefined ? {} : { broken }),
        rows: flatRows(definition.plugins).map(row => ({
          entryId: row.id ?? null,
          moduleName: row.name,
          enabled: true,
        })),
      }
    })
  }

  async register(definition: PresetDefinition): Promise<() => Promise<void>> {
    if (this.definitions.has(definition.id)) throw new Error(`duplicate preset ${definition.id}`)
    const problem = entryListProblem(definition.plugins)
    if (problem !== undefined) throw new Error(problem)
    this.definitions.set(definition.id, definition)
    return async () => { this.definitions.delete(definition.id) }
  }

  presetForSession(): string | null {
    return null
  }
}

/** The tool-registry seam the plugin writes into. */
class FakeTools {
  readonly definitions = new Map<string, ToolDefinition>()

  register(definition: ToolDefinition): () => void {
    if (this.definitions.has(definition.name)) throw new Error(`tool ${definition.name} is already registered`)
    this.definitions.set(definition.name, definition)
    return () => { this.definitions.delete(definition.name) }
  }

  get(name: string): ToolDefinition | undefined {
    return this.definitions.get(name)
  }
}

/** Optional orchestrator display-metadata seam. */
class FakeOrchestrator {
  readonly names = new Map<string, string>()

  registerToolName(toolId: string, nameZh: string): () => void {
    if (this.names.has(toolId)) throw new Error(`tool ${toolId} already has a display name`)
    this.names.set(toolId, nameZh)
    return () => {
      if (this.names.get(toolId) === nameZh) this.names.delete(toolId)
    }
  }
}

/** The preset-roster surface the real AgentLoop test kit consumes. */
class RealPresets {
  readonly presets = new Map<string, { readonly id: string }>()
  readonly bySession = new Map<string, string>()

  constructor() {
    this.presets.set('standard', { id: 'standard' })
  }

  async list(): Promise<{ id: string }[]> {
    return [...this.presets.values()].map(preset => ({ id: preset.id }))
  }

  async resolve(id: string): Promise<{ id: string }> {
    return { id }
  }

  async register(definition: PresetDefinition): Promise<() => Promise<void>> {
    this.presets.set(definition.id, { id: definition.id })
    return async () => {
      this.presets.delete(definition.id)
    }
  }

  async compositionInventory(): Promise<readonly {
    id: string
    isDefault: boolean
    rows: readonly { entryId: string | null; moduleName: string; enabled: boolean }[]
  }[]> {
    return [...this.presets.values()].map(preset => ({ id: preset.id, isDefault: true, rows: [] }))
  }

  presetForSession(session: { readonly id: string }): string | null {
    return this.bySession.get(session.id) ?? null
  }

  composedPreset(): string {
    return 'standard'
  }
}

/** Build the registered definition of one tool. */
function toolOf(env: ToolEnv, id: string): ToolDefinition {
  const definition = env.tools.get(id)
  if (definition === undefined) throw new Error(`tool ${id} is not registered`)
  return definition
}

/** Poll until the asynchronous inject registration settles. */
async function until(condition: () => Promise<boolean>, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await condition()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('timed out waiting for tool registration')
}

interface RealToolContext {
  readonly ctx: Context
  readonly agent: Agent
  readonly presets: RealPresets
  readonly stateDir: string
  readonly promptDir: string
}

/** The real AgentLoop + preset registry + sandbox policy, without either plugin. */
async function realToolContext(sessionId: string): Promise<RealToolContext> {
  const stateDir = await mkdtemp(join(tmpdir(), 'elysia-tools-order-'))
  const promptDir = await promptRoot({ 'SOUL.md': 'soul body' })
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx, {
    systemPrompt: { personaPrefix: '', personaSuffix: '' },
  })
  const harness = await mountAgentLoopTestHarness(ctx)
  const agent = await harness.create(SessionId(sessionId), { provider: 'mock', model: 'mock' })
  const presets = new RealPresets()
  presets.bySession.set(sessionId, 'standard')
  ctx.provide('agentPresets', presets as never)
  ctx.provide('sandboxPolicy', {
    resolve: () => ({ mode: 'danger-full-access', workspaceRoot: promptDir }),
  } as never)
  onTestFinished(async () => {
    await ctx.fiber.dispose()
    await rm(stateDir, { recursive: true, force: true })
    await rm(promptDir, { recursive: true, force: true })
  })
  return { ctx, agent, presets, stateDir, promptDir }
}

interface ToolEnv {
  readonly ctx: Context
  readonly manager: PresetManager
  readonly presets: FakePresets
  readonly tools: FakeTools
  readonly orchestrator: FakeOrchestrator | undefined
  readonly stateDir: string
  readonly promptDir: string
  stop(): Promise<void>
}

interface SetupOptions {
  withTools?: boolean
  withSandboxPolicy?: boolean
  withOrchestrator?: boolean
  mode?: SandboxMode
  stateDir?: string
  promptDir?: string
}

let counter = 0

/** Create one temporary prompt root with the given bodies. */
async function promptRoot(bodies: Record<string, string>): Promise<string> {
  counter += 1
  const dir = await mkdtemp(join(tmpdir(), `elysia-tools-${String(counter)}-`))
  for (const [name, body] of Object.entries(bodies)) await writeFile(join(dir, name), body, 'utf8')
  return dir
}

/** Mount the manager and its ordinary tools over temporary directories. */
async function setup(options: SetupOptions = {}): Promise<ToolEnv> {
  const stateDir = options.stateDir ?? await mkdtemp(join(tmpdir(), `elysia-tools-state-${String(counter)}-`))
  const promptDir = options.promptDir ?? await promptRoot({
    'SOUL.md': 'soul body',
    'USER.md': 'user body',
    'BLANK.md': '   \n',
    'notes.txt': 'not markdown',
  })
  const presets = new FakePresets()
  const tools = new FakeTools()
  const orchestrator = options.withOrchestrator === true ? new FakeOrchestrator() : undefined
  const ctx = new Context()
  ctx.provide('agentPresets', presets as never)
  ctx.provide('agents', { list: () => [], get: () => undefined } as never)
  if (options.withTools !== false) ctx.provide('tools', tools as never)
  if (orchestrator !== undefined) ctx.provide('villvHelix', orchestrator as never)
  if (options.withSandboxPolicy !== false) {
    ctx.provide('sandboxPolicy', {
      resolve: () => ({ mode: options.mode ?? 'danger-full-access', workspaceRoot: promptDir }),
    } as never)
  }
  const fiber = await ctx.plugin(presetManager, { stateDir })
  onTestFinished(async () => {
    await fiber.dispose()
    await rm(stateDir, { recursive: true, force: true })
    await rm(promptDir, { recursive: true, force: true })
  })
  return {
    ctx,
    manager: ctx.presetManager,
    presets,
    tools,
    orchestrator,
    stateDir,
    promptDir,
    stop: async () => { await fiber.dispose() },
  }
}

/** A tool execution context for a direct definition call. */
function runContext(name: string, agent?: Agent): ToolRunContext {
  return {
    callId: ToolCallId('call-1'),
    name,
    arguments: {},
    signal: new AbortController().signal,
    rootCallId: ToolCallId('call-1'),
    token: Symbol() as ToolExecutionToken,
    deferContext() {},
    concludeTurn() {},
    ...(agent === undefined ? {} : { agent }),
  }
}

/** Run one registered tool by its id. */
async function callTool(env: ToolEnv, name: string, args: unknown): Promise<unknown> {
  return await toolOf(env, name).execute(args, runContext(name))
}

/** Run one tool call and return the structured failure code and message. */
async function toolFailure(run: () => Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await run()
  } catch (error: unknown) {
    if (error instanceof HarnessError) return { code: error.code, message: error.message }
    if (error instanceof Error) return { code: 'NO_CODE', message: error.message }
    throw error
  }
  throw new Error('expected the tool call to fail')
}

/** A complete create call over one prompt root. */
function createArgs(promptDir: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'preset-one',
    name: 'Preset One',
    identity: 'You are preset one.',
    promptRoot: promptDir,
    ...overrides,
  }
}

/** The tool rows of one registered definition. */
function toolRowsOf(definition: PresetDefinition | undefined): FlatRow[] {
  return flatRows(definition?.plugins ?? []).filter(row => row.name.includes('dsh-tool-'))
}

describe('package independence', () => {
  it('is @elysia/mobius-infinity with no capability-core or panel dependency', async () => {
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
      name?: string
      peerDependencies?: Record<string, string>
      devDependencies?: Record<string, string>
      peerDependenciesMeta?: Record<string, unknown>
    }
    expect(pkg.name).toBe('@elysia/mobius-infinity')
    expect(pkg.peerDependencies?.['@elysia/capability-core']).toBeUndefined()
    expect(pkg.devDependencies?.['@elysia/capability-core']).toBeUndefined()
    expect(pkg.peerDependencies?.['@elysia/capability-panel']).toBeUndefined()
    expect(pkg.devDependencies?.['@elysia/capability-panel']).toBeUndefined()
    expect(pkg.peerDependenciesMeta?.['@elysia/capability-panel']).toBeUndefined()
  })
})

describe('registration', () => {
  it('accepts only the state directory in the Config schema', () => {
    expect(presetManager.Config({ stateDir: 'C:/state' })).toEqual({ stateDir: 'C:/state' })
  })

  it('registers both tools at mount and disposes them on unmount', async () => {
    const env = await setup()
    expect([...env.tools.definitions.keys()].sort()).toEqual(['preset_create', 'preset_list'])

    const create = toolOf(env, 'preset_create')
    expect(create.description).toContain('new sessions can select it')
    const parameters = create.parameters as {
      required?: string[]
      properties: Record<string, { type?: string; enum?: string[]; items?: { enum?: string[] } }>
    }
    expect(parameters.required).toEqual(expect.arrayContaining(['id', 'name', 'identity', 'promptRoot']))
    expect(parameters.properties.promptFiles?.type).toBe('array')
    expect(parameters.properties.tools?.type).toBe('array')
    expect(parameters.properties.tools?.items?.enum).toEqual(TOOL_CATALOG.map(entry => entry.id))
    expect(parameters.properties.toolFace?.type).toBe('object')
    expect(toolOf(env, 'preset_list').description).toContain('free id')

    await env.stop()
    expect(env.tools.definitions.size).toBe(0)
  })

  it('keeps the manager usable when no tools service is mounted', async () => {
    const env = await setup({ withTools: false })
    expect(env.tools.definitions.size).toBe(0)
    expect(await env.manager.list()).toEqual([])
    expect(await env.manager.listToolFaces()).toMatchObject({ faces: expect.any(Array) })
  })

  it('works without an orchestrator and registers Chinese names only when it is present', async () => {
    const plain = await setup()
    expect(plain.orchestrator).toBeUndefined()
    const listed = await callTool(plain, 'preset_list', {}) as { tools: unknown[] }
    expect(listed.tools).toHaveLength(TOOL_CATALOG.length)

    const env = await setup({ withOrchestrator: true })
    await until(async () => (env.orchestrator?.names.size ?? 0) === 2)
    expect([...env.orchestrator?.names.entries() ?? []]).toEqual([
      ['preset_create', '创建预设'],
      ['preset_list', '列出预设'],
    ])
    await env.stop()
    expect(env.orchestrator?.names.size).toBe(0)
  })

  it('picks up an orchestrator mounted after this plugin without re-registering tools', async () => {
    const env = await setup()
    const registered = env.tools.definitions.size
    const orchestrator = new FakeOrchestrator()
    env.ctx.provide('villvHelix', orchestrator as never)
    await until(async () => orchestrator.names.size === 2)
    expect([...orchestrator.names.entries()]).toEqual([
      ['preset_create', '创建预设'],
      ['preset_list', '列出预设'],
    ])
    expect(env.tools.definitions.size).toBe(registered)
    await env.stop()
    expect(orchestrator.names.size).toBe(0)
  })

  it('registers on the real tools service and removes both tools on unmount', async () => {
    const env = await realToolContext('preset-registration')
    const fiber = await env.ctx.plugin(presetManager, { stateDir: env.stateDir })
    await until(async () => ['preset_create', 'preset_list'].every(id => env.ctx.tools.get(id) !== undefined))
    expect(env.ctx.tools.get('preset_create')?.name).toBe('preset_create')
    expect(env.ctx.tools.get('preset_list')?.name).toBe('preset_list')

    const toolSet = await env.ctx.tools.resolve({
      agent: env.agent,
      modelSelection: { provider: 'mock', model: 'mock' },
      signal: new AbortController().signal,
    })
    expect([...toolSet.view(env.agent).keys()]).toEqual(expect.arrayContaining(['preset_create', 'preset_list']))

    const batch = await env.ctx.tools.execute({
      calls: [
        {
          type: 'tool-call', id: ToolCallId('call-list'), name: 'preset_list',
          arguments: JSON.stringify({ promptRoot: env.promptDir }),
        },
        {
          type: 'tool-call', id: ToolCallId('call-create'), name: 'preset_create',
          arguments: JSON.stringify(createArgs(env.promptDir)),
        },
      ],
      signal: new AbortController().signal,
      agent: env.agent,
      toolSet,
    })

    const [listed, created] = batch.results
    expect(listed?.result.isError).toBe(false)
    expect(listed?.result.content[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining('"promptCandidates"'),
    })
    expect(created?.result.isError).toBe(false)
    expect(created?.result.content[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining('Created preset "preset-one"'),
    })
    expect(await readFile(join(env.stateDir, DOCUMENT_FILE_NAME), 'utf8')).toContain('preset-one')

    toolSet.dispose()
    await fiber.dispose()
    expect(env.ctx.tools.get('preset_create')).toBeUndefined()
    expect(env.ctx.tools.get('preset_list')).toBeUndefined()
  })
})

describe('preset_create', () => {
  it('auto-selects the non-empty Markdown files, registers, persists, and returns the created row', async () => {
    const env = await setup()
    const result = await callTool(env, 'preset_create', createArgs(env.promptDir))

    expect(result).toEqual({
      id: 'preset-one',
      name: 'Preset One',
      promptRoot: env.promptDir,
      promptFiles: ['SOUL.md', 'USER.md'],
      tools: ['tool-web'],
      agentInstructions: false,
    })
    expect(env.presets.definitions.has('preset-one')).toBe(true)
    expect(toolRowsOf(env.presets.definitions.get('preset-one')).map(row => row.name))
      .toEqual(['@deepseek-ai/dsh-tool-web'])

    const document = JSON.parse(await readFile(join(env.stateDir, DOCUMENT_FILE_NAME), 'utf8'))
    expect(document.presets[0]).toMatchObject({
      id: 'preset-one',
      promptFiles: ['SOUL.md', 'USER.md'],
      tools: ['tool-web'],
    })
  })

  it('uses explicit files, tools, and metadata when supplied', async () => {
    const env = await setup()
    const face = await env.manager.createToolFace({ name: 'Files', tools: ['tool-fs', 'tool-fs-search'] })
    const created = await callTool(env, 'preset_create', createArgs(env.promptDir, {
      description: 'A files preset',
      promptFiles: ['USER.md'],
      tools: ['tool-fs', 'tool-fs-search'],
      toolFace: { kind: 'custom', id: face.id },
      agentInstructions: true,
      order: 5,
    })) as { order?: number; toolFace?: { kind: string; id: string } }
    expect(created).toMatchObject({ order: 5, toolFace: { kind: 'custom', id: face.id } })

    const definition = env.presets.definitions.get('preset-one')
    expect(definition?.description).toBe('A files preset')
    expect(definition?.order).toBe(5)
    expect(flatRows(definition?.plugins ?? []).map(row => String(row.name)))
      .toContain('@deepseek-ai/dsh-agent-instructions')
    expect(toolRowsOf(definition).map(row => row.name)).toEqual([
      '@deepseek-ai/dsh-tool-fs',
      '@deepseek-ai/dsh-tool-fs-search',
    ])
    const document = JSON.parse(await readFile(join(env.stateDir, DOCUMENT_FILE_NAME), 'utf8'))
    expect(document.presets[0]).toMatchObject({
      promptFiles: ['USER.md'],
      tools: ['tool-fs', 'tool-fs-search'],
      toolFace: { kind: 'custom', id: face.id },
    })
  })

  it('uses the face tool set when tools is omitted and refuses a mismatched pair', async () => {
    const env = await setup()
    const created = await callTool(env, 'preset_create', createArgs(env.promptDir, {
      toolFace: { kind: 'common', id: 'search-files' },
    })) as { tools: string[] }
    expect(created.tools).toEqual(['tool-web', 'tool-fs', 'tool-fs-search'])

    const mismatch = await toolFailure(() => callTool(env, 'preset_create', createArgs(env.promptDir, {
      id: 'preset-two',
      toolFace: { kind: 'common', id: 'search-files' },
      tools: ['tool-web'],
    })))
    expect(mismatch.code).toBe('TOOL_FACE_INVALID')
    expect(mismatch.message).toContain('tool-fs')
    expect(env.presets.definitions.has('preset-two')).toBe(false)
  })

  it('creates a chat-only preset from an empty tool list', async () => {
    const env = await setup()
    await callTool(env, 'preset_create', createArgs(env.promptDir, { tools: [] }))
    expect(toolRowsOf(env.presets.definitions.get('preset-one'))).toEqual([])
  })

  it('returns the manager refusal code and stops before writing on invalid input', async () => {
    const env = await setup()
    await callTool(env, 'preset_create', createArgs(env.promptDir))

    const duplicate = await toolFailure(() => callTool(env, 'preset_create', createArgs(env.promptDir)))
    expect(duplicate.code).toBe('PRESET_ID_EXISTS')
    const invalidId = await toolFailure(() => callTool(env, 'preset_create', createArgs(env.promptDir, { id: 'Not Allowed' })))
    expect(invalidId.code).toBe('PRESET_ID_INVALID')
    const blankIdentity = await toolFailure(() => callTool(env, 'preset_create', createArgs(env.promptDir, {
      id: 'preset-two', identity: '   ',
    })))
    expect(blankIdentity.code).toBe('PRESET_IDENTITY_INVALID')
    const unknownTool = await toolFailure(() => callTool(env, 'preset_create', createArgs(env.promptDir, {
      id: 'preset-three', tools: ['tool-not-real'],
    })))
    // The parameter enum rejects an id outside the catalog before the body runs.
    expect(unknownTool.code).toBe('INVALID_ARGS')
    expect(unknownTool.message).toContain('tools[0]')
    const missingRoot = await toolFailure(() => callTool(env, 'preset_create', createArgs(env.promptDir, {
      id: 'preset-four', promptRoot: join(env.promptDir, 'absent'),
    })))
    expect(missingRoot.code).toBe('PROMPT_ROOT_MISSING')
    const missingFile = await toolFailure(() => callTool(env, 'preset_create', createArgs(env.promptDir, {
      id: 'preset-five', promptFiles: ['absent.md'],
    })))
    expect(missingFile.code).toBe('PROMPT_FILE_INVALID')
    expect(env.presets.definitions.has('preset-two')).toBe(false)
    expect(env.presets.definitions.has('preset-three')).toBe(false)
    expect(env.presets.definitions.has('preset-four')).toBe(false)
    expect(env.presets.definitions.has('preset-five')).toBe(false)
  })

  it('refuses an empty explicit file list and duplicate paths before writing', async () => {
    const env = await setup()
    const empty = await toolFailure(() => callTool(env, 'preset_create', createArgs(env.promptDir, {
      promptFiles: [],
    })))
    expect(empty.code).toBe('PROMPT_FILES_EMPTY')
    const duplicate = await toolFailure(() => callTool(env, 'preset_create', createArgs(env.promptDir, {
      id: 'preset-two', promptFiles: ['SOUL.md', 'SOUL.md'],
    })))
    expect(duplicate.code).toBe('PROMPT_FILE_INVALID')
    expect(env.presets.definitions.has('preset-one')).toBe(false)
    expect(env.presets.definitions.has('preset-two')).toBe(false)
  })

  it('refuses a tool the deployment reports unavailable before asking for permission', async () => {
    // workspace-write without an approval channel would fail in the guard; the
    // availability check must run first, so the code below proves the ordering.
    const env = await setup({ mode: 'workspace-write' })
    env.presets.pendingModules.set('@deepseek-ai/dsh-tool-office', 'officeKit')
    const catalog = await callTool(env, 'preset_list', {}) as {
      tools: { id: string; available: boolean; reason?: string }[]
    }
    expect(catalog.tools.find(tool => tool.id === 'tool-office')).toMatchObject({
      available: false,
      reason: expect.stringContaining('officeKit') as string,
    })
    const failure = await toolFailure(() => callTool(env, 'preset_create', createArgs(env.promptDir, {
      tools: ['tool-office'],
    })))
    expect(failure.code).toBe('TOOL_UNAVAILABLE')
    expect(failure.message).toContain('officeKit')
    expect(env.presets.definitions.has('preset-one')).toBe(false)
  })

  it('refuses a tool face the catalog does not offer before asking for permission', async () => {
    // Same ordering proof as the unavailable-tool case above.
    const env = await setup({ mode: 'workspace-write' })
    const failure = await toolFailure(() => callTool(env, 'preset_create', createArgs(env.promptDir, {
      toolFace: { kind: 'custom', id: 'custom-absent' },
    })))
    expect(failure.code).toBe('TOOL_FACE_NOT_FOUND')
    expect(env.presets.definitions.has('preset-one')).toBe(false)
  })

  it('fails closed when the sandbox policy service is missing', async () => {
    const env = await setup({ withSandboxPolicy: false })
    const failure = await toolFailure(() => callTool(env, 'preset_create', createArgs(env.promptDir)))
    expect(failure.code).toBe('SANDBOX_POLICY_UNAVAILABLE')
    expect(env.presets.definitions.has('preset-one')).toBe(false)
  })

  it('maps a document write failure to a structured code and rolls the registration back', async () => {
    const env = await setup()
    const documentPath = join(env.stateDir, DOCUMENT_FILE_NAME)
    await rm(documentPath, { force: true })
    await mkdir(documentPath)
    const failure = await toolFailure(() => callTool(env, 'preset_create', createArgs(env.promptDir)))
    expect(failure.code).toBe('STATE_WRITE_FAILED')
    expect(env.presets.definitions.has('preset-one')).toBe(false)
  })

  it('refuses automatic discovery when the root has no non-empty Markdown file', async () => {
    const promptDir = await promptRoot({ 'BLANK.md': ' \n', 'notes.txt': 'not markdown' })
    onTestFinished(async () => { await rm(promptDir, { recursive: true, force: true }) })
    const env = await setup({ promptDir })
    const failure = await toolFailure(() => callTool(env, 'preset_create', createArgs(env.promptDir)))
    expect(failure.code).toBe('PROMPT_FILES_EMPTY')
    expect(env.presets.definitions.has('preset-one')).toBe(false)
  })

  it('blocks the write when the call is narrower than danger-full-access and no approval channel is composed', async () => {
    const env = await setup({ mode: 'workspace-write' })
    const failure = await toolFailure(() => callTool(env, 'preset_create', createArgs(env.promptDir)))
    expect(failure.code).toBe('SANDBOX_ESCALATION_UNAVAILABLE')
    expect(env.presets.definitions.has('preset-one')).toBe(false)
    await expect(env.manager.list()).resolves.toEqual([])
  })
})

describe('permission', () => {
  it('routes a narrower create through the approval seam and writes nothing when the user rejects it', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'elysia-tools-approval-'))
    const promptDir = await promptRoot({ 'SOUL.md': 'soul body' })
    const ctx = new Context()
    onTestFinished(async () => {
      await ctx.fiber.dispose()
      await rm(stateDir, { recursive: true, force: true })
      await rm(promptDir, { recursive: true, force: true })
    })
    await mountAgentLoopTestDependencies(ctx, {
      systemPrompt: { personaPrefix: '', personaSuffix: '' },
    })
    const harness = await mountAgentLoopTestHarness(ctx)
    const agent = await harness.create(SessionId('preset-guard'), { provider: 'mock', model: 'mock' })
    ctx.provide('agentPresets', new FakePresets() as never)
    ctx.provide('sandboxPolicy', {
      resolve: () => ({ mode: 'workspace-write', workspaceRoot: promptDir }),
    } as never)
    const asks: unknown[] = []
    ctx.provide('approval', {
      request: async (request: unknown) => {
        asks.push(request)
        return 'rejected'
      },
    } as never)
    const fiber = await ctx.plugin(presetManager, { stateDir })
    await until(async () => ctx.tools.get('preset_create') !== undefined)
    const definition = ctx.tools.get('preset_create')
    if (definition === undefined) throw new Error('preset_create was not registered')

    const failure = await toolFailure(() => definition.execute(
      createArgs(promptDir),
      runContext('preset_create', agent),
    ))

    expect(asks).toHaveLength(1)
    expect(failure.code).toBe('SANDBOX_ESCALATION_REJECTED')
    expect(failure.message).toContain('rejected')
    expect(existsSync(join(stateDir, DOCUMENT_FILE_NAME))).toBe(false)

    await fiber.dispose()
  })
})

describe('preset_list', () => {
  it('returns the roster, every tool option, and the faces that form from them', async () => {
    const env = await setup()
    await callTool(env, 'preset_create', createArgs(env.promptDir))
    const value = await callTool(env, 'preset_list', {}) as {
      presets: { id: string; managed: boolean; promptRoot?: string; tools?: string[] }[]
      tools: { id: string; available: boolean }[]
      faces: ToolFaceCatalog['faces'][number][]
    }

    expect(value.presets).toContainEqual(expect.objectContaining({
      id: 'preset-one',
      managed: true,
      promptRoot: env.promptDir,
      tools: ['tool-web'],
    }))
    expect(value.tools.map(tool => tool.id)).toEqual(TOOL_CATALOG.map(entry => entry.id))
    expect(value.tools.every(tool => tool.available)).toBe(true)
    expect(value.faces.find(face => face.kind === 'default')).toMatchObject({
      id: 'default',
      tools: ['tool-web'],
    })
    expect(value).not.toHaveProperty('promptCandidates')
  })

  it('lists the non-empty Markdown files when a prompt root is supplied', async () => {
    const env = await setup()
    const value = await callTool(env, 'preset_list', { promptRoot: env.promptDir }) as {
      promptCandidates?: { path: string; bytes: number }[]
    }
    expect(value.promptCandidates?.map(candidate => candidate.path)).toEqual(['SOUL.md', 'USER.md'])
  })

  it('maps a bad prompt root to the manager refusal code', async () => {
    const env = await setup()
    const failure = await toolFailure(() => callTool(env, 'preset_list', {
      promptRoot: join(env.promptDir, 'absent'),
    }))
    expect(failure.code).toBe('PROMPT_ROOT_MISSING')
  })
})

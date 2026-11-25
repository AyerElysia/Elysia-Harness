/**
 * Behavior of the Host service: registration, list merging, persistence and
 * re-registration, the delete refusals, and tool-face composition.
 *
 * The preset registry and the Agent registry are the harness seams this plugin
 * adapts to; these specs drive their documented faces with in-memory substitutes
 * so the manager's own rules are what the assertions describe.
 */
import { describe, expect, it, onTestFinished } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { entryListProblem, type PresetDefinition } from '@deepseek-ai/dsh-agent-preset-registry'
import type { AgentPreset } from '@deepseek-ai/dsh-agent-preset-registry'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import * as presetManager from '../src/index.ts'
import { DOCUMENT_FILE_NAME } from '../src/document.ts'
import { PROMPT_FILES_PLUGIN, TOOLS_ROW_ID, buildPresetDefinition } from '../src/definition.ts'
import type { PresetDraft } from '../src/types.ts'
import type { PresetRecord as StoredRecord } from '../src/document.ts'
import { DEFAULT_TOOL_IDS, TOOL_CATALOG, findTool } from '../src/tool-catalog.ts'

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

/** The part of the registry this plugin uses, plus its own bookkeeping. */
class FakePresets {
  readonly definitions = new Map<string, PresetDefinition>()
  readonly broken = new Map<string, string>()
  readonly presetBySession = new Map<string, string>()
  /** Module specifier to the service it waits for; its preset reports a pending row. */
  readonly pendingModules = new Map<string, string>()
  registrations = 0
  /** Make `register` reject, as a refused definition does. */
  failRegister = false

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
    if (definition === undefined) throw new Error(`Unknown agent preset: ${id}`)
    const broken = this.broken.get(id) ?? this.pendingLine(definition)
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
    if (this.failRegister) throw new Error('definition refused')
    if (this.definitions.has(definition.id)) throw new Error(`Duplicate agent preset: ${definition.id}`)
    const problem = entryListProblem(definition.plugins)
    if (problem !== undefined) throw new Error(problem)
    this.registrations += 1
    this.definitions.set(definition.id, definition)
    return async () => { this.definitions.delete(definition.id) }
  }

  presetForSession(session: Session): string | null {
    return this.presetBySession.get(session.id) ?? null
  }

  /** Declare a preset the manager does not own, as a bundle or profile would. */
  declare(id: string, modules: readonly string[] = ['@deepseek-ai/dsh-persona']): void {
    this.definitions.set(id, {
      id,
      plugins: modules.map((name, index) => ({ id: `row-${String(index)}`, name })),
    })
  }
}

interface Env {
  readonly ctx: Context
  readonly presets: FakePresets
  readonly agents: { session: Session }[]
  readonly stateDir: string
  readonly promptDir: string
  /** Drop the plugin fiber, leaving the state directory in place. */
  stop(): Promise<void>
}

let counter = 0

/** Create one temporary prompt root with the given bodies. */
async function promptRoot(bodies: Record<string, string>): Promise<string> {
  counter += 1
  const dir = await mkdtemp(join(tmpdir(), `elysia-prompts-${String(counter)}-`))
  for (const [name, body] of Object.entries(bodies)) await writeFile(join(dir, name), body, 'utf8')
  return dir
}

/** Mount the manager over temporary directories. */
async function setup(options: { stateDir?: string; presets?: FakePresets; promptDir?: string } = {}): Promise<Env> {
  const stateDir = options.stateDir ?? await mkdtemp(join(tmpdir(), `elysia-state-${String(counter)}-`))
  const promptDir = options.promptDir ?? await promptRoot({ 'SOUL.md': 'soul body' })
  const presets = options.presets ?? new FakePresets()
  const agents: { session: Session }[] = []
  const ctx = new Context()
  ctx.provide('agentPresets', presets as never)
  ctx.provide('agents', { list: () => agents, get: () => undefined } as never)
  const fiber = await ctx.plugin(presetManager, { stateDir })
  onTestFinished(async () => {
    await fiber.dispose()
    await rm(stateDir, { recursive: true, force: true })
    await rm(promptDir, { recursive: true, force: true })
  })
  return { ctx, presets, agents, stateDir, promptDir, stop: async () => { await fiber.dispose() } }
}

/** A complete draft over one prompt root. */
function draftFor(promptDir: string, overrides: Partial<PresetDraft> = {}): PresetDraft {
  return {
    id: 'elysia-conscious',
    name: 'Elysia conscious',
    identity: 'You are Elysia.',
    promptRoot: promptDir,
    promptFiles: ['SOUL.md'],
    ...overrides,
  }
}

/** Run one operation and return the code it refused with. */
async function refusalOf(operation: () => Promise<unknown>): Promise<string> {
  try {
    await operation()
  } catch (error: unknown) {
    if (typeof error === 'object' && error !== null && 'code' in error) return String(error['code'])
    throw error
  }
  throw new Error('expected the operation to be refused')
}

/** Run one operation and return the message it refused with. */
async function messageOf(operation: () => Promise<unknown>): Promise<string> {
  try {
    await operation()
  } catch (error: unknown) {
    if (error instanceof Error) return error.message
    throw error
  }
  throw new Error('expected the operation to be refused')
}

/** The tool rows of one registered definition. */
function toolRowsOf(definition: PresetDefinition | undefined): FlatRow[] {
  return flatRows(definition?.plugins ?? []).filter(row => String(row.name).includes('dsh-tool-'))
}

/** A stored record with the fields the definition builder reads. */
function recordFor(tools: readonly string[]): StoredRecord {
  return {
    id: 'probe',
    name: 'Probe',
    identity: 'You are a probe.',
    agentInstructions: false,
    promptRoot: 'C:/prompts',
    promptFiles: ['SOUL.md'],
    tools: [...tools],
    createdAt: '2026-11-22T00:00:00.000Z',
  }
}

describe('create', () => {
  it('registers the prompt child, the default tool group, and the fixed compaction group, then persists', async () => {
    const env = await setup()
    const row = await env.ctx.presetManager.create(draftFor(env.promptDir, {
      description: 'the main mind',
      identity: 'You are Elysia.',
      order: 10,
    }))

    expect(row).toMatchObject({
      id: 'elysia-conscious', name: 'Elysia conscious', managed: true, inUse: [], promptFileCount: 1,
      tools: ['tool-web'],
    })
    expect(row.promptRoot).toBe(env.promptDir)

    const definition = env.presets.definitions.get('elysia-conscious')
    expect(definition).toBeDefined()
    const rows = definition?.plugins ?? []
    expect(rows[0]).toMatchObject({
      name: PROMPT_FILES_PLUGIN,
      config: { root: env.promptDir, files: ['SOUL.md'], identity: 'You are Elysia.' },
    })
    expect(rows[1]).toMatchObject({ name: '@deepseek-ai/dsh-time-context' })
    expect(rows[2]).toMatchObject({ id: TOOLS_ROW_ID, name: 'cordis:group', group: true })
    expect(rows[2]?.config).toEqual([
      {
        id: 'tool-web',
        name: '@deepseek-ai/dsh-tool-web',
        config: { fetch: true, searchTimeoutMs: 60000 },
      },
    ])
    expect(rows[3]).toMatchObject({ name: 'cordis:group', group: true })
    expect(rows[3]?.config).toHaveLength(3)
    // The default face is the only tool row; no file/shell tools leak in.
    expect(toolRowsOf(definition).map(row => row.name)).toEqual(['@deepseek-ai/dsh-tool-web'])
    expect(rows.map(row => String(row.name))).not.toContain('@deepseek-ai/dsh-agent-instructions')

    const document = JSON.parse(await readFile(join(env.stateDir, DOCUMENT_FILE_NAME), 'utf8'))
    expect(document).toMatchObject({
      version: 2,
      presets: [{ id: 'elysia-conscious', promptFiles: ['SOUL.md'], tools: ['tool-web'] }],
      toolFaces: [],
    })
  })

  it('mounts agent-instructions only when the draft requests it', async () => {
    const env = await setup()
    await env.ctx.presetManager.create(draftFor(env.promptDir, {
      agentInstructions: true,
      identity: 'You are Elysia.',
    }))
    const rows = env.presets.definitions.get('elysia-conscious')?.plugins ?? []
    expect(rows.map(row => String(row.name))).toContain('@deepseek-ai/dsh-agent-instructions')
    expect(rows[0]).toMatchObject({ id: 'agent-instructions' })
  })

  it('composes exactly the submitted tools and records the face', async () => {
    const env = await setup()
    await env.ctx.presetManager.create(draftFor(env.promptDir, {
      tools: ['tool-web', 'tool-fs', 'tool-fs-search'],
      toolFace: { kind: 'common', id: 'search-files' },
    }))
    const definition = env.presets.definitions.get('elysia-conscious')
    expect(toolRowsOf(definition).map(row => row.name)).toEqual([
      '@deepseek-ai/dsh-tool-web',
      '@deepseek-ai/dsh-tool-fs',
      '@deepseek-ai/dsh-tool-fs-search',
    ])
    expect(toolRowsOf(definition)[1]?.id).toBe('tool-fs')
    const document = JSON.parse(await readFile(join(env.stateDir, DOCUMENT_FILE_NAME), 'utf8'))
    expect(document.presets[0]).toMatchObject({
      tools: ['tool-web', 'tool-fs', 'tool-fs-search'],
      toolFace: { kind: 'common', id: 'search-files' },
    })
  })

  it('composes no tool group for the chat-only face', async () => {
    const env = await setup()
    await env.ctx.presetManager.create(draftFor(env.promptDir, { tools: [], toolFace: { kind: 'common', id: 'none' } }))
    const definition = env.presets.definitions.get('elysia-conscious')
    expect(definition?.plugins.map(row => String(row.id))).not.toContain(TOOLS_ROW_ID)
    expect(toolRowsOf(definition)).toEqual([])
  })

  it('refuses an unknown tool id and a custom face that does not exist', async () => {
    const env = await setup()
    expect(await refusalOf(() => env.ctx.presetManager.create(draftFor(env.promptDir, {
      tools: ['tool-not-real'],
    })))).toBe('presetManager/TOOL_UNKNOWN')
    expect(await refusalOf(() => env.ctx.presetManager.create(draftFor(env.promptDir, {
      toolFace: { kind: 'custom', id: 'custom-absent' },
    })))).toBe('presetManager/TOOL_FACE_NOT_FOUND')
  })

  it('refuses a duplicate id, including one a bundle declared', async () => {
    const env = await setup()
    await env.ctx.presetManager.create(draftFor(env.promptDir))
    expect(await refusalOf(() => env.ctx.presetManager.create(draftFor(env.promptDir))))
      .toBe('presetManager/PRESET_ID_EXISTS')

    env.presets.declare('standard')
    expect(await refusalOf(() => env.ctx.presetManager.create(draftFor(env.promptDir, { id: 'standard' }))))
      .toBe('presetManager/PRESET_ID_EXISTS')
  })

  it('refuses a malformed id or a blank name', async () => {
    const env = await setup()
    expect(await refusalOf(() => env.ctx.presetManager.create(draftFor(env.promptDir, { id: 'Elysia Conscious' }))))
      .toBe('presetManager/PRESET_ID_INVALID')
    expect(await refusalOf(() => env.ctx.presetManager.create(draftFor(env.promptDir, { name: '   ' }))))
      .toBe('presetManager/PRESET_NAME_INVALID')
    expect(await refusalOf(() => env.ctx.presetManager.create(draftFor(env.promptDir, { identity: '   ' }))))
      .toBe('presetManager/PRESET_IDENTITY_INVALID')
  })

  it('refuses a missing or relative prompt root', async () => {
    const env = await setup()
    expect(await refusalOf(() => env.ctx.presetManager.create(draftFor(join(env.promptDir, 'absent')))))
      .toBe('presetManager/PROMPT_ROOT_MISSING')
    expect(await refusalOf(() => env.ctx.presetManager.create(draftFor(env.promptDir, { promptRoot: 'relative/dir' }))))
      .toBe('presetManager/PROMPT_ROOT_INVALID')
  })

  it('refuses a file outside the root, a missing file, and a blank file set', async () => {
    const env = await setup()
    expect(await refusalOf(() => env.ctx.presetManager.create(draftFor(env.promptDir, {
      promptFiles: ['../escape.md'],
    })))).toBe('presetManager/PROMPT_FILE_OUTSIDE_ROOT')
    expect(await refusalOf(() => env.ctx.presetManager.create(draftFor(env.promptDir, {
      promptFiles: ['absent.md'],
    })))).toBe('presetManager/PROMPT_FILE_INVALID')
    await writeFile(join(env.promptDir, 'BLANK.md'), '   \n', 'utf8')
    expect(await refusalOf(() => env.ctx.presetManager.create(draftFor(env.promptDir, {
      promptFiles: ['BLANK.md'],
    })))).toBe('presetManager/PROMPT_FILE_EMPTY')
  })

  it('rolls back the registration when persistence fails', async () => {
    const env = await setup()
    // Replace the document file with a directory: the atomic rename then fails.
    const documentPath = join(env.stateDir, DOCUMENT_FILE_NAME)
    await rm(documentPath, { force: true })
    await mkdir(documentPath)
    const code = await refusalOf(() => env.ctx.presetManager.create(draftFor(env.promptDir)))
    expect(code).toBe('presetManager/STATE_WRITE_FAILED')
    expect(env.presets.definitions.has('elysia-conscious')).toBe(false)
  })
})

describe('list', () => {
  it('marks ownership and merges bundle-declared presets', async () => {
    const env = await setup()
    env.presets.declare('standard')
    await env.ctx.presetManager.create(draftFor(env.promptDir))

    const rows = await env.ctx.presetManager.list()
    expect(rows.map(row => [row.id, row.managed])).toEqual([
      ['elysia-conscious', true],
      ['standard', false],
    ])
    expect(rows[0]?.tools).toEqual(['tool-web'])
  })

  it('reports the live sessions running a preset', async () => {
    const env = await setup()
    await env.ctx.presetManager.create(draftFor(env.promptDir))
    const session = Session.create(SessionId('session-live'))
    env.agents.push({ session })
    env.presets.presetBySession.set(session.id, 'elysia-conscious')

    const [row] = await env.ctx.presetManager.list()
    expect(row?.inUse).toEqual(['session-live'])
  })

  it('keeps a broken owned preset visible with its diagnostic', async () => {
    const env = await setup()
    await env.ctx.presetManager.create(draftFor(env.promptDir))
    env.presets.broken.set('elysia-conscious', 'row 1 names no plugin')
    const [row] = await env.ctx.presetManager.list()
    expect(row?.diagnostic).toBe('row 1 names no plugin')
  })

  it('reports stored tool ids this build no longer offers', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'elysia-state-unknown-'))
    const promptDir = await promptRoot({ 'SOUL.md': 'soul body' })
    onTestFinished(async () => {
      await rm(stateDir, { recursive: true, force: true })
      await rm(promptDir, { recursive: true, force: true })
    })
    await writeFile(join(stateDir, DOCUMENT_FILE_NAME), JSON.stringify({
      version: 2,
      presets: [{
        id: 'elysia-conscious',
        name: 'Elysia conscious',
        identity: 'You are Elysia.',
        promptRoot: promptDir,
        promptFiles: ['SOUL.md'],
        tools: ['tool-web', 'tool-retired'],
        createdAt: '2026-11-22T00:00:00.000Z',
      }],
      toolFaces: [],
    }), 'utf8')
    const env = await setup({ stateDir, promptDir })
    const [row] = await env.ctx.presetManager.list()
    expect(row?.unknownTools).toEqual(['tool-retired'])
    // The known row still composes; the retired id simply has no row.
    expect(toolRowsOf(env.presets.definitions.get('elysia-conscious')).map(row => row.name))
      .toEqual(['@deepseek-ai/dsh-tool-web'])
  })
})

describe('persistence', () => {
  it('re-registers every owned preset after a restart', async () => {
    const first = await setup()
    await first.ctx.presetManager.create(draftFor(first.promptDir, { identity: 'You are Elysia.' }))
    await first.stop()

    const second = await setup({ stateDir: first.stateDir, promptDir: first.promptDir })
    const rows = await second.ctx.presetManager.list()
    expect(rows.map(row => row.id)).toEqual(['elysia-conscious'])
    const definition = second.presets.definitions.get('elysia-conscious')
    expect(definition?.plugins[0]?.config).toMatchObject({ identity: 'You are Elysia.' })
  })

  it('keeps a preset whose prompt root disappeared visible and blocks nothing else', async () => {
    const first = await setup()
    await first.ctx.presetManager.create(draftFor(first.promptDir))
    await first.ctx.presetManager.create(draftFor(first.promptDir, { id: 'second', name: 'Second' }))
    await first.stop()
    await rm(first.promptDir, { recursive: true, force: true })

    const second = await setup({ stateDir: first.stateDir, promptDir: first.promptDir })
    const rows = await second.ctx.presetManager.list()
    expect(rows.map(row => row.id)).toEqual(['elysia-conscious', 'second'])
    // Registration itself succeeds — the prompt child mounts even when the
    // directory is gone — so the row stays usable and the files are reported
    // by the child at assembly time.
    expect(second.presets.definitions.has('second')).toBe(true)
  })

  it('reads a v1 record as the network-search face', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'elysia-state-v1-'))
    const promptDir = await promptRoot({ 'SOUL.md': 'soul body' })
    onTestFinished(async () => {
      await rm(stateDir, { recursive: true, force: true })
      await rm(promptDir, { recursive: true, force: true })
    })
    // Exactly the document the previous build wrote: no `tools`, no `toolFaces`.
    await writeFile(join(stateDir, DOCUMENT_FILE_NAME), JSON.stringify({
      version: 1,
      presets: [{
        id: 'elysia-conscious',
        name: 'Elysia conscious',
        identity: 'You are Elysia.',
        promptRoot: promptDir,
        promptFiles: ['SOUL.md'],
        createdAt: '2026-11-22T00:00:00.000Z',
      }],
    }), 'utf8')

    const env = await setup({ stateDir, promptDir })
    const [row] = await env.ctx.presetManager.list()
    expect(row?.tools).toEqual(DEFAULT_TOOL_IDS)
    expect(toolRowsOf(env.presets.definitions.get('elysia-conscious')).map(tool => tool.name))
      .toEqual(['@deepseek-ai/dsh-tool-web'])
    // Reading does not rewrite the document: the old generation stays until a mutation.
    const document = JSON.parse(await readFile(join(stateDir, DOCUMENT_FILE_NAME), 'utf8'))
    expect(document.version).toBe(1)
  })

  it('refuses to open a malformed document', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'elysia-state-bad-'))
    await writeFile(join(stateDir, DOCUMENT_FILE_NAME), '{"version":9,"presets":[]}', 'utf8')
    const promptDir = await promptRoot({ 'SOUL.md': 'soul body' })
    onTestFinished(async () => {
      await rm(stateDir, { recursive: true, force: true })
      await rm(promptDir, { recursive: true, force: true })
    })
    const ctx = new Context()
    ctx.provide('agentPresets', new FakePresets() as never)
    ctx.provide('agents', { list: () => [], get: () => undefined } as never)
    await expect(ctx.plugin(presetManager, { stateDir })).rejects.toThrow()
    await ctx.fiber.dispose()
  })
})

describe('delete', () => {
  it('removes a manager-owned preset from the roster and the document', async () => {
    const env = await setup()
    await env.ctx.presetManager.create(draftFor(env.promptDir))
    await env.ctx.presetManager.delete('elysia-conscious')
    expect(await env.ctx.presetManager.list()).toEqual([])
    expect(env.presets.definitions.has('elysia-conscious')).toBe(false)
    const document = JSON.parse(await readFile(join(env.stateDir, DOCUMENT_FILE_NAME), 'utf8'))
    expect(document.presets).toEqual([])
  })

  it('refuses a bundle-declared preset', async () => {
    const env = await setup()
    env.presets.declare('standard')
    expect(await refusalOf(() => env.ctx.presetManager.delete('standard')))
      .toBe('presetManager/PRESET_NOT_MANAGED')
    expect(await refusalOf(() => env.ctx.presetManager.delete('nobody')))
      .toBe('presetManager/PRESET_NOT_FOUND')
  })

  it('refuses a preset a live session runs, naming the session', async () => {
    const env = await setup()
    await env.ctx.presetManager.create(draftFor(env.promptDir))
    const session = Session.create(SessionId('session-live'))
    env.agents.push({ session })
    env.presets.presetBySession.set(session.id, 'elysia-conscious')

    expect(await refusalOf(() => env.ctx.presetManager.delete('elysia-conscious')))
      .toBe('presetManager/PRESET_IN_USE')
    expect(await messageOf(() => env.ctx.presetManager.delete('elysia-conscious')))
      .toContain('session-live')
    // Force never overrides a live reference.
    expect(await refusalOf(() => env.ctx.presetManager.delete('elysia-conscious', { force: true })))
      .toBe('presetManager/PRESET_IN_USE')
    expect(env.presets.definitions.has('elysia-conscious')).toBe(true)
  })

  it('requires force to drop an owned entry that failed to register at startup', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'elysia-state-broken-'))
    onTestFinished(async () => { await rm(stateDir, { recursive: true, force: true }) })
    const presets = new FakePresets()
    presets.failRegister = true
    const env = await setup({ stateDir, presets })
    await writeFile(join(stateDir, DOCUMENT_FILE_NAME), JSON.stringify({
      version: 2,
      presets: [{
        id: 'elysia-conscious',
        name: 'Elysia conscious',
        identity: 'You are Elysia.',
        promptRoot: env.promptDir,
        promptFiles: ['SOUL.md'],
        tools: ['tool-web'],
        createdAt: '2026-11-22T00:00:00.000Z',
      }],
      toolFaces: [],
    }), 'utf8')
    // Remount so the persisted entry goes through the failing registration.
    await env.stop()
    presets.failRegister = true
    const restarted = await setup({ stateDir, presets, promptDir: env.promptDir })
    const [row] = await restarted.ctx.presetManager.list()
    expect(row?.diagnostic).toBeDefined()

    expect(await refusalOf(() => restarted.ctx.presetManager.delete('elysia-conscious')))
      .toBe('presetManager/PRESET_UNREGISTERED')
    await restarted.ctx.presetManager.delete('elysia-conscious', { force: true })
    expect(await restarted.ctx.presetManager.list()).toEqual([])
  })
})

describe('tool faces', () => {
  it('lists every catalog tool and the default, common, existing, and custom faces', async () => {
    const env = await setup()
    env.presets.declare('standard', ['@deepseek-ai/dsh-tool-web', '@deepseek-ai/dsh-tool-fs'])
    const created = await env.ctx.presetManager.createToolFace({
      name: 'Search only',
      tools: ['tool-web'],
    })
    const catalog = await env.ctx.presetManager.listToolFaces()

    expect(catalog.tools.map(tool => tool.id)).toEqual(TOOL_CATALOG.map(entry => entry.id))
    expect(catalog.tools.every(tool => tool.available)).toBe(true)
    expect(catalog.faces[0]).toMatchObject({ kind: 'default', id: 'default', tools: ['tool-web'] })
    expect(catalog.faces.filter(face => face.kind === 'common').map(face => face.id))
      .toEqual(['none', 'search', 'search-files', 'full'])
    expect(catalog.faces.find(face => face.kind === 'common' && face.id === 'none')?.tools).toEqual([])
    expect(catalog.faces.find(face => face.kind === 'existing' && face.id === 'standard')).toMatchObject({
      tools: ['tool-web', 'tool-fs'],
    })
    expect(catalog.faces.find(face => face.kind === 'custom')).toMatchObject({
      id: created.id,
      name: 'Search only',
      tools: ['tool-web'],
    })
  })

  it('builds a valid composition for every offered face', async () => {
    const env = await setup()
    env.presets.declare('standard', ['@deepseek-ai/dsh-tool-web', '@deepseek-ai/dsh-tool-fs'])
    await env.ctx.presetManager.createToolFace({ name: 'Files', tools: ['tool-fs', 'tool-fs-search'] })
    const catalog = await env.ctx.presetManager.listToolFaces()

    for (const face of catalog.faces) {
      // Every face names only tools the catalog resolves; a missing id would
      // silently shrink the preset instead of failing the check below.
      expect(face.tools.filter(id => findTool(id) === undefined)).toEqual([])
      const definition = buildPresetDefinition(recordFor(face.tools))
      expect(entryListProblem(definition.plugins), `face ${face.kind}:${face.id}`).toBeUndefined()
      expect(toolRowsOf(definition)).toHaveLength(face.tools.length)
    }
  })

  it('lists a tool the deployment cannot activate, marked unavailable, and leaves faces free of it', async () => {
    const env = await setup()
    env.presets.pendingModules.set('@deepseek-ai/dsh-tool-office', 'officeKit')
    const catalog = await env.ctx.presetManager.listToolFaces()

    expect(catalog.tools.find(tool => tool.id === 'tool-office')).toMatchObject({
      available: false,
      reason: expect.stringContaining('waiting for officeKit'),
    })
    const full = catalog.faces.find(face => face.kind === 'common' && face.id === 'full')
    expect(full?.tools).not.toContain('tool-office')
    expect(full?.tools).toContain('tool-web')
  })

  it('marks an existing preset face partial when it names a tool this deployment cannot offer', async () => {
    const env = await setup()
    env.presets.declare('legacy', ['@deepseek-ai/dsh-tool-web', '@deepseek-ai/dsh-tool-workflow'])
    const catalog = await env.ctx.presetManager.listToolFaces()
    const face = catalog.faces.find(candidate => candidate.kind === 'existing' && candidate.id === 'legacy')
    expect(face).toMatchObject({
      tools: ['tool-web'],
      missing: ['@deepseek-ai/dsh-tool-workflow'],
      partial: true,
    })
  })

  it('deletes only custom faces', async () => {
    const env = await setup()
    env.presets.declare('standard', ['@deepseek-ai/dsh-tool-web'])
    const created = await env.ctx.presetManager.createToolFace({ name: 'Mine', tools: ['tool-web', 'tool-fs'] })

    expect(await refusalOf(() => env.ctx.presetManager.deleteToolFace('default')))
      .toBe('presetManager/TOOL_FACE_READONLY')
    expect(await refusalOf(() => env.ctx.presetManager.deleteToolFace('none')))
      .toBe('presetManager/TOOL_FACE_READONLY')
    expect(await refusalOf(() => env.ctx.presetManager.deleteToolFace('standard')))
      .toBe('presetManager/TOOL_FACE_READONLY')
    expect(await refusalOf(() => env.ctx.presetManager.deleteToolFace('custom-absent')))
      .toBe('presetManager/TOOL_FACE_NOT_FOUND')

    await env.ctx.presetManager.deleteToolFace(created.id)
    const catalog = await env.ctx.presetManager.listToolFaces()
    expect(catalog.faces.some(face => face.kind === 'custom')).toBe(false)
  })

  it('refuses a blank name, an empty face, and a duplicate name', async () => {
    const env = await setup()
    expect(await refusalOf(() => env.ctx.presetManager.createToolFace({ name: '  ', tools: ['tool-web'] })))
      .toBe('presetManager/TOOL_FACE_INVALID')
    expect(await refusalOf(() => env.ctx.presetManager.createToolFace({ name: 'Empty', tools: [] })))
      .toBe('presetManager/TOOL_FACE_INVALID')
    await env.ctx.presetManager.createToolFace({ name: 'Mine', tools: ['tool-web'] })
    expect(await refusalOf(() => env.ctx.presetManager.createToolFace({ name: 'mine', tools: ['tool-fs'] })))
      .toBe('presetManager/TOOL_FACE_EXISTS')
  })

  it('keeps custom faces after a restart and after a preset is deleted', async () => {
    const first = await setup()
    const face = await first.ctx.presetManager.createToolFace({ name: 'Mine', tools: ['tool-web', 'tool-fs'] })
    await first.ctx.presetManager.create(draftFor(first.promptDir, {
      tools: face.tools,
      toolFace: { kind: 'custom', id: face.id },
    }))
    await first.ctx.presetManager.delete('elysia-conscious')
    await first.stop()

    const second = await setup({ stateDir: first.stateDir, promptDir: first.promptDir })
    const catalog = await second.ctx.presetManager.listToolFaces()
    expect(catalog.faces.find(candidate => candidate.id === face.id)).toMatchObject({
      kind: 'custom', name: 'Mine', tools: ['tool-web', 'tool-fs'],
    })
  })
})

describe('listPromptCandidates', () => {
  it('returns the markdown files sorted by name with their sizes', async () => {
    const env = await setup()
    await writeFile(join(env.promptDir, 'USER.md'), 'user body', 'utf8')
    await writeFile(join(env.promptDir, 'notes.txt'), 'not markdown', 'utf8')
    const candidates = await env.ctx.presetManager.listPromptCandidates(env.promptDir)
    expect(candidates.map(candidate => candidate.path)).toEqual(['SOUL.md', 'USER.md'])
    expect(candidates[0]?.bytes).toBe(Buffer.byteLength('soul body'))
  })

  it('refuses a directory that does not exist', async () => {
    const env = await setup()
    await unlink(join(env.promptDir, 'SOUL.md'))
    expect(await refusalOf(() => env.ctx.presetManager.listPromptCandidates(join(env.promptDir, 'absent'))))
      .toBe('presetManager/PROMPT_ROOT_MISSING')
  })
})

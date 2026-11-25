/**
 * Model-facing tools of the preset manager: list what a preset can be built
 * from, and create one from validated parameters.
 *
 * Both tools delegate every read and write to {@link PresetToolManager}; the
 * manager remains the single owner of validation, registration, and the
 * document. `preset_create` additionally resolves the call's permission through
 * the sandbox policy so a write outside the workspace cannot happen silently.
 *
 * They are registered as ordinary global tools by the Host row and carry no
 * enable flag or private state.
 *
 * @module @elysia/mobius-infinity/tools
 */

import type { Context } from '@deepseek-ai/cordis'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import { approveEscalation } from '@deepseek-ai/dsh-sandbox'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type {} from '@deepseek-ai/dsh-user-approval'
import type { PresetDraft, PresetSummary, PromptCandidate, ToolFaceCatalog, ToolFaceKind } from './types.ts'
import { PresetManagerError } from './errors.ts'
import {
  assertPresetId, assertPresetName, assertToolIds, normalizePromptPath,
  readPromptCandidates, resolvePromptRoot, validatePromptFile,
} from './validation.ts'
import { TOOL_CATALOG } from './tool-catalog.ts'
import { TOOL_FACE_KINDS } from './tool-face-kinds.ts'

/** Model-facing name of the create tool. */
export const PRESET_CREATE_TOOL = 'preset_create'

/** Model-facing name of the discovery tool. */
export const PRESET_LIST_TOOL = 'preset_list'

/** Chinese display name of the create tool, shown by the orchestrator when present. */
export const PRESET_CREATE_NAME_ZH = '创建预设'

/** Chinese display name of the discovery tool, shown by the orchestrator when present. */
export const PRESET_LIST_NAME_ZH = '列出预设'

/** The manager operations these tools read and write. */
export interface PresetToolManager {
  /** Read the merged preset roster. */
  list(): Promise<readonly PresetSummary[]>
  /** Read the tool options and faces the create page also renders. */
  listToolFaces(): Promise<ToolFaceCatalog>
  /** Validate, register, and persist one preset draft. */
  create(draft: PresetDraft): Promise<PresetSummary>
}

/** What a create call intends to write, for the permission question. */
export interface PresetCreateIntent {
  /** Roster key the caller chose. */
  readonly id: string
  /** Canonical absolute prompt root. */
  readonly promptRoot: string
}

/**
 * Resolve one create call's permission before anything is written.
 * Throws a structured failure when permission cannot be obtained.
 */
export type PresetCreateGuard = (exec: ToolRunContext, intent: PresetCreateIntent) => Promise<void>

/** A refused or cancelled model tool call, carrying the manager's stable code. */
export class PresetToolError extends HarnessError {
  /**
   * @param code - the manager refusal code, or a tool-level permission code.
   * @param message - model-actionable explanation.
   * @param options - standard `cause` chaining.
   */
  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, code, options)
    this.name = 'PresetToolError'
  }
}

/**
 * Build the guard used by the shipped Host row: a preset write requires
 * `danger-full-access`, which is already satisfied when the session runs in
 * that mode and otherwise asks through the approval seam for this one call.
 * @param ctx - Host context carrying `sandboxPolicy` and optional `approval`.
 * @param stateDir - manager document directory named in the approval reason.
 * @returns the guard handed to {@link buildPresetCreateTool}.
 */
export function sandboxPresetCreateGuard(ctx: Context, stateDir: string): PresetCreateGuard {
  return async (exec, intent) => {
    const sandboxPolicy = ctx.get('sandboxPolicy')
    if (sandboxPolicy === undefined) {
      throw new PresetToolError(
        'SANDBOX_POLICY_UNAVAILABLE',
        'preset_create requires the sandboxPolicy service to resolve this call\'s permission mode',
      )
    }
    const policy: SandboxExecutionPolicy = sandboxPolicy.resolve(
      exec.agent === undefined ? {} : { session: exec.agent.session },
    )
    await approveEscalation({
      requestedMode: 'danger-full-access',
      effectiveMode: policy.mode,
      subject: 'preset creation',
      justification: `authorize the preset manager to write its document under ${stateDir} and make preset "${intent.id}" selectable by new sessions; the write is direct, not a sandboxed process`,
    }, {
      approver: ctx.get('approval'),
      agent: exec.agent,
      callId: exec.callId,
      toolName: PRESET_CREATE_TOOL,
      signal: exec.signal,
    })
  }
}

/**
 * Build the create tool over one manager and permission guard.
 * @param manager - the manager that validates, registers, and persists.
 * @param guard - permission check run before the write.
 * @returns the definition registered with `ctx.tools.register()`.
 */
export function buildPresetCreateTool(manager: PresetToolManager, guard: PresetCreateGuard): ToolDefinition {
  return defineTool({
    name: PRESET_CREATE_TOOL,
    description: 'Create a new Agent preset from prompt files on disk and a fixed tool group. '
      + 'The preset joins the roster immediately; existing sessions keep their current preset and new sessions can select it. '
      + 'Call preset_list first to see free ids, existing prompt roots, and available tool ids. '
      + 'Requires danger-full-access; a narrower session is asked to approve this one call.',
    parameters: {
      id: {
        type: 'string', required: true,
        description: 'Roster key, unique across all presets: lowercase letters, digits and hyphens. Sessions record this key, so it cannot change later.',
      },
      name: {
        type: 'string', required: true,
        description: 'Display name shown in the preset list.',
      },
      identity: {
        type: 'string', required: true,
        description: 'What this preset is, in one or two sentences. It becomes the first part of the system prompt, before the prompt files.',
      },
      description: {
        type: 'string',
        description: 'One sentence describing what the preset is for, shown beside it in the list.',
      },
      promptRoot: {
        type: 'string', required: true,
        description: 'Absolute path to the directory holding the prompt files. Reuse a root from preset_list when the same prompts apply.',
      },
      promptFiles: {
        type: 'array',
        description: 'Root-relative Markdown files in render order, such as ["SOUL.md", "USER.md"]. Omit to use every non-empty .md file directly inside promptRoot, sorted by name.',
        items: { type: 'string', description: 'Root-relative path that stays inside promptRoot.' },
      },
      tools: {
        type: 'array',
        description: 'Tool ids this preset composes. Omit to use the default face (tool-web search only), or the tools of toolFace when one is supplied; pass an empty array for a preset with no tools.',
        items: {
          type: 'string',
          enum: TOOL_CATALOG.map(entry => entry.id),
          description: 'A catalog tool id; preset_list reports which ones can activate here.',
        },
      },
      toolFace: {
        type: 'object', additionalProperties: false,
        description: 'Tool face from preset_list. When supplied without tools, its tools are used; when both are supplied they must match. Omit when you choose tools yourself.',
        properties: {
          kind: { type: 'string', required: true, enum: TOOL_FACE_KINDS, description: 'Face family.' },
          id: { type: 'string', required: true, description: 'Face id from preset_list.' },
        },
      },
      agentInstructions: {
        type: 'boolean',
        description: 'Inject the workspace AGENTS.md and AGENTS.local.md files. Defaults to false.',
      },
      order: {
        type: 'integer',
        description: 'Roster position; lower values list first.',
      },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          name: { type: 'string', required: true },
          description: { type: 'string' },
          promptRoot: { type: 'string', required: true },
          promptFiles: { type: 'array', required: true, items: { type: 'string' } },
          tools: { type: 'array', required: true, items: { type: 'string' } },
          agentInstructions: { type: 'boolean', required: true },
          order: { type: 'integer' },
          toolFace: {
            type: 'object', additionalProperties: false,
            properties: {
              kind: { type: 'string', required: true, enum: TOOL_FACE_KINDS },
              id: { type: 'string', required: true },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Created preset "${value.id}" (${value.name}): ${String(value.promptFiles.length)} prompt file(s); `
          + `${value.tools.length === 0 ? 'no tools' : `tools: ${value.tools.join(', ')}`}. `
          + 'New sessions can select it; existing sessions keep their current preset.',
      }],
    },
    async execute(args, exec) {
      try {
        exec.signal.throwIfAborted()
        const id = assertPresetId(args.id)
        const name = assertPresetName(args.name)
        const identity = args.identity.trim()
        if (identity === '') {
          throw new PresetManagerError('PRESET_IDENTITY_INVALID', 'preset identity must not be blank', { presetId: id })
        }
        const roster = await manager.list()
        if (roster.some(row => row.id === id)) {
          throw new PresetManagerError('PRESET_ID_EXISTS', `preset id "${id}" is already taken`, { presetId: id })
        }
        const catalog = await manager.listToolFaces()
        const toolFace = args.toolFace
        const selectedFace = toolFace === undefined
          ? undefined
          : catalog.faces.find(face => face.kind === toolFace.kind && face.id === toolFace.id)
        if (toolFace !== undefined && selectedFace === undefined) {
          throw new PresetManagerError(
            'TOOL_FACE_NOT_FOUND',
            `no ${toolFace.kind} tool face "${toolFace.id}" exists in this deployment`,
            { toolFaceId: toolFace.id },
          )
        }
        let tools = assertToolIds(args.tools ?? selectedFace?.tools)
        if (args.tools !== undefined && selectedFace !== undefined) {
          const sameSet = tools.length === selectedFace.tools.length
            && tools.every(id => selectedFace.tools.includes(id))
          if (!sameSet) {
            throw new PresetManagerError(
              'TOOL_FACE_INVALID',
              `toolFace ${selectedFace.kind}/${selectedFace.id} composes [${selectedFace.tools.join(', ')}]; pass those tools or omit tools to use the face`,
              { toolFaceId: selectedFace.id, reason: 'tool-set-mismatch' },
            )
          }
          // Keep the record's tool order equal to the face it cites.
          tools = [...selectedFace.tools]
        }
        const blocked = catalog.tools.filter(option => !option.available && tools.includes(option.id))
        if (blocked.length > 0) {
          throw new PresetToolError(
            'TOOL_UNAVAILABLE',
            blocked.map(option => `${option.id}: ${option.reason ?? 'cannot activate in this deployment'}`).join('; '),
          )
        }
        const promptRoot = await resolvePromptRoot(args.promptRoot.trim())
        const promptFiles = await resolvePromptFiles(promptRoot, args.promptFiles)
        await guard(exec, { id, promptRoot })
        exec.signal.throwIfAborted()
        const row = await manager.create({
          id,
          name,
          identity,
          promptRoot,
          promptFiles,
          tools,
          ...(args.description === undefined ? {} : { description: args.description }),
          ...(args.toolFace === undefined
            ? {}
            : { toolFace: { kind: args.toolFace.kind, id: args.toolFace.id } }),
          ...(args.agentInstructions === undefined ? {} : { agentInstructions: args.agentInstructions }),
          ...(args.order === undefined ? {} : { order: args.order }),
        })
        return {
          id: row.id,
          name: row.name ?? name,
          ...(row.description === undefined ? {} : { description: row.description }),
          promptRoot: row.promptRoot ?? promptRoot,
          promptFiles,
          tools: [...(row.tools ?? tools)],
          agentInstructions: args.agentInstructions === true,
          ...(args.order === undefined ? {} : { order: args.order }),
          ...(toolFace === undefined ? {} : { toolFace: { kind: toolFace.kind, id: toolFace.id } }),
        }
      } catch (error: unknown) {
        refusal(error)
      }
    },
  })
}

/**
 * Build the read-only discovery tool over one manager.
 * @param manager - the manager whose roster, catalog, and prompt roots are read.
 * @returns the definition registered with `ctx.tools.register()`.
 */
export function buildPresetListTool(manager: PresetToolManager): ToolDefinition {
  return defineTool({
    name: PRESET_LIST_TOOL,
    description: 'List the Agent presets available to select, the tool ids a preset can compose, and the faces those ids form. '
      + 'Optionally list the non-empty Markdown files in a prompt directory. '
      + 'Call it before preset_create to choose a free id, reuse a prompt root, and pick available tools.',
    parameters: {
      promptRoot: {
        type: 'string',
        description: 'Optional absolute directory. When set, the result also lists its non-empty Markdown files with sizes.',
      },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          presets: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                managed: { type: 'boolean', required: true },
                inUse: { type: 'array', required: true, items: { type: 'string' } },
                name: { type: 'string' },
                description: { type: 'string' },
                diagnostic: { type: 'string' },
                promptRoot: { type: 'string' },
                promptFileCount: { type: 'integer' },
                tools: { type: 'array', items: { type: 'string' } },
                unknownTools: { type: 'array', items: { type: 'string' } },
              },
            },
          },
          tools: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                available: { type: 'boolean', required: true },
                reason: { type: 'string' },
                platform: { type: 'string', enum: ['win32', 'posix'] },
              },
            },
          },
          faces: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                kind: { type: 'string', required: true, enum: TOOL_FACE_KINDS },
                id: { type: 'string', required: true },
                name: { type: 'string' },
                tools: { type: 'array', required: true, items: { type: 'string' } },
                partial: { type: 'boolean' },
              },
            },
          },
          promptCandidates: {
            type: 'array',
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                path: { type: 'string', required: true },
                bytes: { type: 'integer', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      try {
        exec.signal.throwIfAborted()
        const root = args.promptRoot?.trim()
        const [presets, catalog, candidates] = await Promise.all([
          manager.list(),
          manager.listToolFaces(),
          root === undefined || root === '' ? Promise.resolve(undefined) : nonEmptyPromptCandidates(root),
        ])
        exec.signal.throwIfAborted()
        return {
          presets: presets.map(catalogPreset),
          tools: catalog.tools.map(catalogTool),
          faces: catalog.faces.map(catalogFace),
          ...(candidates === undefined
            ? {}
            : {
              promptCandidates: candidates.map(candidate => ({
                path: candidate.path,
                bytes: candidate.bytes,
              })),
            }),
        }
      } catch (error: unknown) {
        refusal(error)
      }
    },
  })
}

/**
 * Resolve the ordered prompt-file list, auto-selecting non-empty Markdown files
 * when the caller omitted it.
 * @param promptRoot - canonical absolute prompt root.
 * @param submitted - explicit root-relative paths, or undefined.
 * @returns the normalized paths to persist.
 */
async function resolvePromptFiles(
  promptRoot: string,
  submitted: readonly string[] | undefined,
): Promise<string[]> {
  if (submitted === undefined) {
    const nonEmpty = (await nonEmptyPromptCandidates(promptRoot)).map(candidate => candidate.path)
    if (nonEmpty.length === 0) {
      throw new PresetManagerError(
        'PROMPT_FILES_EMPTY',
        `no non-empty Markdown files exist in ${promptRoot}; pass promptFiles or choose another promptRoot`,
        { path: promptRoot },
      )
    }
    return nonEmpty
  }
  if (submitted.length === 0) {
    throw new PresetManagerError('PROMPT_FILES_EMPTY', 'a preset needs at least one prompt file', {
      path: promptRoot,
    })
  }
  const files: string[] = []
  let nonEmpty = 0
  for (const submittedPath of submitted) {
    const path = normalizePromptPath(submittedPath)
    if (files.includes(path)) {
      throw new PresetManagerError('PROMPT_FILE_INVALID', `prompt file ${path} is listed twice`, {
        path, reason: 'duplicate',
      })
    }
    const file = await validatePromptFile(promptRoot, path)
    if (file.text.trim() !== '') nonEmpty += 1
    files.push(path)
  }
  if (nonEmpty === 0) {
    throw new PresetManagerError('PROMPT_FILE_EMPTY', 'every configured prompt file is blank', {
      path: promptRoot,
    })
  }
  return files
}

/**
 * Read the Markdown candidates and keep only files with visible content.
 * @param root - absolute prompt root.
 * @returns non-blank `*.md` files sorted by name, with their sizes.
 */
async function nonEmptyPromptCandidates(root: string): Promise<PromptCandidate[]> {
  const candidates = await readPromptCandidates(root)
  const nonEmpty: PromptCandidate[] = []
  for (const candidate of candidates) {
    const file = await validatePromptFile(root, candidate.path)
    if (file.text.trim() !== '') nonEmpty.push({ path: file.path, bytes: file.bytes })
  }
  return nonEmpty
}

/**
 * Turn a refusal into the model-facing structured failure and rethrow
 * anything else unchanged.
 * @param error - the caught failure.
 */
function refusal(error: unknown): never {
  if (error instanceof PresetManagerError) {
    throw new PresetToolError(error.code, error.message, { cause: error })
  }
  const remote = remoteErrorOf(error)
  if (remote !== undefined) {
    const prefix = 'presetManager/'
    const code = remote.code.startsWith(prefix) ? remote.code.slice(prefix.length) : remote.code
    throw new PresetToolError(code, remote.message, { cause: error })
  }
  throw error
}

/** One preset row the list tool returns. */
interface CatalogPresetRow {
  readonly id: string
  readonly managed: boolean
  readonly inUse: string[]
  readonly name?: string
  readonly description?: string
  readonly diagnostic?: string
  readonly promptRoot?: string
  readonly promptFileCount?: number
  readonly tools?: string[]
  readonly unknownTools?: string[]
}

/** One tool option the list tool returns. */
interface CatalogToolRow {
  readonly id: string
  readonly available: boolean
  readonly reason?: string
  readonly platform?: 'win32' | 'posix'
}

/** One tool face the list tool returns. */
interface CatalogFaceRow {
  readonly kind: ToolFaceKind
  readonly id: string
  readonly name?: string
  readonly tools: string[]
  readonly partial?: boolean
}

/** One preset row the list tool returns. */
function catalogPreset(row: PresetSummary): CatalogPresetRow {
  return {
    id: row.id,
    managed: row.managed,
    inUse: [...row.inUse],
    ...(row.name === undefined ? {} : { name: row.name }),
    ...(row.description === undefined ? {} : { description: row.description }),
    ...(row.diagnostic === undefined ? {} : { diagnostic: row.diagnostic }),
    ...(row.promptRoot === undefined ? {} : { promptRoot: row.promptRoot }),
    ...(row.promptFileCount === undefined ? {} : { promptFileCount: row.promptFileCount }),
    ...(row.tools === undefined ? {} : { tools: [...row.tools] }),
    ...(row.unknownTools === undefined ? {} : { unknownTools: [...row.unknownTools] }),
  }
}

/** One tool option the list tool returns. */
function catalogTool(option: ToolFaceCatalog['tools'][number]): CatalogToolRow {
  return {
    id: option.id,
    available: option.available,
    ...(option.reason === undefined ? {} : { reason: option.reason }),
    ...(option.platform === undefined ? {} : { platform: option.platform }),
  }
}

/** One tool face the list tool returns. */
function catalogFace(face: ToolFaceCatalog['faces'][number]): CatalogFaceRow {
  return {
    kind: face.kind,
    id: face.id,
    tools: [...face.tools],
    ...(face.name === '' ? {} : { name: face.name }),
    ...(face.partial === undefined ? {} : { partial: face.partial }),
  }
}

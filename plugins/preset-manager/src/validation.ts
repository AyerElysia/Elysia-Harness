/**
 * Draft validation and prompt-root scanning. Every rule here answers an
 * operator mistake with a coded refusal instead of a half-registered preset:
 * the id shape, the display name, the absolute root, containment of each file,
 * and at least one non-empty body.
 *
 * @module @elysia/preset-manager/validation
 */

import { readFile, readdir, realpath, stat } from 'node:fs/promises'
import type { Stats } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { PresetDraft, PromptCandidate, ToolFaceKind } from './types.ts'
import type { PresetRecord } from './document.ts'
import { PresetManagerError, describeError } from './errors.ts'
import { DEFAULT_TOOL_IDS, partitionToolIds } from './tool-catalog.ts'
import { TOOL_FACE_KINDS } from './tool-face-kinds.ts'

/** Identity shape the preset registry accepts. */
const PRESET_ID = /^[a-z0-9-]+$/

/**
 * Validate and return one preset identity.
 * @param value - submitted id.
 * @returns the id unchanged.
 * @throws PresetManagerError `PRESET_ID_INVALID` for an empty or malformed id.
 */
export function assertPresetId(value: string): string {
  if (!PRESET_ID.test(value)) {
    throw new PresetManagerError(
      'PRESET_ID_INVALID',
      `preset id ${JSON.stringify(value)} must use lowercase letters, digits and hyphens`,
      { presetId: value, reason: 'id-shape' },
    )
  }
  return value
}

/**
 * Validate and return one display name.
 * @param value - submitted name.
 * @returns the trimmed name.
 * @throws PresetManagerError `PRESET_NAME_INVALID` for a blank name.
 */
export function assertPresetName(value: string): string {
  const name = value.trim()
  if (name === '') {
    throw new PresetManagerError('PRESET_NAME_INVALID', 'preset name must not be blank', { reason: 'blank-name' })
  }
  return name
}

/**
 * Canonicalize an absolute prompt root.
 * @param root - submitted directory.
 * @returns the real absolute path of the directory.
 * @throws PresetManagerError `PROMPT_ROOT_MISSING` when no directory exists there, `PROMPT_ROOT_INVALID` for a non-absolute path or a non-directory.
 */
export async function resolvePromptRoot(root: string): Promise<string> {
  if (!isAbsolute(root)) {
    throw new PresetManagerError('PROMPT_ROOT_INVALID', `prompt root must be absolute, got ${JSON.stringify(root)}`, {
      path: root, reason: 'not-absolute',
    })
  }
  let real: string
  try {
    real = await realpath(resolve(root))
  } catch (error: unknown) {
    throw new PresetManagerError('PROMPT_ROOT_MISSING', `no directory exists at ${root}: ${describeError(error)}`, {
      path: root, reason: 'missing',
    })
  }
  let info: Stats
  try {
    info = await stat(real)
  } catch (error: unknown) {
    throw new PresetManagerError('PROMPT_ROOT_MISSING', `cannot inspect ${root}: ${describeError(error)}`, {
      path: root, reason: 'unreadable',
    })
  }
  if (!info.isDirectory()) {
    throw new PresetManagerError('PROMPT_ROOT_INVALID', `prompt root ${root} is not a directory`, {
      path: root, reason: 'not-directory',
    })
  }
  return real
}

/**
 * Store a submitted file path in its canonical form: `/` separators, no
 * leading `./`.
 * @param value - submitted root-relative path.
 * @returns the normalized relative path.
 */
export function normalizePromptPath(value: string): string {
  return value.replaceAll('\\', '/').replace(/^\.\/+/, '')
}

/**
 * Whether one resolved path stays inside a root.
 * @param root - canonical absolute root.
 * @param target - canonical absolute candidate.
 * @returns true when the relative step from root reaches target without leaving it.
 */
function isInside(root: string, target: string): boolean {
  const step = relative(root, target)
  if (step === '') return true
  if (isAbsolute(step)) return false
  return !step.split(sep).includes('..')
}

/** One validated prompt file. */
export interface ValidatedPromptFile {
  /** Canonical root-relative path with `/` separators. */
  readonly path: string
  /** Current size in bytes. */
  readonly bytes: number
  /** File contents as read for the emptiness check. */
  readonly text: string
}

/**
 * Validate one configured file against its prompt root.
 * @param realRoot - canonical absolute root.
 * @param path - normalized root-relative path.
 * @returns the validated file, including the contents read for validation.
 * @throws PresetManagerError `PROMPT_FILE_OUTSIDE_ROOT` for traversal or a symlink escape, `PROMPT_FILE_INVALID` for anything else unusable.
 */
export async function validatePromptFile(realRoot: string, path: string): Promise<ValidatedPromptFile> {
  if (path === '') {
    throw new PresetManagerError('PROMPT_FILE_INVALID', 'prompt file path must not be empty', { path, reason: 'empty' })
  }
  if (isAbsolute(path)) {
    throw new PresetManagerError('PROMPT_FILE_OUTSIDE_ROOT', `prompt file ${path} must be relative to the prompt root`, {
      path, reason: 'absolute',
    })
  }
  if (path.split('/').includes('..')) {
    throw new PresetManagerError('PROMPT_FILE_OUTSIDE_ROOT', `prompt file ${path} must not traverse out of the prompt root`, {
      path, reason: 'traversal',
    })
  }
  let real: string
  try {
    real = await realpath(resolve(realRoot, path))
  } catch (error: unknown) {
    throw new PresetManagerError('PROMPT_FILE_INVALID', `prompt file ${path} is unreadable: ${describeError(error)}`, {
      path, reason: 'missing',
    })
  }
  if (!isInside(realRoot, real)) {
    throw new PresetManagerError('PROMPT_FILE_OUTSIDE_ROOT', `prompt file ${path} resolves outside the prompt root`, {
      path, reason: 'symlink-escape',
    })
  }
  let info: Stats
  try {
    info = await stat(real)
  } catch (error: unknown) {
    throw new PresetManagerError('PROMPT_FILE_INVALID', `cannot inspect prompt file ${path}: ${describeError(error)}`, {
      path, reason: 'unreadable',
    })
  }
  if (!info.isFile()) {
    throw new PresetManagerError('PROMPT_FILE_INVALID', `prompt file ${path} is not a regular file`, {
      path, reason: 'not-file',
    })
  }
  let text: string
  try {
    text = await readFile(real, 'utf8')
  } catch (error: unknown) {
    throw new PresetManagerError('PROMPT_FILE_INVALID', `cannot read prompt file ${path}: ${describeError(error)}`, {
      path, reason: 'unreadable',
    })
  }
  return { path, bytes: info.size, text }
}

/**
 * Validate and return one custom face name.
 * @param value - submitted name.
 * @returns the trimmed name.
 * @throws PresetManagerError `TOOL_FACE_INVALID` for a blank name.
 */
export function assertToolFaceName(value: string): string {
  const name = value.trim()
  if (name === '') {
    throw new PresetManagerError('TOOL_FACE_INVALID', 'a tool face needs a name', { reason: 'blank-name' })
  }
  return name
}

/**
 * Validate the submitted tool ids.
 * @param value - submitted tool list, or undefined for the default face.
 * @returns the ids to persist, in submitted order.
 * @throws PresetManagerError `TOOL_UNKNOWN` for an id this build's catalog does not compose.
 */
export function assertToolIds(value: readonly string[] | undefined): string[] {
  if (value === undefined) return [...DEFAULT_TOOL_IDS]
  if (!Array.isArray(value)) {
    throw new PresetManagerError('TOOL_FACE_INVALID', 'the tool list must be an array', { reason: 'not-a-list' })
  }
  for (const id of value) {
    if (typeof id !== 'string' || id === '') {
      throw new PresetManagerError('TOOL_FACE_INVALID', 'every tool id must be a non-empty string', {
        reason: 'invalid-id',
      })
    }
  }
  const { known, unknown } = partitionToolIds(value)
  const unknownTool = unknown[0]
  if (unknownTool !== undefined) {
    throw new PresetManagerError('TOOL_UNKNOWN', `tool ${JSON.stringify(unknownTool)} is not in this build's catalog`, {
      toolId: unknownTool, reason: 'unknown-tool',
    })
  }
  return known
}

/**
 * Validate one submitted face reference.
 * @param value - submitted `toolFace`, or undefined when the operator edited switches directly.
 * @param customFaceIds - ids of the custom faces the document holds.
 * @returns the reference, or undefined when absent.
 * @throws PresetManagerError for an unknown family, a blank id, or a missing custom face.
 */
export function assertToolFace(value: PresetDraft['toolFace'], customFaceIds: readonly string[]): PresetDraft['toolFace'] {
  if (value === undefined) return undefined
  if (typeof value !== 'object' || value === null) {
    throw new PresetManagerError('TOOL_FACE_INVALID', 'the tool face reference must be an object', {
      reason: 'not-an-object',
    })
  }
  const kind = value.kind
  const id = value.id
  const faceId = typeof id === 'string' && id !== '' ? { toolFaceId: id } : {}
  if (typeof kind !== 'string' || !TOOL_FACE_KINDS.includes(kind as ToolFaceKind)) {
    throw new PresetManagerError('TOOL_FACE_INVALID', `tool face family ${JSON.stringify(String(kind))} is not known`, {
      ...faceId, reason: 'unknown-kind',
    })
  }
  if (typeof id !== 'string' || id === '') {
    throw new PresetManagerError('TOOL_FACE_INVALID', 'the tool face reference needs an id', { reason: 'blank-id' })
  }
  if (kind === 'custom' && !customFaceIds.includes(id)) {
    throw new PresetManagerError('TOOL_FACE_NOT_FOUND', `no custom tool face "${id}" exists`, {
      toolFaceId: id, reason: 'missing',
    })
  }
  return { kind: kind as ToolFaceKind, id }
}

/**
 * Validate one submitted draft and turn it into a persisted record.
 * @param draft - the create page's fields.
 * @param customFaceIds - ids of the custom faces the document holds.
 * @returns the record to register and persist.
 * @throws PresetManagerError for every draft rule the manager enforces.
 */
export async function normalizeDraft(
  draft: PresetDraft,
  customFaceIds: readonly string[] = [],
): Promise<PresetRecord> {
  const id = assertPresetId(draft.id)
  const name = assertPresetName(draft.name)
  if (draft.promptFiles.length === 0) {
    throw new PresetManagerError('PROMPT_FILES_EMPTY', 'a preset needs at least one prompt file', { presetId: id })
  }
  const realRoot = await resolvePromptRoot(draft.promptRoot)
  const files: string[] = []
  let nonEmpty = 0
  for (const submitted of draft.promptFiles) {
    const path = normalizePromptPath(submitted)
    if (files.includes(path)) {
      throw new PresetManagerError('PROMPT_FILE_INVALID', `prompt file ${path} is listed twice`, {
        presetId: id, path, reason: 'duplicate',
      })
    }
    const file = await validatePromptFile(realRoot, path)
    if (file.text.trim() !== '') nonEmpty += 1
    files.push(path)
  }
  if (nonEmpty === 0) {
    throw new PresetManagerError('PROMPT_FILE_EMPTY', 'every configured prompt file is blank', { presetId: id })
  }
  const description = draft.description?.trim()
  const identity = draft.identity.trim()
  if (identity === '') {
    throw new PresetManagerError('PRESET_IDENTITY_INVALID', 'preset identity must not be blank', { presetId: id })
  }
  const tools = assertToolIds(draft.tools)
  const toolFace = assertToolFace(draft.toolFace, customFaceIds)
  const record: PresetRecord = {
    id,
    name,
    identity,
    agentInstructions: draft.agentInstructions === true,
    promptRoot: realRoot,
    promptFiles: files,
    tools,
    createdAt: new Date().toISOString(),
    ...(description === undefined || description === '' ? {} : { description }),
    ...(draft.order === undefined ? {} : { order: draft.order }),
    ...(toolFace === undefined ? {} : { toolFace }),
  }
  return record
}

/**
 * List the Markdown files directly inside a prompt root.
 * @param root - submitted directory.
 * @returns `*.md` entries sorted by name, each with its size.
 * @throws PresetManagerError for a root that is not an absolute, readable directory.
 */
export async function readPromptCandidates(root: string): Promise<PromptCandidate[]> {
  const realRoot = await resolvePromptRoot(root)
  let entries
  try {
    entries = await readdir(realRoot, { withFileTypes: true })
  } catch (error: unknown) {
    throw new PresetManagerError('PROMPT_ROOT_INVALID', `cannot list ${root}: ${describeError(error)}`, {
      path: root, reason: 'unreadable',
    })
  }
  const candidates: PromptCandidate[] = []
  for (const entry of entries) {
    if (!entry.isFile()) continue
    if (!entry.name.toLowerCase().endsWith('.md')) continue
    let info: Stats
    try {
      info = await stat(join(realRoot, entry.name))
    } catch (error: unknown) {
      throw new PresetManagerError('PROMPT_ROOT_INVALID', `cannot size ${entry.name} in ${root}: ${describeError(error)}`, {
        path: entry.name, reason: 'unreadable',
      })
    }
    candidates.push({ path: entry.name, bytes: info.size })
  }
  return candidates.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
}

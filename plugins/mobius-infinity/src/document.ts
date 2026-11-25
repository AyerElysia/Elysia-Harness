/**
 * The manager's own persisted document: which presets this plugin owns, which
 * tool faces the operator defined, and the fields needed to rebuild each
 * definition after a restart. It is not a preset declaration —
 * `agentPresets.register()` is the only writer of roster state, and this file is
 * the manager's source of truth for re-registration.
 *
 * @module @elysia/mobius-infinity/document
 */

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import type { ToolFaceKind, ToolFaceRef } from './types.ts'
import { DEFAULT_TOOL_IDS } from './tool-catalog.ts'
import { PresetManagerError, describeError } from './errors.ts'

/** File name of the manager document inside the configured state directory. */
export const DOCUMENT_FILE_NAME = 'presets.json'

/** Document generation this build writes. */
export const DOCUMENT_VERSION = 2

/** Generations this build still reads. A v1 document has no tool faces. */
export const READABLE_DOCUMENT_VERSIONS: readonly number[] = [1, 2]

/** One face the operator created; only these are deletable. */
export interface ToolFaceRecord {
  /** Generated id, stable for the face's lifetime. */
  readonly id: string
  /** Operator-provided display name. */
  readonly name: string
  /** Tool ids the face switches on. */
  readonly tools: readonly string[]
}

/** One manager-owned preset, exactly as the create page submitted it. */
export interface PresetRecord {
  /** Preset identity and roster key. */
  readonly id: string
  /** Display name. */
  readonly name: string
  /** One sentence on what the preset is for. */
  readonly description?: string
  /** One sentence telling the model what this preset is; rendered before the files. */
  readonly identity: string
  /** Whether this preset mounts `agent-instructions` for workspace AGENTS.md files. */
  readonly agentInstructions: boolean
  /** Absolute directory holding the prompt files. */
  readonly promptRoot: string
  /** Ordered, root-relative file list. */
  readonly promptFiles: readonly string[]
  /** Roster position. */
  readonly order?: number
  /** Tool ids the preset's tool group composes. */
  readonly tools: readonly string[]
  /** Face the ids came from, when the operator picked one. */
  readonly toolFace?: ToolFaceRef
  /** ISO timestamp of creation. */
  readonly createdAt: string
}

/** The whole persisted document. */
export interface PresetDocument {
  /** Document generation. */
  readonly version: typeof DOCUMENT_VERSION
  /** Manager-owned presets in creation order. */
  readonly presets: readonly PresetRecord[]
  /** Operator-defined tool faces in creation order. */
  readonly toolFaces: readonly ToolFaceRecord[]
}

/** Every face family a stored reference may name. */
const FACE_KINDS: readonly ToolFaceKind[] = ['default', 'common', 'existing', 'custom']

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function invalid(file: string, reason: string): PresetManagerError {
  return new PresetManagerError('STATE_INVALID', `mobius-infinity document ${file} is unusable: ${reason}`, {
    path: file, reason,
  })
}

/**
 * Read the optional string field of one stored entry.
 * @param entry - the stored object being validated.
 * @param field - field name to read.
 * @param file - document path, used in the diagnostic.
 * @returns the value, or undefined when the field is absent.
 */
function optionalString(entry: Record<string, unknown>, field: string, file: string): string | undefined {
  const value = entry[field]
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw invalid(file, `"${field}" must be a string`)
  return value
}

/**
 * Read one stored string list, dropping duplicates.
 * @param value - candidate field value.
 * @param label - field label used in the diagnostic.
 * @param file - document path, used in the diagnostic.
 * @returns the stored strings in order, or undefined when the field is absent.
 */
function optionalStringList(value: unknown, label: string, file: string): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) throw invalid(file, `"${label}" must be an array`)
  const items: string[] = []
  for (const item of value) {
    if (typeof item !== 'string' || item === '') throw invalid(file, `"${label}" has an invalid entry`)
    if (!items.includes(item)) items.push(item)
  }
  return items
}

/**
 * Validate a stored face reference.
 * @param value - candidate `toolFace` field.
 * @param label - position label used in the diagnostic.
 * @param file - document path, used in the diagnostic.
 * @returns the reference, or undefined when the field is absent.
 */
function parseFaceRef(value: unknown, label: string, file: string): ToolFaceRef | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value)) throw invalid(file, `${label}.toolFace must be an object`)
  const kind = value['kind']
  const id = value['id']
  if (typeof kind !== 'string' || !FACE_KINDS.includes(kind as ToolFaceKind)) {
    throw invalid(file, `${label}.toolFace.kind is not a known face family`)
  }
  if (typeof id !== 'string' || id === '') throw invalid(file, `${label}.toolFace has no id`)
  return { kind: kind as ToolFaceKind, id }
}

/**
 * Validate one stored preset entry. A record written before tool faces existed
 * carries no `tools`; it keeps the network-search face it was created with.
 * @param value - candidate entry from the parsed document.
 * @param index - position in the array, used in the diagnostic.
 * @param file - document path, used in the diagnostic.
 * @returns the validated record.
 */
function parseRecord(value: unknown, index: number, file: string): PresetRecord {
  const label = `presets[${String(index)}]`
  if (!isRecord(value)) throw invalid(file, `${label} is not an object`)
  const id = optionalString(value, 'id', file)
  const name = optionalString(value, 'name', file)
  const promptRoot = optionalString(value, 'promptRoot', file)
  const createdAt = optionalString(value, 'createdAt', file)
  if (id === undefined || id === '') throw invalid(file, `${label} has no id`)
  if (name === undefined || name === '') throw invalid(file, `${label} has no name`)
  if (promptRoot === undefined || promptRoot === '') throw invalid(file, `${label} has no promptRoot`)
  if (createdAt === undefined) throw invalid(file, `${label} has no createdAt`)
  const promptFiles = value['promptFiles']
  if (!Array.isArray(promptFiles) || promptFiles.length === 0) {
    throw invalid(file, `${label} has no promptFiles`)
  }
  const files: string[] = []
  for (const item of promptFiles) {
    if (typeof item !== 'string' || item === '') throw invalid(file, `${label} has an invalid prompt file`)
    files.push(item)
  }
  const order = value['order']
  if (order !== undefined && (typeof order !== 'number' || !Number.isFinite(order))) {
    throw invalid(file, `${label} has a non-numeric order`)
  }
  const description = optionalString(value, 'description', file)
  const identity = optionalString(value, 'identity', file)
  if (identity === undefined || identity === '') {
    throw invalid(file, `${label} has no identity`)
  }
  const agentInstructions = value['agentInstructions']
  if (agentInstructions !== undefined && typeof agentInstructions !== 'boolean') {
    throw invalid(file, `${label}.agentInstructions must be a boolean`)
  }
  const storedTools = optionalStringList(value['tools'], `${label}.tools`, file)
  const toolFace = parseFaceRef(value['toolFace'], label, file)
  return {
    id,
    name,
    identity,
    agentInstructions: agentInstructions === true,
    promptRoot,
    promptFiles: files,
    // A record written before tool faces existed has no `tools` key. An explicit
    // empty list is the chat-only face and means what it says.
    tools: storedTools === undefined ? [...DEFAULT_TOOL_IDS] : storedTools,
    createdAt,
    ...(description === undefined ? {} : { description }),
    ...(order === undefined ? {} : { order }),
    ...(toolFace === undefined ? {} : { toolFace }),
  }
}

/**
 * Validate the stored custom faces.
 * @param value - candidate `toolFaces` field.
 * @param file - document path, used in the diagnostic.
 * @returns the validated faces in creation order.
 */
function parseFaces(value: unknown, file: string): ToolFaceRecord[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw invalid(file, '"toolFaces" must be an array')
  const faces: ToolFaceRecord[] = []
  const seen = new Set<string>()
  for (const [index, entry] of value.entries()) {
    const label = `toolFaces[${String(index)}]`
    if (!isRecord(entry)) throw invalid(file, `${label} is not an object`)
    const id = optionalString(entry, 'id', file)
    const name = optionalString(entry, 'name', file)
    if (id === undefined || id === '') throw invalid(file, `${label} has no id`)
    if (name === undefined || name === '') throw invalid(file, `${label} has no name`)
    const tools = optionalStringList(entry['tools'], `${label}.tools`, file)
    if (tools === undefined || tools.length === 0) throw invalid(file, `${label} has no tools`)
    if (seen.has(id)) throw invalid(file, `duplicate tool face id "${id}"`)
    seen.add(id)
    faces.push({ id, name, tools })
  }
  return faces
}

/**
 * Validate a parsed document. An absent document is the empty one; a present
 * one must carry a generation this build reads and well-formed lists.
 * @param value - parsed JSON, or undefined when the file does not exist.
 * @param file - document path, used in the diagnostic.
 * @returns the validated document at this build's generation.
 */
export function parseDocument(value: unknown, file: string): PresetDocument {
  if (value === undefined) return { version: DOCUMENT_VERSION, presets: [], toolFaces: [] }
  if (!isRecord(value)) throw invalid(file, 'the document must be an object')
  const version = value['version']
  if (typeof version !== 'number' || !READABLE_DOCUMENT_VERSIONS.includes(version)) {
    throw invalid(file, `unsupported version ${String(version)}; this build reads ${READABLE_DOCUMENT_VERSIONS.join(', ')}`)
  }
  const presets = value['presets']
  if (!Array.isArray(presets)) throw invalid(file, '"presets" must be an array')
  const records = presets.map((entry, index) => parseRecord(entry, index, file))
  const seen = new Set<string>()
  for (const record of records) {
    if (seen.has(record.id)) throw invalid(file, `duplicate preset id "${record.id}"`)
    seen.add(record.id)
  }
  // A v1 document predates custom faces, so it has none to read.
  const faces = version === 1 ? [] : parseFaces(value['toolFaces'], file)
  return { version: DOCUMENT_VERSION, presets: records, toolFaces: faces }
}

/**
 * The manager's persisted owned-preset and tool-face list. Every mutation
 * rewrites the whole document through a temporary file and one rename, so a
 * reader never observes a partial write.
 */
export class PresetDocumentStore {
  private records: readonly PresetRecord[]
  private faces: readonly ToolFaceRecord[]

  private constructor(
    private readonly file: string,
    document: PresetDocument,
  ) {
    this.records = document.presets
    this.faces = document.toolFaces
  }

  /**
   * Open the document under one state directory, creating the directory when
   * it is absent.
   * @param stateDir - absolute directory the document lives in.
   * @returns the store over the persisted records.
   * @throws PresetManagerError `STATE_INVALID` for a non-absolute directory or a malformed document.
   */
  static async open(stateDir: string): Promise<PresetDocumentStore> {
    if (!isAbsolute(stateDir)) {
      throw new PresetManagerError('STATE_INVALID', `mobius-infinity stateDir must be absolute, got ${JSON.stringify(stateDir)}`, {
        path: stateDir, reason: 'not-absolute',
      })
    }
    try {
      await mkdir(stateDir, { recursive: true })
    } catch (error: unknown) {
      throw new PresetManagerError('STATE_INVALID', `mobius-infinity cannot create stateDir ${stateDir}: ${describeError(error)}`, {
        path: stateDir, reason: 'uncreatable',
      })
    }
    const file = join(stateDir, DOCUMENT_FILE_NAME)
    let raw: string | undefined
    try {
      raw = await readFile(file, 'utf8')
    } catch (error: unknown) {
      if (!isMissingFile(error)) {
        throw new PresetManagerError('STATE_INVALID', `mobius-infinity cannot read ${file}: ${describeError(error)}`, {
          path: file, reason: 'unreadable',
        })
      }
    }
    let parsed: unknown
    if (raw !== undefined) {
      try {
        parsed = JSON.parse(raw)
      } catch (error: unknown) {
        throw new PresetManagerError('STATE_INVALID', `mobius-infinity document ${file} is not JSON: ${describeError(error)}`, {
          path: file, reason: 'not-json',
        })
      }
    }
    return new PresetDocumentStore(file, parseDocument(parsed, file))
  }

  /** The persisted path of this document. */
  get path(): string {
    return this.file
  }

  /** Manager-owned records in creation order. */
  list(): readonly PresetRecord[] {
    return this.records
  }

  /** Operator-defined tool faces in creation order. */
  listFaces(): readonly ToolFaceRecord[] {
    return this.faces
  }

  /**
   * Read one manager-owned record.
   * @param id - preset identity.
   * @returns the record, or undefined when the manager does not own it.
   */
  find(id: string): PresetRecord | undefined {
    return this.records.find(record => record.id === id)
  }

  /**
   * Read one operator-defined face.
   * @param id - face id.
   * @returns the face, or undefined when the operator did not create it.
   */
  findFace(id: string): ToolFaceRecord | undefined {
    return this.faces.find(face => face.id === id)
  }

  /**
   * Append one record and persist the whole document.
   * @param record - the new manager-owned preset.
   * @returns after the document is durable.
   */
  async add(record: PresetRecord): Promise<void> {
    await this.commit([...this.records, record], this.faces)
  }

  /**
   * Drop one record and persist the whole document. Tool faces are independent
   * of presets, so they survive this write.
   * @param id - preset identity.
   * @returns after the document is durable.
   */
  async remove(id: string): Promise<void> {
    await this.commit(this.records.filter(record => record.id !== id), this.faces)
  }

  /**
   * Append one custom face and persist the whole document.
   * @param face - the face to store.
   * @returns after the document is durable.
   */
  async addFace(face: ToolFaceRecord): Promise<void> {
    await this.commit(this.records, [...this.faces, face])
  }

  /**
   * Drop one custom face and persist the whole document. Presets that named it
   * keep their tool ids.
   * @param id - face id.
   * @returns after the document is durable.
   */
  async removeFace(id: string): Promise<void> {
    await this.commit(this.records, this.faces.filter(face => face.id !== id))
  }

  private async commit(next: readonly PresetRecord[], faces: readonly ToolFaceRecord[]): Promise<void> {
    const text = `${JSON.stringify({ version: DOCUMENT_VERSION, presets: next, toolFaces: faces }, undefined, 2)}\n`
    const temporary = `${this.file}.${String(process.pid)}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, text, 'utf8')
      await rename(temporary, this.file)
    } catch (error: unknown) {
      throw new PresetManagerError('STATE_WRITE_FAILED', `mobius-infinity cannot write ${this.file}: ${describeError(error)}`, {
        path: this.file, reason: 'write-failed',
      })
    }
    this.records = next
    this.faces = faces
  }
}

/**
 * Whether a read failure is the document not existing yet.
 * @param error - the caught read failure.
 * @returns true for ENOENT only.
 */
function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT'
}

/**
 * The session-scoped state document: orchestration mode, enabled/disabled
 * tools, and the shared tool-group preset library.
 *
 * Every mutation rewrites the whole document through a temporary file and one
 * rename, so a reader never observes a partial write. Mutations are serialized
 * because a tool switch and a mode change can interleave on the event loop.
 *
 * The document stays at version 1. Fields written by older builds for the
 * context bus (per-session `contexts`/`events`, top-level `queues`) are ignored
 * on read and dropped on the next write; they are not migrated.
 *
 * @module @elysia/villv-helix/state
 */

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import type { HelixDocument, SessionStateRecord, ToolPresetEntry } from './types.ts'
import { VillvHelixError, describeError } from './errors.ts'

/** File name of the panel document inside the configured state directory. */
export const DOCUMENT_FILE_NAME = 'villv-helix-state.json'

/** Document generation this build writes and reads. */
export const DOCUMENT_VERSION = 1

/** A session with no stored state. */
const EMPTY_SESSION: SessionStateRecord = { orchestrated: false, enabledTools: [], disabledTools: [] }

/** A fresh, never-written document. */
function emptyDocument(): HelixDocument {
  return { version: DOCUMENT_VERSION, sessions: {}, toolPresets: [], updatedAt: new Date(0).toISOString() }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isMissingFile(error: unknown): boolean {
  return isRecord(error) && error['code'] === 'ENOENT'
}

function invalid(file: string, message: string): VillvHelixError {
  return new VillvHelixError('STATE_INVALID', `villv-helix cannot use ${file}: ${message}`, { path: file })
}

function stringArray(value: unknown, label: string, file: string): string[] {
  if (!Array.isArray(value) || value.some(entry => typeof entry !== 'string')) {
    throw invalid(file, `${label} must be a string array`)
  }
  return [...value]
}

function parseSession(value: unknown, label: string, file: string): SessionStateRecord {
  if (!isRecord(value)) throw invalid(file, `${label} is not an object`)
  // `contexts` and `events` were written by builds that owned the context bus.
  // They are ignored here and disappear on the next commit.
  return {
    orchestrated: value['orchestrated'] === true,
    enabledTools: value['enabledTools'] === undefined
      ? []
      : stringArray(value['enabledTools'], `${label}.enabledTools`, file),
    disabledTools: stringArray(value['disabledTools'], `${label}.disabledTools`, file),
  }
}

function parseDocument(value: unknown, file: string): HelixDocument {
  if (!isRecord(value)) throw invalid(file, 'the document is not an object')
  if (value['version'] !== DOCUMENT_VERSION) throw invalid(file, `unsupported document version ${String(value['version'])}`)
  const sessions: Record<string, SessionStateRecord> = {}
  const sessionSection = value['sessions']
  if (sessionSection !== undefined) {
    if (!isRecord(sessionSection)) throw invalid(file, '"sessions" must be an object')
    for (const [id, entry] of Object.entries(sessionSection)) sessions[id] = parseSession(entry, `sessions.${id}`, file)
  }
  // A top-level `queues` section from an older build is ignored, not migrated.
  const presets = value['toolPresets']
  if (presets !== undefined && !Array.isArray(presets)) throw invalid(file, '"toolPresets" must be an array')
  return {
    version: DOCUMENT_VERSION,
    sessions,
    toolPresets: (presets ?? []).map((entry, index) => {
      const label = `toolPresets[${String(index)}]`
      if (!isRecord(entry) || typeof entry['id'] !== 'string' || typeof entry['name'] !== 'string'
        || typeof entry['createdAt'] !== 'number') throw invalid(file, `${label} is not a tool preset`)
      return {
        id: entry['id'], name: entry['name'], createdAt: entry['createdAt'],
        tools: stringArray(entry['tools'], `${label}.tools`, file),
      }
    }),
    updatedAt: typeof value['updatedAt'] === 'string' ? value['updatedAt'] : new Date(0).toISOString(),
  }
}

/** Persisted per-session state and the shared tool-preset library. */
export class HelixStore {
  private document: HelixDocument
  private writing: Promise<void> = Promise.resolve()
  private readonly file: string

  private constructor(file: string, document: HelixDocument) {
    this.file = file
    this.document = document
  }

  /**
   * Open (or create) the document in one state directory.
   * @param stateDir - absolute directory holding the document.
   * @returns the opened store.
   * @throws VillvHelixError `STATE_INVALID` when the directory is relative or the document is unreadable.
   */
  static async open(stateDir: string): Promise<HelixStore> {
    if (!isAbsolute(stateDir)) {
      throw new VillvHelixError('STATE_INVALID', `villv-helix stateDir must be absolute, got ${JSON.stringify(stateDir)}`, {
        path: stateDir, reason: 'not-absolute',
      })
    }
    try {
      await mkdir(stateDir, { recursive: true })
    } catch (error: unknown) {
      throw new VillvHelixError('STATE_INVALID', `villv-helix cannot create ${stateDir}: ${describeError(error)}`, {
        path: stateDir, reason: 'mkdir',
      })
    }
    const file = join(stateDir, DOCUMENT_FILE_NAME)
    let raw: string | undefined
    try {
      raw = await readFile(file, 'utf8')
    } catch (error: unknown) {
      if (!isMissingFile(error)) {
        throw new VillvHelixError('STATE_INVALID', `villv-helix cannot read ${file}: ${describeError(error)}`, {
          path: file, reason: 'unreadable',
        })
      }
    }
    if (raw === undefined) return new HelixStore(file, emptyDocument())
    let parsed: unknown
    try {
      parsed = JSON.parse(raw) as unknown
    } catch (error: unknown) {
      throw invalid(file, `not valid JSON: ${describeError(error)}`)
    }
    return new HelixStore(file, parseDocument(parsed, file))
  }

  /** ISO timestamp of the last committed write. */
  get updatedAt(): string {
    return this.document.updatedAt
  }

  /** Every session id the document knows. */
  sessionIds(): readonly string[] {
    return Object.keys(this.document.sessions)
  }

  /** One session's panel state; an unknown session reads as empty. */
  session(sessionId: string): SessionStateRecord {
    return this.document.sessions[sessionId] ?? EMPTY_SESSION
  }

  /** Whether 工具编辑模式 is active for one session. */
  orchestrated(sessionId: string): boolean {
    return this.session(sessionId).orchestrated
  }

  /**
   * Turn 工具编辑模式 on or off for one session.
   * @param sessionId - target session.
   * @param enabled - true installs the stored deny mask; false releases it.
   * @returns after the document is durable.
   */
  async setOrchestrated(sessionId: string, enabled: boolean): Promise<void> {
    const current = this.session(sessionId)
    await this.commit({
      ...this.document,
      sessions: {
        ...this.document.sessions,
        [sessionId]: { ...current, orchestrated: enabled },
      },
    })
  }

  /** Explicitly allowed global tool ids of one session. */
  enabledTools(sessionId: string): readonly string[] {
    return this.session(sessionId).enabledTools
  }

  /** Global tool ids one session disabled. */
  disabledTools(sessionId: string): readonly string[] {
    return this.session(sessionId).disabledTools
  }

  /**
   * Switch one global tool for one session.
   * @param sessionId - target session.
   * @param toolId - global tool id.
   * @param enabled - false disables it for this session.
   * @returns after the document is durable.
   */
  async setTool(sessionId: string, toolId: string, enabled: boolean): Promise<void> {
    const current = this.session(sessionId)
    const enabledTools = current.enabledTools.filter(id => id !== toolId)
    if (enabled) enabledTools.push(toolId)
    await this.commit({
      ...this.document,
      sessions: {
        ...this.document.sessions,
        [sessionId]: { ...current, enabledTools },
      },
    })
  }

  /** Saved tool selections, in creation order. */
  toolPresets(): readonly ToolPresetEntry[] {
    return this.document.toolPresets
  }

  /**
   * Save one named tool selection.
   * @param name - operator-provided display name.
   * @param tools - dynamic tool ids the preset switches on.
   * @returns the committed preset.
   * @throws VillvHelixError `STATE_INVALID` for an empty name or selection.
   */
  async createToolPreset(name: string, tools: readonly string[]): Promise<ToolPresetEntry> {
    const trimmed = name.trim()
    if (trimmed === '') throw new VillvHelixError('STATE_INVALID', 'a tool preset needs a name')
    if (tools.length === 0) throw new VillvHelixError('STATE_INVALID', 'a tool preset needs at least one tool')
    const entry: ToolPresetEntry = {
      id: randomUUID(),
      name: trimmed,
      tools: [...new Set(tools)],
      createdAt: Date.now(),
    }
    await this.commit({ ...this.document, toolPresets: [...this.document.toolPresets, entry] })
    return entry
  }

  /**
   * Delete one saved tool selection.
   * @param id - preset identity.
   * @returns after the document is durable.
   */
  async deleteToolPreset(id: string): Promise<void> {
    await this.commit({ ...this.document, toolPresets: this.document.toolPresets.filter(entry => entry.id !== id) })
  }

  /**
   * Serialize and persist one document generation.
   * @param next - the next document.
   * @returns after the rename settles.
   */
  private async commit(next: HelixDocument): Promise<void> {
    const document: HelixDocument = { ...next, updatedAt: new Date().toISOString() }
    const write = this.writing.then(async () => {
      const temporary = `${this.file}.${String(process.pid)}.${randomUUID()}.tmp`
      try {
        await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, 'utf8')
        await rename(temporary, this.file)
      } catch (error: unknown) {
        throw new VillvHelixError('STATE_WRITE_FAILED', `villv-helix cannot write ${this.file}: ${describeError(error)}`, {
          path: this.file, reason: 'write',
        })
      }
      this.document = document
    })
    this.writing = write.then(() => undefined, () => undefined)
    await write
  }
}

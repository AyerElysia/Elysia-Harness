/**
 * Reading and diffing the configured prompt files. The system-prompt section
 * and the change notice share one read, so the notice always describes the same
 * bytes the prompt will render.
 *
 * @module @elysia/preset-manager/prompt-source
 */

import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { PromptBundle, PromptChange, PromptFileSnapshot } from './types.ts'

/** Marker prefixed to the one line that names unreadable files. */
export const MISSING_FILES_MARKER = '[prompt-files]'

/** One pass over the configured files, before they are rendered. */
export interface PromptRead {
  /** Body of each file that was read, in configured order. */
  readonly bodies: readonly string[]
  /** Content identity of each file that was read, in configured order. */
  readonly snapshot: readonly PromptFileSnapshot[]
  /** Configured files that could not be read. */
  readonly missing: readonly string[]
}

/**
 * Read every configured file under one root.
 *
 * A file that cannot be read is reported in `missing` and its absent body is
 * named in the assembled text: silently dropping a configured prompt would hide
 * the operator's mistake from the model that is supposed to follow it.
 * @param root - absolute prompt root.
 * @param files - ordered root-relative paths with `/` separators.
 * @returns the bodies, content identities, and unreadable paths.
 */
export function readPromptFiles(root: string, files: readonly string[]): PromptRead {
  const bodies: string[] = []
  const snapshot: PromptFileSnapshot[] = []
  const missing: string[] = []
  for (const path of files) {
    let content: Buffer
    try {
      const info = statSync(join(root, path))
      if (!info.isFile()) {
        missing.push(path)
        continue
      }
      content = readFileSync(join(root, path))
    } catch {
      // A prompt file is mutable input: deleting one must not break assembly,
      // and the notice pass reports the removal on its own.
      missing.push(path)
      continue
    }
    snapshot.push({
      path,
      bytes: content.byteLength,
      hash: createHash('sha256').update(content).digest('hex'),
    })
    const body = content.toString('utf8').trim()
    if (body !== '') bodies.push(body)
  }
  return { bodies, snapshot, missing }
}

/**
 * Read the configured files and assemble the system-prompt text.
 * @param root - absolute prompt root.
 * @param files - ordered root-relative paths with `/` separators.
 * @param identity - optional text rendered before the file bodies.
 * @returns the assembled text plus each file's content identity.
 */
export function readPromptBundle(
  root: string,
  files: readonly string[],
  identity?: string,
): PromptBundle {
  const read = readPromptFiles(root, files)
  const parts: string[] = []
  if (identity !== undefined && identity.trim() !== '') parts.push(identity.trim())
  parts.push(...read.bodies)
  if (read.missing.length > 0) {
    parts.push(`${MISSING_FILES_MARKER} Configured prompt files are missing: ${read.missing.join(', ')}`)
  }
  return { text: parts.join('\n\n'), snapshot: read.snapshot, missing: read.missing }
}

/**
 * Read only the content identities of the configured files.
 * @param root - absolute prompt root.
 * @param files - ordered root-relative paths with `/` separators.
 * @returns each file's content identity, in configured order.
 */
export function readPromptSnapshot(root: string, files: readonly string[]): readonly PromptFileSnapshot[] {
  return readPromptFiles(root, files).snapshot
}

/**
 * Compare two reads of the same configured file list.
 * @param previous - content identities the session was last told about.
 * @param current - content identities just read.
 * @returns changes in configured order, with removals last; empty when nothing moved.
 */
export function diffPromptSnapshots(
  previous: readonly PromptFileSnapshot[],
  current: readonly PromptFileSnapshot[],
): PromptChange[] {
  const before = new Map(previous.map(file => [file.path, file.hash]))
  const after = new Map(current.map(file => [file.path, file.hash]))
  const changes: PromptChange[] = []
  for (const file of current) {
    const hash = before.get(file.path)
    if (hash === undefined) changes.push({ action: 'add', path: file.path })
    else if (hash !== file.hash) changes.push({ action: 'modify', path: file.path })
  }
  for (const file of previous) {
    if (!after.has(file.path)) changes.push({ action: 'remove', path: file.path })
  }
  return changes
}

/** Verb used for each action in the model-facing notice. */
const ACTION_VERBS = {
  load: 'loaded',
  add: 'added',
  modify: 'modified',
  remove: 'removed',
} as const

/**
 * Render the one-line change account carried by the notice.
 * @param changes - changes detected since the previous read.
 * @returns a compact clause such as `modified MEMORY.md, added NOTES.md`.
 */
export function describePromptChanges(changes: readonly PromptChange[]): string {
  return changes.map(change => `${ACTION_VERBS[change.action]} ${change.path}`).join(', ')
}

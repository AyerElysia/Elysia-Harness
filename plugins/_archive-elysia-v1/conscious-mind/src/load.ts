import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** A standing-prompt file cannot be read, or a required file is missing or empty. */
export class StandingPromptError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StandingPromptError'
  }
}

/** Reject a file name that would leave the standing-prompt directory. */
export function assertStandingFileName(name: string): void {
  if (name.length === 0 || name === '.' || name === '..' || name.includes('/') || name.includes('\\') || name.includes('\0')) {
    throw new StandingPromptError(`standing prompt file name must stay inside the directory: ${JSON.stringify(name)}`)
  }
}

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

/**
 * Read the configured files in order and join them with a blank line.
 * A missing or empty required file aborts. Any other missing or empty file is skipped.
 */
export function loadStandingPrompt(
  baseDir: string,
  files: readonly string[],
  required: readonly string[],
): string {
  const requiredNames = new Set(required)
  const parts: string[] = []
  for (const name of files) {
    assertStandingFileName(name)
    let text: string
    try {
      text = readFileSync(join(baseDir, name), 'utf8')
    } catch (error) {
      if (isMissingFile(error)) {
        if (requiredNames.has(name)) throw new StandingPromptError(`required standing prompt missing: ${name}`)
        continue
      }
      throw error
    }
    const trimmed = text.trim()
    if (trimmed.length === 0) {
      if (requiredNames.has(name)) throw new StandingPromptError(`required standing prompt empty: ${name}`)
      continue
    }
    parts.push(trimmed)
  }
  return parts.join('\n\n')
}

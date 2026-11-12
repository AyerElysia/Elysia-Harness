/**
 * Agent-scoped path admission and standing-prompt backup guards for DSH's
 * existing filesystem tools. No tool schema or vendored DSH code is replaced.
 * @module @elysia/conscious-mind/file-capabilities
 */

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import * as ToolFs from '@deepseek-ai/dsh-tool-fs'
import * as ToolFsSearch from '@deepseek-ai/dsh-tool-fs-search'
import z from '@deepseek-ai/schemastery'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-working-directory'
import { assertStandingFileName } from './load.ts'

const FILE_TOOLS = new Set(['read', 'read_image', 'write', 'edit', 'glob', 'grep'])
const SEARCH_TOOLS = new Set(['glob', 'grep'])
const MUTATION_TOOLS = new Set(['write', 'edit'])
const MISSING = new Set(['ENOENT', 'ENOTDIR'])

export interface Config {
  /** Directory containing the selected standing-prompt files. */
  baseDir: string
  /** Ordered standing-prompt allow-list; other files in baseDir stay closed. */
  files: string[]
  /** Prompt files that must remain non-empty. Defaults to SOUL.md. */
  required?: string[]
  /** The only recursively readable and writable workspace. */
  workspaceDir: string
  /** Maintenance-only prompt backup directory, never model-readable. */
  backupDir: string
  /** Maximum UTF-8 bytes in one prompt after mutation. */
  maxPromptBytes?: number
  /** Maximum retained backups per prompt after a successful mutation. */
  backupRetention?: number
}

export const Config: z<Config> = z.object({
  baseDir: z.string().required(),
  files: z.array(z.string()).required(),
  required: z.array(z.string()).default(['SOUL.md']),
  workspaceDir: z.string().required(),
  backupDir: z.string().required(),
  maxPromptBytes: z.number().default(65536),
  backupRetention: z.number().default(20),
})

interface Roots {
  workspace: string
  migration: string
  prompts: Map<string, string>
  promptNames: Map<string, string>
  required: ReadonlySet<string>
  backup: string
  maxPromptBytes: number
  backupRetention: number
}

interface Args {
  file_path?: unknown
  path?: unknown
  content?: unknown
  old_string?: unknown
  new_string?: unknown
  replace_all?: unknown
}

function missing(error: unknown): boolean {
  return MISSING.has((error as NodeJS.ErrnoException).code ?? '')
}

function under(root: string, target: string): boolean {
  const tail = relative(root, target)
  return tail === '' || (tail !== '..' && !tail.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(tail))
}

/** Canonicalize the deepest existing ancestor and preserve a missing suffix. */
async function canonical(path: string): Promise<string> {
  const lexical = resolve(path)
  let ancestor = lexical
  while (true) {
    try {
      await stat(ancestor)
      break
    } catch (error) {
      if (!missing(error)) throw error
      const parent = dirname(ancestor)
      if (parent === ancestor) throw error
      ancestor = parent
    }
  }
  const resolved = join(await realpath(ancestor), relative(ancestor, lexical))
  try {
    return await realpath(resolved)
  } catch (error) {
    if (missing(error)) return resolved
    throw error
  }
}

async function rootsOf(config: Config): Promise<Roots> {
  if (config.files.length === 0) throw new Error('file capability prompt files must not be empty')
  if (new Set(config.files).size !== config.files.length) throw new Error('file capability prompt files must be unique')
  for (const file of config.files) assertStandingFileName(file)
  const required = new Set(config.required ?? ['SOUL.md'])
  for (const file of required) {
    assertStandingFileName(file)
    if (!config.files.includes(file)) throw new Error(`required prompt is not listed: ${file}`)
  }
  if (config.maxPromptBytes !== undefined && (!Number.isInteger(config.maxPromptBytes) || config.maxPromptBytes < 1)) {
    throw new Error('maxPromptBytes must be a positive integer')
  }
  if (config.backupRetention !== undefined && (!Number.isInteger(config.backupRetention) || config.backupRetention < 1)) {
    throw new Error('backupRetention must be a positive integer')
  }
  const workspace = await realpath(config.workspaceDir)
  const promptBase = await realpath(config.baseDir)
  await mkdir(config.backupDir, { recursive: true, mode: 0o700 })
  const backup = await realpath(config.backupDir)
  if (under(workspace, backup) || backup === promptBase || config.files.some(file => backup === join(promptBase, file))) {
    throw new Error('prompt backups must be outside every model-accessible path')
  }
  const prompts = new Map<string, string>()
  const promptNames = new Map<string, string>()
  for (const file of config.files) {
    const path = join(promptBase, file)
    prompts.set(file, path)
    promptNames.set(path, file)
  }
  return {
    workspace,
    migration: join(workspace, '.migration'),
    prompts,
    promptNames,
    required,
    backup,
    maxPromptBytes: config.maxPromptBytes ?? 65536,
    backupRetention: config.backupRetention ?? 20,
  }
}

function denial(exec: ToolExecution, reason: string, code = 'ELYSIA_PATH_DENIED') {
  return { kind: 'deny' as const, reason, info: { name: exec.name, code } }
}

function promptName(roots: Roots, target: string): string | undefined {
  return roots.promptNames.get(target)
}

function admitted(roots: Roots, tool: string, target: string): boolean {
  if (tool === 'read_image') return under(roots.workspace, target) && !under(roots.migration, target)
  if (under(roots.workspace, target) && !under(roots.migration, target)) return true
  return promptName(roots, target) !== undefined
}

async function rejectHardLink(target: string): Promise<boolean> {
  try {
    const info = await stat(target)
    return info.isFile() && info.nlink > 1
  } catch (error) {
    if (missing(error)) return false
    throw error
  }
}

function replacement(args: Args): string | undefined {
  if (typeof args.old_string !== 'string' || typeof args.new_string !== 'string') return undefined
  if (args.old_string.length === 0 || args.old_string === args.new_string) return undefined
  return args.new_string
}

async function prospectivePrompt(target: string, tool: string, args: Args): Promise<string | undefined> {
  if (tool === 'write') return typeof args.content === 'string' ? args.content : undefined
  const next = replacement(args)
  if (next === undefined) return undefined
  const before = await readFile(target, 'utf8')
  // Match DSH fs-local's literal, LF-normalized edit and its on-disk line endings.
  // String.replace(old, next) would interpret dollar sequences in model text.
  const normalized = before.replaceAll('\r\n', '\n')
  const old = (args.old_string as string).replaceAll('\r\n', '\n')
  const count = normalized.split(old).length - 1
  if (old.length === 0 || count === 0 || (args.replace_all !== true && count !== 1)) return undefined
  const after = normalized.split(old).join(next.replaceAll('\r\n', '\n'))
  const sample = before.slice(0, 4096)
  const crlfCount = sample.split('\r\n').length - 1
  const lfCount = sample.split('\n').length - 1 - crlfCount
  return crlfCount > lfCount ? after.split('\n').join('\r\n') : after
}

async function backupPrompt(roots: Roots, target: string, name: string): Promise<void> {
  let content: Buffer
  try {
    content = await readFile(target)
  } catch (error) {
    if (missing(error)) return
    throw error
  }
  const stamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')
  const path = join(roots.backup, `${stamp}-${randomUUID()}-${name}.bak`)
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, content, { flag: 'wx', mode: 0o600 })
    await rename(temporary, path)
  } finally {
    await unlink(temporary).catch(() => {})
  }
}

async function pruneBackups(roots: Roots, name: string): Promise<void> {
  const entries = await readdir(roots.backup, { withFileTypes: true })
  const backups = entries.filter(entry => entry.isFile() && entry.name.endsWith(`-${name}.bak`))
  if (backups.length <= roots.backupRetention) return
  const withTime = await Promise.all(backups.map(async entry => {
    const path = join(roots.backup, entry.name)
    return { path, mtime: (await stat(path)).mtimeMs }
  }))
  withTime.sort((left, right) => right.mtime - left.mtime)
  await Promise.all(withTime.slice(roots.backupRetention).map(entry => unlink(entry.path)))
}

function visiblePaths(value: unknown, key?: string): string[] {
  if (typeof value === 'string') return ['path', 'paths', 'items', 'root'].includes(key ?? '') ? [value] : []
  if (Array.isArray(value)) return value.flatMap(item => visiblePaths(item, key))
  if (typeof value !== 'object' || value === null) return []
  return Object.entries(value).flatMap(([childKey, child]) => visiblePaths(child, childKey))
}

/**
 * Mount the shared guard chain in one Elysia agent scope. DSH still owns every
 * schema, observation check, atomic mutation, image decode and search process.
 */
export async function mountFileCapabilities(ctx: Context, config: Config): Promise<() => void> {
  const roots = await rootsOf(config)
  const scope = scopeOf(ctx)
  // Preset plugins mount once under a registry-owned scope before any concrete
  // Agent exists. Only a real Agent scope can accept a working-directory set;
  // executions below still resolve and authorize against their real exec.agent.
  const agent = scope !== undefined && 'session' in scope ? scope as Agent : undefined
  if (agent !== undefined && ctx.workingDirectory !== undefined) {
    await ctx.workingDirectory.set(agent, roots.workspace)
  }

  const resolveTarget = async (exec: ToolExecution, args: Args): Promise<{ target: string; cwd: string }> => {
    const cwd = exec.agent === undefined || ctx.workingDirectory === undefined
      ? roots.workspace
      : await ctx.workingDirectory.ensure(exec.agent, exec.signal)
    const supplied = SEARCH_TOOLS.has(exec.name) ? args.path : args.file_path
    const raw = supplied === undefined && SEARCH_TOOLS.has(exec.name) ? cwd : supplied
    if (typeof raw !== 'string' || raw.trim().length === 0) return { target: '', cwd }
    return { target: await canonical(resolve(cwd, raw)), cwd }
  }

  const removePre = ctx.on('tools/pre-execute', async (exec, next) => {
    if (!FILE_TOOLS.has(exec.name)) return next()
    exec.signal.throwIfAborted()
    const args = exec.arguments as Args
    const { target } = await resolveTarget(exec, args)
    if (target.length === 0) return next()
    if (!admitted(roots, exec.name, target) || await rejectHardLink(target)) {
      return denial(exec, `爱莉的文件权限不允许访问该路径：${exec.name}`)
    }
    const name = promptName(roots, target)
    if (name === undefined || !MUTATION_TOOLS.has(exec.name)) return next()

    const after = await prospectivePrompt(target, exec.name, args)
    if (after === undefined) return next()
    if (roots.required.has(name) && after.trim().length === 0) {
      return denial(exec, `${name} 是必需固定提示词，不能修改为空`, 'ELYSIA_PROMPT_INVALID')
    }
    if (Buffer.byteLength(after, 'utf8') > roots.maxPromptBytes) {
      return denial(exec, `${name} 超过 ${roots.maxPromptBytes} 字节上限，原文件未修改`, 'ELYSIA_PROMPT_INVALID')
    }
    try {
      await backupPrompt(roots, target, name)
    } catch (error) {
      return denial(exec, `${name} 修改前备份失败，原文件未修改：${error instanceof Error ? error.message : String(error)}`, 'ELYSIA_PROMPT_BACKUP_FAILED')
    }
    return next()
  })

  const removePost = ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next()
    if (SEARCH_TOOLS.has(exec.name) && !result.isError) {
      const { cwd } = await resolveTarget(exec, exec.arguments as Args)
      // Meta is a capped presentation. The canonical value retains every search
      // result, including paths omitted from the card or moved into a spill.
      const paths = new Set([...visiblePaths(result.value), ...visiblePaths(result.meta)])
      for (const path of paths) {
        const target = await canonical(resolve(cwd, path))
        if (!admitted(roots, exec.name, target) || await rejectHardLink(target)) {
          return { kind: 'block', feedback: [{ type: 'text', text: '搜索结果包含越出爱莉权限范围的路径，已阻止返回。' }] }
        }
      }
    }
    const name = MUTATION_TOOLS.has(exec.name) && !result.isError
      ? promptName(roots, (await resolveTarget(exec, exec.arguments as Args)).target)
      : undefined
    if (name !== undefined) {
      await pruneBackups(roots, name).catch((error: unknown) => {
        process.stderr.write(`提示词备份清理失败（目标修改已成功）：${String(error)}\n`)
      })
    }
    return decision
  })
  return () => {
    removePost()
    removePre()
  }
}

/** Standalone agent-preset plugin form, sharing the exact main-agent guard chain. */
export const name = 'elysia-file-capabilities'
export const inject = ['tools', 'workingDirectory', 'fs', 'systemPrompt', 'subprocess']
export async function apply(ctx: Context, config: Config): Promise<void> {
  if (scopeOf(ctx) === undefined) throw new Error('elysia file capabilities must be mounted in an agent scope')
  const removeGuards = await mountFileCapabilities(ctx, config)
  let files: { dispose(): Promise<unknown> } | undefined
  try {
    files = await ctx.plugin(ToolFs, { read: true, readImage: true, write: true, edit: true })
    await ctx.plugin(ToolFsSearch, { sampleOverCapGlobResults: false })
  } catch (error) {
    const cleanup = await Promise.allSettled([
      Promise.resolve().then(removeGuards),
      Promise.resolve().then(() => files?.dispose()),
    ])
    const failures = cleanup.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    if (failures.length > 0) {
      throw new AggregateError([error, ...failures.map(result => result.reason)], 'file capability composition and cleanup failed')
    }
    throw error
  }
}

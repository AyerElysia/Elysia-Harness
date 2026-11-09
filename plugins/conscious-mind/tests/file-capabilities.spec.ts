import { link, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { PostToolDecision, PreToolDecision, ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { beforeEach, expect, it, onTestFinished } from 'vitest'
import { mountFileCapabilities } from '../src/file-capabilities.ts'

type Pre = (exec: ToolExecution, next: () => Promise<PreToolDecision>) => Promise<PreToolDecision>
type Post = (exec: ToolExecution, result: ToolExecutionResult, next: () => Promise<PostToolDecision>) => Promise<PostToolDecision>

let home: string
let workspace: string
let prompts: string
let backups: string
let outside: string
let pre: Pre
let post: Post

const files = ['SOUL.md', 'USER.md', 'MEMORY.md', 'EXISTENCE.md', 'TOOLS.md']
const allow: PreToolDecision = { kind: 'allow' }

function execution(name: string, args: unknown): ToolExecution {
  return {
    name,
    arguments: args,
    signal: new AbortController().signal,
  } as unknown as ToolExecution
}

async function callPre(name: string, args: unknown): Promise<PreToolDecision> {
  return pre(execution(name, args), () => Promise.resolve(allow))
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'elysia-file-guards-'))
  onTestFinished(async () => rm(home, { recursive: true, force: true }))
  workspace = join(home, 'workspace')
  prompts = join(home, 'standing-prompts')
  backups = join(home, 'backups')
  outside = join(home, 'outside')
  await mkdir(workspace)
  await mkdir(prompts)
  await mkdir(outside)
  await mkdir(join(workspace, '.migration'))
  await mkdir(join(home, 'feishu-sdk'))
  await writeFile(join(workspace, 'note.md'), 'note')
  await writeFile(join(workspace, '.migration', 'private.md'), 'migration')
  await writeFile(join(home, 'feishu-sdk', 'private.md'), 'private')
  await writeFile(join(outside, 'secret.md'), 'secret')
  for (const file of files) await writeFile(join(prompts, file), `${file} before`)
  await writeFile(join(prompts, 'OTHER.md'), 'not selected')

  const listeners = new Map<string, unknown>()
  const ctx = {
    on(event: string, listener: unknown) { listeners.set(event, listener) },
  } as unknown as Context
  await mountFileCapabilities(ctx, {
    baseDir: prompts,
    files,
    required: ['SOUL.md'],
    workspaceDir: workspace,
    backupDir: backups,
    maxPromptBytes: 256,
    backupRetention: 2,
  })
  pre = listeners.get('tools/pre-execute') as Pre
  post = listeners.get('tools/post-execute') as Post
})

it('admits workspace files and selected prompts but nothing else', async () => {
  await expect(callPre('read', { file_path: join(workspace, 'note.md') })).resolves.toEqual(allow)
  await expect(callPre('write', { file_path: join(workspace, 'new.md'), content: '' })).resolves.toEqual(allow)
  await expect(callPre('read', { file_path: join(prompts, 'SOUL.md') })).resolves.toEqual(allow)
  await expect(callPre('read', { file_path: join(prompts, 'OTHER.md') })).resolves.toMatchObject({ kind: 'deny' })
  await expect(callPre('read', { file_path: join(home, 'feishu-sdk', 'private.md') })).resolves.toMatchObject({ kind: 'deny' })
  await expect(callPre('read', { file_path: join(workspace, '.migration', 'private.md') })).resolves.toMatchObject({ kind: 'deny' })
  await expect(callPre('read', { file_path: join(outside, 'secret.md') })).resolves.toMatchObject({ kind: 'deny' })
  await expect(callPre('read', { file_path: join(backups, 'old.bak') })).resolves.toMatchObject({ kind: 'deny' })
})

it('uses workspace for omitted searches and checks explicit roots', async () => {
  await expect(callPre('glob', { pattern: '**/*.md' })).resolves.toEqual(allow)
  await expect(callPre('grep', { pattern: 'note', path: workspace })).resolves.toEqual(allow)
  await expect(callPre('glob', { pattern: '**/*', path: home })).resolves.toMatchObject({ kind: 'deny' })
  await expect(callPre('read_image', { file_path: join(prompts, 'SOUL.md') })).resolves.toMatchObject({ kind: 'deny' })
  await expect(callPre('read_image', { file_path: join(workspace, 'image.png') })).resolves.toEqual(allow)
})

it('rejects symlink and hard-link escapes', async () => {
  await symlink(outside, join(workspace, 'escape'), 'dir')
  await expect(callPre('read', { file_path: join(workspace, 'escape', 'secret.md') })).resolves.toMatchObject({ kind: 'deny' })
  await link(join(outside, 'secret.md'), join(workspace, 'hard-link.md'))
  await expect(callPre('read', { file_path: join(workspace, 'hard-link.md') })).resolves.toMatchObject({ kind: 'deny' })
})

it('backs up a prompt before a valid write', async () => {
  await expect(callPre('write', { file_path: join(prompts, 'TOOLS.md'), content: 'TOOLS.md after' })).resolves.toEqual(allow)
  const names = await readdir(backups)
  expect(names).toHaveLength(1)
  expect(names[0]).toMatch(/-TOOLS\.md\.bak$/)
  expect(await readFile(join(backups, names[0]!), 'utf8')).toBe('TOOLS.md before')
  expect(await readFile(join(prompts, 'TOOLS.md'), 'utf8')).toBe('TOOLS.md before')
})

it('backs up before a valid edit and preserves DSH match validation', async () => {
  await expect(callPre('edit', {
    file_path: join(prompts, 'USER.md'),
    old_string: 'before',
    new_string: 'after',
  })).resolves.toEqual(allow)
  expect((await readdir(backups)).some(name => name.endsWith('-USER.md.bak'))).toBe(true)
  await expect(callPre('edit', {
    file_path: join(prompts, 'USER.md'),
    old_string: 'missing',
    new_string: 'after',
  })).resolves.toEqual(allow)
  expect((await readdir(backups)).filter(name => name.endsWith('-USER.md.bak'))).toHaveLength(1)
})

it('refuses an empty required prompt and oversized output without changing it', async () => {
  await expect(callPre('write', { file_path: join(prompts, 'SOUL.md'), content: '  \n' }))
    .resolves.toMatchObject({ kind: 'deny', info: { code: 'ELYSIA_PROMPT_INVALID' } })
  await expect(callPre('write', { file_path: join(prompts, 'TOOLS.md'), content: 'x'.repeat(257) }))
    .resolves.toMatchObject({ kind: 'deny', info: { code: 'ELYSIA_PROMPT_INVALID' } })
  expect(await readFile(join(prompts, 'SOUL.md'), 'utf8')).toBe('SOUL.md before')
  expect(await readFile(join(prompts, 'TOOLS.md'), 'utf8')).toBe('TOOLS.md before')
  expect(await readdir(backups)).toHaveLength(0)
})

it('fails closed when the pre-mutation backup cannot be written', async () => {
  const moved = join(home, 'backups-moved')
  await rename(backups, moved)
  await writeFile(backups, 'not a directory')
  await expect(callPre('write', { file_path: join(prompts, 'TOOLS.md'), content: 'after' }))
    .resolves.toMatchObject({ kind: 'deny', info: { code: 'ELYSIA_PROMPT_BACKUP_FAILED' } })
  expect(await readFile(join(prompts, 'TOOLS.md'), 'utf8')).toBe('TOOLS.md before')
})

it('blocks a visible search result that escapes the admitted root', async () => {
  const exec = execution('glob', { pattern: '**/*' })
  const result = {
    isError: false,
    content: [],
    meta: { shape: 'paths', items: [join(outside, 'secret.md')] },
  } as ToolExecutionResult
  await expect(post(exec, result, () => Promise.resolve({ kind: 'accept' })))
    .resolves.toMatchObject({ kind: 'block' })
})


it('checks complete search values even when presentation metadata omits a forbidden result', async () => {
  const result = {
    isError: false,
    content: [],
    value: { root: '.', paths: [join(workspace, 'note.md'), join(outside, 'secret.md')] },
    meta: { shape: 'paths', paths: [join(workspace, 'note.md')], truncated: true, total: 2 },
  } as ToolExecutionResult
  await expect(post(execution('glob', { pattern: '**/*' }), result, () => Promise.resolve({ kind: 'accept' })))
    .resolves.toMatchObject({ kind: 'block' })
})

it('blocks grep results from a hard link even though its pathname is in the workspace', async () => {
  const path = join(workspace, 'hard-link.md')
  await link(join(outside, 'secret.md'), path)
  const result = {
    isError: false,
    content: [],
    value: { matches: [{ path, lineNumber: 1, line: 'secret' }] },
    meta: { shape: 'matches', files: [{ path, matches: [{ lineNumber: 1, line: 'secret' }] }], truncated: false, total: 1 },
  } as ToolExecutionResult
  await expect(post(execution('grep', { pattern: 'secret' }), result, () => Promise.resolve({ kind: 'accept' })))
    .resolves.toMatchObject({ kind: 'block' })
})

it('treats dollar sequences as literal edits when validating prompt contents and byte limits', async () => {
  await expect(callPre('edit', {
    file_path: join(prompts, 'SOUL.md'), old_string: 'SOUL.md before', new_string: '$`',
  })).resolves.toEqual(allow)
  await expect(callPre('edit', {
    file_path: join(prompts, 'TOOLS.md'), old_string: 'TOOLS.md before', new_string: '$$'.repeat(130),
  })).resolves.toMatchObject({ kind: 'deny', info: { code: 'ELYSIA_PROMPT_INVALID' } })
})

it('validates LF edit arguments against the CRLF bytes DSH will preserve on disk', async () => {
  await writeFile(join(prompts, 'TOOLS.md'), 'before\r\n')
  await expect(callPre('edit', {
    file_path: join(prompts, 'TOOLS.md'), old_string: 'before\n', new_string: 'x\n'.repeat(100),
  })).resolves.toMatchObject({ kind: 'deny', info: { code: 'ELYSIA_PROMPT_INVALID' } })
})


it('checks the actual working directory when a search omits its path', async () => {
  const listeners = new Map<string, unknown>()
  const ctx = {
    on(event: string, listener: unknown) { listeners.set(event, listener) },
    workingDirectory: { ensure: async () => outside },
  } as unknown as Context
  await mountFileCapabilities(ctx, { baseDir: prompts, files, workspaceDir: workspace, backupDir: backups })
  const scopedPre = listeners.get('tools/pre-execute') as Pre
  const exec = { ...execution('grep', { pattern: 'secret' }), agent: {} } as ToolExecution
  await expect(scopedPre(exec, () => Promise.resolve(allow))).resolves.toMatchObject({ kind: 'deny' })
})

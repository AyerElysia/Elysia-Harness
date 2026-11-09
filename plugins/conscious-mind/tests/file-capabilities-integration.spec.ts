import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'
import { provideWorkingDirectoryFixture } from '@deepseek-ai/dsh-agent-loop-testkit'
import * as FsObservationPolicy from '@deepseek-ai/dsh-fs-observation-policy'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import { SandboxedFileSystem } from '@deepseek-ai/dsh-fs-sandbox'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import { createScope } from '@deepseek-ai/dsh-scope'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as ToolFs from '@deepseek-ai/dsh-tool-fs'
import * as ToolFsSearch from '@deepseek-ai/dsh-tool-fs-search'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import { expect, it, onTestFinished, vi } from 'vitest'
import { mountFileCapabilities } from '../src/file-capabilities.ts'
import * as FileCapabilities from '../src/file-capabilities.ts'

it('runs DSH mutations with observation, staleness, path and prompt-backup guards', async () => {
  const home = await mkdtemp(join(tmpdir(), 'elysia-file-integration-'))
  const workspace = join(home, 'workspace')
  const prompts = join(home, 'standing-prompts')
  const backups = join(home, 'backups')
  await mkdir(workspace)
  await mkdir(prompts)
  await writeFile(join(workspace, 'unread.md'), 'keep')
  await writeFile(join(prompts, 'SOUL.md'), 'soul')
  await writeFile(join(prompts, 'TOOLS.md'), 'tools before')

  const ctx = new Context()
  onTestFinished(async () => {
    await ctx.fiber.dispose()
    await rm(home, { recursive: true, force: true })
  })
  provideWorkingDirectoryFixture(ctx)
  ctx.workingDirectory.set = vi.fn().mockResolvedValue(workspace)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime, { mode: 'native' })
  await ctx.plugin(LocalFileSystem, { cwd: workspace })
  await ctx.plugin(FsObservationPolicy)
  await ctx.plugin(ToolFs, { read: true, readImage: false, write: true, edit: true })

  const key = { session: { id: 'elysia-file-test', header: { cwd: workspace } } } as unknown as Agent
  const scope = createScope(ctx, key)
  Object.assign(key, { ctx: scope.ctx })
  await mountFileCapabilities(scope.ctx, {
    baseDir: prompts,
    files: ['SOUL.md', 'TOOLS.md'],
    required: ['SOUL.md'],
    workspaceDir: workspace,
    backupDir: backups,
  })
  let sequence = 0
  const execute = (name: string, args: unknown) => ctx.tools.execute({
    callId: `call-${++sequence}` as ToolCallId,
    name,
    arguments: args,
    agent: key,
    signal: new AbortController().signal,
  })

  const note = join(workspace, 'note.md')
  const created = await execute('write', { file_path: note, content: 'first' })
  expect(created).toMatchObject({ isError: false })
  expect((await execute('read', { file_path: note })).isError).toBe(false)
  expect((await execute('edit', { file_path: note, old_string: 'first', new_string: 'second' })).isError).toBe(false)
  expect(await readFile(note, 'utf8')).toBe('second')

  expect((await execute('write', { file_path: join(workspace, 'unread.md'), content: 'overwrite' })).isError).toBe(true)
  expect(await readFile(join(workspace, 'unread.md'), 'utf8')).toBe('keep')

  expect((await execute('read', { file_path: note })).isError).toBe(false)
  await writeFile(note, 'external')
  expect((await execute('edit', { file_path: note, old_string: 'external', new_string: 'stale' })).isError).toBe(true)
  expect(await readFile(note, 'utf8')).toBe('external')

  expect((await execute('read', { file_path: join(home, 'credentials.yaml') })).isError).toBe(true)
  expect((await execute('write', { file_path: join(prompts, 'SOUL.md'), content: ' \n' })).isError).toBe(true)
  expect(await readFile(join(prompts, 'SOUL.md'), 'utf8')).toBe('soul')

  expect((await execute('read', { file_path: join(prompts, 'TOOLS.md') })).isError).toBe(false)
  expect((await execute('edit', { file_path: join(prompts, 'TOOLS.md'), old_string: 'before', new_string: 'after' })).isError).toBe(false)
  expect(await readFile(join(prompts, 'TOOLS.md'), 'utf8')).toBe('tools after')
  const saved = await readdir(backups)
  expect(saved.filter(name => name.endsWith('-TOOLS.md.bak'))).toHaveLength(1)
  expect(await readFile(join(backups, saved[0]!), 'utf8')).toBe('tools before')
})


it('isolates Elysia guards from another session and keeps native read-only policy after unload', async () => {
  const home = await mkdtemp(join(tmpdir(), 'elysia-file-scope-'))
  const ctx = new Context()
  onTestFinished(async () => {
    await ctx.fiber.dispose()
    await rm(home, { recursive: true, force: true })
  })
  const workspace = join(home, 'workspace')
  const prompts = join(home, 'standing-prompts')
  ctx.provide('subprocess', {} as Context['subprocess'])
  const outside = join(home, 'standard-note.md')
  await mkdir(workspace)
  await mkdir(prompts)
  await writeFile(outside, 'standard fixture')
  provideWorkingDirectoryFixture(ctx)
  ctx.workingDirectory.set = vi.fn().mockResolvedValue(workspace)
  // Keep the production filesystem and tools; only the session-policy lookup
  // is supplied locally instead of mounting a persistent session store.
  ctx.provide('sandboxPolicy', {
    defaultMode: 'read-only',
    resolve: () => ({ mode: 'read-only', workspaceRoot: home }),
  } as unknown as Context['sandboxPolicy'])
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime, { mode: 'native' })
  await ctx.plugin(SandboxedFileSystem, { cwd: home })
  await ctx.plugin(LocalAttachmentStore, { dshHome: home })
  await ctx.plugin(ToolFs, { read: false, readImage: true, write: false, edit: false })
  const makeAgent = (id: string) => {
    const key = { session: { id, header: { cwd: home } } } as unknown as Agent
    const scope = createScope(ctx, key)
    Object.assign(key, { ctx: scope.ctx })
    return { key, scope }
  }
  const minimal = makeAgent('minimal-fixture')
  const minimalBefore = ctx.tools.schemas(minimal.key).map(tool => tool.name).sort()
  expect(minimalBefore).toEqual(['read_image'])
  const standard = makeAgent('standard-fixture')
  // This is the standard preset's native tool row; its scope owns the same
  // definitions before and after another agent mounts Elysia's guard plugin.
  await standard.scope.ctx.plugin(ToolFs, { read: true, readImage: false, write: true, edit: true })
  const before = ctx.tools.schemas(standard.key).map(tool => tool.name).sort()
  let sequence = 0
  const execute = (agent: Agent, name: string, args: unknown) => ctx.tools.execute({
    callId: `scope-${++sequence}` as ToolCallId, name, arguments: args, agent,
    signal: new AbortController().signal,
  })
  expect((await execute(standard.key, 'read', { file_path: outside })).isError).toBe(false)
  expect((await execute(standard.key, 'write', { file_path: outside, content: 'denied' })).error)
    .toMatchObject({ info: { code: 'FS_SANDBOX_DENIED' } })

  const elysia = makeAgent('elysia-fixture')
  const guard = await elysia.scope.ctx.plugin(FileCapabilities, {
    baseDir: prompts, files: ['SOUL.md'], workspaceDir: workspace, backupDir: join(home, 'backups'),
  })
  expect(ctx.tools.schemas(standard.key).map(tool => tool.name).sort()).toEqual(before)
  expect(ctx.tools.schemas(minimal.key).map(tool => tool.name).sort()).toEqual(minimalBefore)
  expect((await execute(standard.key, 'read', { file_path: outside })).isError).toBe(false)
  expect((await execute(elysia.key, 'read', { file_path: outside })).isError).toBe(true)
  await guard.dispose()
  expect(ctx.tools.get('read', elysia.key)).toBeUndefined()
  expect(ctx.tools.get('glob', elysia.key)).toBeUndefined()
  expect(ctx.tools.schemas(minimal.key).map(tool => tool.name).sort()).toEqual(minimalBefore)
  expect((await execute(standard.key, 'read', { file_path: outside })).isError).toBe(false)
  expect((await execute(standard.key, 'write', { file_path: outside, content: 'still denied' })).error)
    .toMatchObject({ info: { code: 'FS_SANDBOX_DENIED' } })
  expect(await readFile(outside, 'utf8')).toBe('standard fixture')

  const mount = elysia.scope.ctx.plugin.bind(elysia.scope.ctx)
  const pluginSpy = vi.spyOn(elysia.scope.ctx, 'plugin').mockImplementation(async (plugin, config) => {
    if (plugin === ToolFsSearch) throw new Error('fixture search registration failed')
    return mount(plugin, config)
  })
  try {
    await expect(FileCapabilities.apply(elysia.scope.ctx, {
      baseDir: prompts, files: ['SOUL.md'], workspaceDir: workspace, backupDir: join(home, 'backups'),
    })).rejects.toThrow('fixture search registration failed')
  } finally {
    pluginSpy.mockRestore()
  }
  expect(ctx.tools.get('read', elysia.key)).toBeUndefined()
  // A safe fallback tool detects a leaked pre-execute guard without reading
  // any path. The failed mount must have removed both its tools and listeners.
  const removeFallback = ctx.tools.register(defineTool({
    name: 'read', description: 'fixture-only fallback',
    parameters: { file_path: { type: 'string', required: true } },
    output: { schema: { type: 'string' }, render: (_args, text) => [{ type: 'text', text }] },
    execute: async () => 'fixture-only result',
  }))
  try {
    expect((await execute(elysia.key, 'read', { file_path: outside })).isError).toBe(false)
  } finally {
    removeFallback()
  }
  expect(ctx.tools.schemas(minimal.key).map(tool => tool.name).sort()).toEqual(minimalBefore)
})

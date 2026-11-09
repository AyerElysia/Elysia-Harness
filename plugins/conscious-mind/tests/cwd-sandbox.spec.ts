import { mkdtemp, mkdir, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { SandboxedFileSystem } from '@deepseek-ai/dsh-fs-sandbox'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { expect, it, onTestFinished } from 'vitest'

it('keeps the original cwd spelling while canonicalizing its Data symlink target', async () => {
  // Platform temp roots are independently writable under DSH's policy. Use an
  // owned temporary tree in the checkout to exercise the workspace boundary.
  const base = await mkdtemp(join(process.cwd(), '.elysia-cwd-fixture-'))
  const ctx = new Context()
  onTestFinished(async () => {
    await ctx.fiber.dispose()
    await rm(base, { recursive: true, force: true })
  })
  const original = join(base, 'conscious-mind')
  const retired = join(base, 'conscious-mind-empty')
  const data = join(base, 'Data')
  const outside = join(base, 'outside')
  await mkdir(original)
  await mkdir(join(data, 'workspace'), { recursive: true })
  await mkdir(join(data, 'standing-prompts'))
  await mkdir(outside)
  await rename(original, retired)
  await symlink(data, original, 'dir')
  expect(await realpath(original)).toBe(data)

  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: original })
  await ctx.plugin(SandboxedFileSystem, { cwd: original })
  const fs = ctx.fs as SandboxedFileSystem
  const policy = { mode: 'workspace-write', workspaceRoot: original } as const

  const note = join(original, 'workspace', 'note.txt')
  await fs.writeText(await fs.resolve(note), 'workspace', undefined, undefined, policy)
  expect(await readFile(join(data, 'workspace', 'note.txt'), 'utf8')).toBe('workspace')

  const prompt = join(original, 'standing-prompts', 'TOOLS.md')
  await writeFile(prompt, 'before')
  await fs.writeText(await fs.resolve(prompt), 'after', undefined, undefined, policy)
  expect(await readFile(prompt, 'utf8')).toBe('after')

  await expect(fs.writeText(await fs.resolve(join(outside, 'denied.txt')), 'no', undefined, undefined, policy))
    .rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
})

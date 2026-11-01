import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { provideWorkingDirectoryFixture } from '@deepseek-ai/dsh-agent-loop-testkit'
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import { createScope, type Scope } from '@deepseek-ai/dsh-scope'
import type { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as ToolFs from '@deepseek-ai/dsh-tool-fs'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { expect, it, onTestFinished } from 'vitest'
import { composeMainAgent } from '../src/main-session.ts'

function globalTool(name: string): ToolDefinition {
  return {
    name,
    description: `test ${name}`,
    parameters: { type: 'object', properties: {} },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value as string }],
    },
    execute: () => Promise.resolve('ok'),
  }
}

it('composes the real read_image registration into the main agent allow-list', async () => {
  const home = await mkdtemp(join(tmpdir(), 'elysia-main-tools-'))
  const ctx = new Context()
  onTestFinished(async () => {
    await ctx.fiber.dispose()
    await rm(home, { recursive: true, force: true })
  })
  provideWorkingDirectoryFixture(ctx)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime, { mode: 'native' })
  await ctx.plugin(LocalFileSystem, { cwd: home })
  await ctx.plugin(LocalAttachmentStore, { dshHome: home })
  await ctx.plugin(ToolFs, { read: false, readImage: true, write: false, edit: false })
  ctx.tools.register(globalTool('send_text'))
  ctx.tools.register(globalTool('send_voice'))

  const key = { id: 'elysia-conscious-mind' as SessionId } as Agent
  let scope!: Scope
  await ctx.plugin(Object.assign((inner: Context) => { scope = createScope(inner, key) }, {
    inject: ['tools', 'systemPrompt'],
  }))
  await composeMainAgent(scope.ctx, { baseDir: home, files: ['SOUL.md'], complete: true })

  expect(ctx.tools.schemas().map(tool => tool.name).sort()).toEqual(['read_image', 'send_text', 'send_voice'])
  expect(ctx.tools.schemas(key).map(tool => tool.name).sort()).toEqual(['pass', 'read_image', 'send_text', 'send_voice'])
})

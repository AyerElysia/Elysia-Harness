import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionStore, { type SessionEvent } from '@deepseek-ai/dsh-session'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import Projections from '@deepseek-ai/dsh-session-projection'
import FsLocal from '@deepseek-ai/dsh-fs-local'
import WorkingDirectory from '@deepseek-ai/dsh-working-directory'
import FileReference from '@deepseek-ai/dsh-file-reference-local'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createVoiceAgent, type VoiceDriverRequest } from '../src/session.ts'
import { assembleVoicePrompt } from '../src/prompt.ts'
import { acceptVoiceAudioCommit } from '../src/input.ts'
import { inject as voiceOwnerInject } from '../src/index.ts'

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

async function webFixture(withTools = true) {
  const directory = mkdtempSync(join(tmpdir(), 'elysia-voice-real-web-hooks-'))
  const root = new Context()
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }))
  cleanups.push(() => root.fiber.dispose())
  writeFileSync(join(directory, 'SOUL.md'), 'fake SOUL v1 {{literal}}')
  await root.plugin(SessionStore)
  await root.plugin(AgentRegistry)
  await root.plugin(SystemPrompt, { includeHarnessIdentity: true, personaPrefix: 'global deployment must not leak' })
  await root.plugin(Tools)
  await root.plugin(Projections)
  await root.plugin(FsLocal, { cwd: directory })
  await root.plugin(WorkingDirectory, { defaultDirectory: directory })
  await root.plugin(FileReference)
  const executeRead = vi.fn(async () => 'fixture tool must never execute')
  root.tools.register({ name: 'read', description: 'Web fixture global tool', parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'string' }, render: () => [] }, execute: executeRead })
  const executeAny = vi.spyOn(root.tools, 'execute')
  const events: SessionEvent[] = []
  const errors: unknown[] = []
  root.on('session/event', (_session, event) => { events.push(event) })
  root.on('agent/error', ({ error }) => { errors.push(error) })
  root.on('session/flush', () => {})
  const ready = Promise.withResolvers<Context>()
  await root.inject(['sessions', 'agents', 'systemPrompt', ...(withTools ? ['tools'] : [])], ctx => { ready.resolve(ctx) })
  return { root, ctx: await ready.promise, directory, executeRead, executeAny, events, errors }
}

describe('voice against real Web global WorkingDirectory and FileReference hooks', () => {
  it('accepts first and post-registration assembly while sending only literal SOUL and no tool execution', async () => {
    const f = await webFixture()
    const requests: VoiceDriverRequest[] = []
    const globalBefore = renderPrompt(await f.root.systemPrompt.assemble())
    const voice = await createVoiceAgent(f.ctx, { cwd: f.directory, promptsDir: f.directory,
      driver: { async *run(request) {
        requests.push(request)
        yield { type: 'text-delta', index: 0, text: 'fixture output' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      } } })
    cleanups.push(voice.dispose)
    expect(voiceOwnerInject).toContain('tools')
    expect(await assembleVoicePrompt(voice.agent)).toBe('fake SOUL v1 {{literal}}')
    const raw = await voice.agent.ctx.systemPrompt.assemble({ agent: voice.agent, scope: voice.agent })
    expect(raw.sections.map(section => section.name)).toEqual(['elysia:standing-prompts'])
    // This proves the real prepend middleware adds context AFTER the scoped
    // filter; provider-boundary isolation is necessary, not a mocked no-op hook.
    expect(raw.contexts.map(context => context.name)).toContain('working-directory:current')
    await acceptVoiceAudioCommit(voice.agent, { type: 'audio_committed', itemId: 'item_1' }, 'call_fixture', 0)
    await voice.agent.whenIdle()
    writeFileSync(join(f.directory, 'SOUL.md'), 'fake SOUL v2 {{literal}}')
    await acceptVoiceAudioCommit(voice.agent, { type: 'audio_committed', itemId: 'item_2' }, 'call_fixture', 0)
    await voice.agent.whenIdle()
    expect(requests.map(request => request.instructions)).toEqual(['fake SOUL v1 {{literal}}', 'fake SOUL v2 {{literal}}'])
    expect(f.errors).toEqual([])
    expect(f.executeAny).not.toHaveBeenCalled()
    expect(f.executeRead).not.toHaveBeenCalled()
    expect(f.events.filter(event => event.type === 'request/header').every(event => event.data.header.tools === undefined)).toBe(true)
    expect(renderPrompt(await f.root.systemPrompt.assemble())).toBe(globalBefore)
  })

  it('reproduces the real file-reference failure when an owner omits tools injection', async () => {
    const f = await webFixture(false)
    const voice = await createVoiceAgent(f.ctx, { cwd: f.directory, promptsDir: f.directory,
      driver: { async *run() { yield { type: 'finish', reason: { kind: 'stop' } } } } })
    cleanups.push(voice.dispose)
    await expect(assembleVoicePrompt(voice.agent)).rejects.toThrow(/tools.*without inject/u)
    expect(f.executeAny).not.toHaveBeenCalled()
    expect(f.executeRead).not.toHaveBeenCalled()
    const id = voice.agent.id
    await voice.dispose()
    expect(f.ctx.agents.get(id)).toBeUndefined()
    expect(f.ctx.sessions.get(id)).toBeUndefined()
    const recreated = await createVoiceAgent(f.ctx, { cwd: f.directory, promptsDir: f.directory,
      driver: { async *run() { yield { type: 'finish', reason: { kind: 'stop' } } } } })
    await recreated.dispose()
    expect(f.ctx.agents.get(id)).toBeUndefined()
    expect(f.ctx.sessions.get(id)).toBeUndefined()
  })
})

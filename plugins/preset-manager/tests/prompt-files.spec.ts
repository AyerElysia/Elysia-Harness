/**
 * Behavior of the preset child: what the system prompt renders, and what the
 * change notice reports to each session.
 */
import { describe, expect, it, onTestFinished } from 'vitest'
import { mkdtemp, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import { bindScopeParent, createScope, type ScopeKey } from '@deepseek-ai/dsh-scope'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { agentEvents, type Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { unsupportedInbox, unsupportedModel } from '@deepseek-ai/dsh-agent-loop-testkit'
import * as promptFiles from '../src/prompt-files.ts'
import { MISSING_FILES_MARKER } from '../src/prompt-source.ts'

const SIGNAL = new AbortController().signal

interface Harness {
  readonly ctx: Context
  readonly key: ScopeKey
  readonly agent: Agent
  readonly session: Session
  readonly root: string
}

/** One mount request: the configured list is fixed, the files on disk are not. */
interface MountOptions {
  /** Configured root-relative file list. */
  readonly files: readonly string[]
  /** Bodies written before the row mounts; a listed file may be absent. */
  readonly bodies?: Readonly<Record<string, string>>
  /** Optional identity prefix. */
  readonly identity?: string
}

/** Build a structurally complete Agent for the pre-step waterfall. */
function sessionAgent(session: Session): Agent {
  return {
    id: session.id,
    options: {},
    session,
    model: unsupportedModel(),
    inbox: unsupportedInbox(),
    status: 'running',
    ctx: new Context(),
    send: () => {},
    followup: () => {},
    steer: () => {},
    inject: () => { throw new Error('prompt-files must append through the returned decision') },
    cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
}

/**
 * Mount the child in a preset scope and route one Agent into that scope, the
 * same parent link the preset registry binds for every Agent it composes.
 */
async function mount(options: MountOptions): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'elysia-preset-'))
  for (const [name, body] of Object.entries(options.bodies ?? {})) {
    await writeFile(join(root, name), body, 'utf8')
  }
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, {})
  const key: ScopeKey = {}
  const scope = createScope(ctx, key)
  await scope.ctx.plugin(promptFiles, {
    root,
    files: [...options.files],
    ...(options.identity === undefined ? {} : { identity: options.identity }),
  })
  const session = Session.create(SessionId('session-1'))
  const agent = sessionAgent(session)
  bindScopeParent(agent, key)
  onTestFinished(async () => {
    await scope.dispose()
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  })
  return { ctx, key, agent, session, root }
}

/** Run the pre-step waterfall and commit what the listener proposed. */
async function fire(harness: Harness, step: number): Promise<void> {
  const proposed = createUserMessage({ content: [{ type: 'text', text: `step ${String(step)}` }], source: { kind: 'user' } })
  const decision = await agentEvents(harness.ctx, harness.agent).waterfall(
    'agent/pre-step',
    {
      modelSelection: { provider: 'mock', model: 'mock' },
      messages: [proposed],
      turn: 1,
      step,
      signal: SIGNAL,
    },
    () => Promise.resolve({ kind: 'enter' as const, messages: [proposed] }),
  )
  expect(decision.kind).toBe('enter')
  if (decision.kind !== 'enter') return
  for (const message of decision.messages) {
    if (message === proposed) continue
    harness.agent.session.append('user/message', message, { surfaceOp: 'append' })
  }
}

/** Visible change notices: the surface nodes that still carry notice text. */
function visibleNotices(session: Session): string[] {
  const texts: string[] = []
  for (const seq of session.surface.nodes) {
    // oxlint-disable-next-line typescript/no-deprecated -- test-side history read
    const event = session.eventAt(seq)
    if (event?.type !== 'user/message' || event.data.source.kind !== promptFiles.CHANGE_SOURCE) continue
    const block = event.data.content[0]
    if (block?.type !== 'text' || block.text === '') continue
    texts.push(block.text)
  }
  return texts
}

/** Render the assembled system prompt for the preset scope. */
async function promptText(harness: Harness): Promise<string> {
  return renderPrompt(await harness.ctx.systemPrompt.assemble({ scope: harness.key }))
}

describe('system prompt composition', () => {
  it('renders the identity prefix, then the configured files in order', async () => {
    const harness = await mount({
      files: ['SOUL.md', 'MEMORY.md'],
      bodies: { 'SOUL.md': 'soul body', 'MEMORY.md': 'memory body' },
      identity: 'You are Elysia.',
    })
    const assembly = await harness.ctx.systemPrompt.assemble({ scope: harness.key })
    expect(assembly.sections).toHaveLength(1)
    expect(assembly.sections[0]?.name).toBe(promptFiles.PROMPT_SECTION)
    expect(renderPrompt(assembly)).toBe('You are Elysia.\n\nsoul body\n\nmemory body')
  })

  it('re-reads the files on every assembly', async () => {
    const harness = await mount({ files: ['SOUL.md'], bodies: { 'SOUL.md': 'first body' } })
    expect(await promptText(harness)).toBe('first body')
    await writeFile(join(harness.root, 'SOUL.md'), 'second body', 'utf8')
    expect(await promptText(harness)).toBe('second body')
  })

  it('names a configured file that disappeared instead of dropping it silently', async () => {
    const harness = await mount({
      files: ['SOUL.md', 'USER.md'],
      bodies: { 'SOUL.md': 'soul body', 'USER.md': 'user body' },
    })
    await unlink(join(harness.root, 'USER.md'))
    expect(await promptText(harness))
      .toBe(`soul body\n\n${MISSING_FILES_MARKER} Configured prompt files are missing: USER.md`)
  })
})

describe('change notice', () => {
  it('publishes one visible loaded notice on the first observation', async () => {
    const harness = await mount({ files: ['SOUL.md'], bodies: { 'SOUL.md': 'soul body' } })
    await fire(harness, 1)
    const notices = visibleNotices(harness.session)
    expect(notices).toHaveLength(1)
    expect(notices[0]).toContain('System prompt loaded: SOUL.md')
  })

  it('reports a modification once for the same content', async () => {
    const harness = await mount({ files: ['SOUL.md'], bodies: { 'SOUL.md': 'soul body' } })
    await fire(harness, 1)
    await writeFile(join(harness.root, 'SOUL.md'), 'changed body', 'utf8')
    await fire(harness, 2)
    await fire(harness, 3)
    const notices = visibleNotices(harness.session)
    expect(notices).toHaveLength(1)
    expect(notices[0]).toContain('modified SOUL.md')
  })

  it('reports a configured file appearing and disappearing', async () => {
    const harness = await mount({ files: ['SOUL.md', 'NOTES.md'], bodies: { 'SOUL.md': 'soul body' } })
    await fire(harness, 1)
    await writeFile(join(harness.root, 'NOTES.md'), 'notes body', 'utf8')
    await fire(harness, 2)
    expect(visibleNotices(harness.session)[0]).toContain('added NOTES.md')
    await unlink(join(harness.root, 'SOUL.md'))
    await fire(harness, 3)
    const notices = visibleNotices(harness.session)
    expect(notices).toHaveLength(1)
    expect(notices[0]).toContain('removed SOUL.md')
  })

  it('replaces the previous notice instead of accumulating them', async () => {
    const harness = await mount({ files: ['SOUL.md'], bodies: { 'SOUL.md': 'soul body' } })
    await fire(harness, 1)
    const firstNoticeSeq = harness.session.seq - 1
    await writeFile(join(harness.root, 'SOUL.md'), 'second body', 'utf8')
    await fire(harness, 2)
    expect(visibleNotices(harness.session)[0]).toContain('modified SOUL.md')
    await writeFile(join(harness.root, 'SOUL.md'), 'third body', 'utf8')
    await fire(harness, 3)
    // The earlier notice is gone from the surface and one current notice remains.
    expect([...harness.session.surface.nodes]).not.toContain(firstNoticeSeq)
    expect(visibleNotices(harness.session)).toHaveLength(1)
  })
})

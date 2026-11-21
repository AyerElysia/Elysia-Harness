import { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, createUserMessage, type GenerateOptions, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { randomBytes, randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '../../../dsh/packages/test-support/agent-loop-testkit/src/index.ts'
import * as StandingPrompt from '../../conscious-mind/src/standing-prompts.ts'
import { mountDesktopHost } from '../src/desktop-host.ts'
import { DesktopPerform } from '../src/desktop-perform.ts'

async function fixture() {
  const ctx = new Context()
  const dir = await mkdtemp(join(tmpdir(), 'elysia-desktop-test-'))
  onTestFinished(async () => { await ctx.fiber.dispose(); await rm(dir, { recursive: true }) })
  const key = randomBytes(32).toString('hex'), file = join(dir, 'key')
  await writeFile(file, key, { mode: 0o600 })
  await writeFile(join(dir, 'SOUL.md'), 'Base soul fixture')
  await mountAgentLoopTestDependencies(ctx)
  const harness = await mountAgentLoopTestHarness(ctx)
  const options: GenerateOptions[] = []
  let answer = '爱莉回复'
  const adapter = new class extends LlmAdapter {
    override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
      return Promise.resolve({ provider, id: model, name: model })
    }
    override async *stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
      options.push(request)
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: answer }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: answer } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }()
  ctx.llm.registerAdapter(['fixture'], adapter)
  const sessionId = SessionId('elysia-conscious-mind')
  const agent = await harness.create(sessionId, { provider: 'fixture', model: 'fixture' })
  await agent.ctx.plugin(StandingPrompt, { baseDir: dir, files: ['SOUL.md'] })
  // Outer tool restrictions must retain the conditional scoped tool.
  agent.ctx.tools.restrict({ allow: [] })
  let targetAvailable = true
  const port = await mountDesktopHost(ctx, file, {
    target: () => {
      if (!targetAvailable) throw new Error('fixture target unavailable')
      return agent
    },
    start: async () => null,
    stop: async () => {},
  }, 0)
  const post = (path: string, body: unknown, credential = key, extra: Record<string, string> = {}) => fetch(`http://127.0.0.1:${port}/desktop/${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${credential}`, ...extra }, body: JSON.stringify(body),
  })
  return { ctx, dir, agent, post, key, options, sessionId, setAnswer(value: string) { answer = value },
    dropTarget() { targetAvailable = false } }
}

it('uses the same native session, admits the tool and system policy only for verified desktop input', async () => {
  const { agent, post, key, options, sessionId } = await fixture()
  const id = randomUUID()
  expect((await post('text', { id, text: '拒绝未配对' }, 'wrong')).status).toBe(403)
  expect((await post('probe', {}, key, { origin: 'https://example.invalid' })).status).toBe(403)
  expect((await post('text', { id, text: '真实桌面输入' })).ok).toBe(true)
  await agent.whenIdle()
  expect(await (await post('reply', { id })).json()).toEqual({ seq: 4, text: '爱莉回复', done: true })
  expect(await (await post('reply', { id })).json()).toEqual({ seq: 4, text: '爱莉回复', done: true })
  expect((await post('text', { id, text: '真实桌面输入' })).ok).toBe(true)
  expect((await post('text', { id, text: '篡改重复输入' })).status).toBe(409)
  agent.followup(createUserMessage({ content: [{ type: 'text', text: '我伪称来自桌面' }], source: { kind: 'user' } }))
  await agent.whenIdle()
  expect(options.map(request => request.sessionId)).toEqual([sessionId, sessionId])
  expect(JSON.stringify(options[0]?.messages)).toContain('桌面 · 打字')
  expect(JSON.stringify(options[0]?.tools)).toContain('desktop_perform')
  expect(JSON.stringify(options[1]?.tools ?? [])).not.toContain('desktop_perform')
  const system = (request: GenerateOptions | undefined) => JSON.stringify(request?.messages.filter(message => message.role === 'system'))
  expect(system(options[0])).toContain('桌宠是你在 Windows 上的形象')
  expect(system(options[1])).not.toContain('桌宠是你在 Windows 上的形象')
  expect(agent.session.snapshotEvents().filter(event => event.type === 'user/message')
    .map(event => event.data.source)).toContainEqual(expect.objectContaining({ elysiaIngress: expect.objectContaining({ surface: 'desktop', medium: 'text' }) }))
})

it('reports an exact desktop claim that fails during standing prompt assembly before the first step', async () => {
  const { agent, dir, post, options, dropTarget } = await fixture()
  await rm(join(dir, 'SOUL.md'))
  const id = randomUUID()
  expect(await (await post('text', { id, text: '桌面输入已领取，准备提示词失败' })).json()).toEqual({ ok: true })
  await agent.whenIdle()
  const log = agent.session.snapshotEvents()
  expect(log.find(event => event.type === 'turn/end')?.data.reason.kind).toBe('error')
  expect(log.some(event => event.type === 'step/start' || event.type === 'user/message')).toBe(false)
  expect(options).toHaveLength(0)
  const failed = { seq: 0, text: '', done: true, error: 'turn_failed' }
  expect(await (await post('reply', { id })).json()).toEqual(failed)

  await writeFile(join(dir, 'SOUL.md'), 'Restored soul fixture')
  const next = randomUUID()
  expect(await (await post('text', { id: next, text: '独立的下一轮' })).json()).toEqual({ ok: true })
  await agent.whenIdle()
  expect(options).toHaveLength(1)
  expect(await (await post('reply', { id: next })).json()).toEqual({ seq: 4, text: '爱莉回复', done: true })
  dropTarget()
  expect(await (await post('reply', { id })).json()).toEqual(failed)
})

it('distinguishes mixed input, empty output, unknown IDs and expired receipts without exposing text', async () => {
  const { agent, post, setAnswer } = await fixture()
  const read = async (id: string) => (await post('reply', { id })).json()
  const mixed = randomUUID(), empty = randomUUID()
  agent.inject(createUserMessage({ content: [{ type: 'text', text: 'Private unrelated input' }], source: { kind: 'user' } }))
  expect(await (await post('text', { id: mixed, text: 'Mixed desktop input' })).json()).toEqual({ ok: true })
  await agent.whenIdle()
  expect(await read(mixed)).toEqual({ seq: 0, text: '', done: true, error: 'mixed_inputs' })
  setAnswer(' ')
  expect(await (await post('text', { id: empty, text: 'No spoken reply' })).json()).toEqual({ ok: true })
  await agent.whenIdle()
  expect(await read(empty)).toEqual({ seq: 0, text: '', done: true, error: 'no_reply' })
  expect(await read(randomUUID())).toEqual({ seq: 0, text: '', done: true, error: 'no_reply' })

  const now = Date.now()
  const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 300001)
  try {
    expect(await read(mixed)).toEqual({ seq: 0, text: '', done: true, error: 'expired' })
    expect(await (await post('text', { id: mixed, text: 'Mixed desktop input' })).json()).toEqual({ ok: true })
    expect(await read(mixed)).toEqual({ seq: 0, text: '', done: true, error: 'expired' })
    expect(agent.session.snapshotEvents().filter(event => event.type === 'turn/start')).toHaveLength(2)
  } finally {
    clock.mockRestore()
  }
})

it('reports a starting desktop receipt as pending and settles it if the input is discarded', async () => {
  const { agent, post, options } = await fixture()
  const hold = Promise.withResolvers<void>()
  const maintenance = agent.runMaintenance(() => hold.promise)
  const id = randomUUID()
  try {
    expect(await (await post('text', { id, text: 'Queued desktop input' })).json()).toEqual({ ok: true })
    expect(await (await post('reply', { id })).json()).toEqual({ seq: 0, text: '', done: false })
    agent.cancel({ kind: 'user' })
    expect(await (await post('reply', { id })).json()).toEqual({ seq: 0, text: '', done: true, error: 'turn_failed' })
    expect(options).toHaveLength(0)
  } finally {
    hold.resolve()
    await maintenance
  }
})

it('delivers a verified expression exactly once and requires the exact started receipt', async () => {
  const avatar = new DesktopPerform()
  const signal = new AbortController().signal
  avatar.seen()
  expect(avatar.catalogUpdate({ expressions: [{ id: 'smile', label: '微笑' }], motions: [] })).toBe(true)
  expect(await avatar.run(false, { action: 'list' }, signal)).toEqual({ status: 'rejected', code: 'NOT_DESKTOP_TURN' })
  const catalog = await avatar.run(true, { action: 'list' }, signal)
  if (catalog.status !== 'catalog') throw new Error('no fixture model')
  const run = avatar.run(true, { action: 'play', catalog_rev: catalog.catalog_rev, steps: [{ kind: 'expression', id: 'smile' }] }, signal)
  const job = avatar.take()
  expect(job?.steps).toEqual([{ kind: 'expression', id: 'smile', hold_ms: 1500 }])
  expect(avatar.take()).toBeUndefined()
  expect(avatar.ack({ id: 'wrong', started: true })).toBe(false)
  expect(avatar.ack({ id: job?.id, started: true })).toBe(true)
  expect(await run).toEqual({ status: 'started', performance_id: job?.id })
  expect(avatar.ack({ id: job?.id, started: true })).toBe(false)
})

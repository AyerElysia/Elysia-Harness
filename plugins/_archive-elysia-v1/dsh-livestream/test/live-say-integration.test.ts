import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId, createAssistantMessage } from '@deepseek-ai/dsh-llm'
import { createScope, type Scope } from '@deepseek-ai/dsh-scope'
import SessionStore, { pluginRecordOf } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { expect, it, onTestFinished, vi } from 'vitest'
import { LiveShow, type ShowHooks } from '../src/body/show'
import type { StageEvent } from '../src/stage/protocol'
import { composeLivestreamAgent, journalInput, LIVESTREAM_SESSION_ID } from '../src/dsh/session'

const runtime = vi.hoisted(() => ({ show: undefined as LiveShow | undefined }))
vi.mock('../src/dsh/runtime', () => ({
  get show() { return runtime.show },
  markAgentReady: () => {},
  currentMoods: () => ['talk', 'laugh'],
}))

it('only speaks a durable live_say and returns the managed stage playback receipt', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'elysia-live-say-'))
  const ctx = new Context()
  let unsubscribe: (() => void) | undefined
  let unsubscribeSubtitles: (() => void) | undefined
  onTestFinished(async () => {
    unsubscribe?.()
    unsubscribeSubtitles?.()
    runtime.show?.dispose()
    runtime.show = undefined
    try { await ctx.fiber.dispose() } finally { await rm(dir, { recursive: true, force: true }) }
  })
  await writeFile(join(dir, 'SOUL.md'), 'Public isolated standing fixture.')
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(SessionStore)
  const session = ctx.sessions.create(LIVESTREAM_SESSION_ID)
  const records = () => session.snapshotEvents().map(pluginRecordOf).filter(Boolean)
  let flushed = records()
  ctx.on('session/flush', async subject => { if (subject === session) flushed = records() })

  let beforeSynthesis = records()
  const synthesize = vi.fn<ShowHooks['synthesize']>(async () => {
    beforeSynthesis = flushed
    return { audio: Uint8Array.of(1), timeline: [], audioMime: 'audio/wav', durationMs: 800 }
  })
  const show = runtime.show = new LiveShow({ synthesize, push: async () => true }, { dataDir: dir, names: ['fixture'] })
  const stage = show.stage
  const speech = vi.fn()
  const captions = vi.fn()
  unsubscribe = stage.subscribePlayback('fixture-speaker', 'audio', event => { if (event.type === 'say') speech(event) })
  unsubscribeSubtitles = stage.subscribeSubtitles(captions)

  const agent = { id: LIVESTREAM_SESSION_ID, session } as Agent
  let scope!: Scope
  await ctx.plugin(Object.assign((inner: Context) => { scope = createScope(inner, agent) }, {
    inject: ['tools', 'sessions', 'systemPrompt'],
  }))
  Object.defineProperty(agent, 'ctx', { value: scope.ctx })
  await composeLivestreamAgent(scope.ctx, { baseDir: dir, files: ['SOUL.md'] }, agent)
  show.goLive(LIVESTREAM_SESSION_ID)

  const assembled = await ctx.systemPrompt.assemble({ scope: agent, agent })
  expect(assembled.sections.map(section => section.text)).toEqual(['Public isolated standing fixture.'])
  expect(assembled.contexts.some(context => context.name === 'elysia-livestream:public-speech'
    && context.text.includes('live_say'))).toBe(true)
  expect((await ctx.systemPrompt.assemble()).contexts.some(context => context.name === 'elysia-livestream:public-speech')).toBe(false)

  const source = await journalInput(ctx, session, {
    platform: 'bilibili', kind: 'chat', id: 'fixture-inbound', ts: 1, user: { id: 'viewer', name: 'Viewer' }, text: 'public fixture',
  }, false, null, 'fixture-occurrence', show.currentShowId)
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('assistant/message', {
    turn: 1, step: 1,
    message: createAssistantMessage({
      source: { provider: 'fixture', model: 'gemini-fixture' },
      content: [{ type: 'text', text: 'Ordinary assistant prose stays in DSH.' }],
    }),
  }, { surfaceOp: 'append' })
  await Promise.resolve()
  expect(synthesize).not.toHaveBeenCalled()
  expect(speech).not.toHaveBeenCalled()

  const callId = ToolCallId('native-speech-call')
  const args = { text: '[笑] 公开样例', reply_to: [source.ref], stage_mood: 'laugh', expression_instruction: '放慢一点' }
  const call = session.append('tool/call', {
    turn: 1, step: 1, callId, name: 'live_say', arguments: JSON.stringify(args),
  })
  const signal = new AbortController().signal
  let settled = false
  const pending = ctx.tools.execute({ agent, signal, name: 'live_say', callId, arguments: args })
    .finally(() => { settled = true })
  await vi.waitFor(() => expect(speech).toHaveBeenCalledOnce())
  const [line] = speech.mock.calls[0] as [Extract<StageEvent, { type: 'say' }>]
  expect(line).toMatchObject({ text: '公开样例', mood: 'laugh', audioMime: 'audio/wav' })
  expect(synthesize).toHaveBeenCalledExactlyOnceWith('[笑] 公开样例', expect.any(AbortSignal), undefined, '放慢一点')
  expect(beforeSynthesis).toContainEqual(expect.objectContaining({
    type: 'plugin:elysia-livestream/speech-intent',
    data: expect.objectContaining({ id: line.id, callSeq: Number(call.seq), replyTo: [source.ref] }),
  }))
  expect(settled).toBe(false)
  expect(stage.reportPlayback('audio', 'fixture-speaker', line.id, { state: 'ended' })).toBe(false)
  expect(stage.reportPlayback('audio', 'fixture-speaker', line.id, { state: 'started' })).toBe(true)
  expect(captions).toHaveBeenCalledWith(expect.objectContaining({ id: line.id, state: 'started', text: '公开样例' }))
  expect(settled).toBe(false)
  expect(stage.reportPlayback('audio', 'fixture-speaker', line.id, { state: 'ended' })).toBe(true)
  expect(await pending).toMatchObject({ isError: false, value: { id: line.id, state: 'ended' } })
  expect(flushed).toContainEqual(expect.objectContaining({
    type: 'plugin:elysia-livestream/speech-receipt', data: { id: line.id, state: 'ended' },
  }))
  expect(speech).toHaveBeenCalledOnce()
})

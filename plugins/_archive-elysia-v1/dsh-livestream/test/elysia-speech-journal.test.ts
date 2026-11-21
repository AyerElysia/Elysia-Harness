import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SessionStore, { pluginRecordOf, type Session } from '@deepseek-ai/dsh-session'
import { describe, expect, it, vi } from 'vitest'
import { journalInput, LIVESTREAM_SESSION_ID, runLiveSpeech } from '../src/dsh/session'
import type { LiveChatEvent } from '../src/core/live'
import type { LiveSpeechResult } from '../src/body/show'

const stage = vi.hoisted(() => ({ currentShowId: 'fixture-show', currentSpeechOutputKey: 'fixture-output', liveSay: vi.fn() }))
vi.mock('../src/dsh/runtime', () => ({ show: stage }))

const event: LiveChatEvent = {
  kind: 'chat', id: 'fixture-event', platform: 'bilibili', ts: 1,
  user: { id: 'fixture-viewer', name: 'viewer' }, text: 'fixture',
}
const callId = ToolCallId('fixture-speech')
const signal = new AbortController().signal

async function harness(seed?: Session) {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  ctx.on('session/flush', async () => {})
  const session = ctx.sessions.create(LIVESTREAM_SESSION_ID, seed ? { seed: structuredClone(seed.snapshotEvents()) } : undefined)
  if (!seed) session.append('tool/call', { turn: 1, step: 1, name: 'live_say', callId, arguments: '{}' })
  return { ctx, session }
}

describe('native livestream speech journal', () => {
  it('durably links same-show events and reuses the terminal receipt after concurrent and restored calls', async () => {
    const { ctx, session } = await harness()
    stage.liveSay.mockReset()
    try {
      const { ref } = await journalInput(ctx, session, event, false, null, 'first', stage.currentShowId)
      let complete!: (result: LiveSpeechResult) => void
      stage.liveSay.mockImplementation(({ id }) => new Promise<LiveSpeechResult>(resolve => {
        complete = resolve
        const latest = session.snapshotEvents().map(pluginRecordOf).at(-1)
        expect(latest?.type).toBe('plugin:elysia-livestream/speech-intent')
        expect(latest?.data).toMatchObject({ id, callId, showId: stage.currentShowId, replyTo: [ref] })
      }))
      const args = { text: 'hello', replyTo: [ref] }
      const first = runLiveSpeech(ctx, session, callId, args, signal)
      const duplicate = runLiveSpeech(ctx, session, callId, args, signal)
      await vi.waitFor(() => expect(stage.liveSay).toHaveBeenCalledOnce())
      const id = stage.liveSay.mock.calls[0]![0].id
      const unconfirmed = await harness(session)
      try {
        await expect(runLiveSpeech(unconfirmed.ctx, unconfirmed.session, callId, args, signal)).resolves.toMatchObject({ id, state: 'failed' })
      } finally { await unconfirmed.ctx.fiber.dispose() }
      const ended = { id, state: 'ended' } as const
      complete(ended)
      await expect(Promise.all([first, duplicate])).resolves.toEqual([ended, ended])
      const restored = await harness(session)
      try {
        await expect(runLiveSpeech(restored.ctx, restored.session, callId, args, signal)).resolves.toEqual(ended)
        expect(stage.liveSay).toHaveBeenCalledOnce()
      } finally { await restored.ctx.fiber.dispose() }
    } finally { await ctx.fiber.dispose() }
  })

  it('cancels a queued intent if the output changes during its durability barrier', async () => {
    const { ctx, session } = await harness()
    stage.liveSay.mockReset()
    let release!: () => void
    let entered!: () => void
    const barrier = new Promise<void>(resolve => { release = resolve })
    const flushing = new Promise<void>(resolve => { entered = resolve })
    let paused = false
    const remove = ctx.on('session/flush', async () => {
      if (paused) return
      paused = true
      entered()
      await barrier
    })
    try {
      const pending = runLiveSpeech(ctx, session, callId, { text: 'hello' }, signal)
      await flushing
      stage.currentSpeechOutputKey = 'fixture-new-output'
      release()
      await expect(pending).resolves.toMatchObject({ state: 'cancelled' })
      expect(stage.liveSay).not.toHaveBeenCalled()
    } finally {
      release()
      remove()
      stage.currentSpeechOutputKey = 'fixture-output'
      await ctx.fiber.dispose()
    }
  })

  it('rejects forged references, another show, and a call missing from the native journal', async () => {
    const { ctx, session } = await harness()
    stage.liveSay.mockReset()
    try {
      const { ref } = await journalInput(ctx, session, event, false, null, 'previous', 'previous-show')
      await expect(runLiveSpeech(ctx, session, callId, { text: 'hello', replyTo: [ref] }, signal)).rejects.toThrow('different show')
      await expect(runLiveSpeech(ctx, session, callId, { text: 'hello', replyTo: [ref.replace(/:[a-f0-9]+$/, ':' + '0'.repeat(64))] }, signal)).rejects.toThrow('hash')
      await expect(runLiveSpeech(ctx, session, 'missing', { text: 'hello' }, signal)).rejects.toThrow('native live_say call')
      expect(stage.liveSay).not.toHaveBeenCalled()
    } finally { await ctx.fiber.dispose() }
  })
})

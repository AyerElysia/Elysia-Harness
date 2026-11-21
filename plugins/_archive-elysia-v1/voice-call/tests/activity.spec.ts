import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeRecordActivity, readVoiceActivities, VoiceInfrastructureDomain, VOICE_INFRASTRUCTURE_DOMAIN_NAME,
  type VoiceActivity } from '../src/activity.ts'

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'elysia-voice-infrastructure-gate-'))
  const root = new Context()
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  cleanups.push(() => root.fiber.dispose())
  await root.plugin(Storage)
  await root.plugin(StorageJson, { root: dir })
  await root.plugin(StorageDomain, { backend: 'json' })
  const ready = Promise.withResolvers<Context>()
  await root.inject(['storageDomain'], ctx => { ready.resolve(ctx) })
  return { root, ctx: await ready.promise, dir }
}
const event = (overrides: Partial<VoiceActivity> = {}): VoiceActivity => ({
  type: 'call-start', callId: 'fixture-call', epoch: 0, at: 100, occurrenceId: 'fixture-start',
  source: 'voice-call-controller', details: { agentRegistered: false, rawAudioRecorded: false }, ...overrides,
})

describe('public infrastructure-only durable audit domain', () => {
  it('records pre-Agent attempts with honest infrastructure identity, globally readable independently of an Agent', async () => {
    const f = await fixture()
    const record = makeRecordActivity(f.ctx)
    expect(f.ctx.storageDomain.get(VOICE_INFRASTRUCTURE_DOMAIN_NAME)).toBeUndefined()
    expect(() => readVoiceActivities(f.ctx)).toThrow(/not open/)
    await record(event())
    const publicDomain = f.ctx.storageDomain.get(VOICE_INFRASTRUCTURE_DOMAIN_NAME)
    expect(publicDomain?.table('events').size).toBe(1)
    const visible = readVoiceActivities(f.ctx).entries[0]
    expect(visible).toMatchObject({ actor: 'infrastructure', source: 'elysia-voice-call/controller',
      sessionId: 'elysia-voice-call', subjectState: 'attempt-only', occurrenceId: 'fixture-start' })
    expect(JSON.stringify(visible)).not.toMatch(/modelText|SOUL正文|PCM|apiKey/u)
    const facility = f.ctx.storageDomain
    await f.ctx.fiber.dispose()
    const reopened = await facility.open(VoiceInfrastructureDomain)
    expect(reopened.table('events').get('fixture-start')).toEqual(visible)
    await reopened.close()
  })

  it('awaits durable put before promise completion or public change, keeps exact retries immutable and rejects collisions', async () => {
    const f = await fixture()
    const changes: unknown[] = []
    f.root.on('domain/changed', change => { changes.push(change) })
    const record = makeRecordActivity(f.ctx)
    await record(event())
    const table = f.ctx.storageDomain.get(VOICE_INFRASTRUCTURE_DOMAIN_NAME)!.table('events')
    const original = table.put.bind(table)
    const gate = Promise.withResolvers<void>()
    vi.spyOn(table, 'put').mockImplementationOnce(async (key, value) => { await gate.promise; await original(key, value) })
    let finished = false
    const next = event({ type: 'usage', occurrenceId: 'usage-1', at: 101,
      details: { agentRegistered: true, inputTokens: 1, outputTokens: 2, totalTokens: 3, usageComplete: false } })
    const writing = record(next).then(() => { finished = true })
    await Promise.resolve()
    expect(finished).toBe(false)
    expect(changes).toHaveLength(1)
    gate.resolve()
    await writing
    expect(changes).toHaveLength(2)
    await Promise.all([record(next), record(next)])
    expect(changes).toHaveLength(2)
    await expect(record({ ...next, details: { inputTokens: 999 } })).rejects.toThrow(/collision/)
    expect(readVoiceActivities(f.ctx).entries[1]?.details.inputTokens).toBe(1)
  })

  it('rejects unrestricted text/raw buffers/secret fields and preserves client-reported partial or unknown playback evidence', async () => {
    const f = await fixture()
    const record = makeRecordActivity(f.ctx)
    await expect(record(event({ details: { text: 'not accepted' } as never }))).rejects.toThrow()
    await expect(record(event({ details: { pcm: 'not accepted' } as never }))).rejects.toThrow()
    await expect(record(event({ details: { apiKey: 'not accepted' } as never }))).rejects.toThrow()
    await record(event({ type: 'segment-planned', occurrenceId: 'plan-1', details: { agentRegistered: true,
      responseId: 'resp_1', segmentId: 'segment_1', nativeSeq: 12, plannedFrames: 24000, playbackStatus: 'planned',
      privacyMode: 'no-raw-audio', contextPolicy: 'current-call-only', provider: 'openai-realtime', model: 'gpt-realtime-2.1-mini',
      source: 'voice-call-controller', physicalAudibilityKnown: false, characters: 12, frames: 24000 } }))
    await record(event({ type: 'playback-client-reported', occurrenceId: 'receipt-1', at: 102,
      details: { segmentId: 'segment_1', responseId: 'resp_1', nativeSeq: 12, playedFrames: 5000,
        fullyPlayed: false, clientReported: true, playbackStatus: 'partial' } }))
    await record(event({ type: 'call-stop', occurrenceId: 'stop-1', at: 103,
      details: { reason: 'browser_disconnect', playbackStatus: 'unknown', usageComplete: false } }))
    const page = readVoiceActivities(f.ctx, { limit: 2 })
    expect(page.entries).toHaveLength(2)
    expect(page.nextCursor).toBe('receipt-1')
    expect(readVoiceActivities(f.ctx, { after: page.nextCursor! }).entries[0]?.details.playbackStatus).toBe('unknown')
  })

  it('mounts and disposes without opening a storage medium when no activity occurs', async () => {
    const f = await fixture()
    makeRecordActivity(f.ctx)
    expect(f.ctx.storageDomain.get(VOICE_INFRASTRUCTURE_DOMAIN_NAME)).toBeUndefined()
    await f.ctx.fiber.dispose()
    expect(() => readVoiceActivities(f.root)).toThrow(/not open/)
  })
})

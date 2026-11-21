/** Prepare the separate voice Session through the existing native persistence backend. */
import { isAbsolute } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { interruptedTurnClosers, SessionSeq, type Session, type SessionEvent, type SessionId, type UserMessage } from '@deepseek-ai/dsh-session'
import { SessionPersistenceNotFoundError, type SessionHandle } from '@deepseek-ai/dsh-session-persistence'
import { VOICE_SESSION_ID, type VoiceRestoreState } from './session.ts'

export interface VoiceSessionPreparation {
  readonly session: Session
  readonly restore: VoiceRestoreState
  readonly source: 'created' | 'restored'
  /** Keep this write owner alive until the Agent has drained and closed. */
  readonly handle: SessionHandle
}

/** Fold only this handle's public cold-read facts; no synchronous live Session scans. */
export function voiceRestoreState(events: readonly SessionEvent[]): VoiceRestoreState {
  let lastTurn = 0
  const nextTurn: UserMessage[] = []
  const nextStep: UserMessage[] = []
  for (const event of events) {
    if (event.type === 'turn/start') {
      if (!Number.isSafeInteger(event.data.turn) || event.data.turn < 1) throw new Error('Invalid stored voice turn')
      lastTurn = Math.max(lastTurn, event.data.turn)
    } else if (event.type === 'agent/inbox/spliced') {
      const splice = event.data
      const list = splice.target === 'next-turn' ? nextTurn : splice.target === 'next-step' ? nextStep : undefined
      const count = splice.removedCount ?? 0
      if (!list || !Number.isSafeInteger(splice.start) || splice.start < 0 || splice.start > list.length
        || !Number.isSafeInteger(count) || count < 0 || splice.start + count > list.length) {
        throw new Error('Invalid stored voice inbox splice')
      }
      list.splice(splice.start, count, ...splice.inserted)
    }
  }
  return { lastTurn, nextTurn, nextStep }
}

/**
 * Take the single-writer claim before publishing the Agent. Native JSONL already
 * forwards session/event and session/flush to this handle: do not add another writer.
 * Caller must inject sessions and sessionPersistence and close handle AFTER agent.close().
 */
export async function prepareVoiceSession(ctx: Context, options: {
  readonly cwd: string
  readonly sessionId?: SessionId
  readonly signal?: AbortSignal
}): Promise<VoiceSessionPreparation> {
  if (!isAbsolute(options.cwd)) throw new Error('Voice Session cwd must be absolute')
  const id = options.sessionId ?? VOICE_SESSION_ID
  if (ctx.sessions.get(id)) throw new Error(`Voice Session is already live: ${id}`)
  options.signal?.throwIfAborted()
  let handle: SessionHandle
  try {
    handle = await ctx.sessionPersistence.open(id, 'write', options.signal ? { signal: options.signal } : undefined)
  } catch (error) {
    if (!(error instanceof SessionPersistenceNotFoundError)) throw error
    const session = ctx.sessions.prepare(id, { meta: { cwd: options.cwd } })
    handle = await ctx.sessionPersistence.create(session.header, {
      inheritedEventCount: session.inheritedEventCount,
      ...(options.signal ? { signal: options.signal } : {}),
    })
    try {
      await handle.flush(options.signal ? { signal: options.signal } : undefined)
      return { session, restore: { lastTurn: 0 }, source: 'created', handle }
    } catch (failure) { await handle.close(); throw failure }
  }
  try {
    options.signal?.throwIfAborted()
    if (handle.header.cwd !== options.cwd) throw new Error('Stored voice Session cwd does not match configured cwd')
    const read = await handle.read(0, undefined, options.signal ? { signal: options.signal } : undefined)
    options.signal?.throwIfAborted()
    const closers = interruptedTurnClosers(read.events)
    const repaired = [...read.events, ...closers]
    // prepare() appends an end-seed marker for a restored log. Supply and persist
    // it explicitly first, so no constructor-only suffix is lost or read privately.
    const suffix: SessionEvent[] = [...closers]
    if (repaired.at(-1)?.type !== 'session/end-seed') {
      const marker: SessionEvent<'session/end-seed'> = {
        type: 'session/end-seed', seq: SessionSeq(repaired.length), time: Date.now(), data: {},
      }
      repaired.push(marker)
      suffix.push(marker)
    }
    if (suffix.length > 0) await handle.append(suffix, options.signal ? { signal: options.signal } : undefined)
    await handle.flush(options.signal ? { signal: options.signal } : undefined)
    const restore = voiceRestoreState(repaired)
    // Snapshot mode safely detaches both frozen backend history and new repair facts.
    const session = ctx.sessions.prepare(id, {
      seed: repaired,
      meta: { ...handle.header },
      inheritedEventCount: handle.inheritedEventCount,
    })
    if (session.seq !== repaired.length) throw new Error('Unexpected unstored voice Session constructor suffix')
    return { session, restore, source: 'restored', handle }
  } catch (error) { await handle.close(); throw error }
}

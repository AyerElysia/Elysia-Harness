/** Native, tool-free Agent driven directly by a Realtime transport, never ReactLoop. */
import { randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { agentEvents, type Agent, type AgentOptions, type Inbox, type InboxTarget, type CancelOptions } from '@deepseek-ai/dsh-agent'
import { AssistantStreamAccumulator, BlockAssembler, createAssistantMessage, createSystemMessage, LlmAttemptId,
  type MessageId, type StreamChunk, type UserMessage } from '@deepseek-ai/dsh-llm'
import { createScope } from '@deepseek-ai/dsh-scope'
import { SessionId, type Session, type SessionSeq, type AgentCancelCause, type SessionEventMap, type TurnEndReason } from '@deepseek-ai/dsh-session'
import { assembleVoicePrompt, mountVoicePrompt } from './prompt.ts'

export const VOICE_SESSION_ID = SessionId('elysia-voice-call')

/** Input messages are durable source/control facts; audio is already at the provider. */
export interface VoiceDriverRequest {
  readonly messages: readonly UserMessage[]
  readonly instructions: string
  readonly turn: number
  readonly step: number
  readonly signal: AbortSignal
}

/** Provider adapters map genuine provider deltas to the native stream vocabulary. */
export interface VoiceDriver {
  run(request: VoiceDriverRequest): AsyncIterable<StreamChunk>
}

export type RecordedVoiceResponse = SessionEventMap['assistant/message'] & {
  readonly agent: VoiceAgent
  readonly seq: SessionSeq
  readonly signal: AbortSignal
}

/** Cursor supplied by a restoration owner through a public query/projection. */
export interface VoiceRestoreState {
  readonly lastTurn: number
  readonly nextTurn?: readonly UserMessage[]
  readonly nextStep?: readonly UserMessage[]
}

export interface VoiceAgentConfig {
  readonly cwd: string
  readonly promptsDir: string
  readonly driver: VoiceDriver
  readonly sessionId?: SessionId
  /** Prepared and unentered; persistence owner may restore it before attaching. */
  readonly session?: Session
  readonly restore?: VoiceRestoreState
  readonly provider?: string
  readonly model?: string
  /** Invoked only after complete native message append AND persistence checkpoint. */
  readonly onRecordedResponse?: (response: RecordedVoiceResponse) => Promise<void> | void
}

class VoiceInbox implements Inbox {
  private readonly lists: Record<InboxTarget, UserMessage[]> = { 'next-turn': [], 'next-step': [] }

  constructor(private readonly agent: VoiceAgent, restore?: VoiceRestoreState) {
    this.lists['next-turn'].push(...restore?.nextTurn ?? [])
    this.lists['next-step'].push(...restore?.nextStep ?? [])
  }

  get nextTurn(): readonly UserMessage[] { return Object.freeze([...this.lists['next-turn']]) }
  get nextStep(): readonly UserMessage[] { return Object.freeze([...this.lists['next-step']]) }

  splice(target: InboxTarget, start: number, deleteCount: number, inserted: UserMessage[]): UserMessage[] {
    return this.change(target, start, deleteCount, inserted)
  }

  private change(target: InboxTarget, start: number, deleteCount: number, inserted: UserMessage[], canceled = false): UserMessage[] {
    const list = this.lists[target]
    const integerStart = Number.isNaN(start) ? 0 : Math.trunc(start)
    const normalized = (integerStart < 0 ? Math.max(list.length + integerStart, 0) : Math.min(integerStart, list.length)) || 0
    const count = Math.max(0, Math.min(Number.isNaN(deleteCount) ? 0 : Math.trunc(deleteCount), list.length - normalized)) || 0
    // Commit before changing pending state or notifying observers.
    const event = this.agent.session.append('agent/inbox/spliced', {
      target, start: normalized, removedCount: count, inserted,
      ...(canceled ? { outcome: 'canceled' as const } : {}),
    })
    const accepted = event.data.inserted
    const removed = list.splice(normalized, count, ...accepted)
    if (canceled) for (const message of removed) this.agent.events.emit('agent/inbox/discarded', { message })
    for (const message of accepted) this.agent.events.emit('agent/inbox/inserted', { message })
    return removed
  }

  clear(): void {
    for (const target of ['next-step', 'next-turn'] as const) {
      if (this.lists[target].length) this.change(target, 0, this.lists[target].length, [], true)
    }
  }
  append(target: InboxTarget, message: UserMessage): void { this.splice(target, this.lists[target].length, 0, [message]) }
  prepend(target: InboxTarget, message: UserMessage): void { this.splice(target, 0, 0, [message]) }
  replace(id: MessageId, message: UserMessage): boolean {
    for (const target of ['next-turn', 'next-step'] as const) {
      const index = this.lists[target].findIndex(item => item.id === id)
      if (index >= 0) { this.splice(target, index, 1, [message]); return true }
    }
    return false
  }
  remove(id: MessageId): boolean {
    for (const target of ['next-turn', 'next-step'] as const) {
      const index = this.lists[target].findIndex(item => item.id === id)
      if (index >= 0) { this.splice(target, index, 1, []); return true }
    }
    return false
  }
}

/** A real Agent: owns its scope, durable inbox, turn driver, and lifecycle. */
export class VoiceAgent implements Agent {
  readonly id: SessionId
  readonly options: AgentOptions
  readonly inbox: Inbox
  readonly ctx: Context
  readonly events: ReturnType<typeof agentEvents>
  readonly scope: ReturnType<typeof createScope>
  private active: { controller: AbortController; promise: Promise<unknown>; maintenance: boolean } | undefined
  private waking = false
  private disposed = false
  private closed = false
  private lastTurn: number
  private revision = 0
  private unregister: (() => unknown) | undefined
  private detachSession: (() => unknown) | undefined
  private closePromise: Promise<void> | undefined
  private resourceClosePromise: Promise<void> | undefined
  private ownerDispose: (() => unknown) | undefined
  private preparedHeader = false
  private faulted = false
  private _status: 'idle' | 'running' = 'idle'

  constructor(owner: Context, readonly session: Session, private readonly config: VoiceAgentConfig) {
    this.id = session.id
    this.lastTurn = config.restore?.lastTurn ?? 0
    this.options = { provider: config.provider ?? 'openai-realtime', model: config.model ?? 'gpt-realtime-2.1-mini' }
    this.scope = createScope(owner, this)
    this.ctx = this.scope.ctx
    this.events = agentEvents(this.ctx, this)
    this.inbox = new VoiceInbox(this, config.restore)
  }

  get status(): 'idle' | 'running' { return this._status }

  /** Adopt the scope so owner unload drains the Agent before scope registrations unwind. */
  own(owner: Context): void {
    const agent = this
    this.ownerDispose = owner.effect(function* () {
      yield agent.scope.rawDispose
      yield () => agent.closeResources()
    }, `voice-call.lifecycle(${this.id})`)
  }

  /** Called once by createVoiceAgent after prompt validation, not by consumers. */
  async attach(): Promise<void> {
    this.detachSession = this.ctx.sessions.enter(this.session)
    try {
      this.ctx.sessions.announce(this.session)
      const unregister = this.ctx.agents.register(this)
      await unregister
      this.unregister = unregister
    } catch (error) {
      this.detachSession()
      this.detachSession = undefined
      throw error
    }
  }

  send(message: UserMessage, target: InboxTarget, wakeup: boolean): void {
    if (this.disposed || this.faulted) throw new Error('Voice Agent is closed or failed its persistence checkpoint')
    // Input arriving during abort belongs to a future turn, never the dying step.
    const destination = this.active?.controller.signal.aborted ? 'next-turn' : target
    this.inbox.append(destination, message)
    if (wakeup) { this.waking = true; this.startIfNeeded() }
  }
  followup(message: UserMessage): void { this.send(message, 'next-turn', true) }
  steer(message: UserMessage): void { this.send(message, 'next-step', true) }
  inject(message: UserMessage): void { this.send(message, 'next-step', false) }

  /** Accept a single identified input durably, then wake that exact inbox entry. */
  async acceptInput(message: UserMessage): Promise<void> {
    this.send(message, 'next-turn', false)
    await this.checkpoint()
    if (this.disposed || this.faulted) throw new Error('Voice Agent closed while accepting input')
    this.waking = true
    this.startIfNeeded()
  }

  cancel(cause: AgentCancelCause, options?: CancelOptions): void {
    if (!options?.keepInbox) this.inbox.clear()
    this.waking = false
    if (this.active && !this.active.controller.signal.aborted) this.active.controller.abort(cause)
  }

  async whenIdle(): Promise<void> {
    while (this.active) await this.active.promise.catch(() => undefined)
  }

  runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.disposed || this.faulted || this.active) throw new Error('Voice Agent is not available for maintenance')
    const controller = new AbortController()
    const latch = Promise.withResolvers<T>()
    const activity = { controller, promise: latch.promise, maintenance: true }
    this.active = activity
    void this.ctx.agents.withInitiator(this, async () => {
      try { latch.resolve(await task(controller.signal)) } catch (error) { latch.reject(error) }
      finally { if (this.active === activity) this.active = undefined; this.startIfNeeded() }
    })
    return latch.promise
  }

  private setStatus(status: 'idle' | 'running'): void {
    this._status = status
    this.events.emit('agent/status', { status })
  }

  private startIfNeeded(): void {
    if (this.active || this.disposed || this.faulted || !this.waking) return
    if (this.inbox.nextTurn.length === 0 && this.inbox.nextStep.length === 0) { this.waking = false; return }
    const controller = new AbortController()
    const latch = Promise.withResolvers<void>()
    const activity = { controller, promise: latch.promise, maintenance: false }
    this.active = activity
    this.setStatus('running')
    void this.ctx.agents.withInitiator(this, async () => {
      try { await this.drive(controller.signal) }
      catch (error) { this.events.emit('agent/error', { turn: this.lastTurn, step: 1, error }) }
      finally {
        if (this.active === activity) this.active = undefined
        this.setStatus('idle')
        this.startIfNeeded()
        latch.resolve()
      }
    })
  }

  private async drive(signal: AbortSignal): Promise<void> {
    while (!signal.aborted && this.waking && !this.disposed && !this.faulted) {
      const next = this.inbox.nextTurn[0]
      const stepInput = [...this.inbox.nextStep]
      if (!next && stepInput.length === 0) { this.waking = false; return }
      const messages = [...(next ? [next] : []), ...stepInput]
      const turn = ++this.lastTurn
      const step = 1
      this.session.append('turn/start', { turn })
      // A tool-free Realtime response is one native step, not a second text model turn.
      this.session.append('step/start', { turn, step })
      let reason: TurnEndReason = { kind: 'completed' }
      let admitted = false
      try {
        const instructions = await assembleVoicePrompt(this, signal)
        if (!this.preparedHeader) {
          const hadHeader = this.session.requestHeader() !== undefined
          this.session.append('request/header', {
            header: { config: { provider: this.options.provider!, model: this.options.model! } },
            reason: hadHeader ? 'resume' : 'initial',
          })
          this.session.append('request/context', {
            provider: this.options.provider!, model: this.options.model!, systemPromptUpdate: 'in-history',
          })
          this.preparedHeader = true
        }
        this.session.append('system/message', { turn, step, message: createSystemMessage(instructions) }, { surfaceOp: 'append' })
        // Released storage requires the first surface node to be the protected
        // system head. Until SOUL succeeds, original inputs stay in durable inbox.
        if (next) this.inbox.splice('next-turn', 0, 1, [])
        if (stepInput.length) this.inbox.splice('next-step', 0, stepInput.length, [])
        for (const message of messages) {
          this.session.append('user/message', message, { surfaceOp: 'append' })
          this.events.emit('agent/inbox/claimed', { message, turn })
        }
        admitted = true
        // Fail before starting the provider if the source inputs/instructions cannot checkpoint.
        await this.checkpoint()
        signal.throwIfAborted()
        reason = await this.respond({ messages, instructions, turn, step, signal })
      } catch (error) {
        if (!admitted) this.waking = false
        reason = signal.aborted
          ? { kind: 'aborted', reason: signal.reason as AgentCancelCause }
          : { kind: 'error', error: { message: 'Voice response failed', code: 'VOICE_RESPONSE_FAILED' } }
        if (!signal.aborted) this.events.emit('agent/error', { turn, step, error })
      } finally {
        this.session.append('step/end', { turn, step })
        this.session.append('turn/end', { turn, reason })
        await this.checkpoint()
      }
    }
  }

  private async respond(request: VoiceDriverRequest): Promise<TurnEndReason> {
    const { turn, step, signal } = request
    const stream = new AssistantStreamAccumulator()
    const assembler = new BlockAssembler()
    const attemptId = LlmAttemptId(randomUUID())
    const revision = ++this.revision
    let count = 0
    let failed = false
    let failure: unknown
    let settlement: { eventType: 'assistant/message' | 'assistant/attempt'; seq: SessionSeq } | undefined
    this.events.emit('agent/assistant-stream', { frame: { type: 'start', attemptId, revision, turn, step } })
    try {
      for await (const chunk of this.config.driver.run(request)) {
        signal.throwIfAborted()
        // MVP is speech/text only. Tool output must never become callable tools.
        if (chunk.type === 'tool-call-delta' || (chunk.type === 'block-start' && chunk.blockType === 'tool-call')
          || (chunk.type === 'block-end' && chunk.block.type === 'tool-call')) {
          throw new Error('Realtime voice driver must not emit tool calls')
        }
        const time = Date.now()
        const accepted = stream.push({ time, chunk })
        assembler.push(accepted.chunk)
        // Framework live inspection only. TTS must use onRecordedResponse below.
        this.events.emit('agent/assistant-stream', { frame: { type: 'chunk', attemptId, revision, index: count++, ...accepted } })
      }
      signal.throwIfAborted()
      if (!assembler.finish) throw new Error('Realtime stream ended without a terminal finish')
      if (assembler.finish.kind === 'error') throw new Error('Realtime stream failed')
      if (assembler.finish.kind === 'tool-calls') throw new Error('Realtime speech requested tools')
    } catch (error) { failed = true; failure = error }
    try {
      const intentionalAbort = assembler.finish?.kind === 'aborted'
      const interrupted = failed || signal.aborted || intentionalAbort
      const blocks = interrupted ? assembler.interruptedBlocks() : assembler.blocks()
      if (blocks.length > 0) {
        const message = createAssistantMessage({
          content: blocks,
          source: {
            provider: this.options.provider!, model: this.options.model!,
            ...(!interrupted && assembler.replayState ? { replayState: assembler.replayState } : {}),
          },
        })
        const data: SessionEventMap['assistant/message'] = {
          turn, step, message, stream: [...stream.snapshot()],
          ...(assembler.usage ? { usage: assembler.usage } : {}),
          ...(interrupted ? { interrupted: true } : {}),
        }
        const event = this.session.append('assistant/message', data, { surfaceOp: 'append' })
        const seq = event.seq
        settlement = { eventType: 'assistant/message', seq }
        await this.checkpoint()
        if (!interrupted) {
          signal.throwIfAborted()
          await this.config.onRecordedResponse?.({ ...event.data, agent: this, seq, signal })
        }
      } else {
        const { seq } = this.session.append('assistant/attempt', { turn, step, stream: [...stream.snapshot()] })
        settlement = { eventType: 'assistant/attempt', seq }
        await this.checkpoint()
      }
      if (failed) throw failure
      signal.throwIfAborted()
      if (intentionalAbort) return { kind: 'aborted', reason: { kind: 'hook', reason: 'Voice reply interrupted' } }
      return assembler.finish?.kind === 'max-tokens' ? { kind: 'max-tokens' } : { kind: 'completed' }
    } finally {
      this.events.emit('agent/assistant-stream', { frame: {
        type: 'end', attemptId, revision, index: count,
        outcome: settlement ? { kind: 'committed', ...settlement } : { kind: 'abandoned' },
      } })
    }
  }

  /** Cancel, drain, checkpoint, then unregister; one id has exactly one owner. */
  close(): Promise<void> {
    this.closePromise ??= (async () => {
      try { await this.closeResources() }
      finally { await this.ownerDispose?.(); await this.scope.dispose() }
    })()
    return this.closePromise
  }

  private async checkpoint(): Promise<void> {
    try {
      if (!await this.ctx.sessions.flush(this.session)) throw new Error('Voice session has no persistence checkpoint listener')
    }
    catch (error) { this.faulted = true; this.waking = false; throw error }
  }

  private closeResources(): Promise<void> {
    this.resourceClosePromise ??= this.finishCloseResources()
    return this.resourceClosePromise
  }

  private async finishCloseResources(): Promise<void> {
    this.disposed = true
    this.cancel({ kind: 'disposed' })
    await this.whenIdle()
    // A failed checkpoint must not be silently turned into a successful close.
    try { if (this.detachSession) await this.checkpoint() }
    finally {
      if (!this.closed) {
        this.closed = true
        await this.unregister?.()
        this.detachSession?.()
      }
    }
  }
}

/** Register one real custom Agent, without installing/replacing the global factory. */
export async function createVoiceAgent(ctx: Context, config: VoiceAgentConfig): Promise<{ agent: VoiceAgent; dispose(): Promise<void> }> {
  if (!isAbsolute(config.cwd) || !isAbsolute(config.promptsDir)) throw new Error('Voice cwd and prompt directory must be absolute')
  const id = config.sessionId ?? VOICE_SESSION_ID
  if (ctx.agents.get(id) || ctx.sessions.get(id)) throw new Error(`Voice session already has an owner: ${id}`)
  const session = config.session ?? ctx.sessions.prepare(id, { meta: { cwd: config.cwd } })
  if (session.id !== id || session.header.cwd !== config.cwd) throw new Error('Voice session identity/cwd mismatch')
  if (session.seq > 0 && !config.restore) throw new Error('Restored voice session requires an explicit projection-derived cursor')
  if (config.restore && (!Number.isSafeInteger(config.restore.lastTurn) || config.restore.lastTurn < 0)) throw new Error('Invalid restored voice turn cursor')
  const agent = new VoiceAgent(ctx, session, config)
  try {
    agent.own(ctx)
    await mountVoicePrompt(agent.ctx, config.promptsDir)
    await assembleVoicePrompt(agent)
    await agent.attach()
  } catch (error) {
    await agent.close()
    throw error
  }
  return { agent, dispose: () => agent.close() }
}

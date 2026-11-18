import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-attachment'
import { createUserMessage, type ContentBlock, type ContextFormed } from '@deepseek-ai/dsh-llm'
import type { SessionId, SessionEvent } from '@deepseek-ai/dsh-session'
import { ParticipantSessions } from './participants.ts'
import { redactVisible, SessionReader, type SessionListArgs, type SessionReadArgs } from './read.ts'
import { CommunicationError, CommunicationStore, type StoredMessage } from './store.ts'
import type { Participant } from './types.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'elysia-session-communication': {
      kind: 'elysia-session-communication'
      messageId: string
      conversationId: string
      senderSessionId: string
      targetSessionId: string
      replyTo?: string
    } & ContextFormed
  }
}

export interface SendArgs {
  target: string
  content: unknown[]
  conversation_id?: string
  reply_to?: string
  idempotency_key?: string
}

const SOURCE = 'elysia-session-communication'
const RETRY_MS = [1000, 3000, 10_000, 30_000, 60_000]
const QUEUE_CHECK_MS = 3500

type AttachmentBlock = Extract<ContentBlock, { type: 'image' | 'file' }>
type DeliveryBlock = Extract<ContentBlock, { type: 'text' }> | AttachmentBlock

function isAttachment(block: ContentBlock): block is AttachmentBlock {
  return block.type === 'image' || block.type === 'file'
}

function describeError(error: unknown) {
  const details = error as { code?: unknown; retryable?: unknown }
  return {
    code: typeof details?.code === 'string' ? details.code : 'DELIVERY_UNKNOWN',
    message: details?.code === 'TARGET_NOT_FOUND' ? '目标会话不存在'
      : details?.code === 'TARGET_DISABLED' ? '目标会话已停用'
      : '未能确认交付，宿主会核对后继续',
    retryable: details?.retryable !== false,
  }
}

function receipt(message: StoredMessage) {
  return {
    message_id: message.id,
    conversation_id: message.conversationId,
    sender_session_id: message.senderSessionId,
    target_session_id: message.targetSessionId,
    ...(message.replyTo === undefined ? {} : { reply_to: message.replyTo }),
    stored_at: new Date(message.storedAt).toISOString(),
    delivery_state: message.deliveryState,
  }
}

export class SessionCommunication {
  readonly store: CommunicationStore
  readonly reader: SessionReader
  private readonly sessions: ParticipantSessions
  private readonly active = new Map<string, { turn: number; messageIds: Set<string> }>()
  private readonly evidence = new Set<Promise<void>>()
  private timer: ReturnType<typeof setTimeout> | undefined
  private running: Promise<void> | undefined
  private stopped = false

  constructor(
    private readonly ctx: Context,
    readonly participants: readonly Participant[],
    stateDir: string,
    private readonly maxPending: number,
  ) {
    this.sessions = new ParticipantSessions(ctx)
    this.reader = new SessionReader(ctx, participants)
    this.store = new CommunicationStore(stateDir)
  }

  participant(id: string): Participant | undefined {
    return this.participants.find(p => p.alias === id || p.sessionId === id)
  }

  private caller(agent: Agent | undefined): Participant {
    const sender = this.participants.find(p => p.sessionId === agent?.id && p.enabled !== false)
    if (agent === undefined || sender === undefined || this.ctx.agents.get(agent.id) !== agent) {
      throw new CommunicationError('CALLER_UNREGISTERED', '当前会话未登记为通讯参与者')
    }
    return sender
  }

  private target(value: string): Participant {
    const target = this.participant(value)
    if (target === undefined) throw new CommunicationError('TARGET_NOT_FOUND', '目标会话未登记')
    if (target.enabled === false) throw new CommunicationError('TARGET_DISABLED', '目标会话已停用')
    return target
  }

  async list(agent: Agent | undefined, args: SessionListArgs, signal: AbortSignal) {
    return this.reader.list(this.caller(agent).sessionId, args, signal)
  }

  async read(agent: Agent | undefined, args: SessionReadArgs, signal: AbortSignal) {
    const caller = this.caller(agent)
    if (args.view !== 'message') return this.reader.read(caller.sessionId, args, signal)
    const target = this.target(args.target)
    if (args.message_id === undefined || !args.message_id || args.cursor !== undefined || args.limit !== undefined
      || args.event_seq !== undefined || args.seq_from !== undefined || args.seq_to !== undefined
      || args.event_types !== undefined || args.query !== undefined) {
      throw new CommunicationError('INVALID_ARGUMENT', '查看交付证据只需指定 target 和 message_id')
    }
    const message = this.store.get(args.message_id)
    if (message === undefined || ![message.senderSessionId, message.targetSessionId].includes(target.sessionId)
      || ![message.senderSessionId, message.targetSessionId].includes(caller.sessionId)) {
      throw new CommunicationError('REFERENCE_NOT_VISIBLE', '该通讯消息对当前查询不可见')
    }
    const evidence = await this.reconcileTurnEnd(message, signal)
    const at = (time: number | undefined) => time === undefined ? undefined : new Date(time).toISOString()
    return {
      target_session_id: target.sessionId, view: 'message', as_of: new Date().toISOString(),
      message: {
        ...receipt(evidence), queued_at: at(evidence.queuedAt), accepted_at: at(evidence.acceptedAt),
        model_presented_at: at(evidence.modelPresentedAt), target_event_seq: evidence.targetEventSeq,
        request_ref: evidence.requestRef, turn: evidence.turn, ended_at: at(evidence.endedAt),
        turn_end_reason: evidence.turnEndReason, last_error: evidence.lastError,
        replies: this.store.replies(message.id).slice(0, 20).map(receipt),
      },
    }
  }

  private async reconcileTurnEnd(message: StoredMessage, signal: AbortSignal): Promise<StoredMessage> {
    if (message.targetEventSeq === undefined || message.endedAt !== undefined) return message
    const snapshot = await this.ctx.sessionQuery.readSession(message.targetSessionId as SessionId).catch(() => undefined)
    signal.throwIfAborted()
    if (snapshot === undefined || this.stopped) return message
    let turn: number | undefined
    let matchedTurn: number | undefined
    for (const event of snapshot.events) {
      if (event.type === 'turn/start') turn = event.data.turn
      if (Number(event.seq) === message.targetEventSeq && event.type === 'user/message'
        && event.data.source.kind === SOURCE && event.data.source.messageId === message.id) {
        matchedTurn = turn
      }
      if (event.type === 'turn/end' && event.data.turn === matchedTurn) {
        this.store.recordTurnEnd(message.id, { turn: matchedTurn, time: event.time, reason: event.data.reason.kind })
        return this.store.get(message.id) ?? message
      }
    }
    return message
  }

  async send(agent: Agent | undefined, args: SendArgs, callIdentity: string, signal: AbortSignal) {
    const sender = this.caller(agent)
    const target = this.target(args.target)
    if (sender.sessionId === target.sessionId) throw new CommunicationError('INVALID_ARGUMENT', '请选择其他参与会话')
    for (const value of [args.conversation_id, args.reply_to, args.idempotency_key]) {
      if (value !== undefined && (!value.trim() || value.length > 200 || /[\r\n]/.test(value))) {
        throw new CommunicationError('INVALID_ARGUMENT', '消息标识须为 1 至 200 字符的单行文本')
      }
    }
    const content = await this.content(args.content, agent!, signal)
    signal.throwIfAborted()
    if (args.reply_to !== undefined) {
      const original = this.store.get(args.reply_to)
      if (original === undefined
        || original.targetSessionId !== sender.sessionId || original.senderSessionId !== target.sessionId) {
        throw new CommunicationError('REFERENCE_NOT_VISIBLE', '回复应引用对方发给当前会话的消息')
      }
    }
    const result = this.store.save({
      senderSessionId: sender.sessionId, targetSessionId: target.sessionId, content,
      callIdentity,
      ...(args.conversation_id === undefined ? {} : { conversationId: args.conversation_id }),
      ...(args.reply_to === undefined ? {} : { replyTo: args.reply_to }),
      ...(args.idempotency_key === undefined ? {} : { idempotencyKey: args.idempotency_key }),
      maxPending: this.maxPending,
    })
    this.wake()
    return { ...receipt(result.message), idempotent_replay: result.idempotentReplay }
  }

  private async content(input: unknown[], agent: Agent, signal: AbortSignal): Promise<DeliveryBlock[]> {
    if (!Array.isArray(input) || input.length < 1 || input.length > 16) {
      throw new CommunicationError('INVALID_ARGUMENT', '一条消息须包含 1 至 16 个内容块')
    }
    const content: DeliveryBlock[] = []
    let bytes = 0
    for (const raw of input) {
      const block = raw as { type?: unknown; text?: unknown; ref?: unknown } | null
      if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
        bytes += Buffer.byteLength(block.text)
        content.push({ type: 'text', text: block.text })
      } else if (block?.type === 'attachment_ref' && typeof block.ref === 'string') {
        content.push(await this.attachment(agent, block.ref, signal))
      } else {
        throw new CommunicationError('INVALID_ARGUMENT', '内容块必须是非空文字或原生附件引用')
      }
    }
    if (bytes > 32 * 1024) throw new CommunicationError('INVALID_ARGUMENT', '文字总长超出 32 KiB')
    return content
  }

  private async attachment(agent: Agent, ref: string, signal: AbortSignal): Promise<AttachmentBlock> {
    if (ref.length > 128) throw new CommunicationError('INVALID_ARGUMENT', '附件引用格式无效')
    const snapshot = await this.ctx.sessionQuery.readSession(agent.id)
    signal.throwIfAborted()
    for (const event of snapshot.events) {
      // User attachments are explicitly shared to this participant's session.
      // Files or paths from tool output need their own admission provenance.
      if (event.type !== 'user/message') continue
      for (const block of event.data.content) {
        if (!isAttachment(block) || block.attachment.attachmentId !== ref) continue
        try {
          if (block.type === 'image') await this.ctx.attachments.readImage(block.attachment, signal)
          else for await (const _chunk of this.ctx.attachments.readFileStream(block.attachment, signal)) { signal.throwIfAborted() }
        } catch (error) {
          signal.throwIfAborted()
          throw new CommunicationError('CONTENT_UNAVAILABLE', '附件当前无法通过原生存储核验')
        }
        return block
      }
    }
    throw new CommunicationError('REFERENCE_NOT_VISIBLE', '引用须来自本会话收到的原生附件')
  }

  start() { this.wake() }

  private wake(delay = 0): void {
    if (this.stopped || this.running !== undefined) return
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.running = this.drain().catch(error => {
        this.ctx.logger('session-communication').warn('投递轮询失败 %s', String(redactVisible(String(error))))
      }).finally(() => {
        this.running = undefined
        if (this.stopped) return
        const next = this.store.nextWakeAt()
        if (next !== undefined) this.wake(Math.max(100, next - Date.now()))
      })
    }, delay)
    this.timer.unref()
  }

  private async drain(): Promise<void> {
    const selected = new Map<string, StoredMessage>()
    for (const message of this.store.pending(Date.now(), 100)) {
      if (!selected.has(message.targetSessionId)) selected.set(message.targetSessionId, message)
    }
    await Promise.all([...selected.values()].map(message => this.deliver(message)))
  }

  private async deliver(message: StoredMessage): Promise<void> {
    try {
      const target = this.target(message.targetSessionId)
      const agent = await this.sessions.ensure(target)
      if (this.stopped || this.store.get(message.id)?.acceptedAt !== undefined) return
      await this.ctx.sessions.flush(agent.session)
      const snapshot = await this.ctx.sessionQuery.readSession(agent.id)
      if (this.stopped || this.store.get(message.id)?.acceptedAt !== undefined) return
      const accepted = snapshot.events.find(event => event.type === 'user/message'
        && event.data.source.kind === SOURCE && event.data.source.messageId === message.id)
      if (accepted !== undefined) {
        this.store.recordAccepted(message.id, Number(accepted.seq), accepted.time)
        return
      }
      const queued = agent.inbox.nextTurn.find(event => event.source.kind === SOURCE && event.source.messageId === message.id)
      if ((queued !== undefined && agent.status !== 'idle') || this.active.get(agent.id)?.messageIds.has(message.id)) {
        this.store.recordQueued(message.id, Date.now(), Date.now() + QUEUE_CHECK_MS)
        return
      }
      // Restoring DSH replays the inbox without waking it. Requeue its owned
      // item once, using the same message identity, to open the original turn.
      if (queued !== undefined) agent.inbox.remove(queued.id)
      agent.followup(queued ?? createUserMessage({
        source: {
          kind: SOURCE, form: 'relay', messageId: message.id, conversationId: message.conversationId,
          senderSessionId: message.senderSessionId, targetSessionId: message.targetSessionId,
          ...(message.replyTo === undefined ? {} : { replyTo: message.replyTo }),
        },
        content: [{
          type: 'text',
          text: `[内部会话消息 · 来自 ${this.participant(message.senderSessionId)?.alias ?? message.senderSessionId}]\n消息 ID: ${message.id}\n讨论 ID: ${message.conversationId}${message.replyTo === undefined ? '' : `\n回复于: ${message.replyTo}`}\n如需回复，请用 session_send 发给原会话并引用本消息 ID。\n\n`,
        }, ...message.content as DeliveryBlock[]],
      }))
      this.store.recordQueued(message.id, Date.now(), Date.now() + QUEUE_CHECK_MS)
    } catch (error) {
      if (this.stopped) return
      const detail = describeError(error)
      const wait = detail.retryable ? RETRY_MS[Math.min(message.attemptCount, RETRY_MS.length - 1)]! : 60_000
      this.store.recordFailure(message.id, detail, Date.now() + wait)
    }
  }

  claim(agent: Agent, message: { source: unknown }, turn: number): void {
    const source = message.source as { kind?: string; messageId?: string }
    if (source.kind !== SOURCE || source.messageId === undefined) return
    const current = this.active.get(agent.id)
    if (current?.turn === turn) current.messageIds.add(source.messageId)
    else this.active.set(agent.id, { turn, messageIds: new Set([source.messageId]) })
  }

  event(sessionId: SessionId, event: SessionEvent): void {
    if (this.stopped) return
    const current = this.active.get(sessionId)
    if (event.type === 'user/message' && event.data.source.kind === SOURCE) {
      const row = this.store.get(event.data.source.messageId)
      if (row?.targetSessionId === sessionId) {
        this.afterFlush(sessionId, () => {
          if (this.store.get(row.id)?.acceptedAt === undefined) this.store.recordAccepted(row.id, Number(event.seq), event.time)
          this.wake()
        })
      }
    }
    if (event.type === 'turn/end' && current?.turn === event.data.turn) {
      this.afterFlush(sessionId, () => {
        for (const messageId of current.messageIds) {
          if (this.store.get(messageId)?.acceptedAt === undefined) continue
          this.store.recordTurnEnd(messageId, { turn: current.turn, time: event.time, reason: event.data.reason.kind })
        }
      })
      this.active.delete(sessionId)
    }
  }

  private afterFlush(sessionId: string, write: () => void): void {
    const agent = this.ctx.agents.get(sessionId as SessionId)
    if (agent === undefined) return
    const operation = Promise.resolve().then(() => this.ctx.sessions.flush(agent.session)).then(write)
      .catch(() => { this.ctx.logger('session-communication').warn('会话交付证据暂未写入') })
      .finally(() => { this.evidence.delete(operation) })
    this.evidence.add(operation)
  }

  presented(sessionId: string | undefined, messages: readonly { source?: unknown }[]): void {
    if (this.stopped || sessionId === undefined) return
    const current = this.active.get(sessionId)
    if (current === undefined) return
    const presented = new Set<string>()
    for (const message of messages) {
      const source = message.source as { kind?: string; messageId?: string } | undefined
      if (source?.kind !== SOURCE || source.messageId === undefined || !current.messageIds.has(source.messageId)) continue
      const row = this.store.get(source.messageId)
      if (row !== undefined && row.modelPresentedAt === undefined) presented.add(row.id)
    }
    if (presented.size === 0) return
    const agent = this.ctx.agents.get(sessionId as SessionId)
    const boundary = agent === undefined ? undefined : this.ctx.agents.turnBoundaryOf(agent.session)
    this.afterFlush(sessionId, () => {
      for (const id of presented) {
        this.store.recordPresented(id, {
          turn: current.turn,
          ...(boundary?.lastStepStartSeq == null ? {} : { requestRef: `${sessionId}:step-start:${boundary.lastStepStartSeq}` }),
        })
      }
    })
  }

  async dispose(): Promise<void> {
    this.stopped = true
    if (this.timer !== undefined) clearTimeout(this.timer)
    await this.sessions.dispose()
    await this.running
    await Promise.all(this.evidence)
    this.store.close()
  }
}

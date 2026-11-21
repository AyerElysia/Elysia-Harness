import { mkdir } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic'
import { createUserMessage, type ContentBlock, type UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionPersistenceNotFoundError } from '@deepseek-ai/dsh-session-persistence'
import * as StandingPrompt from '@elysia/conscious-mind/standing-prompts'
import * as CurrentTime from '@elysia/conscious-mind/current-time'
import * as FileCapabilities from '@elysia/conscious-mind/file-capabilities'
import { hasRecordedModelSelection, restoreDirectSessionModel } from '@elysia/conscious-mind/src/restore-direct-session-model.ts'
import type { Config } from './config.ts'
import { MEMORY_SESSION_ID, reminderContent, taskContent, taskMessageSource } from './dispatch.ts'
import { DispatchError, type DispatchStore } from './dispatch-store.ts'
import { defineSubconsciousReportTool } from './dispatch-tools.ts'
import { guardStandingPromptWrites } from './general-capabilities.ts'

const contextSources = new Set(['agent-instructions', 'runtime-context'])
const composed = new WeakSet<Context>()

/**
 * 单次 Assignment 的墙钟预算。超时只让这一次 run 失败：不 dispose、不 abort 耐久 Session，
 * 因为模型回合可能正在真实写文件，强行打断会留下半成品；是否再派由 runtime 的失败预算决定。
 * 超时后仍会结束的旧 run 通过 `hit` 检查不再推进 Task 状态，避免与下一次投递并发改同一 Session。
 */
export class AssignmentRunBudget {
  private readonly startedAt = Date.now()
  private timer: ReturnType<typeof setTimeout> | undefined
  private expiredAt: number | undefined
  private delivering = false
  private settled = false
  readonly expired: Promise<never>

  constructor(readonly assignmentId: string, readonly maxRunMs: number) {
    this.expired = new Promise<never>((_, reject) => {
      this.timer = setTimeout(() => {
        this.expiredAt = Date.now()
        const used = this.expiredAt - this.startedAt
        // 日志必须说清职责：回合仍在跑时，下一次投递会等它，不与它并发写同一 Session。
        const running = this.delivering && !this.settled
        process.stderr.write(`潜意识记忆：Assignment ${assignmentId} 已用 ${used}ms 超过上限 ${maxRunMs}ms；`
          + '本次 run 以 ASSIGNMENT_TIMEOUT 失败，'
          + (running
            ? '模型回合仍在进行，下一个 Assignment 会等它结束后再投递，不会并发写同一 Session。\n'
            : this.delivering ? '模型回合已结束，超时仍按 deadline 生效。\n' : '尚未开始模型回合，无需等待。\n'))
        reject(new DispatchError('ASSIGNMENT_TIMEOUT', `Assignment ${assignmentId} 已用 ${used}ms，超过上限 ${maxRunMs}ms`, true))
      }, maxRunMs)
      this.timer.unref()
    })
  }

  get hit(): boolean {
    return this.expiredAt !== undefined
  }

  /** 第一次把任务真正投给模型前调用；超时日志据此区分「回合仍在跑」和「还没开始」。 */
  beginDelivery(): void {
    this.delivering = true
  }

  /** 真实工作已经结束；超时日志据此判断模型回合是否仍在进行。 */
  markSettled(): void {
    this.settled = true
  }

  clear(): void {
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
  }
}

function isTaskMessage(message: UserMessage, assignmentId: string, deliveryId: string): boolean {
  return message.source.kind === 'elysia-subconscious-task'
    && message.source.assignmentId === assignmentId && message.source.deliveryId === deliveryId
}

function isolateMemoryContext(agentCtx: Context, agent: Agent, store: DispatchStore): void {
  const restore = agentCtx.systemPrompt.suppressRuntimeContext()
  agentCtx.effect(() => restore, 'elysia-subconscious.memory-runtime-context()')
  agentCtx.effect(() => agentCtx.root.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (decision.kind === 'reject' || payload.agent.id !== MEMORY_SESSION_ID) return decision
    for (const message of decision.messages) {
      if (message.role !== 'user' || message.source.kind !== 'elysia-subconscious-task') continue
      store.markAssignmentPresented(message.source.assignmentId, payload.turn, payload.step)
    }
    return {
      ...decision,
      messages: decision.messages.filter(message => !(message.role === 'user' && contextSources.has(message.source.kind))),
    }
  }, { prepend: true }), 'elysia-subconscious.memory-context-filter()')
  for (const seq of [...agent.session.surface.nodes]) {
    const event = agent.session.eventAt(seq)
    if (event?.type !== 'user/message' || !contextSources.has(event.data.source.kind) || event.data.content.length === 0) continue
    agent.session.append('user/message', createUserMessage({ content: [], source: event.data.source }), {
      surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq }, sourceEventSeqs: [seq],
    })
  }
}

/** One durable memory specialist; assignments change, identity and history do not. */
export class MemorySession {
  private handlePromise: Promise<AgentHandle> | undefined

  constructor(private readonly ctx: Context, private readonly config: Required<Config>, private readonly store: DispatchStore) {
    ctx.effect(() => ctx.root.on('session/event', (session, event) => {
      if (session.id !== MEMORY_SESSION_ID || event.type !== 'user/message') return
      if (event.data.source.kind !== 'elysia-subconscious-task') return
      store.markAssignmentAccepted(event.data.source.assignmentId, event.seq, event.time)
    }), 'elysia-subconscious.memory-delivery-accepted()')
  }

  private selectModel(agent: Agent): void {
    // Keep a route this Session already recorded; the configured route only seeds a fresh one.
    if (hasRecordedModelSelection(agent)) return
    agent.model.select({ provider: this.config.provider, model: this.config.model })
  }

  private async setup(agentCtx: Context, agent: Agent): Promise<void> {
    this.selectModel(agent)
    if (composed.has(agentCtx)) return
    await mkdir(this.config.memoryWorkspaceDir, { recursive: true })
    await agentCtx.plugin(StandingPrompt, {
      baseDir: this.config.baseDir,
      files: this.config.memoryFiles,
      required: this.config.memoryRequired,
      complete: true,
    })
    await agentCtx.plugin(CurrentTime, { timeZone: 'Asia/Shanghai' })
    if (agentCtx.get('compaction') === undefined) await agentCtx.plugin(BasicCompactionEngine, { auto: true })
    agentCtx.effect(() => agentCtx.tools.restrict({ allow: [] }), 'elysia-subconscious.memory-global-tool-denial()')
    await agentCtx.plugin(FileCapabilities, {
      baseDir: this.config.baseDir,
      files: this.config.memoryFiles,
      required: this.config.memoryRequired,
      workspaceDir: this.config.memoryWorkspaceDir,
      backupDir: this.config.memoryBackupDir,
    })
    await guardStandingPromptWrites(agentCtx, {
      baseDir: this.config.baseDir, files: this.config.memoryFiles, workspaceDir: this.config.memoryWorkspaceDir,
    })
    agentCtx.effect(() => agentCtx.tools.register(defineSubconsciousReportTool(this.store, this.config.memoryWorkspaceDir)),
      'elysia-subconscious.memory-report-tool()')
    isolateMemoryContext(agentCtx, agent, this.store)
    composed.add(agentCtx)
  }

  private ensure(): Promise<AgentHandle> {
    this.handlePromise ??= (async () => {
      const live = this.ctx.agents.get(MEMORY_SESSION_ID)
      if (live !== undefined) {
        // External Session operations (for example model selection) may attach the durable
        // Session through a fresh plugin scope. Reapply the complete isolation composition
        // instead of either adopting unscoped tools or permanently deadlocking its Assignments.
        await this.setup(live.ctx, live)
        return { agent: live, dispose: async () => {} }
      }
      const agentOptions = this.ctx.agentDefaultModel.currentSelection()
      const setup = (agentCtx: Context, agent: Agent): Promise<void> => this.setup(agentCtx, agent)
      try {
        return await this.ctx.agents.resume({
          resumeSessionId: MEMORY_SESSION_ID,
          agentOptions: { ...agentOptions },
          setup: (agentCtx, agent) => {
            restoreDirectSessionModel(agent, MEMORY_SESSION_ID)
            return setup(agentCtx, agent)
          },
        })
      } catch (error) {
        const concurrent = this.ctx.agents.get(MEMORY_SESSION_ID)
        if (concurrent !== undefined) {
          await this.setup(concurrent.ctx, concurrent)
          return { agent: concurrent, dispose: async () => {} }
        }
        if (!(error instanceof SessionPersistenceNotFoundError)) throw error
        return await this.ctx.agents.create({
          sessionId: MEMORY_SESSION_ID, agentOptions, setup, meta: { cwd: this.config.memoryWorkspaceDir },
        })
      }
    })().catch(error => {
      this.handlePromise = undefined
      throw error
    })
    return this.handlePromise
  }

  /** 供其它插件在需要真实会话时获取，返回已装配完成的 Agent。 */
  async ensureAgent(): Promise<Agent> {
    const { agent } = await this.ensure()
    return agent
  }

  private async completedTurn(assignmentId: string, deliveryId: string, from: number): Promise<boolean> {
    const reader = await this.ctx.sessionPersistence.open(MEMORY_SESSION_ID, 'read')
    try {
      let offset = from
      let received = false
      for (;;) {
        const { events } = await reader.read(offset, 512)
        if (events.length === 0) return false
        for (const event of events) {
          if (event.type === 'turn/start') received = false
          if (event.type === 'user/message' && isTaskMessage(event.data, assignmentId, deliveryId)) received = true
          if (event.type === 'turn/end') {
            if (received && event.data.reason.kind === 'completed') return true
            received = false
          }
        }
        offset += events.length
      }
    } finally {
      await reader.close()
    }
  }

  private async deliver(agent: Agent, assignmentId: string, deliveryId: string, content: ContentBlock[]): Promise<void> {
    await agent.whenIdle()
    if (await this.completedTurn(assignmentId, deliveryId, 0)) return
    for (const message of agent.inbox.nextTurn) {
      if (isTaskMessage(message, assignmentId, deliveryId)) agent.inbox.remove(message.id)
    }
    const from = agent.session.seq
    agent.followup(createUserMessage({ content, source: taskMessageSource(assignmentId, deliveryId) }))
    await agent.whenIdle()
    await this.ctx.sessions.flush(agent.session)
    // A durable terminal Report is stronger evidence than the later turn receipt: the model
    // may overflow after successfully writing its outputs and submitting that Report.
    if (this.store.getReportByAssignment(assignmentId) !== undefined) return
    if (!await this.completedTurn(assignmentId, deliveryId, from)) {
      throw new Error(`记忆 Assignment ${assignmentId} 没有正常结束的 DSH 轮次`)
    }
  }

  async run(assignmentId: string): Promise<void> {
    if (this.store.getReportByAssignment(assignmentId) !== undefined) return
    const pkg = this.store.getTaskPackage(assignmentId)
    const budget = new AssignmentRunBudget(assignmentId, pkg.mandate.maxRunMs)
    const work = (async () => {
      const { agent } = await this.ensure()
      if (budget.hit) return
      budget.beginDelivery()
      await this.deliver(agent, assignmentId, pkg.assignment.deliveryId,
        taskContent(pkg.task, pkg.assignment, pkg.mandate, pkg.observations))
      // 超时后的旧 run 不再推进 Task 状态；下一次投递会重新走完整流程。
      if (budget.hit || this.store.getReportByAssignment(assignmentId) !== undefined) return
      this.store.markReportPending(assignmentId)
      await this.deliver(agent, assignmentId, `${pkg.assignment.deliveryId}:reminder`,
        reminderContent(pkg.task, pkg.assignment))
      if (budget.hit) return
      if (this.store.getReportByAssignment(assignmentId) === undefined) this.store.failMissingReport(assignmentId)
    })().finally(() => budget.markSettled())
    try {
      await Promise.race([work, budget.expired])
    } finally {
      budget.clear()
    }
  }

  async dispose(): Promise<void> {
    const handle = await this.handlePromise?.catch(() => undefined)
    this.handlePromise = undefined
    await handle?.dispose()
  }
}

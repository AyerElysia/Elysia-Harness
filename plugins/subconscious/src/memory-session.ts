import { mkdir } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic'
import { createUserMessage, type ContentBlock, type UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionPersistenceNotFoundError } from '@deepseek-ai/dsh-session-persistence'
import * as StandingPrompt from '@elysia/conscious-mind/standing-prompts'
import * as CurrentTime from '@elysia/conscious-mind/current-time'
import * as FileCapabilities from '@elysia/conscious-mind/file-capabilities'
import { restoreDirectSessionModel } from '@elysia/conscious-mind/src/restore-direct-session-model.ts'
import type { Config } from './config.ts'
import { MEMORY_SESSION_ID, reminderContent, taskContent, taskMessageSource } from './dispatch.ts'
import type { DispatchStore } from './dispatch-store.ts'
import { defineSubconsciousReportTool } from './dispatch-tools.ts'
import { guardStandingPromptWrites } from './general-capabilities.ts'

const contextSources = new Set(['agent-instructions', 'runtime-context'])
const composed = new WeakSet<Context>()

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
        if (!composed.has(live.ctx)) throw new Error('已存在的记忆 Session 没有本插件的提示词与工具隔离装配')
        this.selectModel(live)
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
          if (!composed.has(concurrent.ctx)) throw new Error('并发恢复的记忆 Session 作用域不符', { cause: error })
          this.selectModel(concurrent)
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
    if (!await this.completedTurn(assignmentId, deliveryId, from)) {
      throw new Error(`记忆 Assignment ${assignmentId} 没有正常结束的 DSH 轮次`)
    }
  }

  async run(assignmentId: string): Promise<void> {
    if (this.store.getReportByAssignment(assignmentId) !== undefined) return
    const { task, assignment, mandate, observations } = this.store.getTaskPackage(assignmentId)
    const { agent } = await this.ensure()
    await this.deliver(agent, assignmentId, assignment.deliveryId, taskContent(task, assignment, mandate, observations))
    if (this.store.getReportByAssignment(assignmentId) !== undefined) return
    this.store.markReportPending(assignmentId)
    await this.deliver(agent, assignmentId, `${assignment.deliveryId}:reminder`, reminderContent(task, assignment))
    if (this.store.getReportByAssignment(assignmentId) === undefined) this.store.failMissingReport(assignmentId)
  }

  async dispose(): Promise<void> {
    const handle = await this.handlePromise?.catch(() => undefined)
    this.handlePromise = undefined
    await handle?.dispose()
  }
}

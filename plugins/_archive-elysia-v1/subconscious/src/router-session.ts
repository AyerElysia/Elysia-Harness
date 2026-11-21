import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionPersistenceNotFoundError } from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import * as StandingPrompt from '@elysia/conscious-mind/standing-prompts'
import * as CurrentTime from '@elysia/conscious-mind/current-time'
import { hasRecordedModelSelection, restoreDirectSessionModel } from '@elysia/conscious-mind/src/restore-direct-session-model.ts'
import type { Config } from './config.ts'
import { batchContent, ROUTER_SESSION_ID, routerMessageSource, routerReportSource, type RouterBatch } from './model.ts'
import type { RouterStore } from './store.ts'
import type { DispatchStore } from './dispatch-store.ts'
import { reportContent } from './dispatch.ts'
import { defineSubconsciousDispatchTool } from './dispatch-tools.ts'
import { mountGeneralCapabilities } from './general-capabilities.ts'

const contextSources = new Set(['agent-instructions', 'runtime-context'])
const composed = new WeakSet<Context>()

function isBatchMessage(message: UserMessage, batchId: string): boolean {
  return message.source.kind === 'elysia-subconscious-router' && message.source.batchId === batchId
}

function isReportMessage(message: UserMessage, reportId: string): boolean {
  return message.source.kind === 'elysia-subconscious-router' && message.source.reportId === reportId
}

function isolateRouterContext(agentCtx: Context, agent: Agent, store: RouterStore): void {
  const restore = agentCtx.systemPrompt.suppressRuntimeContext()
  agentCtx.effect(() => restore, 'elysia-subconscious.runtime-context()')
  agentCtx.effect(() => agentCtx.root.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (decision.kind === 'reject' || payload.agent.id !== ROUTER_SESSION_ID) return decision
    for (const message of decision.messages) {
      if (message.role !== 'user' || message.source.kind !== 'elysia-subconscious-router' || message.source.batchId === undefined) continue
      store.markPresented(message.source.batchId, payload.turn, payload.step)
    }
    return {
      ...decision,
      messages: decision.messages.filter(message => !(message.role === 'user' && contextSources.has(message.source.kind))),
    }
  }, { prepend: true }), 'elysia-subconscious.context-filter()')
  for (const seq of [...agent.session.surface.nodes]) {
    const event = agent.session.eventAt(seq)
    if (event?.type !== 'user/message' || !contextSources.has(event.data.source.kind) || event.data.content.length === 0) continue
    agent.session.append('user/message', createUserMessage({ content: [], source: event.data.source }), {
      surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq }, sourceEventSeqs: [seq],
    })
  }
}

export class RouterSession {
  private handlePromise: Promise<AgentHandle> | undefined
  private activeTrigger: string | undefined

  constructor(
    private readonly ctx: Context,
    private readonly config: Required<Config>,
    private readonly store: RouterStore,
    private readonly dispatch: DispatchStore,
  ) {
    ctx.effect(() => ctx.root.on('session/event', (session, event) => {
      if (session.id !== ROUTER_SESSION_ID || event.type !== 'user/message') return
      const batchId = event.data.source.kind === 'elysia-subconscious-router' ? event.data.source.batchId : undefined
      if (batchId !== undefined) store.markAccepted(batchId, event.seq, event.time)
    }), 'elysia-subconscious.delivery-accepted()')
  }

  currentTrigger(): string | undefined {
    return this.activeTrigger
  }

  private selectModel(agent: Agent): void {
    // The configured route is the default for a fresh Router, never a per-batch override:
    // a Session that already recorded a route (Client choice, earlier default, resume) keeps it.
    if (hasRecordedModelSelection(agent)) return
    agent.model.select({ provider: this.config.provider, model: this.config.model })
  }

  private async setup(agentCtx: Context, agent: Agent): Promise<void> {
    this.selectModel(agent)
    if (composed.has(agentCtx)) return
    await agentCtx.plugin(StandingPrompt, {
      baseDir: this.config.baseDir,
      files: this.config.files,
      required: this.config.required,
      complete: true,
    })
    await agentCtx.plugin(CurrentTime, { timeZone: 'Asia/Shanghai' })
    if (agentCtx.get('compaction') === undefined) await agentCtx.plugin(BasicCompactionEngine, { auto: true })
    agentCtx.effect(() => agentCtx.tools.restrict({ allow: [] }), 'elysia-subconscious.global-tool-denial()')
    await mountGeneralCapabilities(agentCtx, this.config)
    agentCtx.effect(() => agentCtx.tools.register(defineSubconsciousDispatchTool(this.dispatch, () => this.activeTrigger)),
      'elysia-subconscious.dispatch-tool()')
    isolateRouterContext(agentCtx, agent, this.store)
    composed.add(agentCtx)
  }

  private ensure(): Promise<AgentHandle> {
    this.handlePromise ??= (async () => {
      const live = this.ctx.agents.get(ROUTER_SESSION_ID)
      if (live !== undefined) {
        // Manual compaction and other external Session operations may reattach the durable
        // Router through a fresh plugin scope. Restore our complete composition in place.
        await this.setup(live.ctx, live)
        return { agent: live, dispose: async () => {} }
      }
      const agentOptions = this.ctx.agentDefaultModel.currentSelection()
      const setup = (agentCtx: Context, agent: Agent): Promise<void> => this.setup(agentCtx, agent)
      try {
        return await this.ctx.agents.resume({
          resumeSessionId: ROUTER_SESSION_ID,
          agentOptions: { ...agentOptions },
          setup: (agentCtx, agent) => {
            restoreDirectSessionModel(agent, ROUTER_SESSION_ID)
            return setup(agentCtx, agent)
          },
        })
      } catch (error) {
        const concurrent = this.ctx.agents.get(ROUTER_SESSION_ID)
        if (concurrent !== undefined) {
          await this.setup(concurrent.ctx, concurrent)
          return { agent: concurrent, dispose: async () => {} }
        }
        if (!(error instanceof SessionPersistenceNotFoundError)) throw error
        return await this.ctx.agents.create({
          sessionId: ROUTER_SESSION_ID, agentOptions, setup, meta: { cwd: this.config.workspaceDir },
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

  private async completedTurn(from: number, matches: (message: UserMessage) => boolean): Promise<{ turn: number; completedAt: number } | undefined> {
    const reader = await this.ctx.sessionPersistence.open(ROUTER_SESSION_ID, 'read')
    try {
      let offset = from
      let received = false
      for (;;) {
        const { events } = await reader.read(offset, 512)
        if (events.length === 0) return undefined
        for (const event of events) {
          if (event.type === 'turn/start') received = false
          if (event.type === 'user/message' && matches(event.data)) received = true
          if (event.type === 'turn/end') {
            if (received && event.data.reason.kind === 'completed') return { turn: event.data.turn, completedAt: event.time }
            received = false
          }
        }
        offset += events.length
      }
    } finally {
      await reader.close()
    }
  }

  /** Deliver observations and accept the native completed turn as the batch receipt. */
  async run(batch: RouterBatch): Promise<{ turn: number; completedAt: number }> {
    const { agent } = await this.ensure()
    await agent.whenIdle()
    const matches = (message: UserMessage): boolean => isBatchMessage(message, batch.id)
    if (batch.state === 'presenting' || batch.state === 'presented') {
      await this.ctx.sessions.flush(agent.session)
      const completed = await this.completedTurn(0, matches)
      if (completed !== undefined) return completed
      for (const message of agent.inbox.nextTurn) {
        if (isBatchMessage(message, batch.id)) agent.inbox.remove(message.id)
      }
    }
    const from = agent.session.seq
    this.activeTrigger = `batch/${batch.id}`
    try {
      agent.followup(createUserMessage({ content: batchContent(batch), source: routerMessageSource(batch.id) }))
      await agent.whenIdle()
      await this.ctx.sessions.flush(agent.session)
      const completed = await this.completedTurn(from, matches)
      if (completed === undefined) throw new Error(`Router 批次 ${batch.id} 没有正常结束的 DSH 轮次`)
      return completed
    } finally {
      this.activeTrigger = undefined
    }
  }

  /** Relay a persisted specialist report into the same long Router identity. */
  async runReport(reportId: string): Promise<{ turn: number; completedAt: number }> {
    const report = this.dispatch.getReport(reportId)
    if (report === undefined) throw new Error(`Report ${reportId} 不存在`)
    const task = this.dispatch.getTask(report.taskId)
    if (task === undefined) throw new Error(`Report ${reportId} 的原任务不存在`)
    const { agent } = await this.ensure()
    await agent.whenIdle()
    const matches = (message: UserMessage): boolean => isReportMessage(message, reportId)
    await this.ctx.sessions.flush(agent.session)
    const existing = await this.completedTurn(0, matches)
    if (existing !== undefined) return existing
    for (const message of agent.inbox.nextTurn) {
      if (isReportMessage(message, reportId)) agent.inbox.remove(message.id)
    }
    const from = agent.session.seq
    this.activeTrigger = `report/${reportId}`
    try {
      agent.followup(createUserMessage({ content: reportContent(report, task), source: routerReportSource(reportId) }))
      await agent.whenIdle()
      await this.ctx.sessions.flush(agent.session)
      const completed = await this.completedTurn(from, matches)
      if (completed === undefined) throw new Error(`Report ${reportId} 没有正常结束的 Router 轮次`)
      return completed
    } finally {
      this.activeTrigger = undefined
    }
  }

  async dispose(): Promise<void> {
    const handle = await this.handlePromise?.catch(() => undefined)
    this.handlePromise = undefined
    await handle?.dispose()
  }
}

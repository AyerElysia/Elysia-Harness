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
import { restoreDirectSessionModel } from '@elysia/conscious-mind/src/restore-direct-session-model.ts'
import type { Config } from './config.ts'
import { batchContent, ROUTER_SESSION_ID, routerMessageSource, type RouterBatch } from './model.ts'
import type { RouterStore } from './store.ts'
import { mountGeneralCapabilities } from './general-capabilities.ts'

const contextSources = new Set(['agent-instructions', 'runtime-context'])
const composed = new WeakSet<Context>()

function isBatchMessage(message: UserMessage, batchId: string): boolean {
  return message.source.kind === 'elysia-subconscious-router' && message.source.batchId === batchId
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

  constructor(private readonly ctx: Context, private readonly config: Required<Config>, private readonly store: RouterStore) {
    ctx.effect(() => ctx.root.on('session/event', (session, event) => {
      if (session.id !== ROUTER_SESSION_ID || event.type !== 'user/message') return
      const batchId = event.data.source.kind === 'elysia-subconscious-router' ? event.data.source.batchId : undefined
      if (batchId !== undefined) store.markAccepted(batchId, event.seq, event.time)
    }), 'elysia-subconscious.delivery-accepted()')
  }

  private selectModel(agent: Agent): void {
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
    // The Web profile already owns the shared compaction service. Only an
    // isolated host without one needs the Router-local fallback.
    if (agentCtx.get('compaction') === undefined) {
      await agentCtx.plugin(BasicCompactionEngine, { auto: true })
    }
    // Hide unrelated Host-global tools; native capabilities mount explicitly below.
    agentCtx.effect(() => agentCtx.tools.restrict({ allow: [] }), 'elysia-subconscious.global-tool-denial()')
    await mountGeneralCapabilities(agentCtx, this.config)
    isolateRouterContext(agentCtx, agent, this.store)
    composed.add(agentCtx)
  }

  private ensure(): Promise<AgentHandle> {
    this.handlePromise ??= (async () => {
      const live = this.ctx.agents.get(ROUTER_SESSION_ID)
      if (live !== undefined) {
        if (!composed.has(live.ctx)) throw new Error('已存在的 Router 实例没有本插件的提示词与工具隔离装配')
        this.selectModel(live)
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
          if (!composed.has(concurrent.ctx)) throw new Error('并发恢复的 Router 实例作用域不符', { cause: error })
          this.selectModel(concurrent)
          return { agent: concurrent, dispose: async () => {} }
        }
        // Never disguise setup, corruption, or ownership failures as a first run.
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

  private async completedTurn(batchId: string, from: number): Promise<{ turn: number; completedAt: number } | undefined> {
    const reader = await this.ctx.sessionPersistence.open(ROUTER_SESSION_ID, 'read')
    try {
      let offset = from
      let received = false
      for (;;) {
        const { events } = await reader.read(offset, 512)
        if (events.length === 0) return undefined
        for (const event of events) {
          if (event.type === 'turn/start') received = false
          if (event.type === 'user/message' && isBatchMessage(event.data, batchId)) received = true
          if (event.type === 'turn/end') {
            if (received && event.data.reason.kind === 'completed') {
              return { turn: event.data.turn, completedAt: event.time }
            }
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
    if (batch.state === 'presenting' || batch.state === 'presented') {
      await this.ctx.sessions.flush(agent.session)
      const completed = await this.completedTurn(batch.id, 0)
      if (completed !== undefined) return completed
      // If DSH did not finish the original turn, retry the same stable batch ID.
      for (const message of agent.inbox.nextTurn) {
        if (isBatchMessage(message, batch.id)) agent.inbox.remove(message.id)
      }
    }
    const from = agent.session.seq
    agent.followup(createUserMessage({ content: batchContent(batch), source: routerMessageSource(batch.id) }))
    await agent.whenIdle()
    await this.ctx.sessions.flush(agent.session)
    const completed = await this.completedTurn(batch.id, from)
    if (completed === undefined) throw new Error(`Router 批次 ${batch.id} 没有正常结束的 DSH 轮次`)
    return completed
  }

  async dispose(): Promise<void> {
    const handle = await this.handlePromise?.catch(() => undefined)
    this.handlePromise = undefined
    await handle?.dispose()
  }
}

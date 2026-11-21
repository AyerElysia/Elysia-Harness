import type { Context, Fiber } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { defaultParticipants } from './participants.ts'
import { SessionCommunication } from './runtime.ts'

export const name = 'elysia-session-communication'
export const inject = ['agents', 'attachments', 'llm', 'sessionQuery', 'sessions'] as const

export interface Config {
  stateDir: string
  maxPending?: number
}

export const Config: z<Config> = z.object({
  stateDir: z.string().required(),
  maxPending: z.number().step(1).min(1).max(10000).default(256),
})

const output = {
  schema: { type: 'json' as const },
  render: (_args: unknown, value: JsonValue) => [{ type: 'text' as const, text: JSON.stringify(value) }],
}

async function result(work: () => Promise<unknown>): Promise<JsonValue> {
  try {
    return JSON.parse(JSON.stringify({ ok: true, value: await work() })) as JsonValue
  } catch (error) {
    const e = error as Error & { code?: unknown; retryable?: unknown }
    if (typeof e?.code === 'string' && typeof e.retryable === 'boolean') {
      return { ok: false, error: { code: e.code, message: e.message, retryable: e.retryable } }
    }
    return { ok: false, error: { code: 'SERVICE_UNAVAILABLE', message: '通讯操作暂时无法完成', retryable: true } }
  }
}

function registerTools(ctx: Context, service: SessionCommunication): void {
  ctx.tools.register(defineTool({
    name: 'session_list',
    description: '列出可以直接通讯和互读历史的爱莉会话，包含别名、状态及能力。',
    parameters: {
      query: { type: 'string', description: '可选的会话名称过滤' },
      limit: { type: 'integer', description: '每页条数，默认 20，范围 1–50' },
      cursor: { type: 'string', description: '上次返回的续页游标' },
    },
    output,
    isConcurrencySafe: () => true,
    execute: (args, exec) => result(() => service.list(exec.agent, args, exec.signal)),
  }))
  ctx.tools.register(defineTool({
    name: 'session_send',
    description: '直接给 main、router 或 memory 发送内部消息，宿主保存消息并排入目标的下一轮。回复时用 reply_to 引用收到的消息 ID。',
    parameters: {
      target: { type: 'string', required: true, description: '目标会话的别名或固定 ID' },
      content: {
        type: 'array', required: true,
        items: { oneOf: [
          { type: 'object', additionalProperties: false, properties: {
            type: { type: 'string', const: 'text', required: true },
            text: { type: 'string', required: true },
          } },
          { type: 'object', additionalProperties: false, properties: {
            type: { type: 'string', const: 'attachment_ref', required: true },
            ref: { type: 'string', required: true, description: '本会话收到的原生 attachmentId' },
          } },
        ] },
      },
      reply_to: { type: 'string', description: '收到的内部消息 ID' },
      conversation_id: { type: 'string', description: '已知的讨论 ID，回复时可省略' },
      idempotency_key: { type: 'string', description: '需要重试同一发送意图时复用的标识' },
    },
    output,
    execute: (args, exec) => result(() => {
      const turn = exec.agent === undefined ? undefined : ctx.reflect.get('agents', false)?.turnBoundaryOf(exec.agent.session)
      const identity = [turn?.lastTurn, turn?.lastStepStartSeq, exec.callId].join(':')
      return service.send(exec.agent, args, identity, exec.signal)
    }),
  }))
  ctx.tools.register(defineTool({
    name: 'session_read',
    description: '按需读取已登记会话的状态、可见历史或工具事件。读取离线会话不会唤醒它。用 message 视图查看内部消息交付证据。',
    parameters: {
      target: { type: 'string', required: true, description: '目标会话的别名或固定 ID' },
      view: { type: 'string', enum: ['info', 'history', 'event', 'search', 'message'], description: '默认 history' },
      message_id: { type: 'string', description: 'message 视图要查询的通讯消息 ID' },
      event_seq: { type: 'integer', description: 'event 视图要查询的原始事件序号' },
      seq_from: { type: 'integer', description: '起始事件序号，包含端点' },
      seq_to: { type: 'integer', description: '末尾事件序号，包含端点' },
      event_types: { type: 'array', items: { type: 'string', enum: ['user/message', 'assistant/message', 'tool/call', 'tool/result'] } },
      query: { type: 'string', description: 'search 视图字面查询词' },
      limit: { type: 'integer', description: '每页条数，默认 20，范围 1–50' },
      cursor: { type: 'string', description: '上次返回的续页游标，保留原查询条件' },
    },
    output,
    isConcurrencySafe: () => true,
    execute: (args, exec) => result(() => service.read(exec.agent, args, exec.signal)),
  }))
}

export async function apply(ctx: Context, config: Config): Promise<void> {
  const service = new SessionCommunication(ctx, defaultParticipants, config.stateDir, config.maxPending ?? 256)
  const mounted = new Map<Agent, Promise<Fiber>>()
  const mount = async (agent: Agent): Promise<void> => {
    if (!defaultParticipants.some(peer => peer.sessionId === agent.id && peer.enabled !== false)) return
    if (mounted.has(agent)) { await mounted.get(agent); return }
    const loading = Promise.resolve(agent.ctx.plugin({
      name: 'elysia-session-communication-tools',
      inject: ['tools'],
      apply: (agentCtx: Context) => registerTools(agentCtx, service),
    }))
    mounted.set(agent, loading)
    try { await loading } catch (error) { mounted.delete(agent); throw error }
  }
  ctx.effect(() => async () => {
    await Promise.allSettled([...mounted.values()].map(async loading => (await loading).dispose()))
    await service.dispose()
  }, 'elysia-session-communication.dispose')
  ctx.on('agent/created', async ({ agent }) => { await mount(agent); return undefined })
  ctx.on('agent/disposed', ({ agent }) => { mounted.delete(agent) })
  ctx.on('agent/inbox/claimed', ({ agent, message, turn }) => service.claim(agent, message, turn))
  ctx.on('session/event', (session, event) => service.event(session.id, event))
  ctx.on('llm/stream', async function* (options, next) {
    let observed = false
    for await (const chunk of next()) {
      if (!observed && (chunk.type !== 'finish' || (chunk.reason.kind !== 'error' && chunk.reason.kind !== 'aborted'))) {
        observed = true
        service.presented(options.sessionId, options.messages)
      }
      yield chunk
    }
  })
  await Promise.all(ctx.agents.list().map(mount))
  service.start()
}

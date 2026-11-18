import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { Participant } from './types.ts'

const MAIN_SESSION_ID = 'elysia-conscious-mind'
const ROUTER_SESSION_ID = 'elysia-subconscious-router'

export const defaultParticipants: readonly Participant[] = [
  { alias: 'main', sessionId: MAIN_SESSION_ID, name: '主意识', role: '主意识与对外表达' },
  { alias: 'router', sessionId: ROUTER_SESSION_ID, name: '潜意识中枢', role: '潜意识协调' },
  { alias: 'memory', sessionId: 'elysia-subconscious-memory', name: '记忆潜意识', role: '回顾经历与整理记忆' },
]

interface RouterOwner {
  readonly session: { ensureExisting(): Promise<Agent> }
  readonly store: { resting(): boolean }
}

function failure(code: string, message: string, retryable: boolean): Error {
  return Object.assign(new Error(message), { code, retryable })
}

/** Resolve participants through their existing owners without acquiring their lifetime. */
export class ParticipantSessions {
  private disposed = false

  constructor(private readonly ctx: Context) {}

  async ensure(participant: Participant): Promise<Agent> {
    if (this.disposed) throw failure('RESTORE_FAILED', '通讯插件已停止', false)
    if (participant.enabled === false) throw failure('TARGET_DISABLED', '目标会话已停用', false)
    const id = participant.sessionId as SessionId
    if (participant.sessionId === ROUTER_SESSION_ID) {
      const owner = this.ctx.reflect.get('subconsciousRouter', false) as RouterOwner | undefined
      if (owner === undefined) throw failure('RESTORE_FAILED', '潜意识中枢宿主尚未就绪', true)
      if (owner.store?.resting()) throw failure('TARGET_RESTING', '目标会话休息中，消息保留待投递', true)
      return owner.session.ensureExisting()
    }
    const live = this.ctx.agents.get(id)
    if (live !== undefined) return live
    if (participant.sessionId === MAIN_SESSION_ID) {
      // The conscious-mind owner preheats and retries its scoped composition.
      // Generic API resume here could steal the identity under the wrong preset.
      throw failure('RESTORE_FAILED', '主意识宿主正在恢复，请稍后继续投递', true)
    }
    const result = await this.ctx.sessionController.resolveAgent(id)
    if ('error' in result) {
      const absent = result.error.code === 'session/not-found'
      throw failure(absent ? 'TARGET_NOT_FOUND' : 'RESTORE_FAILED', result.error.message, !absent)
    }
    return result.agent
  }

  async dispose(): Promise<void> {
    this.disposed = true
  }
}

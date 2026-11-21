/** Require user confirmation before a local DSH turn delivers to an external channel. */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { splitOutboundText } from './send-text.ts'

/** The optional native user-questions service already mounted by the Web bundle. */
interface UserQuestions {
  ask(request: {
    agent: Agent
    signal: AbortSignal
    questions: {
      id: string
      header: string
      question: string
      detail: string
      options: { label: string }[]
    }[]
  }): Promise<{ answers: { id: string; selected: string[]; custom?: string }[] }>
}

const APPROVE = '确认发送'
const LOCAL_REPLY = '当前输入来自 DSH。普通回应直接写在当前会话正文。只有用户明确指定外部渠道和收件人并要求发送时，才可以请求确认。'
const UNCONFIRMED = '外发未获本次确认，未发送。'

function literal(text: string): string {
  let width = 3
  for (const match of text.matchAll(/~+/g)) width = Math.max(width, match[0].length + 1)
  const fence = '~'.repeat(width)
  return `${fence}text
${text}
${fence}`
}

export function installLocalSendConfirmation(ctx: Context, isLocalTurn: (agent: Agent) => boolean): () => void {
  const lifetime = new AbortController()
  const permitted = new WeakSet<ToolExecution['token']>()
  const localAgent = (exec: ToolExecution): Agent | undefined => {
    const agent = exec.agent
    return agent?.ctx === ctx && (exec.name === 'send_text' || exec.name === 'send_voice') && isLocalTurn(agent)
      ? agent : undefined
  }
  const removeGuard = ctx.tools.guard(exec => {
    if (localAgent(exec) === undefined || permitted.delete(exec.token)) return
    return LOCAL_REPLY
  })
  const removeAsk = ctx.on('tools/pre-execute', async (exec, next) => {
    const agent = localAgent(exec)
    const args = exec.arguments
    if (agent === undefined || args === null || typeof args !== 'object'
      || !('explicit_request' in args) || args.explicit_request !== true) return next()

    const decision = await next()
    if (decision.kind !== 'allow') return decision
    if (exec.signal.aborted || lifetime.signal.aborted) return { kind: 'cancel' }

    const channel = 'channel' in args && typeof args.channel === 'string' ? args.channel.trim() : ''
    const conversation = 'conversation' in args && typeof args.conversation === 'string' ? args.conversation.trim() : ''
    const voice = exec.name === 'send_voice'
    const outbound = voice ? ctx.get('outboundVoice') : ctx.get('outboundText')
    if (!outbound?.sender(channel) || !conversation || /[\p{Cc}\p{Cf}]/u.test(conversation)) {
      return { kind: 'deny', reason: '外发确认需要已登记的渠道及有效的会话 ID，未发送。' }
    }

    const body = voice
      ? 'text' in args && typeof args.text === 'string' ? args.text.trim() : ''
      : 'content' in args && typeof args.content === 'string' ? splitOutboundText(args.content).join('\n') : ''
    if (!body) return { kind: 'deny', reason: '外发正文为空，未发送。' }
    const questions = ctx.reflect.get('userQuestions') as UserQuestions | undefined
    if (questions === undefined) return { kind: 'deny', reason: '当前没有可用的用户确认界面，未发送。' }

    const id = randomUUID()
    const replyTo = !voice && 'reply_to' in args && typeof args.reply_to === 'string' ? args.reply_to.trim() : ''
    const expression = voice && 'expression_instruction' in args && typeof args.expression_instruction === 'string'
      ? args.expression_instruction.trim() : ''
    const target = [`渠道：${channel}`, `会话：${conversation}`, ...(replyTo ? [`引用消息：${replyTo}`] : [])].join('\n')
    const detail = [literal(target), voice ? '语音正文' : '每行发送为一条消息', literal(body),
      ...(expression ? ['语气说明', literal(expression)] : [])].join('\n\n')
    const signal = AbortSignal.any([exec.signal, lifetime.signal, AbortSignal.timeout(60_000)])
    try {
      const answer = await questions.ask({
        agent, signal,
        questions: [{
          id, header: '外部发送', question: voice ? '确认向以下会话发送语音？' : '确认向以下会话发送文字？',
          detail, options: [{ label: APPROVE }, { label: '取消' }],
        }],
      })
      if (exec.signal.aborted || lifetime.signal.aborted || localAgent(exec) !== agent) return { kind: 'cancel' }
      const [choice] = answer.answers
      if (!signal.aborted && answer.answers.length === 1 && choice?.id === id
        && choice.selected.length === 1 && choice.selected[0] === APPROVE && (choice.custom === undefined || choice.custom === '')) {
        permitted.add(exec.token)
        return decision
      }
    } catch {
      if (exec.signal.aborted || lifetime.signal.aborted) return { kind: 'cancel' }
    }
    return { kind: 'deny', reason: UNCONFIRMED }
  })

  return () => {
    lifetime.abort()
    removeAsk()
    removeGuard()
  }
}

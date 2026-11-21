import { realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { DispatchError, type DispatchStore } from './dispatch-store.ts'
import { MEMORY_SESSION_ID, type DispatchInput, type ReportInput } from './dispatch.ts'

function render(_args: unknown, value: unknown): ContentBlock[] {
  return [{ type: 'text', text: JSON.stringify(value) }]
}

function failure(error: unknown): never {
  if (error instanceof DispatchError) throw new HarnessError(`${error.code}: ${error.message}`, error.code)
  throw error
}

function currentTurn(agent: Agent): number | undefined {
  const events = agent.session.snapshotEvents()
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]!
    if (event.type === 'turn/start') return event.data.turn
  }
  return undefined
}

function under(root: string, target: string): boolean {
  const tail = relative(root, target)
  return tail === '' || (tail !== '..' && !tail.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(tail))
}

async function canonical(path: string): Promise<string> {
  return realpath(path)
}

function assignmentStart(agent: Agent, assignmentId: string): number {
  const event = agent.session.snapshotEvents().find(candidate => candidate.type === 'user/message'
    && candidate.data.source.kind === 'elysia-subconscious-task'
    && candidate.data.source.assignmentId === assignmentId)
  if (event === undefined) throw new DispatchError('ASSIGNMENT_NOT_CURRENT', '当前 Session 中没有对应任务包')
  return event.seq
}

async function fileProduced(agent: Agent, assignmentId: string, target: string, workspaceDir: string): Promise<boolean> {
  const start = assignmentStart(agent, assignmentId)
  for (const event of agent.session.snapshotEvents()) {
    if (event.seq < start || event.type !== 'tool/call' || (event.data.name !== 'write' && event.data.name !== 'edit')) continue
    try {
      const args = JSON.parse(event.data.arguments) as { file_path?: unknown }
      if (typeof args.file_path !== 'string') continue
      const candidate = resolve(workspaceDir, args.file_path)
      if (await canonical(candidate).catch(() => resolve(candidate)) === target) return true
    } catch {
      // Invalid tool records cannot prove production; continue checking other real calls.
    }
  }
  return false
}

function toolProduced(agent: Agent, assignmentId: string, callId: string): boolean {
  const start = assignmentStart(agent, assignmentId)
  return agent.session.snapshotEvents().some(event => event.seq >= start && event.type === 'tool/call'
    && String(event.data.callId) === callId)
}

async function validateReportOutputs(input: ReportInput, agent: Agent, workspaceDir: string): Promise<void> {
  if (agent === undefined || String(agent.session.id) !== String(MEMORY_SESSION_ID)) {
    throw new DispatchError('ASSIGNMENT_NOT_OWNED', '只有记忆专业 Session 可以提交此报告')
  }
  if (input.status === 'dropped') {
    if (input.output_refs.length !== 0) throw new DispatchError('VALIDATION_FAILED', 'dropped 必须传空 output_refs')
    return
  }
  if (input.status === 'completed' && !input.output_refs.some(ref => ref.startsWith('file:'))) {
    throw new DispatchError('ACCEPTANCE_FAILED', 'memory completed 至少需要一个真实文件产物')
  }
  const workspace = await realpath(workspaceDir)
  for (const ref of input.output_refs) {
    if (ref.startsWith('file:')) {
      const supplied = ref.slice('file:'.length)
      if (supplied.length === 0) throw new DispatchError('OUTPUT_NOT_FOUND', '空文件产物引用')
      const target = await canonical(supplied).catch(() => {
        throw new DispatchError('OUTPUT_NOT_FOUND', `文件产物不存在：${supplied}`)
      })
      if (!under(workspace, target)) throw new DispatchError('OUTPUT_NOT_ALLOWED', `文件产物越出记忆工作区：${supplied}`)
      const info = await stat(target)
      if (!info.isFile() || (input.status === 'completed' && info.size === 0)) {
        throw new DispatchError('ACCEPTANCE_FAILED', 'completed 文件产物必须是非空普通文件')
      }
      if (input.status === 'completed' && !await fileProduced(agent, input.assignment_id, target, workspaceDir)) {
        throw new DispatchError('OUTPUT_NOT_PRODUCED_BY_ASSIGNMENT', '文件并非当前 Assignment 实际写入或编辑')
      }
      continue
    }
    if (ref.startsWith('tool:')) {
      if (!toolProduced(agent, input.assignment_id, ref.slice('tool:'.length))) {
        throw new DispatchError('OUTPUT_NOT_FOUND', `工具产物不属于当前 Assignment：${ref}`)
      }
      continue
    }
    throw new DispatchError('OUTPUT_NOT_ALLOWED', `不支持的产物引用：${ref}`)
  }
}

export function defineSubconsciousDispatchTool(store: DispatchStore, activeTrigger: () => string | undefined) {
  return defineTool({
    name: 'subconscious_dispatch',
    description: '把当前批次或报告中的明确材料派给一个已注册的长期专业潜意识 Session。只创建持久任务，不代表任务已经完成。首个可用类型是 memory。不要传权限、目录、模型或渠道字段。',
    parameters: {
      trigger_ref: { type: 'string', required: true, description: '当前输入的 batch/<id> 或 report/<id>，必须照抄当前真实输入。' },
      kind: { type: 'string', required: true, description: '已注册任务类型，目前为 memory。' },
      title: { type: 'string', required: true, description: '简洁任务标题，最长 120 字。' },
      reason: { type: 'string', required: true, description: '为什么这些材料需要形成专业工作。' },
      instruction: { type: 'string', required: true, description: '给记忆 Session 的具体任务，不要求修改主意识提示词或对外发言。' },
      source_refs: {
        type: 'array', required: true, items: { type: 'string' },
        description: '当前输入中 1～20 个 observation/obs_... 来源引用，保持证据顺序。',
      },
    },
    isConcurrencySafe: () => false,
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          task_id: { type: 'string', required: true },
          assignment_id: { type: 'string', required: true },
          kind: { type: 'string', required: true },
          state: { type: 'string', required: true, enum: ['assigned'] },
          idempotent_replay: { type: 'boolean', required: true },
        },
      },
      render,
    },
    async execute(args, exec) {
      try {
        if (exec.agent === undefined || String(exec.agent.session.id) !== 'elysia-subconscious-router') {
          throw new DispatchError('ASSIGNMENT_NOT_OWNED', '只有潜意识 Router 可以派工')
        }
        const input = args as DispatchInput
        const trigger = activeTrigger()
        if (trigger === undefined || trigger !== input.trigger_ref) throw new DispatchError('TRIGGER_NOT_CURRENT', 'trigger_ref 不是当前正在运行的输入')
        return store.createTask(input, {
          triggerRef: trigger,
          sessionId: String(exec.agent.session.id),
          toolCallId: String(exec.callId),
          ...currentTurn(exec.agent) === undefined ? {} : { turn: currentTurn(exec.agent)! },
        })
      } catch (error) {
        failure(error)
      }
    },
  })
}

export function defineSubconsciousReportTool(store: DispatchStore, workspaceDir: string) {
  return defineTool({
    name: 'subconscious_report',
    description: '提交当前记忆 Assignment 的终态报告。completed 必须引用本次真实写入的非空文件；看过但无需写入时使用 dropped 并传空 output_refs。报告保存后会由宿主可靠回传 Router。',
    parameters: {
      task_id: { type: 'string', required: true, description: '当前任务包中的 task_id。' },
      assignment_id: { type: 'string', required: true, description: '当前任务包中的 assignment_id。' },
      status: { type: 'string', required: true, enum: ['completed', 'blocked', 'failed', 'dropped'], description: '本次 Assignment 的真实终态。' },
      summary: { type: 'string', required: true, description: '真实结果、阻塞、失败或无需工作的说明。' },
      output_refs: { type: 'array', required: true, items: { type: 'string' }, description: 'file:<绝对路径> 或 tool:<call id>；没有产物传空数组。' },
    },
    isConcurrencySafe: () => false,
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          report_id: { type: 'string', required: true },
          task_id: { type: 'string', required: true },
          assignment_id: { type: 'string', required: true },
          accepted_status: { type: 'string', required: true, enum: ['completed', 'blocked', 'failed', 'dropped'] },
          relay_state: { type: 'string', required: true },
          idempotent_replay: { type: 'boolean', required: true },
        },
      },
      render,
    },
    async execute(args, exec) {
      try {
        if (exec.agent === undefined) throw new DispatchError('ASSIGNMENT_NOT_OWNED', '缺少专业 Session 上下文')
        const input = args as ReportInput
        await validateReportOutputs(input, exec.agent, workspaceDir)
        const saved = store.saveReport(input, {
          sessionId: String(exec.agent.session.id),
          toolCallId: String(exec.callId),
          ...currentTurn(exec.agent) === undefined ? {} : { turn: currentTurn(exec.agent)! },
        })
        return {
          report_id: saved.report.id,
          task_id: saved.report.taskId,
          assignment_id: saved.report.assignmentId,
          accepted_status: saved.report.status,
          relay_state: saved.relayState,
          idempotent_replay: saved.idempotentReplay,
        }
      } catch (error) {
        failure(error)
      }
    },
  })
}

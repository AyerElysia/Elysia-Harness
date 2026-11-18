import { brandString } from '@deepseek-ai/dsh-brand'
import type { ContentBlock, ContextFormed } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { Observation } from './model.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'elysia-subconscious-task': {
      kind: 'elysia-subconscious-task'
      assignmentId: string
      deliveryId: string
    } & ContextFormed
  }
}

export const MEMORY_SESSION_ID = brandString<SessionId>('elysia-subconscious-memory')
export const DEFAULT_MEMORY_SESSION_CWD = '/home/ayerelysia/Elysia/Data/workspace/subconscious/memory'

export type TaskState = 'assigned' | 'running' | 'report_pending'
  | 'completed' | 'blocked' | 'failed' | 'dropped' | 'cancelled'
export type AssignmentState = 'pending' | 'delivering' | 'running' | 'report_pending' | 'ended' | 'interrupted'
export type ReportStatus = 'completed' | 'blocked' | 'failed' | 'dropped'

export interface Formation {
  triggerRef: string
  sessionId: string
  turn?: number
  toolCallId: string
}

export interface SubconsciousTask {
  id: string
  revision: number
  kind: string
  title: string
  reason: string
  instruction: string
  sourceRefs: string[]
  formation: Formation
  mandateId: string
  dedupeKey: string
  visibilityRef: string
  state: TaskState
  currentAssignmentId: string
  createdAt: number
  updatedAt: number
  closedAt?: number
  closeReason?: string
}

export interface TaskMandate {
  id: string
  taskId: string
  kind: string
  specialist: string
  sessionId: string
  policyVersion: string
  sourceRefs: string[]
  visibilityRef: string
  allowedReadRoots: string[]
  allowedWriteRoots: string[]
  allowedTools: string[]
  allowedOutputKinds: string[]
  maxInputBytes: number
  maxRunMs: number
  createdAt: number
}

export interface TaskAssignment {
  id: string
  taskId: string
  taskRevision: number
  specialist: string
  sessionId: string
  attempt: number
  state: AssignmentState
  deliveryId: string
  inputRefs: string[]
  createdAt: number
  sessionSeq?: number
  acceptedAt?: number
  presentedTurn?: number
  presentedStep?: number
  presentedAt?: number
  endedAt?: number
  lastError?: string
}

export interface TaskReport {
  id: string
  taskId: string
  assignmentId: string
  specialist: string
  sessionId: string
  turn?: number
  toolCallId: string
  status: ReportStatus
  summary: string
  outputRefs: string[]
  requestHash: string
  createdAt: number
}

export interface DispatchInput {
  trigger_ref: string
  kind: string
  title: string
  reason: string
  instruction: string
  source_refs: string[]
}

export interface ReportInput {
  task_id: string
  assignment_id: string
  status: ReportStatus
  summary: string
  output_refs: string[]
}

export interface DispatchHealth {
  tasks: number
  activeTasks: number
  completedTasks: number
  pendingAssignments: number
  pendingReportRelays: number
  failedEffects: number
  lastTaskAt?: string
  lastReportAt?: string
}

export const taskMessageSource = (assignmentId: string, deliveryId: string) => ({
  kind: 'elysia-subconscious-task', form: 'relay', assignmentId, deliveryId,
}) as const

export function taskContent(task: SubconsciousTask, assignment: TaskAssignment, mandate: TaskMandate, observations: Observation[]): ContentBlock[] {
  const content: ContentBlock[] = [{
    type: 'text',
    text: [
      '[subconscious.task]',
      `task_id: ${task.id}`,
      `assignment_id: ${assignment.id}`,
      `kind: ${task.kind}`,
      `title: ${task.title}`,
      `reason: ${task.reason}`,
      `instruction: ${task.instruction}`,
      `visibility: ${task.visibilityRef}`,
      `allowed_outputs: ${mandate.allowedOutputKinds.join(', ')}`,
      '完成实际工作后，必须使用 subconscious_report 提交终态报告。无需写入时使用 dropped。',
    ].join('\n'),
  }]
  for (const observation of observations) {
    content.push({
      type: 'text',
      text: [
        '',
        `[observation/${observation.id}]`,
        `kind: ${observation.kind}`,
        `source: ${observation.source.kind}/${observation.source.instance}`,
        `source_event: ${observation.source.eventId}`,
        `thread: ${observation.threadRefs.join(', ')}`,
        `occurred_at: ${new Date(observation.eventTime).toISOString()}`,
      ].join('\n'),
    })
    content.push(...structuredClone(observation.content))
  }
  return content
}

export function reminderContent(task: SubconsciousTask, assignment: TaskAssignment): ContentBlock[] {
  return [{
    type: 'text',
    text: `[subconscious.task.reminder]\ntask_id: ${task.id}\nassignment_id: ${assignment.id}\n上一轮没有有效终态报告。若工作已经完成，请现在使用 subconscious_report；无需产物时使用 dropped。`,
  }]
}

export function reportContent(report: TaskReport, task: SubconsciousTask): ContentBlock[] {
  return [{
    type: 'text',
    text: [
      '[subconscious.report]',
      `trigger_ref: report/${report.id}`,
      `report_id: ${report.id}`,
      `task_id: ${task.id}`,
      `assignment_id: ${report.assignmentId}`,
      `kind: ${task.kind}`,
      `title: ${task.title}`,
      `status: ${report.status}`,
      `summary: ${report.summary}`,
      `output_refs: ${JSON.stringify(report.outputRefs)}`,
      `source_refs: ${JSON.stringify(task.sourceRefs)}`,
      `specialist_session: ${report.sessionId}`,
      `reported_at: ${new Date(report.createdAt).toISOString()}`,
    ].join('\n'),
  }]
}

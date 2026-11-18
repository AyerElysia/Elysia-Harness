import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { DispatchError, DispatchStore } from '../src/dispatch-store.ts'
import type { DispatchInput } from '../src/dispatch.ts'
import { RouterStore } from '../src/store.ts'

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'elysia-dispatch-store-'))
  const stateDir = join(home, 'state')
  const store = new RouterStore(stateDir)
  const dispatch = new DispatchStore(stateDir, { memoryWorkspaceDir: join(home, 'memory') })
  onTestFinished(async () => {
    dispatch.close()
    store.close()
    await rm(home, { recursive: true, force: true })
  })
  store.recordObservation({
    source: { kind: 'fixture', instance: 'one', eventId: 'event-1' },
    kind: 'external_input', occurredAt: Date.now(), payload: { text: '请记住这件事' },
    content: [{ type: 'text', text: '请记住这件事' }], threadRefs: ['kook:direct:one'], visibilityRef: 'kook:direct:one',
  })
  store.formBatches(20, 65_536)
  const batch = store.nextBatch()!
  const observation = batch.observations[0]!
  const input: DispatchInput = {
    trigger_ref: `batch/${batch.id}`, kind: 'memory', title: '写一篇日记', reason: '这段经历值得留下',
    instruction: '写一篇简短日记并报告', source_refs: [`observation/${observation.id}`],
  }
  const formation = { triggerRef: input.trigger_ref, sessionId: 'elysia-subconscious-router', toolCallId: 'call-1', turn: 1 }
  return { home, store, dispatch, batch, observation, input, formation }
}

function expectCode(work: () => unknown, code: string): void {
  let caught: unknown
  try { work() } catch (error) { caught = error }
  expect(caught).toBeInstanceOf(DispatchError)
  expect((caught as DispatchError).code).toBe(code)
}

it('persists one idempotent Task and rejects an active duplicate', async () => {
  const { dispatch, input, formation } = await fixture()
  const first = dispatch.createTask(input, formation)
  const replay = dispatch.createTask(input, formation)
  expect(first.idempotent_replay).toBe(false)
  expect(replay).toEqual({ ...first, idempotent_replay: true })
  expect(dispatch.listTasks()).toHaveLength(1)
  expectCode(() => dispatch.createTask({ ...input, title: '另一个活动任务' }, { ...formation, toolCallId: 'call-2' }), 'ACTIVE_TASK_EXISTS')
  const bundle = dispatch.getTaskPackage(first.assignment_id)
  expect(bundle.task.title).toBe('写一篇日记')
  expect(bundle.mandate.allowedTools).toContain('subconscious_report')
  expect(bundle.mandate.allowedWriteRoots).toEqual([dispatch.memoryWorkspaceDir])
  expect(bundle.observations[0]?.content).toEqual([{ type: 'text', text: '请记住这件事' }])
})

it('rejects foreign triggers, unregistered kinds, and mixed visibility', async () => {
  const { store, dispatch, input, formation } = await fixture()
  expectCode(() => dispatch.createTask(input, { ...formation, triggerRef: 'batch/batch_other' }), 'TRIGGER_NOT_CURRENT')
  expectCode(() => dispatch.createTask({ ...input, kind: 'learning' }, formation), 'KIND_NOT_REGISTERED')
  store.recordObservation({
    source: { kind: 'fixture', instance: 'one', eventId: 'event-2' },
    kind: 'external_input', occurredAt: Date.now(), payload: { text: '另一个会话' },
    content: [{ type: 'text', text: '另一个会话' }], threadRefs: ['qq:group:two'], visibilityRef: 'qq:group:two',
  })
  store.formBatches(20, 65_536)
  const second = store.listObservations().find(item => item.source.eventId === 'event-2')!
  const currentBatch = store.getBatch(input.trigger_ref.slice('batch/'.length))!
  // The second Observation is not in the current Batch, so it cannot be smuggled into the task.
  expectCode(() => dispatch.createTask({ ...input, source_refs: [...input.source_refs, `observation/${second.id}`] }, formation), 'SOURCE_NOT_ALLOWED')
  expect(currentBatch.observations).toHaveLength(1)
})

it('stores terminal reports idempotently and relays without re-execution', async () => {
  const { dispatch, input, formation } = await fixture()
  const created = dispatch.createTask(input, formation)
  dispatch.markAssignmentPresented(created.assignment_id, 1, 1)
  const reportInput = {
    task_id: created.task_id, assignment_id: created.assignment_id, status: 'dropped' as const,
    summary: '看过以后无需制造日记', output_refs: [],
  }
  const identity = { sessionId: 'elysia-subconscious-memory', toolCallId: 'report-call', turn: 1 }
  const saved = dispatch.saveReport(reportInput, identity)
  const replay = dispatch.saveReport(reportInput, identity)
  expect(saved.report.status).toBe('dropped')
  expect(replay.idempotentReplay).toBe(true)
  expect(replay.report.id).toBe(saved.report.id)
  expectCode(() => dispatch.saveReport({ ...reportInput, status: 'failed' }, identity), 'REPORT_CONFLICT')
  expectCode(() => dispatch.saveReport(reportInput, { ...identity, sessionId: 'other' }), 'ASSIGNMENT_NOT_OWNED')
  expect(dispatch.nextReportRelay()?.id).toBe(saved.report.id)
  dispatch.completeReportRelay(saved.report.id)
  expect(dispatch.nextReportRelay()).toBeUndefined()
  expect(dispatch.getTask(created.task_id)?.state).toBe('dropped')
  expect(dispatch.health()).toMatchObject({ activeTasks: 0, pendingReportRelays: 0 })
})

it('never treats a missing report as successful completion', async () => {
  const { dispatch, input, formation } = await fixture()
  const created = dispatch.createTask(input, formation)
  expect(dispatch.nextAssignment()?.id).toBe(created.assignment_id)
  dispatch.markAssignmentPresented(created.assignment_id, 1, 1)
  dispatch.markReportPending(created.assignment_id)
  dispatch.failMissingReport(created.assignment_id)
  dispatch.completeDelivery(created.assignment_id)
  expect(dispatch.getTask(created.task_id)).toMatchObject({ state: 'failed', closeReason: 'REPORT_MISSING' })
  expect(dispatch.listReports()).toEqual([])
  expect(dispatch.nextAssignment()).toBeUndefined()
  expect(dispatch.health()).toMatchObject({ activeTasks: 0, pendingAssignments: 0 })
})

it('recovers interrupted delivery and uses persisted retry times', async () => {
  const { dispatch, input, formation } = await fixture()
  const created = dispatch.createTask(input, formation)
  expect(dispatch.nextAssignment()?.state).toBe('delivering')
  dispatch.recover()
  expect(dispatch.getAssignment(created.assignment_id)?.state).toBe('interrupted')
  expect(dispatch.nextAssignment()?.id).toBe(created.assignment_id)
  dispatch.failDelivery(created.assignment_id, 'temporary', Date.now() + 60_000)
  expect(dispatch.nextAssignment()).toBeUndefined()
  expect(dispatch.nextWakeAt()).toBeGreaterThan(Date.now())
  expect(dispatch.nextAssignment(Date.now() + 61_000)?.id).toBe(created.assignment_id)
})

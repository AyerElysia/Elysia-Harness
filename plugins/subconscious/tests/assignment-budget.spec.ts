import { expect, it } from 'vitest'
import { AssignmentRunBudget } from '../src/memory-session.ts'

it('lets a run finish inside its wall-clock budget and releases the timer', async () => {
  const budget = new AssignmentRunBudget('assignment_inside_budget', 5_000)
  try {
    await expect(Promise.race([Promise.resolve('done'), budget.expired])).resolves.toBe('done')
    expect(budget.hit).toBe(false)
  } finally {
    budget.clear()
  }
})

it('fails an over-budget run with ASSIGNMENT_TIMEOUT without aborting the session', async () => {
  const budget = new AssignmentRunBudget('assignment_over_budget', 30)
  try {
    const stillRunning = new Promise<void>(() => {})
    const error = await Promise.race([stillRunning, budget.expired]).catch((caught: unknown) => caught)
    expect(error).toMatchObject({ name: 'DispatchError', code: 'ASSIGNMENT_TIMEOUT', retryable: true })
    expect((error as Error).message).toContain('Assignment assignment_over_budget')
    expect((error as Error).message).toMatch(/已用 \d+ms，超过上限 30ms/u)
    expect(budget.hit).toBe(true)
  } finally {
    budget.clear()
  }
})

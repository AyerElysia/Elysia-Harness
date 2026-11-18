import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type { Config } from './config.ts'
import { MAIN_SESSION_ID, type MainSessionEvent } from './model.ts'
import { RouterSession } from './router-session.ts'
import { MemorySession } from './memory-session.ts'
import { RouterStore, type RouterHealth } from './store.ts'
import { DispatchStore } from './dispatch-store.ts'
import type { DispatchHealth } from './dispatch.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    subconsciousRouter: RouterRuntime
  }
}

const backoff = [5000, 30000, 120000, 600000]

/** Durable collector plus serial Batch, Assignment, and Report delivery workers. */
export class RouterRuntime extends Service {
  readonly store: RouterStore
  readonly dispatch: DispatchStore
  readonly session: RouterSession
  readonly memory: MemorySession
  private readonly events: MainSessionEvent[] = []
  private bootstrapPromise: Promise<void> | undefined
  private drainPromise: Promise<void> | undefined
  private workerPromise: Promise<void> | undefined
  private stopped = false
  private bootstrapped = false
  private timer: ReturnType<typeof setTimeout> | undefined
  private timerDue: number | undefined
  private wakeTimer: ReturnType<typeof setTimeout> | undefined
  private wakeup: (() => void) | undefined
  private failures = 0
  private lastErrorText: string | undefined

  constructor(ctx: Context, readonly config: Required<Config>) {
    super(ctx, 'subconsciousRouter')
    this.store = new RouterStore(config.stateDir, config.triggerBatchCount)
    this.dispatch = new DispatchStore(config.stateDir, {
      memoryWorkspaceDir: config.memoryWorkspaceDir,
      maxInputBytes: config.maxBytes,
      maxRunMs: config.assignmentMaxRunMs,
      maxTasksPerTrigger: config.maxTasksPerTrigger,
      maxQueuedTasks: config.maxQueuedTasks,
    })
    this.dispatch.recover()
    this.session = new RouterSession(ctx, config, this.store, this.dispatch)
    this.memory = new MemorySession(ctx, config, this.dispatch)
    ctx.effect(() => ctx.root.on('session/event', (session, event) => {
      if (this.stopped || session.id !== MAIN_SESSION_ID) return
      this.events.push(structuredClone(event))
      if (this.bootstrapped) void this.drainEvents()
    }), 'elysia-subconscious.session-events()')
  }

  start(): void {
    this.bootstrapPromise ??= this.bootstrap()
  }

  private error(error: unknown): void {
    this.lastErrorText = error instanceof Error ? error.message : String(error)
    process.stderr.write(`潜意识 Router：${this.lastErrorText}\n`)
  }

  private async catchUp(): Promise<void> {
    await this.ctx.sessionPersistence.flush()
    const reader = await this.ctx.sessionPersistence.open(MAIN_SESSION_ID, 'read')
    try {
      const existing = this.store.sourceCursor()
      const fresh = existing === undefined
      let offset = existing ?? 0
      for (;;) {
        const { events } = await reader.read(offset, 512)
        if (events.length === 0) break
        if (fresh) this.store.initializeCursor(events.at(-1)!.seq)
        else for (const event of events) this.store.recordEvent(event)
        offset += events.length
      }
      this.store.formBatches(this.config.maxObservations, this.config.maxBytes)
    } finally {
      await reader.close()
    }
  }

  private async bootstrap(): Promise<void> {
    while (!this.stopped) {
      try {
        await this.catchUp()
        this.bootstrapped = true
        this.lastErrorText = undefined
        await this.drainEvents()
        this.kick()
        return
      } catch (error) {
        this.error(error)
        await this.wait(5000)
      }
    }
  }

  private drainEvents(): Promise<void> {
    this.drainPromise ??= (async () => {
      while (!this.stopped && this.events.length > 0) {
        const event = this.events[0]!
        try {
          this.store.recordEvent(event)
          this.events.shift()
        } catch (error) {
          this.error(error)
          await this.wait(5000)
        }
      }
      if (!this.stopped) this.arm(this.config.collectMs)
    })().catch(error => this.error(error)).finally(() => { this.drainPromise = undefined })
    return this.drainPromise
  }

  private arm(milliseconds: number): void {
    if (this.stopped) return
    const due = Date.now() + Math.max(0, milliseconds)
    if (this.timerDue !== undefined && this.timerDue <= due) return
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timerDue = due
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.timerDue = undefined
      this.store.formBatches(this.config.maxObservations, this.config.maxBytes)
      this.kick()
    }, Math.max(0, due - Date.now()))
    this.timer.unref()
  }

  private nextWake(): number | undefined {
    const values = [this.store.nextWakeAt(), this.dispatch.nextWakeAt()].filter((value): value is number => value !== undefined)
    return values.length === 0 ? undefined : Math.min(...values)
  }

  private kick(): void {
    const wake = this.wakeup
    this.wakeup = undefined
    wake?.()
    if (!this.bootstrapped || this.stopped || this.store.resting() || this.workerPromise !== undefined) return
    this.workerPromise = this.work().finally(() => {
      this.workerPromise = undefined
      if (!this.stopped && !this.store.resting()) {
        const next = this.nextWake()
        if (next !== undefined) this.arm(next - Date.now())
      }
    })
  }

  private retryDelay(): number {
    const delay = backoff[Math.min(this.failures, backoff.length - 1)]!
    this.failures++
    return delay
  }

  private succeeded(): void {
    this.failures = 0
    this.lastErrorText = undefined
  }

  private async work(): Promise<void> {
    for (;;) {
      if (this.stopped || this.store.resting()) return
      // Finish work already dispatched before consuming more surface traffic. Otherwise a
      // continuously active main Session can starve every Assignment and Report indefinitely.
      // Reports come first so each specialist result returns before another Assignment starts.
      const report = this.dispatch.nextReportRelay()
      if (report !== undefined) {
        try {
          await this.session.runReport(report.id)
          this.dispatch.completeReportRelay(report.id)
          this.succeeded()
        } catch (error) {
          this.error(error)
          const delay = this.retryDelay()
          this.dispatch.failReportRelay(report.id, error instanceof Error ? error.message : String(error), Date.now() + delay)
          await this.wait(delay)
        }
        continue
      }
      const assignment = this.dispatch.nextAssignment()
      if (assignment !== undefined) {
        try {
          await this.memory.run(assignment.id)
          this.dispatch.completeDelivery(assignment.id)
          this.succeeded()
        } catch (error) {
          this.error(error)
          const delay = this.retryDelay()
          this.dispatch.failDelivery(assignment.id, error instanceof Error ? error.message : String(error), Date.now() + delay)
          await this.wait(delay)
        }
        continue
      }
      const batch = this.store.nextBatch()
      if (batch !== undefined) {
        try {
          this.store.markPresenting(batch.id)
          const { turn, completedAt } = await this.session.run(batch)
          this.store.markCompleted(batch.id, turn, completedAt)
          this.succeeded()
        } catch (error) {
          this.error(error)
          await this.wait(this.retryDelay())
        }
        continue
      }
      return
    }
  }

  private wait(milliseconds: number): Promise<void> {
    return new Promise(resolve => {
      this.wakeTimer = setTimeout(() => {
        this.wakeTimer = undefined
        this.wakeup = undefined
        resolve()
      }, milliseconds)
      this.wakeTimer.unref()
      this.wakeup = () => {
        if (this.wakeTimer !== undefined) clearTimeout(this.wakeTimer)
        this.wakeTimer = undefined
        resolve()
      }
    })
  }

  health(): RouterHealth & { dispatch: DispatchHealth } {
    return { ...this.store.health(this.lastErrorText), dispatch: this.dispatch.health() }
  }

  setResting(resting: boolean): void {
    this.store.setResting(resting)
    if (!resting) this.kick()
  }

  private commandStatus(): string {
    const health = this.store.health()
    return `当前待研判 ${health.readyBatches} 批；每 ${health.triggerBatchCount} 批合并研判一次。`
  }

  executeCommand(rawInput: string): { kind: 'success' | 'error'; text: string } {
    const args = rawInput.trim().split(/\s+/u).filter(Boolean)
    if (args.length === 0 || (args.length === 1 && args[0] === 'status')) {
      return { kind: 'success', text: this.commandStatus() }
    }
    if (args.length === 2 && args[0] === 'trigger' && /^[1-9]\d*$/u.test(args[1]!)) {
      const count = Number(args[1])
      if (Number.isSafeInteger(count)) {
        this.store.setTriggerBatchCount(count)
        this.kick()
        return { kind: 'success', text: `已设置每 ${count} 批合并研判一次。\n${this.commandStatus()}` }
      }
    }
    return { kind: 'error', text: '用法：/subconscious [status] 或 /subconscious trigger <正整数>' }
  }

  /** Wait for catch-up and the finite pass over ready Batch / Assignment / Report work. */
  async whenIdle(): Promise<void> {
    await this.bootstrapPromise
    await this.drainPromise
    await this.workerPromise
  }

  async dispose(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
    this.timerDue = undefined
    this.wakeup?.()
    await this.workerPromise?.catch(() => {})
    await Promise.allSettled([this.session.dispose(), this.memory.dispose()])
    this.dispatch.close()
    this.store.close()
  }
}

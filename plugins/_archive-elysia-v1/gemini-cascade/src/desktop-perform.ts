import { randomBytes } from 'node:crypto'

export type DesktopIngress = { surface: 'desktop'; medium: 'text' | 'voice'; deviceId: string }
type Kind = 'expression' | 'motion'
type Item = { id: string; label: string }
type Step = { kind: Kind; id: string; hold_ms?: number }
type List = { action: 'list' }
type Play = { action: 'play'; catalog_rev: string; steps: Step[] }
export type PerformanceArgs = List | Play
export type Reject = 'NOT_DESKTOP_TURN' | 'OFFLINE' | 'NO_MODEL' | 'STALE_CATALOG' | 'UNKNOWN_ITEM' | 'BUSY' | 'INVALID_ARGS'
export type Result = { status: 'catalog'; catalog_rev: string; expressions: Item[]; motions: Item[] }
  | { status: 'started'; performance_id: string }
  | { status: 'unknown'; code: 'ACK_TIMEOUT'; performance_id: string }
  | { status: 'rejected'; code: Reject }
const identifier = /^[a-zA-Z0-9_-]{1,64}$/u
export const idPattern = identifier
export function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
export function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return object(value) && Object.keys(value).length === keys.length && keys.every(k => Object.hasOwn(value, k))
}
function id(value: unknown): value is string { return typeof value === 'string' && identifier.test(value) }
export function performanceArgs(value: unknown): PerformanceArgs | undefined {
  if (exact(value, ['action']) && value.action === 'list') return { action: 'list' }
  if (!exact(value, ['action', 'catalog_rev', 'steps']) || value.action !== 'play' || !id(value.catalog_rev)
    || !Array.isArray(value.steps) || value.steps.length < 1 || value.steps.length > 4) return
  const steps: Step[] = []
  for (const entry of value.steps) {
    if (!object(entry) || !id(entry.id)) return
    if (entry.kind === 'motion' && exact(entry, ['kind', 'id'])) steps.push({ kind: 'motion', id: entry.id as string })
    else if (entry.kind === 'expression' && (exact(entry, ['kind', 'id']) || exact(entry, ['kind', 'id', 'hold_ms']))) {
      const hold = entry.hold_ms ?? 1500
      if (typeof hold !== 'number' || !Number.isInteger(hold) || hold < 200 || hold > 4000 || (Object.hasOwn(entry, 'hold_ms') && entry.hold_ms == null)) return
      steps.push({ kind: 'expression', id: entry.id as string, hold_ms: hold })
    } else return
  }
  return { action: 'play', catalog_rev: value.catalog_rev, steps }
}
const rejected = (code: Reject): Result => ({ status: 'rejected', code })
export type Job = { id: string; steps: Step[]; expiresAt: number }
const now = () => Date.now()

/** Single device, bounded ephemeral catalog and exactly one non-replayed command. */
export class DesktopPerform {
  private last = 0
  private catalog?: Extract<Result, { status: 'catalog' }>
  private job: Job | undefined
  private delivered = false
  private wait: ((result: Result) => void) | undefined

  seen(): void { this.last = now() }
  catalogUpdate(input: unknown): boolean {
    if (!exact(input, ['expressions', 'motions'])) return false
    const lists: Item[][] = []
    for (const n of ['expressions', 'motions'] as const) {
      const values = input[n]
      if (!Array.isArray(values) || values.length > 64) return false
      const unique = new Set<string>()
      const valid: Item[] = []
      for (const item of values) {
        if (!exact(item, ['id', 'label']) || !id(item.id) || typeof item.label !== 'string' || !item.label.trim()
          || item.label.length > 64 || /[\p{C}\r\n]/u.test(item.label) || unique.has(item.id)) return false
        unique.add(item.id); valid.push({ id: item.id, label: item.label })
      }
      lists.push(valid)
    }
    const next = { expressions: lists[0]!, motions: lists[1]! }
    if (!this.catalog || JSON.stringify(next.expressions) !== JSON.stringify(this.catalog.expressions)
      || JSON.stringify(next.motions) !== JSON.stringify(this.catalog.motions)) {
      this.catalog = { status: 'catalog', catalog_rev: randomBytes(12).toString('hex'), ...next }
      if (this.job && !this.delivered) { this.wait?.(rejected('STALE_CATALOG')); this.job = undefined }
    }
    return true
  }

  take(): Job | undefined {
    if (!this.job || this.delivered || this.job.expiresAt <= now()) return
    this.delivered = true
    return this.job
  }
  ack(value: unknown): boolean {
    if (!exact(value, ['id', 'started']) || !this.job || !this.delivered || !this.wait || value.id !== this.job.id
      || typeof value.started !== 'boolean') return false
    this.wait(value.started ? { status: 'started', performance_id: this.job.id } : rejected('UNKNOWN_ITEM'))
    return true
  }

  async run(allowed: boolean, value: unknown, signal: AbortSignal): Promise<Result> {
    if (!allowed || signal.aborted) return rejected('NOT_DESKTOP_TURN')
    const args = performanceArgs(value)
    if (!args) return rejected('INVALID_ARGS')
    if (now() - this.last > 5000) return rejected('OFFLINE')
    const catalog = this.catalog
    if (!catalog) return rejected('NO_MODEL')
    if (args.action === 'list') return catalog
    if (args.catalog_rev !== catalog.catalog_rev) return rejected('STALE_CATALOG')
    if (args.steps.some(step => !catalog[step.kind === 'motion' ? 'motions' : 'expressions'].some(item => item.id === step.id))) return rejected('UNKNOWN_ITEM')
    if (this.job && this.job.expiresAt > now()) return rejected('BUSY')
    const performance_id = randomBytes(12).toString('hex')
    const unknown: Result = { status: 'unknown', code: 'ACK_TIMEOUT', performance_id }
    this.job = { id: performance_id, steps: args.steps, expiresAt: now() + 10000 }
    this.delivered = false
    return await new Promise<Result>(resolve => {
      const finish = (result: Result) => {
        clearTimeout(timer)
        signal.removeEventListener('abort', abort)
        this.wait = undefined
        if (!this.delivered || result.status === 'rejected') this.job = undefined
        resolve(result)
      }
      const abort = () => finish(this.delivered ? unknown : rejected('NOT_DESKTOP_TURN'))
      const timer = setTimeout(() => finish(this.delivered ? unknown : rejected('OFFLINE')), 2000)
      this.wait = finish
      signal.addEventListener('abort', abort, { once: true })
    })
  }
}

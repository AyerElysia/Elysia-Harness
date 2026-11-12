/** Server-authenticated provider text, bounded and projected onto one native DSH turn. */
import type { StreamChunk } from '@deepseek-ai/dsh-llm'

type Finish = 'done' | 'interrupted' | 'error'
const LIMIT = 4096

export class NativeTurn {
  private text = ''
  private whitespace = ''
  private finish?: Finish
  private wake: (() => void) | undefined

  delta(fragment: string): void {
    if (this.finish) return
    const candidate = (this.text + this.whitespace + fragment).trimStart()
    if (candidate.length > LIMIT + 512) { this.settle('error'); return }
    this.text = candidate.trimEnd()
    this.whitespace = candidate.slice(this.text.length)
    if (this.text.length > LIMIT) { this.text = this.text.slice(0, LIMIT); this.settle('error'); return }
    this.wake?.()
  }

  /** Completion may carry text not streamed during queue congestion. */
  settle(finish: Finish, full = ''): boolean {
    if (this.finish) return false
    if (finish === 'done') {
      const final = full.trim()
      if (!final || final.length > LIMIT || !final.startsWith(this.text)) finish = 'error'
      else this.text = final
    }
    this.finish = finish
    this.whitespace = ''
    this.wake?.()
    return finish === 'done'
  }

  private async changed(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    await new Promise<void>(resolve => {
      const wake = () => {
        signal.removeEventListener('abort', wake)
        this.wake = undefined
        resolve()
      }
      this.wake = wake
      signal.addEventListener('abort', wake, { once: true })
      if (signal.aborted) wake()
    })
    signal.throwIfAborted()
  }

  async *chunks(signal: AbortSignal): AsyncGenerator<StreamChunk> {
    let sent = 0
    for (;;) {
      signal.throwIfAborted()
      const suffix = this.text.slice(sent)
      if (suffix) {
        if (!sent) yield { type: 'block-start', index: 0, blockType: 'text' }
        sent += suffix.length
        yield { type: 'text-delta', index: 0, text: suffix }
      }
      if (!this.finish) {
        // A delta can arrive while the consumer was suspended on yield above.
        if (this.text.length > sent) continue
        await this.changed(signal)
        continue
      }
      // The final authoritative body may have arrived while yielding a delta.
      if (this.text.length > sent) continue
      if (this.finish === 'done') {
        yield { type: 'block-end', index: 0, block: { type: 'text', text: this.text } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      } else if (this.finish === 'interrupted') {
        yield { type: 'finish', reason: { kind: 'aborted', failure: { code: 'voice/interrupted', message: 'Voice reply interrupted.' } } }
      } else {
        yield { type: 'finish', reason: { kind: 'error', failure: { code: 'voice/cascade-failed', message: 'Voice reply unavailable.' } } }
      }
      return
    }
  }
}

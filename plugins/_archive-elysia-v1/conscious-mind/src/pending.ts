/**
 * Pending inbound messages for the conscious mind.
 *
 * Messages wait here instead of each starting a reply. One turn drains every
 * message waiting at that moment, across channels and conversations.
 * @module @elysia/conscious-mind/pending
 */

import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import { inboundEventText, type InboundEvent } from './inbound.ts'

/** How long the queue must stay quiet before its batch is delivered. */
export const COLLECT_MS = 1200

/** Split off the first conversation's messages, preserving arrival order. */
export function takeConversationBatch<T extends { conversation: string }>(pending: readonly T[]): { batch: T[], rest: T[] } {
  const conversation = pending[0]?.conversation
  if (conversation === undefined) return { batch: [], rest: [] }
  return {
    batch: pending.filter(item => item.conversation === conversation),
    rest: pending.filter(item => item.conversation !== conversation),
  }
}

/** Replies to one drained batch. Channels do not call this. */
export type PendingTurn = (batch: readonly InboundEvent[]) => Promise<void>

declare module '@deepseek-ai/cordis' {
  interface Context {
    inboundPending: InboundPending
  }
}

/**
 * The conscious mind's pending list. Every channel receives into this one queue.
 */
export class InboundPending extends Service {
  private readonly items: InboundEvent[] = []
  private readonly seen = new Set<string>()
  private wakeup: (() => void) | undefined
  private turn: PendingTurn | undefined
  private revision = 0
  private stopped = false

  constructor(ctx: Context) {
    super(ctx, 'inboundPending')
    void this.loop()
  }

  /**
   * Queue one inbound text. A duplicate message id on the same channel is ignored.
   * @param message - text from any registered channel.
   */
  receive(message: InboundEvent): void {
    const key = `${message.channel}\0${message.messageId}`
    if (message.messageId.length > 0 && this.seen.has(key)) return
    if (message.messageId.length > 0) this.seen.add(key)
    this.items.push(message)
    this.revision++
    process.stderr.write(`pending ${this.items.length} ${message.channel} ${message.conversation} ${inboundEventText(message)}\n`)
    this.wake()
  }

  /**
   * Install the single reply used for every channel.
   * @param turn - answers one drained batch, usually through send_text.
   */
  replyWith(turn: PendingTurn): void {
    this.turn = turn
    this.wake()
  }

  /** Stop the collect loop. */
  stop(): void {
    this.stopped = true
    this.wake()
  }

  private wake(): void {
    const wakeup = this.wakeup
    this.wakeup = undefined
    wakeup?.()
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      if (this.items.length === 0 || this.turn === undefined) {
        await new Promise<void>(resolve => {
          this.wakeup = resolve
          if (this.items.length > 0 && this.turn !== undefined) this.wake()
        })
        if (this.stopped) return
      }
      const revision = this.revision
      await new Promise<void>(resolve => {
        const timer = setTimeout(() => {
          this.wakeup = undefined
          resolve()
        }, COLLECT_MS)
        this.wakeup = () => {
          clearTimeout(timer)
          resolve()
        }
        if (revision !== this.revision) this.wake()
      })
      if (this.stopped || this.turn === undefined || revision !== this.revision) continue
      const batch = this.items.splice(0, this.items.length)
      if (batch.length === 0) continue
      process.stderr.write(`取出 ${batch.length} 条 ${batch[0]?.channel} ${batch[0]?.conversation} ${batch.map(message => inboundEventText(message)).join(' / ')}\n`)
      try {
        await this.turn(batch)
      } catch (error) {
        // A drained batch is not delivered until the turn completes. Put it
        // back ahead of newer arrivals so a restart/resume failure cannot
        // silently erase the only copy of an external message.
        this.items.unshift(...batch)
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}；消息已放回队列\n`)
      }
    }
  }
}

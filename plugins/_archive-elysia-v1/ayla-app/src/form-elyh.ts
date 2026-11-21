/**
 * The elyh form: hand admitted events to the conscious mind's queue.
 *
 * The plugin knows nothing about the conscious mind beyond one method. It
 * registers no tool and opens no session, so exactly one send_text exists in
 * the process — the conscious mind's own (REQUIREMENTS.zh.md §8.5).
 * @module @elysia/ayla-app/form-elyh
 */

import type { InboundEvent } from './inbound.ts'

/**
 * The part of the conscious mind's pending queue this form uses.
 *
 * Declared here rather than imported so the plugin stays installable in a dsh
 * that has no conscious mind at all; the real service satisfies this
 * structurally.
 */
export interface InboundPendingPort {
  receive(message: InboundEvent): void
}

/**
 * Install the elyh form.
 *
 * A batch is delivered message by message: the queue does its own batching and
 * deduplication, and a repeated message id must reach it unchanged so it can be
 * dropped there rather than here.
 *
 * A message the queue refuses is reported and then rethrown after the rest of
 * the batch was attempted. The caller uses that rejection to withhold the ack,
 * so Ayla redelivers instead of the message disappearing; the in-process
 * duplicate check keeps the redelivered copies from reaching the queue twice.
 * @param pending - the conscious mind's pending queue.
 * @param logger - logger used when the queue rejects a delivery.
 * @returns a handler that queues one batch.
 */
export function installElyhForm(
  pending: InboundPendingPort,
  logger: { error(message: string): void },
): (batch: readonly InboundEvent[]) => Promise<void> {
  return async batch => {
    const failed: string[] = []
    for (const message of batch) {
      try {
        pending.receive(message)
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        failed.push(message.messageId + ': ' + reason)
        logger.error('Ayla 事件入队失败: ' + message.messageId + ': ' + reason)
      }
    }
    if (failed.length > 0) throw new Error('Ayla 事件入队失败: ' + failed.join('; '))
  }
}

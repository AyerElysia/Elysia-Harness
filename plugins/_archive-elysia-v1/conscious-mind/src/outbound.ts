/**
 * Channel-agnostic text delivery. Channel plugins register a sender; send_text
 * looks one up by name and never speaks a platform protocol itself.
 * @module @elysia/conscious-mind/outbound
 */

import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'

/** One segment handed to a channel plugin. */
export interface OutboundDelivery {
  /** Conversation identifier, interpreted by that channel plugin. */
  conversation: string
  /** One already-split message body. */
  text: string
  /** Quote target. Present only on the first segment of a call. */
  replyTo?: string
}

/** Receipt from a channel plugin after it accepted a segment. */
export interface OutboundReceipt {
  /** Platform message id, when the channel returned one. */
  messageId?: string
}

/** Send one segment. Throw {@link OutboundDeliveryUnknown} when delivery cannot be confirmed. */
export type OutboundSend = (delivery: OutboundDelivery) => Promise<OutboundReceipt>

/** The platform accepted the attempt but could not confirm it landed. Do not retry. */
export class OutboundDeliveryUnknown extends Error {
  constructor() {
    super('投递状态未知')
    this.name = 'OutboundDeliveryUnknown'
  }
}

/** One synthesized voice handed to a channel plugin. */
export interface OutboundVoiceDelivery {
  conversation: string
  audio: Uint8Array
  mediaType: 'audio/wav'
  signal?: AbortSignal
}

/** Send one voice. Platform-specific transcoding and upload stay in the channel. */
export type OutboundSendVoice = (delivery: OutboundVoiceDelivery) => Promise<OutboundReceipt>

declare module '@deepseek-ai/cordis' {
  interface Context {
    outboundText: OutboundText
    outboundVoice: OutboundVoice
  }
}

/** Shared registry behavior for one delivery kind. */
abstract class OutboundRegistry<Send> extends Service {
  private readonly senders = new Map<string, Send>()

  register(channel: string, send: Send): () => void {
    const name = channel.trim()
    if (name.length === 0) throw new Error('outbound channel name is empty')
    if (this.senders.has(name)) throw new Error(`outbound channel already registered: ${name}`)
    this.senders.set(name, send)
    return () => {
      if (this.senders.get(name) === send) this.senders.delete(name)
    }
  }

  sender(channel: string): Send | undefined {
    return this.senders.get(channel.trim())
  }
}

/** Channel-agnostic text senders. */
export class OutboundText extends OutboundRegistry<OutboundSend> {
  constructor(ctx: Context) {
    super(ctx, 'outboundText')
  }
}

/** Channel-agnostic synthesized-voice senders. */
export class OutboundVoice extends OutboundRegistry<OutboundSendVoice> {
  constructor(ctx: Context) {
    super(ctx, 'outboundVoice')
  }
}

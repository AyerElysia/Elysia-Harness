/**
 * Ayla channel plugin. Ayla chat reaches the conscious mind, or the plugin's own
 * 'ayla-channel' session when no conscious mind is installed, over one
 * WebSocket the plugin dials; the plugin opens no port of its own.
 *
 * The plugin logs in as Elysia's own Ayla account, keeps one bridge socket
 * alive, admits each inbound message into DSH attachments, and writes replies
 * back on the same socket. Which of the two forms delivers the messages is
 * decided at mount time from the services this dsh actually provides
 * (REQUIREMENTS.zh.md §4).
 *
 * No '@elysia/*' package is imported. A channel that needed the conscious mind
 * installed could not be added to an arbitrary dsh, and a missing service would
 * take the whole plugin down; the two optional services are therefore probed
 * with ctx.get() and never declared in inject.
 * @module @elysia/ayla-app
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-tools'
import { AylaAuth, RefreshTokenStore, defaultRefreshFile } from './auth.ts'
import { AylaClient } from './client.ts'
import { installElyhForm } from './form-elyh.ts'
import type { InboundPendingPort } from './form-elyh.ts'
import { createStandaloneTurn } from './form-standalone.ts'
import type { AylaModelPort } from './form-standalone.ts'
import { resolveForm } from './forms.ts'
import { AYLA_INBOUND_CHANNEL, prepareInboundEvent } from './inbound.ts'
import type { InboundEvent } from './inbound.ts'
import { replyInput } from './outbound.ts'
import type { AylaDelivery } from './outbound.ts'
import { assertBaseUrl } from './settings.ts'
import type { Config } from './settings.ts'

export { formatAylaConversation, parseAylaConversation } from './conversation.ts'
export type { AylaConversation } from './conversation.ts'
export {
  MAX_FRAME_BYTES, MAX_TEXT_BYTES, PROTOCOL_VERSION,
  buildAck, buildPing, buildPong, buildReply, buildResume, parseFrame,
} from './protocol.ts'
export type {
  AckFrame, AylaConversationType, AylaInboundPart, ErrorFrame, Frame, InboundFrame,
  InboundMessagePayload, PingFrame, PongFrame, ReplyFrame, ReplyInput, ResumeFrame, SentFrame,
} from './protocol.ts'
export { resolveForm } from './forms.ts'
export type { AylaForm, AylaMode } from './forms.ts'
export { DEFAULT_BASE_URL, Config, assertBaseUrl, isLoopbackOrPrivateHost } from './settings.ts'
export { AylaAuth, AylaAuthError, AylaHttpError, RefreshTokenStore, defaultRefreshFile, endpointUrl } from './auth.ts'
export type { AylaFetch, AylaHttpResponse, AylaTokens } from './auth.ts'
export {
  AylaClient, BRIDGE_PATH, HEARTBEAT_INTERVAL_MS, MAX_HEARTBEAT_MISSES,
  RECONNECT_INITIAL_MS, RECONNECT_MAX_MS, REPLY_TIMEOUT_MS, bridgeUrl,
} from './client.ts'
export type { AylaClientOptions, AylaClientState, AylaSocket, AylaSocketFactory } from './client.ts'
export { AylaInboundRejected, AYLA_INBOUND_CHANNEL, inboundEventText, prepareInboundEvent } from './inbound.ts'
export type {
  AylaAttachmentAdmission, AylaInboundContentPart, AylaInboundDeps, AylaMediaFetch, InboundEvent,
} from './inbound.ts'
export {
  AYLA_CHANNEL, AylaReplyRejected, OutboundDeliveryUnknown,
  defineSendTextTool, deliverSendText, splitOutboundText,
} from './outbound.ts'
export type { AylaDelivery, AylaSend, SendTextArgs, SendTextResult, SentSegment } from './outbound.ts'
export {
  AYLA_SESSION_ID, composeAylaAgent, createStandaloneTurn, formatInboundBatch, formatInboundEvent,
} from './form-standalone.ts'
export type { AylaModelPort, StandaloneFormOptions, StandaloneTurn } from './form-standalone.ts'
export { installElyhForm } from './form-elyh.ts'
export type { InboundPendingPort } from './form-elyh.ts'

/** Cordis plugin name. */
export const name = 'ayla-app'

/**
 * Services every dsh the plugin is installed into provides. 'inboundPending'
 * and 'outboundText' are deliberately absent: declaring them would make the
 * plugin unmountable without the conscious mind.
 */
export const inject = ['agents', 'sessionPersistence', 'attachments', 'tools']

/** How long the standalone form collects arrivals into one user message. */
export const STANDALONE_COLLECT_MS = 1200

/** Message ids remembered for in-process deduplication. */
const DEDUP_CAPACITY = 512

/**
 * The part of the conscious mind's outbound registry this form uses.
 *
 * Declared here, like the pending port, so the plugin never imports the
 * conscious mind; the real service satisfies it structurally.
 */
interface OutboundTextPort {
  register(channel: string, send: (delivery: AylaDelivery) => Promise<{ messageId: string }>): () => void
}

/** A batch collector that hands one quiet-period batch to a turn handler. */
interface BatchQueue {
  push(message: InboundEvent): void
  stop(): void
}

/**
 * Collect admitted events and deliver them as one batch once arrivals stop.
 *
 * A burst of messages becomes one user message, which is what the model should
 * see; a single message is still delivered after the quiet period so nothing
 * waits for a second arrival that may never come.
 *
 * A batch whose turn failed is put back ahead of newer arrivals and retried.
 * The frame was already acked, so dropping the batch would lose a message that
 * Ayla will not send again; only a repeated identical failure is logged once.
 * @param turn - handler for one batch.
 * @param onError - reports a failure whose message differs from the last one.
 * @param collectMs - quiet period before a batch is delivered.
 * @returns the collector.
 */
export function createBatchQueue(
  turn: (batch: readonly InboundEvent[]) => Promise<void>,
  onError: (error: unknown) => void,
  collectMs: number = STANDALONE_COLLECT_MS,
): BatchQueue {
  const items: InboundEvent[] = []
  let timer: ReturnType<typeof setTimeout> | undefined
  let running = false
  let stopped = false
  let lastError: string | undefined

  const schedule = (): void => {
    if (stopped || running || timer !== undefined || items.length === 0) return
    timer = setTimeout(() => {
      timer = undefined
      void flush()
    }, collectMs)
  }

  const flush = async (): Promise<void> => {
    if (stopped || items.length === 0) return
    if (running) {
      schedule()
      return
    }
    running = true
    const batch = items.splice(0, items.length)
    try {
      await turn(batch)
      lastError = undefined
    } catch (error) {
      items.unshift(...batch)
      const reason = error instanceof Error ? error.message : String(error)
      if (reason !== lastError) {
        lastError = reason
        onError(error)
      }
    } finally {
      running = false
      schedule()
    }
  }

  return {
    push(message) {
      if (stopped) return
      items.push(message)
      schedule()
    },
    stop() {
      stopped = true
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
      items.length = 0
    },
  }
}

/**
 * Record one message id as delivered, dropping the oldest beyond capacity.
 *
 * Call this only after the message reached its destination. A message that
 * failed admission was never delivered, and remembering it would make the
 * redelivery look like a duplicate and be acked without ever being shown.
 * @param seen - insertion-ordered set owned by the plugin instance.
 * @param key - channel-scoped message identity.
 */
export function rememberDelivered(seen: Set<string>, key: string): void {
  seen.add(key)
  if (seen.size > DEDUP_CAPACITY) {
    const oldest = seen.values().next()
    if (!oldest.done) seen.delete(oldest.value)
  }
}

/**
 * Resolve the settings, decide the form, and start the channel.
 *
 * A misconfigured address or an unresolvable form setting throws, so the mount
 * fails in the log instead of leaving a channel that silently delivers nowhere.
 *
 * The socket is started inside an effect, so it is closed when the plugin
 * unloads and no reconnect timer outlives the mount.
 * @param ctx - context providing the injected services.
 * @param config - live settings section.
 */
export function apply(ctx: Context, config: Config): void {
  const baseUrl = assertBaseUrl(config.baseUrl.get())
  const mode = config.mode.get()
  const pending = ctx.get('inboundPending') as InboundPendingPort | undefined
  const outboundText = ctx.get('outboundText') as OutboundTextPort | undefined
  const form = resolveForm(mode, pending !== undefined, outboundText !== undefined)
  const logger = ctx.logger('ayla-app')
  logger.info('Ayla 通道形态: ' + form + ' (mode=' + mode + ', ' + baseUrl.origin + ')')

  const auth = new AylaAuth({
    baseUrl,
    username: config.username.get(),
    password: config.password.get(),
    store: new RefreshTokenStore(defaultRefreshFile()),
  })

  // One outbound path for both forms: conversation → reply frame → receipt.
  const send = (delivery: AylaDelivery): Promise<{ messageId: string }> => {
    const clientMessageId = 'ayla-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10)
    return client.sendReply(replyInput(delivery, clientMessageId))
  }

  // resolveForm() already refused an 'elyh' setting without the services; this
  // guard keeps a future change to that decision from turning into a silent
  // channel that queues nowhere.
  if (form === 'elyh' && pending === undefined) {
    throw new Error('Ayla 形态判定为 elyh，但 inboundPending 不存在')
  }
  const deliverToPending = form === 'elyh' && pending !== undefined
    ? installElyhForm(pending, logger)
    : undefined
  // Optional: a host without a default-model plugin still gets a working
  // session, it simply inherits whatever the agent loop defaults to.
  const model = ctx.get('agentDefaultModel') as AylaModelPort | undefined
  const turn = form === 'standalone'
    ? createStandaloneTurn(ctx, {
      cwd: config.workspaceDir.get(),
      sender: () => send,
      ...model === undefined ? {} : { model },
      logger,
    })
    : undefined
  const queue = turn === undefined
    ? undefined
    : createBatchQueue(turn, error => {
      logger.error('Ayla 批次投递失败: ' + (error instanceof Error ? error.message : String(error)))
    })
  if (queue !== undefined) ctx.effect(() => () => queue.stop(), 'elysia-ayla-app.batch()')

  const seen = new Set<string>()
  const client = new AylaClient({
    baseUrl,
    auth,
    logger,
    onInbound: async frame => {
      const message = frame.message
      const key = AYLA_INBOUND_CHANNEL + '\0' + message.id
      // A resumed connection can redeliver a message that was queued but not
      // acked; the model must not see it twice.
      if (seen.has(key)) return true
      let event: InboundEvent
      try {
        event = await prepareInboundEvent(message, {
          signMedia: async mediaId => {
            const body = await auth.requestJson(
              '/api/v1/media/' + encodeURIComponent(mediaId) + ':sign',
              { method: 'POST', body: '{}' },
            )
            if (body === null || typeof body !== 'object') return ''
            const url = (body as { url?: unknown }).url
            return typeof url === 'string' ? url : ''
          },
          fetchMedia: async url => await fetch(url),
          attachments: ctx.attachments,
        })
      } catch (error) {
        // Not acked: Ayla redelivers, and the model never sees a partial message.
        logger.error('Ayla 消息 ' + message.id + ' 不可投递: ' + (error instanceof Error ? error.message : String(error)))
        return false
      }
      // Delivery failures propagate, so the client withholds the ack and Ayla
      // redelivers; only a message that reached its destination is remembered.
      if (deliverToPending !== undefined) await deliverToPending([event])
      else if (queue !== undefined) queue.push(event)
      else throw new Error('Ayla 通道没有投递目标')
      rememberDelivered(seen, key)
      return true
    },
  })

  ctx.effect(() => {
    client.start()
    return () => { client.stop() }
  }, 'elysia-ayla-app.client()')

  // Only the conscious mind's send_text looks channels up in this registry.
  // The standalone form owns its own tool, so registering a channel there would
  // give the conscious mind a path this form deliberately does not depend on.
  if (form === 'elyh' && outboundText !== undefined) {
    ctx.effect(
      () => outboundText.register(AYLA_INBOUND_CHANNEL, (delivery: AylaDelivery) => send(delivery)),
      'elysia-ayla-app.outbound()',
    )
  }
}

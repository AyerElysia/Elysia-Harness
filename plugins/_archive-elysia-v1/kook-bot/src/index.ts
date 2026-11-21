/**
 * KOOK channel plugin. It reads Elysium's bot config, registers the `kook`
 * sender used by send_text, and admits text/images into the shared pending queue.
 * @module @elysia/kook-bot
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-attachment'
import type { InboundContentPart, InboundEvent, InboundEventInputContent } from '@elysia/conscious-mind/src/inbound.ts'
import type {} from '@elysia/conscious-mind/outbound'
import type {} from '@elysia/conscious-mind/src/pending.ts'
import { KookClient } from './client.ts'
import { loadElysiumKookConfig } from './config.ts'
import { KookGateway } from './gateway.ts'
import type { KookInboundEvent } from './inbound.ts'

export { formatKookConversation, parseKookConversation } from './conversation.ts'
export type { KookConversation } from './conversation.ts'
export { kookDirectMessageEvent, kookInboundEvent, kookInboundText } from './inbound.ts'
export type { KookInboundEvent, KookInboundSourcePart, KookInboundText } from './inbound.ts'
export { ELYSIUM_KOOK_CONFIG, KOOK_API_BASE, loadElysiumKookConfig, parseElysiumKookConfig } from './config.ts'
export type { KookSettings } from './config.ts'
export { KookClient } from './client.ts'
export type { KookDirectChat } from './client.ts'
export { KookGateway } from './gateway.ts'
export { handleKookFrame } from './frame.ts'
export { prepareKookVoiceAsset } from './voice.ts'
export type { KookVoiceAsset } from './voice.ts'

/** Cordis plugin name. */
export const name = 'kook-bot'

/** Outbound registries, durable attachments, and the shared pending queue. */
export const inject = ['outboundText', 'outboundVoice', 'inboundPending', 'attachments']

/** Optional path override. The bot token still comes from that file. */
export interface Config {
  configPath?: string
  listen?: boolean
}

/** Runtime schema. */
export const Config: z<Config> = z.object({
  configPath: z.string().default(''),
  listen: z.boolean().default(false),
})

declare module '@deepseek-ai/cordis' {
  interface Events {
    /** A user text or image event arrived from KOOK. */
    'kook/message'(message: KookInboundEvent): void
  }
}

/** Download and durably admit one event, then enqueue only the admitted references. */
export async function forwardKookInbound(ctx: Context, message: KookInboundEvent, client: KookClient): Promise<void> {
  try {
    const input: InboundEventInputContent[] = []
    for (const part of message.content) {
      if (part.type === 'text') {
        input.push({ type: 'text', text: part.text })
      } else {
        const image = await client.downloadImage(part.url, ctx.attachments.imageLimits.maxImageBytes)
        input.push({ type: 'image', ...image })
      }
    }
    const admitted = await ctx.attachments.admitPromptContent(input)
    const content: InboundContentPart[] = []
    for (const part of admitted) {
      if (part.type === 'file') throw new Error('KOOK 图片准入意外返回文件附件')
      content.push(part)
    }
    const event: InboundEvent = {
      channel: message.channel,
      conversation: message.conversation,
      messageId: message.messageId,
      senderId: message.senderId,
      senderName: message.senderName,
      content,
    }
    ctx.emit('kook/message', message)
    ctx.inboundPending.receive(event)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    ctx.logger('kook-bot').error(`KOOK 消息 ${message.messageId} 入站失败: ${reason}`)
  }
}

/** Register the KOOK sender and optionally hold the single gateway socket. */
export function apply(ctx: Context, config: Config): void {
  const settings = loadElysiumKookConfig(config.configPath === '' ? undefined : config.configPath)
  const client = new KookClient(settings)
  let active = true
  const gateway = new KookGateway(client, async (message) => {
    if (active) await forwardKookInbound(ctx, message, client)
  })
  ctx.effect(() => ctx.outboundText.register('kook', delivery => client.sendText(delivery)))
  ctx.effect(() => ctx.outboundVoice.register('kook', delivery => client.sendVoice(delivery)))
  ctx.effect(() => () => { active = false })
  if (config.listen) {
    ctx.effect(() => {
      void gateway.start().catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        ctx.logger('kook-bot').error(`KOOK Gateway 失败: ${message}`)
      })
      return () => { gateway.stop() }
    })
  }
}

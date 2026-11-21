/**
 * Feishu channel plugin. It reads Elysium's app config, registers the
 * `feishu` sender used by send_text, and can hold the event long connection.
 * @module @elysia/feishu-app
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@elysia/conscious-mind/outbound'
import { FeishuClient } from './client.ts'
import { loadElysiumFeishuConfig } from './config.ts'
import type { FeishuInboundText } from './inbound.ts'
import { FeishuLink } from './link.ts'

export { formatFeishuConversation, parseFeishuConversation } from './conversation.ts'
export type { FeishuConversation } from './conversation.ts'
export { feishuInboundText } from './inbound.ts'
export type { FeishuInboundText } from './inbound.ts'
export { ELYSIUM_FEISHU_CONFIG, loadElysiumFeishuConfig, parseElysiumFeishuConfig } from './config.ts'
export type { FeishuSettings } from './config.ts'
export { FeishuClient } from './client.ts'
export { FeishuLink, FEISHU_SDK } from './link.ts'

/** Cordis plugin name. */
export const name = 'feishu-app'

/** The outbound registry send_text already uses. */
export const inject = ['outboundText']

/** Optional path override. The app id and secret still come from that file. */
export interface Config {
  /** Path to Elysium's feishu_adapter config.toml. */
  configPath?: string
  /** Open the long connection. The same app can keep only one. */
  listen?: boolean
}

/** Runtime schema. */
export const Config: z<Config> = z.object({
  configPath: z.string().default(''),
  listen: z.boolean().default(false),
})

declare module '@deepseek-ai/cordis' {
  interface Events {
    /** A text message arrived from Feishu. */
    'feishu/message'(message: FeishuInboundText): void
  }
}

/**
 * Register the feishu sender from Elysium's config.
 * @param ctx - context that already provides outboundText.
 * @param config - optional path override and whether to open the socket.
 */
export function apply(ctx: Context, config: Config): void {
  const settings = loadElysiumFeishuConfig(config.configPath === '' ? undefined : config.configPath)
  const client = new FeishuClient(settings)
  const link = new FeishuLink(client, settings, (message) => { ctx.emit('feishu/message', message) })
  ctx.effect(() => ctx.outboundText.register('feishu', delivery => client.sendText(delivery)))
  if (config.listen) {
    ctx.effect(() => {
      void link.start().catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        ctx.logger('feishu-app').error(`飞书长连接失败: ${message}`)
      })
      return () => { link.stop() }
    })
  }
}

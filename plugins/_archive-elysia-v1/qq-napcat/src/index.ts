/**
 * QQ channel plugin. It reads Elysium's NapCat account config, keeps the
 * OneBot socket, and registers the `qq` sender used by send_text.
 * @module @elysia/qq-napcat
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@elysia/conscious-mind/outbound'
import { loadElysiumNapcatConfig } from './config.ts'
import type { QqInboundText } from './inbound.ts'
import { NapcatLink } from './link.ts'

export { formatQqConversation, parseQqConversation } from './conversation.ts'
export type { QqConversation } from './conversation.ts'
export type { QqInboundText } from './inbound.ts'
export { ELYSIUM_NAPCAT_CONFIG, loadElysiumNapcatConfig, parseElysiumNapcatConfig } from './config.ts'
export type { QqNapcatSettings } from './config.ts'

/** Cordis plugin name. */
export const name = 'qq-napcat'

/** The outbound registry send_text already uses. */
export const inject = ['outboundText']

/** Optional overrides. Account and token still come from Elysium's config file. */
export interface Config {
  /** Path to Elysium's napcat_adapter config.toml. */
  configPath?: string
  /** Listen or dial port. Defaults to the port in that file. */
  port?: number
}

/** Runtime schema. */
export const Config: z<Config> = z.object({
  configPath: z.string().default(''),
  port: z.number().default(0),
})

declare module '@deepseek-ai/cordis' {
  interface Events {
    /** A text message arrived from QQ. */
    'qq/message'(message: QqInboundText): void
  }
}

/**
 * Connect to NapCat and register the qq sender.
 * @param ctx - context that already provides outboundText.
 * @param config - optional path and port overrides.
 */
export function apply(ctx: Context, config: Config): void {
  const settings = loadElysiumNapcatConfig(config.configPath === '' ? undefined : config.configPath)
  const port = config.port ?? 0
  if (port > 0) settings.port = port
  const link = new NapcatLink(settings, (message) => { ctx.emit('qq/message', message) })
  ctx.effect(() => ctx.outboundText.register('qq', delivery => link.session.sendText(delivery)))
  ctx.effect(() => {
    void link.start().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      ctx.logger('qq-napcat').error(`NapCat 连接失败: ${message}`)
    })
    return () => { void link.stop() }
  })
}

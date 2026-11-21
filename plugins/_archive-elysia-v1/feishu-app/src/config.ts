/**
 * Read the Feishu app from Elysium's existing adapter config.
 * @module @elysia/feishu-app/config
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** Elysium checkout the adapter reads its account config from; see `ELYSIA_ROOT` in qq-napcat/config.ts. */
export const ELYSIA_ROOT = process.env.ELYSIA_ROOT ?? '/home/ayerelysia/Elysia'

/** The Feishu adapter config Elysium already uses. */
export const ELYSIUM_FEISHU_CONFIG = process.env.ELYSIA_FEISHU_CONFIG
  ?? join(ELYSIA_ROOT, 'Elysium/config/plugins/feishu_adapter/config.toml')

/** Facts needed to send Feishu text. */
export interface FeishuSettings {
  appId: string
  appSecret: string
  apiBaseUrl: string
  botName: string
  replyToMessage: boolean
}

function section(source: string, name: string): string {
  const match = source.match(new RegExp(`(?:^|\\n)\\[${name}\\]\\n([\\s\\S]*?)(?=\\n\\[|$)`))
  return match?.[1] ?? ''
}

function field(body: string, key: string): string | undefined {
  const match = body.match(new RegExp(`^${key}\\s*=\\s*(.+)$`, 'm'))
  const captured = match?.[1]
  if (captured === undefined) return undefined
  const raw = captured.trim()
  if (raw.startsWith('"') && raw.endsWith('"')) return raw.slice(1, -1)
  return raw
}

function flag(body: string, key: string, fallback: boolean): boolean {
  const value = field(body, key)
  if (value === undefined) return fallback
  return value === 'true'
}

/**
 * Parse the app table from an Elysium Feishu config.
 * @param source - TOML text.
 * @returns the settings used to call the Feishu API.
 */
export function parseElysiumFeishuConfig(source: string): FeishuSettings {
  const app = section(source, 'app')
  const bot = section(source, 'bot')
  const behavior = section(source, 'behavior')
  const appId = field(app, 'app_id')?.trim() ?? ''
  const appSecret = field(app, 'app_secret')?.trim() ?? ''
  const apiBaseUrl = (field(app, 'api_base_url')?.trim() || 'https://open.feishu.cn').replace(/\/$/u, '')
  if (!/^cli_[A-Za-z0-9]+$/u.test(appId)) throw new Error('Elysium 飞书配置缺少 app_id')
  if (appSecret.length === 0) throw new Error('Elysium 飞书配置缺少 app_secret')
  return {
    appId,
    appSecret,
    apiBaseUrl,
    botName: field(bot, 'bot_name')?.trim() || '爱莉',
    replyToMessage: flag(behavior, 'reply_to_message', true),
  }
}

/**
 * Load the settings from Elysium's config file.
 * @param path - config.toml path. Defaults to the live Elysium file.
 * @returns parsed settings.
 */
export function loadElysiumFeishuConfig(path = ELYSIUM_FEISHU_CONFIG): FeishuSettings {
  return parseElysiumFeishuConfig(readFileSync(path, 'utf8'))
}

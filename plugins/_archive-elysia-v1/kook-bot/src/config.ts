/**
 * Read the KOOK bot from Elysium's existing adapter config.
 * @module @elysia/kook-bot/config
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** Elysium checkout the adapter reads its account config from; see `ELYSIA_ROOT` in qq-napcat/config.ts. */
export const ELYSIA_ROOT = process.env.ELYSIA_ROOT ?? '/home/ayerelysia/Elysia'

/** The KOOK adapter config Elysium already uses. */
export const ELYSIUM_KOOK_CONFIG = process.env.ELYSIA_KOOK_CONFIG
  ?? join(ELYSIA_ROOT, 'Elysium/config/plugins/kook_adapter/config.toml')

/** KOOK HTTP API. */
export const KOOK_API_BASE = 'https://www.kookapp.cn/api/v3'

/** Facts needed to send KOOK text. */
export interface KookSettings {
  token: string
  botName: string
  useKmarkdown: boolean
  replyWithQuote: boolean
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
 * Parse the bot and features tables from an Elysium KOOK config.
 * @param source - TOML text.
 * @returns the settings used to call the KOOK API.
 */
export function parseElysiumKookConfig(source: string): KookSettings {
  const bot = section(source, 'bot')
  const features = section(source, 'features')
  const token = field(bot, 'token')?.trim() ?? ''
  if (token.length === 0) throw new Error('Elysium KOOK 配置缺少 bot.token')
  return {
    token,
    botName: field(bot, 'bot_name')?.trim() || '爱莉希雅',
    useKmarkdown: flag(features, 'use_kmarkdown', true),
    replyWithQuote: flag(features, 'reply_with_quote', true),
  }
}

/**
 * Load the settings from Elysium's config file.
 * @param path - config.toml path. Defaults to the live Elysium file.
 * @returns parsed settings.
 */
export function loadElysiumKookConfig(path = ELYSIUM_KOOK_CONFIG): KookSettings {
  return parseElysiumKookConfig(readFileSync(path, 'utf8'))
}

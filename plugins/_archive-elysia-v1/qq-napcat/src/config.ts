/**
 * Read the QQ account and NapCat socket from Elysium's existing adapter config.
 * @module @elysia/qq-napcat/config
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Elysium checkout the adapters read their account config from.
 *
 * Deployments differ, so the root comes from `ELYSIA_ROOT` and only falls back to
 * the path the original machine used. Every channel plugin derives its config
 * location from this one variable instead of repeating an absolute path.
 */
export const ELYSIA_ROOT = process.env.ELYSIA_ROOT ?? '/home/ayerelysia/Elysia'

/** The NapCat adapter config Elysium already uses. */
export const ELYSIUM_NAPCAT_CONFIG = process.env.ELYSIA_NAPCAT_CONFIG
  ?? join(ELYSIA_ROOT, 'Elysium/config/plugins/napcat_adapter/config.toml')

/** Connection facts needed for text send and receive. */
export interface QqNapcatSettings {
  selfId: string
  mode: 'reverse' | 'direct'
  host: string
  port: number
  accessToken: string
  sendTimeoutMs: number
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

/**
 * Parse the bot and napcat_server tables from an Elysium NapCat config.
 * @param source - TOML text.
 * @returns the settings used to open OneBot.
 */
export function parseElysiumNapcatConfig(source: string): QqNapcatSettings {
  const bot = section(source, 'bot')
  const server = section(source, 'napcat_server')
  const features = section(source, 'features')
  const selfId = field(bot, 'qq_id')?.trim() ?? ''
  const mode = field(server, 'mode')?.trim()
  const host = field(server, 'host')?.trim() || '127.0.0.1'
  const port = Number(field(server, 'port'))
  const timeoutSeconds = Number(field(features, 'message_send_timeout_seconds') ?? '20')
  if (!/^[1-9][0-9]*$/u.test(selfId)) throw new Error('Elysium NapCat 配置缺少 qq_id')
  if (mode !== 'reverse' && mode !== 'direct') throw new Error('Elysium NapCat 配置的 mode 必须是 reverse 或 direct')
  if (!Number.isInteger(port) || port <= 0) throw new Error('Elysium NapCat 配置的 port 无效')
  return {
    selfId,
    mode,
    host,
    port,
    accessToken: field(server, 'access_token') ?? '',
    sendTimeoutMs: Number.isFinite(timeoutSeconds) ? Math.max(5, timeoutSeconds) * 1000 : 20_000,
  }
}

/**
 * Load the settings from Elysium's config file.
 * @param path - config.toml path. Defaults to the live Elysium file.
 * @returns parsed settings.
 */
export function loadElysiumNapcatConfig(path = ELYSIUM_NAPCAT_CONFIG): QqNapcatSettings {
  return parseElysiumNapcatConfig(readFileSync(path, 'utf8'))
}

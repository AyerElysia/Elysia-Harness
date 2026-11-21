/**
 * Settings for the Ayla channel. Every field is .volatile(): the settings page
 * shows it, and a saved value takes effect on the next read without a remount.
 *
 * The password is role('secret') so the form masks it and it never appears in
 * logs or diagnostics. Non-loopback plaintext is refused at load: credentials
 * and message bodies would otherwise cross the network in the clear
 * (REQUIREMENTS.zh.md §6).
 * @module @elysia/ayla-app/settings
 */

import type { Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { AylaMode } from './forms.ts'

/** Default Ayla backend for a same-machine deployment. */
export const DEFAULT_BASE_URL = 'http://127.0.0.1:8100'

/** Plugin settings, as read from one live settings section. */
export interface Config {
  /** Ayla backend base URL; the WebSocket URL is derived from it. */
  baseUrl: Volatile<string>
  /** Ayla account name used to log in. */
  username: Volatile<string>
  /** That account's password. Masked in the settings page. */
  password: Volatile<string>
  /** Which delivery form to install. */
  mode: Volatile<AylaMode>
  /** Working directory for the standalone session; empty uses the process cwd. */
  workspaceDir: Volatile<string>
}

/** Runtime schema for the settings page. */
export const Config = z.object({
  baseUrl: z.string().default(DEFAULT_BASE_URL).volatile(),
  username: z.string().default('').volatile(),
  password: z.string().role('secret').default('').volatile(),
  mode: z.union([z.const('auto'), z.const('elyh'), z.const('standalone')]).default('auto').volatile(),
  workspaceDir: z.string().default('').volatile(),
})

function isLoopbackOrPrivateIpv4(host: string): boolean {
  const octets = host.split('.')
  if (octets.length !== 4) return false
  const values = octets.map(octet => Number(octet))
  if (values.some((value, index) => !/^[0-9]{1,3}$/u.test(octets[index] ?? '') || value > 255)) return false
  const [first, second] = values as [number, number, number, number]
  if (first === 127) return true
  if (first === 10) return true
  if (first === 172 && second >= 16 && second <= 31) return true
  if (first === 192 && second === 168) return true
  return false
}

/**
 * Whether a plaintext (http/ws) host stays on this machine or on the local
 * private network.
 * @param host - URL hostname; IPv6 arrives in brackets.
 * @returns true for loopback, 10/8, 172.16/12, and 192.168/16.
 */
export function isLoopbackOrPrivateHost(host: string): boolean {
  const name = host.trim().toLowerCase()
  if (name === 'localhost' || name === '[::1]' || name === '::1') return true
  return isLoopbackOrPrivateIpv4(name)
}

/**
 * Read and check the backend address.
 *
 * `https:` is accepted for any host. `http:` is accepted only for loopback and
 * the private IPv4 ranges, because the plugin sends that account's password
 * over the same connection. A URL carrying userinfo is refused: the password
 * belongs in the settings field, not in an address that reaches logs.
 * @param raw - the configured base URL.
 * @returns the parsed URL.
 */
export function assertBaseUrl(raw: string): URL {
  const text = raw.trim()
  if (text.length === 0) throw new Error('Ayla baseUrl 为空; 请填写 Ayla 后端地址')
  let url: URL
  try {
    url = new URL(text)
  } catch {
    throw new Error('Ayla baseUrl 不是合法 URL: ' + JSON.stringify(raw))
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Ayla baseUrl 只支持 http 或 https: ' + JSON.stringify(raw))
  }
  if (url.hostname.length === 0) throw new Error('Ayla baseUrl 缺少主机名: ' + JSON.stringify(raw))
  if (url.username.length > 0 || url.password.length > 0) {
    throw new Error('Ayla baseUrl 不得内嵌账号或密码; 请使用设置页的 username / password 字段')
  }
  if (url.protocol === 'http:' && !isLoopbackOrPrivateHost(url.hostname)) {
    throw new Error(
      'Ayla baseUrl 的明文 http 只允许 loopback 或私网地址, ' + JSON.stringify(url.hostname)
      + ' 需要改用 https',
    )
  }
  return url
}

/** Read-only compatibility for the login source used by the original surface. */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseEnv } from 'node:util'

const DEFAULT_ELYSIUM_ROOT = '/home/ayerelysia/Elysia/Elysium'
export type CookieDiagnostic = 'ready' | 'legacy-file-not-found' | 'legacy-ref-empty'
export interface CookieSources {
  native(): Promise<string | undefined>
  env?: Readonly<Record<string, string | undefined>>
  readLegacy?(path: string): Promise<string>
  diagnostic?(code: CookieDiagnostic): void
}
/** Same bare-SESSDATA/full-cookie compatibility as the original surface. */
export function normalizeBilibiliCookie(raw: string): string {
  const value=raw.trim().replace(/;\s*$/u,'')
  if (!value) return ''
  if (/[\r\n\0]/u.test(value)) throw new Error('B站凭据包含非法换行或控制字符')
  return value.includes('=') ? value : `SESSDATA=${value}`
}
/** Native credential > explicit environment > original private .env, with no writes. */
export async function resolveBilibiliCookie(sources: CookieSources): Promise<string> {
  const env=sources.env ?? process.env
  const native=await sources.native()
  if (native?.trim()) { sources.diagnostic?.('ready'); return normalizeBilibiliCookie(native) }
  const explicit=env.BILIBILI_COOKIE?.trim() || env.ELYSIUM_BILIBILI_SESSDATA?.trim()
  if (explicit) { sources.diagnostic?.('ready'); return normalizeBilibiliCookie(explicit) }
  const file=env.ELYSIA_LIVE_ENV_FILE?.trim() || join(env.ELYSIA_ROOT?.trim() || DEFAULT_ELYSIUM_ROOT,'.env')
  let text: string
  try { text=await (sources.readLegacy ?? (path=>readFile(path,'utf8')))(file) }
  catch(error: unknown) {
    const code=typeof error==='object' && error!==null && 'code' in error && typeof error.code==='string' && /^[A-Z0-9_]{1,24}$/u.test(error.code) ? error.code : 'IO_ERROR'
    if(code==='ENOENT') { sources.diagnostic?.('legacy-file-not-found'); return '' }
    // Never embed file contents, credential values, or an arbitrary I/O error message.
    throw new Error(`旧B站登录来源读取失败（${code}）`)
  }
  // Node's pure dotenv parser handles quoted, bare, export-prefixed and commented
  // values without sourcing shell code or changing process.env.
  const value=parseEnv(text).ELYSIUM_BILIBILI_SESSDATA
  if(!value?.trim()) { sources.diagnostic?.('legacy-ref-empty'); return '' }
  sources.diagnostic?.('ready')
  return normalizeBilibiliCookie(value)
}

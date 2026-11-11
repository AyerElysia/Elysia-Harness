import { describe, expect, it, vi } from 'vitest'
const disk=vi.hoisted(()=>({readFile:vi.fn()}))
vi.mock('node:fs/promises', async importOriginal => ({...await importOriginal<typeof import('node:fs/promises')>(),readFile:disk.readFile}))
import { resolveBilibiliCookie, normalizeBilibiliCookie } from '../src/dsh/cookie-source'

describe('read-only original Bilibili login compatibility',()=>{
  it('prefers native credentials over explicit environment and never reads the old file',async()=>{
    const read=vi.fn()
    expect(await resolveBilibiliCookie({native:async()=> 'native-fixture',env:{BILIBILI_COOKIE:'SESSDATA=env-fixture',ELYSIUM_BILIBILI_SESSDATA:'alias-fixture'},readLegacy:read})).toBe('SESSDATA=native-fixture')
    expect(read).not.toHaveBeenCalled()
  })
  it('prefers the explicit full cookie environment over the legacy env alias and file',async()=>{
    const read=vi.fn()
    expect(await resolveBilibiliCookie({native:async()=>undefined,env:{BILIBILI_COOKIE:'SESSDATA=env-fixture; DedeUserID=1;',ELYSIUM_BILIBILI_SESSDATA:'alias-fixture'},readLegacy:read})).toBe('SESSDATA=env-fixture; DedeUserID=1')
    expect(read).not.toHaveBeenCalled()
  })
  it('normalizes the original explicit bare SESSDATA environment without reading disk',async()=>{
    const read=vi.fn()
    expect(await resolveBilibiliCookie({native:async()=>'',env:{ELYSIUM_BILIBILI_SESSDATA:'legacy-env-fixture'},readLegacy:read})).toBe('SESSDATA=legacy-env-fixture')
    expect(read).not.toHaveBeenCalled()
  })
  it.each([
    'ELYSIUM_BILIBILI_SESSDATA=bare-fixture',
    'ELYSIUM_BILIBILI_SESSDATA="bare-fixture" # fixture comment',
    "export ELYSIUM_BILIBILI_SESSDATA='bare-fixture'",
  ])('parses quoted/bare dotenv without executing or changing process environment: %s',async line=>{
    const read=vi.fn(async()=>line)
    const before=process.env.ELYSIUM_BILIBILI_SESSDATA
    expect(await resolveBilibiliCookie({native:async()=>'',env:{ELYSIA_LIVE_ENV_FILE:'/fixture-private/legacy.env'},readLegacy:read})).toBe('SESSDATA=bare-fixture')
    expect(read).toHaveBeenCalledExactlyOnceWith('/fixture-private/legacy.env')
    expect(process.env.ELYSIUM_BILIBILI_SESSDATA).toBe(before)
  })
  it('uses ELYSIA_ROOT/.env and the correct fixed Elysium default instead of prompt/persona directories',async()=>{
    const read=vi.fn(async()=> 'ELYSIUM_BILIBILI_SESSDATA=fixture')
    await resolveBilibiliCookie({native:async()=>'',env:{ELYSIA_ROOT:'/fixture-elysium',ELYSIA_PROMPTS_DIR:'/fixture-subject'},readLegacy:read})
    expect(read).toHaveBeenLastCalledWith('/fixture-elysium/.env')
    await resolveBilibiliCookie({native:async()=>'',env:{},readLegacy:read})
    expect(read).toHaveBeenLastCalledWith('/home/ayerelysia/Elysia/Elysium/.env')
  })
  it('reports an absent file as an explicit anonymous state and sanitizes other read failures',async()=>{
    const diagnostic=vi.fn()
    expect(await resolveBilibiliCookie({native:async()=>'',env:{},readLegacy:async()=>{throw Object.assign(new Error('fixture-hidden-value'),{code:'ENOENT'})},diagnostic})).toBe('')
    expect(diagnostic).toHaveBeenCalledExactlyOnceWith('legacy-file-not-found')
    await expect(resolveBilibiliCookie({native:async()=>'',env:{},readLegacy:async()=>{throw Object.assign(new Error('fixture-hidden-value'),{code:'EACCES'})}})).rejects.toThrow('旧B站登录来源读取失败（EACCES）')
  })
  it('preserves a full cookie from a quoted legacy value and rejects header injection',async()=>{
    expect(await resolveBilibiliCookie({native:async()=>'',env:{},readLegacy:async()=> 'ELYSIUM_BILIBILI_SESSDATA="SESSDATA=fixture; DedeUserID=1"'})).toBe('SESSDATA=fixture; DedeUserID=1')
    expect(()=>normalizeBilibiliCookie('SESSDATA=fixture\nInjected: value')).toThrow('非法换行')
  })
  it('does no credential file I/O merely by importing the resolver',async()=>{
    disk.readFile.mockClear()
    vi.resetModules()
    await import('../src/dsh/cookie-source')
    expect(disk.readFile).not.toHaveBeenCalled()
  })
})

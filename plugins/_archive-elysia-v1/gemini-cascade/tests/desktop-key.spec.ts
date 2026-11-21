import { randomBytes } from 'node:crypto'
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { assertDesktopKeyFile, readDesktopOwnerKey } from '../src/desktop-host.ts'

const key = randomBytes(32).toString('hex')

// Windows 的普通文件同样带 0o066、uid 恒为 0；用默认值模拟这台机器的 stat。
function fileStat(overrides: Partial<{ isFile: () => boolean; size: number; mode: number; uid: number }> = {}) {
  return { isFile: () => true, size: key.length, mode: 0o100666, uid: 0, ...overrides }
}

describe('desktop owner key verification', () => {
  it('accepts a private 64-hex key on Windows without POSIX mode or uid', () => {
    expect(() => assertDesktopKeyFile(fileStat(), 'win32')).not.toThrow()
    // 未放宽的约束：链接/非普通文件、大小上限、内容格式。
    expect(() => assertDesktopKeyFile(fileStat({ isFile: () => false }), 'win32')).toThrow('desktop_key_permissions')
    expect(() => assertDesktopKeyFile(fileStat({ size: 66 }), 'win32')).toThrow('desktop_key_format')
  })

  it('keeps the strict POSIX group/other and ownership checks', () => {
    expect(() => assertDesktopKeyFile(fileStat({ mode: 0o100640 }), 'linux')).toThrow('desktop_key_permissions')
    expect(() => assertDesktopKeyFile(fileStat({ uid: (process.getuid?.() ?? 0) + 1 }), 'linux')).toThrow('desktop_key_permissions')
    // process.getuid 在 Windows 上不存在；用同值模拟「所有者是本进程」。
    expect(() => assertDesktopKeyFile(fileStat({ mode: 0o100600, uid: process.getuid?.() as number }), 'linux')).not.toThrow()
  })

  it('accepts a real key file on this host and still refuses a link or a wrong format', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'elysia-desktop-key-'))
    try {
      const file = join(dir, 'owner.key')
      await writeFile(file, key, { mode: 0o600 })
      await expect(readDesktopOwnerKey(file)).resolves.toBe(key)

      const bad = join(dir, 'bad.key')
      await writeFile(bad, 'x'.repeat(64), { mode: 0o600 })
      await expect(readDesktopOwnerKey(bad)).rejects.toThrow('desktop_key_format')

      const link = join(dir, 'link.key')
      try { await symlink(file, link) } catch { return }
      await expect(readDesktopOwnerKey(link)).rejects.toThrow('desktop_key_permissions')
    } finally { await rm(dir, { recursive: true, force: true }) }
  })
})

import { randomBytes } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { apply, readBridgeSecret } from '../src/index.ts'

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'elysia-gemini-key-'))
  onTestFinished(() => rm(dir, { recursive: true, force: true }))
  const warn = vi.fn()
  const ctx = { logger: () => ({ warn }) } as unknown as Context
  return { dir, ctx, warn }
}

// 只给到 apply 在缺 key 分支之前会用到的字段；分支一旦越界访问 ctx，测试会立刻失败。
const config = (dir: string, extra: Record<string, unknown> = {}) => ({
  enabled: true, cwd: dir, promptsDir: dir, bridgeKeyFile: join(dir, 'missing.key'), ...extra,
})

describe('bridge key mount-time behavior', () => {
  it('mounts without a bridge key, warns, and leaves key-dependent capabilities unmounted', async () => {
    const { dir, ctx, warn } = await fixture()
    await expect(apply(ctx, config(dir))).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalledOnce()
    expect(warn.mock.calls[0]?.[0]).toContain('bridge key')
  })

  it('keeps the mount-time failure when strictBridgeKey is on', async () => {
    const { dir, ctx } = await fixture()
    await expect(apply(ctx, config(dir, { strictBridgeKey: true }))).rejects.toMatchObject({ code: 'invalid_bridge_key', status: 503 })
  })

  it('still rejects an existing key that breaks the original format rule', async () => {
    const { dir, ctx } = await fixture()
    const file = join(dir, 'bridge.key')
    await writeFile(file, 'not-a-key', { mode: 0o600 })
    await expect(apply(ctx, config(dir, { bridgeKeyFile: file }))).rejects.toMatchObject({ code: 'invalid_bridge_key' })
    await expect(readBridgeSecret(file)).rejects.toMatchObject({ code: 'invalid_bridge_key' })
  })

  it('accepts a valid existing key on this Windows host without POSIX permission bits', async () => {
    const { dir } = await fixture()
    const file = join(dir, 'bridge.key')
    const key = randomBytes(32).toString('hex')
    // Windows 上 writeFile 的 mode 不生效，普通文件同样带 0o066 位。
    await writeFile(file, key, { mode: 0o600 })
    await expect(readBridgeSecret(file)).resolves.toBe(key)
  })
})
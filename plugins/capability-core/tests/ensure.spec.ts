/**
 * Shared-core mount semantics: the first consumer mounts it, later consumers
 * reuse the same service even when they start from different contexts.
 */

import { describe, expect, it } from 'vitest'
import { ensureCapabilityCore, GLOBAL_PROBE_TOOL } from '../src/index.ts'
import { createEnv } from './harness.ts'

describe('ensureCapabilityCore', () => {
  it('mounts one core and reuses it for every consumer', async () => {
    const env = await createEnv()
    const first = await ensureCapabilityCore(env.ctx, { stateDir: env.stateDir })
    const second = await ensureCapabilityCore(env.ctx, { stateDir: env.stateDir })

    // `ctx.get` may hand back a fresh service proxy; the underlying core must
    // still be one instance. Register through the second handle and read it
    // through the first.
    second.registerTool(GLOBAL_PROBE_TOOL)
    expect((await first.list()).tools.some(tool => tool.id === 'elysia_probe')).toBe(true)
    expect(await first.globalTools()).toHaveProperty('elysia_probe')
    expect(env.host().isEnabled).toBeTypeOf('function')
  })
})
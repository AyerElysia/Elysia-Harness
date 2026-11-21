import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import * as Memory from '../src/index.ts'

describe('elysia-memory placeholder', () => {
  it('does not acquire host capabilities while mounted', () => {
    const unavailable = new Proxy({} as Context, {
      get(_target, key) {
        throw new Error(`placeholder acquired host capability: ${String(key)}`)
      },
    })
    expect(() => Memory.apply(unavailable)).not.toThrow()
  })

  it('mounts and disposes in fresh hosts without requiring memory or sessions', async () => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const ctx = new Context()
      try {
        await ctx.plugin(Memory)
        expect(Memory.name).toBe('elysia-memory')
      } finally {
        await ctx.fiber.dispose()
      }
    }
  })
})

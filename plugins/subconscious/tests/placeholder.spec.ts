import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import * as Subconscious from '../src/index.ts'

describe('elysia-subconscious placeholder', () => {
  it('mounts and unmounts without owning runtime work', async () => {
    const ctx = new Context()
    try {
      await ctx.plugin(Subconscious)
      expect(Subconscious.name).toBe('elysia-subconscious')
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

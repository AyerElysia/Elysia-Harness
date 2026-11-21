import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import * as ProactiveSystem from '../src/index.ts'

describe('elysia-proactive-system placeholder', () => {
  it('mounts and unmounts without owning runtime work', async () => {
    const ctx = new Context()
    try {
      await ctx.plugin(ProactiveSystem)
      expect(ProactiveSystem.name).toBe('elysia-proactive-system')
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

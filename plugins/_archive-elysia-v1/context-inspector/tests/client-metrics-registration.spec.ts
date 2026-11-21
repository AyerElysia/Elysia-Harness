// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { describe, expect, it, vi } from 'vitest'
import { apply, inject } from '../src/client/index.ts'
import { ContextMetricsMeter } from '../src/client/ContextMetricsMeter.tsx'
import { zh } from '../src/client/locales.ts'

async function rootContext() {
  const ctx = new Context()
  ctx.provide('connection', { rpc: { call: vi.fn() } } as never)
  ctx.provide('locale', { register: () => () => {}, bind: () => (key: keyof typeof zh) => zh[key] } as never)
  await ctx.plugin(SlotRegistry).await()
  return ctx
}

describe('metrics official dock registration lifecycle', () => {
  it('adds an independent dock contribution and removes it on plugin unload', async () => {
    const ctx = await rootContext()
    try {
      ctx.slots.register({ name: 'root', children: {
        'conversation.view': { kind: 'list', scope: 'session' },
        'conversation.composer.dock': { kind: 'list', scope: 'session' },
      } } as never, () => null)
      const fiber = ctx.plugin({ inject: [...inject], apply })
      await fiber.await()
      const entry = ctx.slots.entries('conversation.composer.dock').find(row => row.options.id === 'elysia-context-metrics')
      expect(entry?.component).toBe(ContextMetricsMeter)
      expect(entry?.options.order).toBe(20)
      await fiber.dispose()
      expect(ctx.slots.entries('conversation.composer.dock')).toHaveLength(0)
      expect(ctx.slots.entries('conversation.view')).toHaveLength(0)
    } finally { await ctx.fiber.dispose() }
  })

  it('does not create a late meter after the owning plugin was unloaded before the dock appeared', async () => {
    const ctx = await rootContext()
    try {
      const fiber = ctx.plugin({ inject: [...inject], apply })
      await fiber.await()
      await fiber.dispose()
      ctx.slots.register({ name: 'root', children: {
        'conversation.composer.dock': { kind: 'list', scope: 'session' },
      } } as never, () => null)
      expect(ctx.slots.entries('conversation.composer.dock')).toHaveLength(0)
    } finally { await ctx.fiber.dispose() }
  })
})

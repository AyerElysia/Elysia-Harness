// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { describe, expect, it, vi } from 'vitest'
import { createInspectorApi } from '../src/client/api.ts'
import { apply, inject } from '../src/client/index.ts'
import type { ContextInspectorInjected } from '../src/client/ContextInspectorView.tsx'
import { NS, zh } from '../src/client/locales.ts'

describe('context inspector official Conversation slot integration', () => {
  it('binds the slot session id to the Gateway API and removes the tab and locale on unload', async () => {
    const ctx = new Context()
    const call = vi.fn(async () => ({ ok: true, value: { request: null, reason: 'not-recorded' } }))
    const unregisterLocale = vi.fn()
    const registerLocale = vi.fn(() => unregisterLocale)
    ctx.provide('connection', { rpc: { call } } as never)
    ctx.provide('locale', {
      register: registerLocale,
      bind: () => (key: keyof typeof zh) => zh[key],
    } as never)
    try {
      await ctx.plugin(SlotRegistry).await()
      ctx.slots.register({
        name: 'root', children: { 'conversation.view': { kind: 'list', scope: 'session' } },
      } as never, () => null)
      const fiber = ctx.plugin({ inject: [...inject], apply })
      await fiber.await()
      const entry = ctx.slots.entries('conversation.view').find(row => row.options.id === 'context-inspector')
      expect(entry?.options.label).toBeDefined()
      expect(registerLocale).toHaveBeenCalledWith(NS, expect.any(Object))
      const create = entry?.inject as ((sessionId: string) => ContextInspectorInjected) | undefined
      if (create === undefined) throw new Error('missing session-bound inject face')
      const face = create('selected-session')
      expect(face.inspectorSessionId).toBe('selected-session')
      const controller = new AbortController()
      await createInspectorApi(face.inspectorRpc, face.inspectorSessionId).latest(controller.signal)
      expect(call).toHaveBeenCalledWith('/api', 'contextInspector/latest',
        { args: { request: { sessionId: 'selected-session' } } }, controller.signal)
      await fiber.dispose()
      expect(ctx.slots.entries('conversation.view').some(row => row.options.id === 'context-inspector')).toBe(false)
      expect(unregisterLocale).toHaveBeenCalledTimes(1)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

/**
 * Registration behavior of the browser half: the sidebar entry, the main panel
 * it opens, the injected Host adapter, and the dictionaries.
 */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import * as client from '../../src/client/index.ts'

interface Registration {
  readonly name: string
  readonly options: {
    readonly id?: string
    readonly key?: string
    readonly order?: number
    readonly locale?: string
    readonly label?: () => string
    readonly inject?: () => unknown
  }
}

/** Mount the browser half over recording substitutes for its three services. */
async function mount(): Promise<{
  readonly registrations: readonly Registration[]
  readonly dictionaries: readonly { namespace: string; locale: string; keys: readonly string[] }[]
}> {
  const registrations: Registration[] = []
  const dictionaries: { namespace: string; locale: string; keys: readonly string[] }[] = []
  const ctx = new Context()
  ctx.provide('slots', {
    inject(_name: string, contribute: () => unknown) {
      contribute()
      return () => {}
    },
    register(options: Registration['options'], _component: unknown) {
      registrations.push({ name: options.key === undefined ? 'list' : 'keyed', options })
      return () => {}
    },
  } as never)
  ctx.provide('locale', {
    register(namespace: string, copies: Record<string, Record<string, string>>) {
      for (const [locale, keys] of Object.entries(copies)) {
        dictionaries.push({ namespace, locale, keys: Object.keys(keys) })
      }
      return () => {}
    },
    bind(namespace: string) {
      return (key: string) => `${namespace}:${key}`
    },
  } as never)
  ctx.provide('connection', { rpc: { call: async () => ({ ok: true, value: undefined }) } } as never)
  await ctx.plugin(client)
  await ctx.fiber.dispose()
  return { registrations, dictionaries }
}

describe('capability panel entries', () => {
  it('registers the Capabilities main panel and its sidebar entry under one id', async () => {
    const { registrations } = await mount()
    expect(registrations).toHaveLength(2)

    const panel = registrations.find(entry => entry.name === 'keyed')
    expect(panel?.name).toBe('keyed')
    expect(panel?.options.key).toBe('capabilities')
    expect(panel?.options.locale).toBe('controlPanel')

    const entry = registrations.find(registration => registration !== panel)
    expect(entry?.options.id).toBe('capabilities')
    expect(entry?.options.order).toBe(40)
    expect(entry?.options.locale).toBe('controlPanel')
    expect(entry?.options.label?.()).toBe('controlPanel:panel')
    expect(client.PANEL_ID).toBe('capabilities')
    // The panel must not reuse the preset manager's entry identity.
    expect(client.PANEL_ID).not.toBe('presets')
  })

  it('registers both dictionaries under one namespace and injects the Host adapter', async () => {
    const { registrations, dictionaries } = await mount()
    expect(dictionaries.map(entry => entry.locale).toSorted()).toEqual(['en', 'zh'])
    for (const dictionary of dictionaries) expect(dictionary.namespace).toBe('controlPanel')

    const keys = dictionaries.find(entry => entry.locale === 'en')?.keys ?? []
    expect(keys).toContain('panel')
    expect(keys).toContain('atomicGroup')
    expect(keys).toContain('healthTools')
    expect(keys).toContain('errorScopeReadOnly')
    expect(keys).toContain('stepHidden')

    const panel = registrations.find(entry => entry.name === 'keyed')
    const injected = panel?.options.inject?.() as { api?: Record<string, unknown> } | undefined
    expect(Object.keys(injected?.api ?? {}).toSorted()).toEqual([
      'createToolPreset', 'deleteToolPreset', 'list', 'publish', 'setContext', 'setTool', 'status',
    ])
  })

  it('declares only services the Web shell provides', () => {
    expect(client.inject).toEqual(['slots', 'locale', 'connection'])
  })
})
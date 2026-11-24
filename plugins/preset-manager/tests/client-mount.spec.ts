/**
 * Registration behavior of the browser half: the sidebar entry, the main panel
 * it opens, and the injected Host adapter.
 */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import * as client from '../src/client/index.ts'

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
  readonly dictionary: { namespace: string; keys: readonly string[] }
}> {
  const registrations: Registration[] = []
  const dictionary = { namespace: '', keys: [] as string[] }
  const ctx = new Context()
  ctx.provide('slots', {
    inject(_name: string, contribute: () => unknown) {
      contribute()
      return () => {}
    },
    register(options: Registration['options'], _component: unknown) {
      registrations.push({ name: options.key === undefined ? '' : 'main', options })
      return () => {}
    },
  } as never)
  ctx.provide('locale', {
    register(namespace: string, copies: Record<string, Record<string, string>>) {
      dictionary.namespace = namespace
      dictionary.keys = Object.keys(copies['en'] ?? {})
      return () => {}
    },
    bind(namespace: string) {
      return (key: string) => `${namespace}:${key}`
    },
  } as never)
  ctx.provide('connection', { rpc: { call: async () => ({ ok: true, value: undefined }) } } as never)
  await ctx.plugin(client)
  await ctx.fiber.dispose()
  return { registrations, dictionary }
}

describe('preset manager entries', () => {
  it('registers the Presets main panel and its sidebar entry under one id', async () => {
    const { registrations } = await mount()
    expect(registrations).toHaveLength(2)

    const panel = registrations.find(entry => entry.options.key === 'presets')
    expect(panel).toBeDefined()
    expect(panel?.options.locale).toBe('presetManager')

    const entry = registrations.find(registration => registration !== panel)
    expect(entry?.options.id).toBe('presets')
    expect(entry?.options.order).toBe(30)
    expect(entry?.options.locale).toBe('presetManager')
    expect(entry?.options.label?.()).toBe('presetManager:panel')
    expect(client.PANEL_ID).toBe('presets')
  })

  it('registers both dictionaries under one namespace and injects the Host adapter', async () => {
    const { registrations, dictionary } = await mount()
    expect(dictionary.namespace).toBe('presetManager')
    expect(dictionary.keys).toContain('panel')
    expect(dictionary.keys).toContain('faceDefault')
    expect(dictionary.keys).toContain('customFaceHint')

    const panel = registrations.find(entry => entry.options.key === 'presets')
    const injected = panel?.options.inject?.() as { api?: Record<string, unknown> } | undefined
    expect(Object.keys(injected?.api ?? {}).toSorted()).toEqual([
      'create', 'createToolFace', 'deleteToolFace', 'list', 'listPromptCandidates', 'listToolFaces',
      'modelTools', 'pickDirectory', 'remove', 'setModelToolsGlobal',
    ])
  })

  it('declares only services the Web shell provides', () => {
    expect(client.inject).toEqual(['slots', 'locale', 'connection'])
  })
})

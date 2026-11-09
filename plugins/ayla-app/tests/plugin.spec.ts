import { readFile, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply } from '../src/index.ts'
import type { InboundEvent } from '../src/inbound.ts'

const here = dirname(fileURLToPath(import.meta.url))
const packageRoot = join(here, '..')

/** The one thing the plugin is allowed to know about a host: names, not types. */
function fakeConfig(values: { baseUrl?: string; username?: string; password?: string; mode?: string; workspaceDir?: string }) {
  const read = <T>(value: T) => () => value
  return {
    baseUrl: { get: read(values.baseUrl ?? 'http://127.0.0.1:8100') },
    username: { get: read(values.username ?? 'elysia') },
    password: { get: read(values.password ?? 'pw') },
    mode: { get: read(values.mode ?? 'auto') },
    workspaceDir: { get: read(values.workspaceDir ?? '') },
  }
}

/** A socket that never opens; the wiring tests only care about registration. */
class SilentSocket {
  onopen: ((event: unknown) => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onclose: ((event: { code?: number }) => void) | null = null
  onerror: ((event: unknown) => void) | null = null
  send(): void {}
  close(): void {}
}

afterEach(() => {
  vi.unstubAllGlobals()
})

function installSocket(): void {
  vi.stubGlobal('WebSocket', SilentSocket)
}

interface Harness {
  ctx: Context
  tools: string[]
  created: unknown[]
  /** Effects registered so far; read through a getter because it grows after return. */
  readonly effects: number
  logs: string[]
}

function harness(options: {
  pending?: { receive(message: InboundEvent): void }
  outboundText?: { register(channel: string, send: unknown): () => void }
} = {}): Harness {
  const tools: string[] = []
  const created: unknown[] = []
  const logs: string[] = []
  let effects = 0
  const services: Record<string, unknown> = {
    agents: {
      get: () => undefined,
      async resume() { created.push('resume'); throw new Error('no saved session') },
      async create(options: unknown) { created.push(options); return { agent: { followup: () => {}, whenIdle: async () => {} }, dispose: async () => {} } },
    },
    sessionPersistence: {},
    attachments: {
      imageLimits: { maxImageBytes: 1024, maxImagesPerMessage: 2 },
      admitPromptContent: async (content: unknown[]) => content,
    },
    tools: { register: (tool: { name: string }) => { tools.push(tool.name); return () => {} } },
  }
  if (options.pending !== undefined) services.inboundPending = options.pending
  if (options.outboundText !== undefined) services.outboundText = options.outboundText
  const ctx = {
    get: (name: string) => services[name],
    logger: () => ({
      info: (message: string) => logs.push(message),
      warn: (message: string) => logs.push(message),
      error: (message: string) => logs.push(message),
    }),
    effect(callback: () => () => void) {
      effects++
      callback()
      return () => {}
    },
    attachments: services.attachments,
    tools: services.tools,
    agents: services.agents,
  }
  return {
    ctx: ctx as unknown as Context,
    tools,
    created,
    get effects() { return effects },
    logs,
  }
}

describe('Ayla plugin wiring: elyh form', () => {
  it('registers no tool and opens no session', () => {
    installSocket()
    const received: InboundEvent[] = []
    const registered: string[] = []
    const harnessed = harness({
      pending: { receive: message => { received.push(message) } },
      outboundText: {
        register(channel) {
          registered.push(channel)
          return () => {}
        },
      },
    })
    apply(harnessed.ctx, fakeConfig({ mode: 'elyh' }) as never)
    expect(harnessed.tools).toEqual([])
    expect(harnessed.created).toEqual([])
    // The conscious mind's send_text looks the channel up here; that is the
    // only outbound contribution this form makes.
    expect(registered).toEqual(['ayla'])
    expect(harnessed.logs.join('\n')).toContain('Ayla 通道形态: elyh')
  })

  it('starts the socket and stops it on unload', () => {
    installSocket()
    const harnessed = harness({
      pending: { receive: () => {} },
      outboundText: { register: () => () => {} },
    })
    apply(harnessed.ctx, fakeConfig({ mode: 'elyh' }) as never)
    expect(harnessed.effects).toBeGreaterThan(0)
  })
})

describe('Ayla plugin wiring: standalone form', () => {
  it('registers no global tool; send_text arrives only through the agent scope', () => {
    installSocket()
    const harnessed = harness()
    apply(harnessed.ctx, fakeConfig({ mode: 'standalone', workspaceDir: '' }) as never)
    expect(harnessed.tools).toEqual([])
    expect(harnessed.created).toEqual([])
    expect(harnessed.logs.join('\n')).toContain('Ayla 通道形态: standalone')
  })

  it('never registers the outbound channel, because it owns its own tool', () => {
    installSocket()
    const registered: string[] = []
    const harnessed = harness({
      outboundText: { register(channel) { registered.push(channel); return () => {} } },
    })
    apply(harnessed.ctx, fakeConfig({ mode: 'standalone' }) as never)
    expect(registered).toEqual([])
    expect(harnessed.tools).toEqual([])
  })
})

describe('Ayla plugin wiring: misconfiguration', () => {
  it('fails the mount when elyh is chosen without the conscious mind', () => {
    installSocket()
    expect(() => apply(harness().ctx, fakeConfig({ mode: 'elyh' }) as never))
      .toThrow(/inboundPending/u)
  })

  it('fails the mount for a plaintext non-private address', () => {
    installSocket()
    expect(() => apply(harness().ctx, fakeConfig({ baseUrl: 'http://example.com' }) as never))
      .toThrow(/https/u)
  })
})

describe('Ayla plugin dependencies', () => {
  it('imports no @elysia package anywhere in src', async () => {
    const entries = await readdir(join(packageRoot, 'src'))
    const offenders: string[] = []
    for (const entry of entries) {
      const text = await readFile(join(packageRoot, 'src', entry), 'utf8')
      if (/from '@elysia\//u.test(text)) offenders.push(entry)
    }
    expect(offenders).toEqual([])
  })

  it('keeps dependencies empty and declares no ws package', async () => {
    const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>
      peerDependencies: Record<string, string>
      devDependencies: Record<string, string>
    }
    expect(manifest.dependencies).toEqual({})
    const declared = [
      ...Object.keys(manifest.peerDependencies),
      ...Object.keys(manifest.devDependencies),
    ]
    expect(declared.filter(name => name === 'ws' || name.startsWith('@elysia/'))).toEqual([])
  })

  it('uses the Node global WebSocket instead of importing ws', async () => {
    const entries = await readdir(join(packageRoot, 'src'))
    const offenders: string[] = []
    for (const entry of entries) {
      const text = await readFile(join(packageRoot, 'src', entry), 'utf8')
      if (/from 'ws'|require\('ws'\)/u.test(text)) offenders.push(entry)
    }
    expect(offenders).toEqual([])
  })
})

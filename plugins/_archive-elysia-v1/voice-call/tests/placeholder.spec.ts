/** Index integration gate: real Cordis lifecycle, only in-memory infrastructure metadata. */
import { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { VoiceState } from '../src/protocol.ts'
import * as VoiceCall from '../src/index.ts'

interface ControllerOptions {
  enabled: boolean
  credentialConfigured: boolean
  resolveApiKey(signal: AbortSignal): Promise<string>
  openAgent(input: unknown): Promise<unknown>
  [name: string]: unknown
}
interface ControllerFixture {
  readonly options: ControllerOptions
  state: VoiceState
  close: ReturnType<typeof vi.fn>
  updateCredentialConfigured: ReturnType<typeof vi.fn>
}
const edges = vi.hoisted(() => ({
  controllers: [] as ControllerFixture[],
  realtime: vi.fn(), socket: vi.fn(), mkdir: vi.fn(),
  createAgent: vi.fn(), prepareSession: vi.fn(), assemblePrompt: vi.fn(), acceptInput: vi.fn(),
}))
vi.mock('../src/controller.ts', async () => {
  const { idleVoiceState } = await import('../src/protocol.ts')
  return {
    VoiceCallError: class extends Error { constructor(readonly code: string) { super(code) } },
    VoiceCallController: class {
      state: VoiceState
      close = vi.fn(async () => {})
      updateCredentialConfigured = vi.fn((value: boolean) => { this.state = { ...this.state, credentialConfigured: value } })
      constructor(readonly options: ControllerOptions) {
        this.state = idleVoiceState(options.enabled,options.credentialConfigured)
        edges.controllers.push(this)
      }
      getState() { return this.state }
      async start() { throw new Error('No call may start in the index gate') }
      async control() { throw new Error('No call controls may run in the index gate') }
      async playback() { throw new Error('No playback may run in the index gate') }
      subscribeEvents() { throw new Error('No call stream may open in the index gate') }
    },
  }
})
vi.mock('../src/realtime.ts', () => ({ RealtimeTransport: class { constructor(options: unknown) { edges.realtime(options) } } }))
vi.mock('ws', () => ({ default: edges.socket }))
vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>(), mkdir: edges.mkdir }))
vi.mock('@elysia/conscious-mind/src/breeze-tts.ts', () => ({ ELYSIUM_BREEZE_CONFIG: '/fixture/no-runtime/breeze.json' }))
vi.mock('../src/session.ts', () => ({
  VOICE_SESSION_ID: 'elysia-voice-call', VoiceAgent: class {}, createVoiceAgent: edges.createAgent,
}))
vi.mock('../src/persistence.ts', () => ({ prepareVoiceSession: edges.prepareSession }))
vi.mock('../src/prompt.ts', () => ({ assembleVoicePrompt: edges.assemblePrompt }))
vi.mock('../src/input.ts', () => ({ acceptVoiceAudioCommit: edges.acceptInput }))

type Route = { path: string; fetch(request: Request): Promise<Response> }
const roots: Context[] = []
const deployment = { cwd:'/fixture/no-runtime/call',promptsDir:'/fixture/no-runtime/prompts',breezeConfigPath:'/fixture/no-runtime/breeze.json' }
beforeEach(() => {
  vi.useFakeTimers()
  edges.controllers.length = 0
  for (const value of Object.values(edges)) if (typeof value === 'function') value.mockClear()
  vi.stubGlobal('fetch',vi.fn(async () => { throw new Error('Network is forbidden') }))
  vi.stubGlobal('navigator',{mediaDevices:{getUserMedia:vi.fn(async () => { throw new Error('Media is forbidden') })}})
})
afterEach(async () => {
  for (const root of roots.splice(0).reverse()) await root.fiber.dispose()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
})
function fixture(configured = false) {
  const root = new Context(); roots.push(root)
  const routes = new Map<string,Route>()
  const unregister = vi.fn()
  const register = vi.fn((route: Route) => {
    if (routes.has(route.path)) throw new Error('Duplicate route')
    routes.set(route.path,route)
    return () => { unregister(route.path); routes.delete(route.path) }
  })
  const credentials = {
    describe: vi.fn(async (_ref: string) => ({configured,source:configured?'fixture':undefined,writable:false})),
    resolve: vi.fn(async () => { throw new Error('Key resolution is forbidden') }),
  }
  const domains: Array<{close: ReturnType<typeof vi.fn>;table: ReturnType<typeof vi.fn>}> = []
  const storageDomain = { open: vi.fn(async () => {
    const domain = {close:vi.fn(async()=>{}),table:vi.fn(()=>{throw new Error('Business activity storage is forbidden')})}
    domains.push(domain);return domain
  }) }
  const factory = { createAgent:vi.fn(),resume:vi.fn() }
  const agents = {factory,setFactory:vi.fn(),register:vi.fn(),create:vi.fn()}
  const sessions = {flush:vi.fn(),enter:vi.fn(),announce:vi.fn()}
  for (const [name,service] of Object.entries({credentials,storageDomain,agents,sessions,systemPrompt:{},sessionPersistence:{},connection:{fetch:{register}},tools:{}})) {
    root.reflect.provide(name,service)
  }
  const mount = (input: VoiceCall.Config = {}) => root.plugin(VoiceCall,{...deployment,...input})
  const state = async () => {
    const route = routes.get('/api/voice-call/state')
    if (!route) throw new Error('State route is not mounted')
    return await (await route.fetch(new Request('https://fixture.invalid/api/voice-call/state'))).json() as VoiceState
  }
  return {root,routes,register,unregister,credentials,storageDomain,domains,agents,sessions,factory,mount,state}
}
function assertIdle(f: ReturnType<typeof fixture>) {
  expect(f.storageDomain.open).not.toHaveBeenCalled()
  expect(f.domains).toHaveLength(0)
  expect(f.credentials.resolve).not.toHaveBeenCalled()
  expect(f.agents.factory).toBe(f.factory)
  expect(f.agents.setFactory).not.toHaveBeenCalled()
  expect(f.agents.register).not.toHaveBeenCalled()
  expect(f.agents.create).not.toHaveBeenCalled()
  expect(f.sessions.flush).not.toHaveBeenCalled()
  expect(f.sessions.enter).not.toHaveBeenCalled()
  expect(f.sessions.announce).not.toHaveBeenCalled()
  for (const domain of f.domains) expect(domain.table).not.toHaveBeenCalled()
  for (const edge of [edges.socket,edges.mkdir,edges.createAgent,edges.prepareSession,edges.assemblePrompt,edges.acceptInput]) expect(edge).not.toHaveBeenCalled()
  expect(globalThis.fetch).not.toHaveBeenCalled()
  expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
}

describe('voice plugin index offline mount gate', () => {
  it('declares the real plugin boundary with disabled-by-default configuration', () => {
    const manifest = JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8'))
    expect(manifest.name).toBe('@elysia/voice-call')
    expect(manifest.dsh.bundle.patch).toBe('./cordis.patch.yml')
    expect(VoiceCall.name).toBe('elysia-voice-call')
    expect(VoiceCall.Config({}).enabled).toBe(false)
    expect(VoiceCall.Config({}).breezeServerUrl).toBe('http://127.0.0.1:7865')
    expect(VoiceCall.inject).toEqual(expect.arrayContaining(['sessions','agents','systemPrompt','sessionPersistence','credentials','connection','storageDomain']))
    const patch = readFileSync(new URL('../cordis.patch.yml',import.meta.url),'utf8')
    expect(patch).toContain("name: '@elysia/voice-call'")
    expect(patch).toContain('id: elysia-voice-call')
  })
  it('mounts only metadata and authenticated routes; configured does not imply auto-start', async () => {
    const f = fixture(true)
    const plugin = await f.mount()
    expect(f.credentials.describe).toHaveBeenCalledExactlyOnceWith('OPENAI_REALTIME_API_KEY')
    expect(f.register).toHaveBeenCalledTimes(5)
    expect([...f.routes.keys()].sort()).toEqual(['control','events','playback','start','state'].map(name=>'/api/voice-call/'+name).sort())
    expect(await f.state()).toMatchObject({enabled:false,credentialConfigured:true,callId:null,connection:'idle',rawAudioRecorded:false})
    expect(edges.controllers).toHaveLength(1)
    expect(edges.controllers[0]!.options.resolveApiKey).toBeTypeOf('function')
    expect(edges.controllers[0]!.options.openAgent).toBeTypeOf('function')
    assertIdle(f)
    await plugin.dispose()
    expect(edges.controllers[0]!.close).toHaveBeenCalledExactlyOnceWith('plugin_unloaded')
    expect(f.routes.size).toBe(0)
    assertIdle(f)
  })
  it('unmounts and remounts without duplicate routes or stale controllers, even enabled', async () => {
    const f = fixture(true)
    const first = await f.mount({enabled:true})
    expect((await f.state()).enabled).toBe(true)
    await first.dispose()
    expect(f.unregister).toHaveBeenCalledTimes(5)
    const second = await f.mount({enabled:true})
    expect(f.routes.size).toBe(5)
    expect(edges.controllers).toHaveLength(2)
    expect(edges.controllers[0]).not.toBe(edges.controllers[1])
    expect(edges.controllers[0]!.close).toHaveBeenCalledOnce()
    expect(edges.controllers[1]!.close).not.toHaveBeenCalled()
    await second.dispose()
    expect(f.routes.size).toBe(0)
    expect(f.unregister).toHaveBeenCalledTimes(10)
    expect(edges.controllers[1]!.close).toHaveBeenCalledExactlyOnceWith('plugin_unloaded')
    expect(f.domains).toHaveLength(0)
    assertIdle(f)
  })
  it('refreshes only the selected credential-reference metadata and detaches on unload', async () => {
    const f = fixture(false)
    const selected = credentialRef('FIXTURE_VOICE_KEY')
    const plugin = await f.mount({apiKeyRef:selected})
    expect((await f.state()).credentialConfigured).toBe(false)
    await f.root.parallel('credentials/reference-updated',credentialRef('OTHER_FIXTURE_KEY'))
    expect(f.credentials.describe).toHaveBeenCalledTimes(1)
    f.credentials.describe.mockResolvedValue({configured:true,source:'fixture',writable:false})
    await f.root.parallel('credentials/reference-updated',selected)
    expect(edges.controllers[0]!.updateCredentialConfigured).toHaveBeenCalledExactlyOnceWith(true)
    expect((await f.state()).credentialConfigured).toBe(true)
    f.credentials.describe.mockResolvedValue({configured:false,source:undefined,writable:false})
    await f.root.parallel('credentials/reference-updated',selected)
    expect((await f.state()).credentialConfigured).toBe(false)
    await plugin.dispose()
    await f.root.parallel('credentials/reference-updated',selected)
    expect(f.credentials.describe).toHaveBeenCalledTimes(3)
    expect(edges.controllers[0]!.updateCredentialConfigured).toHaveBeenCalledTimes(2)
    assertIdle(f)
  })
  it('owner shutdown drains its idle controller and route registrations', async () => {
    const f = fixture()
    await f.mount()
    await f.root.fiber.dispose()
    expect(f.routes.size).toBe(0)
    expect(edges.controllers[0]!.close).toHaveBeenCalledExactlyOnceWith('plugin_unloaded')
    assertIdle(f)
  })
})

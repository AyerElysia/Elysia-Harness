import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it, vi } from 'vitest'
import * as StandingPrompt from '@elysia/conscious-mind/standing-prompts'
import {
  bindLivestreamAgentSetup, composeLivestreamAgent, LIVESTREAM_SESSION_ID,
  ensureLivestreamAgent, pushLivestream, clearLivestreamDeliveries, type SessionPromptConfig,
} from '../src/dsh/session'
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }

const config: SessionPromptConfig = {
  baseDir: '/fixture-not-read', files: ['SOUL.md', 'LIVE.md'],
  required: ['SOUL.md'],
}

/** A scoped installation fixture: it never invokes StandingPrompt or reads files. */
function scopeFixture() {
  const cleanup: Array<() => void> = []
  const plugin = vi.fn(async (_plugin: unknown, _config: unknown) => ({}))
  const ctx = {
    plugin,
    tools: { restrict: vi.fn(() => () => {}) },
    effect: (start: () => () => void) => { const stop = start(); cleanup.push(stop); return stop },
  } as unknown as Context
  return { ctx, plugin, dispose: () => { for (const stop of cleanup.splice(0)) stop() } }
}

function agentFixture(scope = scopeFixture()) {
  const runMaintenance = vi.fn(async (task: (signal: AbortSignal) => Promise<void>) => {
    await task(new AbortController().signal)
  })
  const touched = vi.fn()
  const agent = {
    id: LIVESTREAM_SESSION_ID, ctx: scope.ctx, runMaintenance,
    get session(): never { touched(); throw new Error('fixture history must not be read') },
  } as unknown as Agent
  return { agent, scope, runMaintenance, touched }
}

function ownerFixture(agent: Agent) {
  const get = vi.fn((id: string) => id === LIVESTREAM_SESSION_ID ? agent : undefined)
  const resume = vi.fn()
  const create = vi.fn()
  const ctx = { agents: { get, resume, create } } as unknown as Context
  return { ctx, get, resume, create }
}

describe('upstream Elysia livestream native lifecycle composition', () => {
  it('awaits scoped installation for the precise UI-resumed identity and ignores every other identity', async () => {
    const root = new Context()
    const fixture = agentFixture()
    const entered = deferred<void>()
    const release = deferred<void>()
    fixture.scope.plugin.mockImplementation(async () => { entered.resolve(); await release.promise; return {} })
    const owner = await root.plugin((ctx: Context) => { bindLivestreamAgentSetup(ctx, config) })
    let settled = false
    try {
      const foreign = {
        id: SessionId('elysia-conscious-mind'),
        get ctx(): never { throw new Error('foreign scope must not be inspected') },
      } as unknown as Agent
      await root.serial('agent/created', { agent: foreign, source: 'resume' })
      expect(fixture.scope.plugin).not.toHaveBeenCalled()
      const creating = root.serial('agent/created', { agent: fixture.agent, source: 'resume' }).then(() => { settled = true })
      await entered.promise
      expect(settled).toBe(false)
      expect(fixture.runMaintenance).not.toHaveBeenCalled()
      release.resolve()
      await creating
      expect(fixture.scope.plugin).toHaveBeenNthCalledWith(1, StandingPrompt, { ...config, complete: true })
      expect(fixture.touched).not.toHaveBeenCalled()
    } finally {
      release.resolve()
      await owner.dispose()
      await root.fiber.dispose()
    }
  })

  it('removes its listener with the owning plugin scope', async () => {
    const root = new Context()
    const fixture = agentFixture()
    const owner = await root.plugin((ctx: Context) => { bindLivestreamAgentSetup(ctx, config) })
    try {
      await owner.dispose()
      await root.serial('agent/created', { agent: fixture.agent, source: 'resume' })
      expect(fixture.scope.plugin).not.toHaveBeenCalled()
    } finally { await root.fiber.dispose() }
  })
})

describe('livestream existing UI agent compatibility', () => {
  it('reserves one existing idle agent without reading history or acquiring a second writer', async () => {
    const fixture = agentFixture()
    const owner = ownerFixture(fixture.agent)
    const handle = await ensureLivestreamAgent(owner.ctx, config)
    expect(handle.agent).toBe(fixture.agent)
    expect(fixture.runMaintenance).toHaveBeenCalledTimes(1)
    expect(fixture.scope.plugin).toHaveBeenNthCalledWith(1, StandingPrompt, { ...config, complete: true })
    expect(owner.get).toHaveBeenCalledExactlyOnceWith(LIVESTREAM_SESSION_ID)
    expect(owner.resume).not.toHaveBeenCalled()
    expect(owner.create).not.toHaveBeenCalled()
    expect(fixture.touched).not.toHaveBeenCalled()
    await handle.dispose()
    const again = await ensureLivestreamAgent(owner.ctx, config)
    expect(again.agent).toBe(fixture.agent)
    expect(fixture.runMaintenance).toHaveBeenCalledTimes(1)
    expect(fixture.scope.plugin).toHaveBeenCalledTimes(2)
  })

  it('shares in-progress composition instead of entering a second maintenance operation', async () => {
    const fixture = agentFixture()
    const owner = ownerFixture(fixture.agent)
    const entered = deferred<void>()
    const release = deferred<void>()
    fixture.scope.plugin.mockImplementation(async () => { entered.resolve(); await release.promise; return {} })
    const first = ensureLivestreamAgent(owner.ctx, config)
    await entered.promise
    const second = ensureLivestreamAgent(owner.ctx, config)
    expect(fixture.runMaintenance).toHaveBeenCalledTimes(1)
    expect(fixture.scope.plugin).toHaveBeenCalledTimes(1)
    release.resolve()
    const handles = await Promise.all([first, second])
    expect(handles.every(handle => handle.agent === fixture.agent)).toBe(true)
    expect(owner.resume).not.toHaveBeenCalled()
    expect(owner.create).not.toHaveBeenCalled()
  })

  it('rejects a different composition receipt without replacement, resume, or create', async () => {
    const fixture = agentFixture()
    const owner = ownerFixture(fixture.agent)
    await composeLivestreamAgent(fixture.scope.ctx, config)
    await expect(ensureLivestreamAgent(owner.ctx, { ...config, files: ['SOUL.md', 'OTHER.md'] })).rejects.toThrow('composition mismatch')
    expect(fixture.scope.plugin).toHaveBeenCalledTimes(2)
    expect(fixture.runMaintenance).not.toHaveBeenCalled()
    expect(owner.resume).not.toHaveBeenCalled()
    expect(owner.create).not.toHaveBeenCalled()
    expect(fixture.touched).not.toHaveBeenCalled()
  })

  it('keeps busy agents untouched and does not attempt a second writer', async () => {
    const fixture = agentFixture()
    const owner = ownerFixture(fixture.agent)
    fixture.runMaintenance.mockImplementation(() => { throw new Error('fixture agent is busy') })
    await expect(ensureLivestreamAgent(owner.ctx, config)).rejects.toThrow('fixture agent is busy')
    expect(fixture.scope.plugin).not.toHaveBeenCalled()
    expect(owner.resume).not.toHaveBeenCalled()
    expect(owner.create).not.toHaveBeenCalled()
  })

  it('propagates setup failure while permitting a clean later retry', async () => {
    const fixture = agentFixture()
    const owner = ownerFixture(fixture.agent)
    fixture.scope.plugin.mockRejectedValueOnce(new Error('fixture setup failed'))
    await expect(ensureLivestreamAgent(owner.ctx, config)).rejects.toThrow('fixture setup failed')
    expect(owner.resume).not.toHaveBeenCalled()
    expect(owner.create).not.toHaveBeenCalled()
    const handle = await ensureLivestreamAgent(owner.ctx, config)
    expect(handle.agent).toBe(fixture.agent)
    expect(fixture.scope.plugin).toHaveBeenCalledTimes(3)
  })

  it('forgets the receipt when its scoped effects are disposed', async () => {
    const fixture = agentFixture()
    await composeLivestreamAgent(fixture.scope.ctx, config)
    fixture.scope.dispose()
    await composeLivestreamAgent(fixture.scope.ctx, config)
    expect(fixture.scope.plugin).toHaveBeenCalledTimes(4)
  })
})

describe('native livestream inbox delivery durability', () => {
  it('retries post-followup flush failure and replays a stable native id without another followup', async () => {
    const storage=new Context();await storage.plugin(SessionStore)
    const session=storage.sessions.create(LIVESTREAM_SESSION_ID)
    const fixture=agentFixture()
    Reflect.defineProperty(fixture.agent,'session',{value:session})
    const followup=vi.fn((message:import('@deepseek-ai/dsh-llm').UserMessage)=>{session.append('agent/inbox/spliced',{target:'next-turn',start:0,inserted:[message]})})
    Reflect.set(fixture.agent,'followup',followup);Reflect.set(fixture.agent,'steer',followup)
    const owner=ownerFixture(fixture.agent)
    const flush=vi.fn().mockResolvedValueOnce(true).mockRejectedValueOnce(new Error('fixture flush failure')).mockResolvedValue(true)
    Reflect.set(owner.ctx,'sessions',{flush});Reflect.set(owner.ctx,'effect',(f:()=>unknown)=>f())
    try {
      await expect(pushLivestream(owner.ctx,config,LIVESTREAM_SESSION_ID,'first immutable projection',false,'fixture-ref')).rejects.toThrow('fixture flush failure')
      const message=followup.mock.calls[0]?.[0]
      await expect(pushLivestream(owner.ctx,config,LIVESTREAM_SESSION_ID,'retry has a later timestamp',false,'fixture-ref')).resolves.toBe(true)
      expect(followup).toHaveBeenCalledTimes(1)
      expect(followup.mock.calls[0]?.[0]).toBe(message)
      expect(flush).toHaveBeenCalledTimes(4)
      clearLivestreamDeliveries(owner.ctx)
      await pushLivestream(owner.ctx,config,LIVESTREAM_SESSION_ID,'restart replay',false,'fixture-ref')
      expect(followup).toHaveBeenCalledTimes(1)
    } finally {await storage.fiber.dispose()}
  })
})

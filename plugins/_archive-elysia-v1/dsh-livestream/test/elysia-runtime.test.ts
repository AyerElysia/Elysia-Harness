import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
const dirs: string[] = []
const directory = () => { const d=mkdtempSync(join(tmpdir(),'elysia-runtime-fixture-'));dirs.push(d);return d }
const config = (dataDir:string) => ({ baseDir:'/fixture-not-read',files:['SOUL.md','LIVE.md'],dataDir,stagePort:0,publisher:'livehime' as const })
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();for(const d of dirs.splice(0))rmSync(d,{recursive:true,force:true})})
describe('owner-scoped upstream runtime initialization',()=>{
  it('does not write storage, listen, create agents, or schedule timers merely by importing',async()=>{
    const parent=directory(), home=join(parent,'not-created')
    vi.stubEnv('DSH_HOME',home)
    vi.resetModules()
    const interval=vi.spyOn(globalThis,'setInterval')
    const runtime=await import('../src/dsh/runtime')
    expect(existsSync(home)).toBe(false)
    expect(runtime.show).toBeUndefined()
    expect(interval).not.toHaveBeenCalled()
  })
  it('initializes only the supplied fixture data and releases its single owner idempotently',async()=>{
    const runtime=await import('../src/dsh/runtime')
    const dir=directory()
    const ctx={get:()=>undefined, get agents():never {throw new Error('agent must not start on init')}}
    const owner=await runtime.initializeRuntime(ctx as never,config(dir))
    try {
      expect(runtime.settings.publisher).toBe('livehime')
      expect(runtime.settings.stagePort).toBe(0)
      expect(runtime.currentVoice()).toBe('elysia-breeze')
      expect(runtime.show.currentSession).toBeNull()
      expect(existsSync(join(dir,'live-memory.db'))).toBe(false)
      expect(existsSync(join(dir,'settings.json'))).toBe(true)
      await expect(runtime.initializeRuntime(ctx as never,config(dir))).rejects.toThrow('already has an owner')
    } finally {await owner.dispose();await owner.dispose()}
    const again=await runtime.initializeRuntime(ctx as never,config(directory()))
    await again.dispose()
  })
  it('rolls back resources acquired before a later initialization failure, then permits a clean retry',async()=>{
    const runtime=await import('../src/dsh/runtime')
    const {LiveShow}=await import('../src/body/show')
    const {StageServer}=await import('../src/body/server')
    const {Whisper}=await import('../src/body/asr')
    const closedShow=vi.spyOn(LiveShow.prototype,'dispose')
    const closedServer=vi.spyOn(StageServer.prototype,'stop')
    const closedAsr=vi.spyOn(Whisper.prototype,'close')
    const videoModule=await import('../src/body/videoLibrary')
    const Original=videoModule.VideoLibrary
    vi.spyOn(videoModule,'VideoLibrary').mockImplementationOnce(class extends Original { constructor(...args: ConstructorParameters<typeof Original>) { super(...args); throw new Error('fixture late init failure') } })
    const dir=directory()
    await expect(runtime.initializeRuntime({get:()=>undefined} as never,config(dir))).rejects.toThrow()
    expect(closedShow).toHaveBeenCalledTimes(1)
    expect(closedServer).toHaveBeenCalledTimes(1)
    expect(closedAsr).toHaveBeenCalledTimes(1)
    const owner=await runtime.initializeRuntime({get:()=>undefined} as never,config(directory()))
    await owner.dispose()
  })
})

import { mkdtempSync,rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe,expect,it,vi } from 'vitest'
import { LiveShow, type ShowHooks } from '../src/body/show'
function fixture(synthesize:ShowHooks['synthesize']) {
  const dir=mkdtempSync(join(tmpdir(),'elysia-speech-budget-'))
  const show=new LiveShow({push:async()=>true,synthesize},{dataDir:dir,names:['fixture']})
  return {show,stop(){show.dispose();rmSync(dir,{recursive:true,force:true})}}
}
describe('public LiveShow speech synthesis budget contract',()=>{
  it('allows deployment-bounded synthesis beyond 15 seconds and publishes only complete audio/text',async()=>{
    vi.useFakeTimers()
    let received:AbortSignal|undefined
    const text='公开完整表达 fixture。'.repeat(30)
    const h=fixture(async (_text,signal)=>{received=signal;await new Promise(resolve=>setTimeout(resolve,20000));signal.throwIfAborted();return {audio:new Uint8Array([1,2]),timeline:[],audioMime:'audio/wav',durationMs:10}})
    const delivered: string[]=[]
    const off=h.show.stage.subscribe(e=>{if(e.type==='say'){delivered.push(e.text);h.show.stage.said(e.id,'ended')}})
    const pending=h.show.say(text,'',AbortSignal.timeout(60000))
    try{
      await vi.advanceTimersByTimeAsync(15001)
      expect(received?.aborted).toBe(false)
      expect(delivered).toEqual([])
      expect(h.show.stats().spokenChars).toBe(0)
      await vi.advanceTimersByTimeAsync(5000)
      expect(await pending).toBe(text)
      expect(delivered).toEqual([text])
      expect(h.show.stats().spokenChars).toBe([...text].length)
    }finally{off();h.stop();vi.useRealTimers()}
  })
  it('propagates caller cancellation during synthesis without publishing partial audio',async()=>{
    vi.useFakeTimers()
    const h=fixture(async (_text,signal)=>new Promise((_resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error('fixture deployment deadline')),60000)
      signal.addEventListener('abort',()=>{clearTimeout(timer);reject(signal.reason)},{once:true})
    }))
    const sent=vi.fn();const off=h.show.stage.subscribe(e=>{if(e.type==='say')sent()})
    const caller=new AbortController()
    const pending=h.show.say('complete fixture','',caller.signal)
    const rejected=expect(pending).rejects.toThrow('fixture caller cancellation')
    try{
      await vi.advanceTimersByTimeAsync(1000)
      caller.abort(new Error('fixture caller cancellation'))
      await rejected
      expect(sent).not.toHaveBeenCalled()
      expect(h.show.stats().spokenChars).toBe(0)
    }finally{off();h.stop();vi.useRealTimers()}
  })
})

/** No browser devices: exercise the real production-minified AudioWorklet preparation. */
import { build } from 'esbuild'
import { runInNewContext } from 'node:vm'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import type { CallPlayer, PcmReceipt } from '../src/console/pcm-player.ts'
import type { VoiceEvent } from '../src/protocol.ts'

interface ProcessorPort { onmessage: ((event: {data: unknown})=>void)|null;postMessage(data:unknown):void }
interface Processor { port: ProcessorPort;process(inputs:unknown[],outputs:Float32Array[][]):boolean }
type ProcessorConstructor = new()=>Processor
type PlayerConstructor = new(receipt:(value:PcmReceipt)=>void,status:(value:string)=>void)=>CallPlayer
let production: Promise<string> | undefined
async function productionPlayer() {
  production ??= build({
    entryPoints:[fileURLToPath(new URL('../src/console/pcm-player.ts',import.meta.url))],
    bundle:true,write:false,platform:'browser',format:'cjs',target:'es2022',minify:true,
  }).then(result=>result.outputFiles[0]!.text)
  return await production
}
async function fixture(options: {moduleError?: Error} = {}) {
  const urls = new Map<string,Blob>()
  const registered = new Map<string,ProcessorConstructor>()
  const contexts: FakeContext[] = [],nodes: FakeNode[] = []
  const receipts:PcmReceipt[] = [],statuses:string[] = []
  const createObjectURL = vi.fn((blob:Blob)=>{const url='blob:offline/'+urls.size;urls.set(url,blob);return url})
  const revokeObjectURL = vi.fn((url:string)=>{urls.delete(url)})
  class ProcessorBase {
    port:ProcessorPort={onmessage:null,postMessage:()=>{}}
  }
  class FakeContext {
    sampleRate=24000;state='suspended';destination={}
    close=vi.fn(async()=>{this.state='closed'})
    resume=vi.fn(async()=>{
      this.state='running'
    })
    audioWorklet={addModule:vi.fn(async(url:string)=>{
      if(options.moduleError) throw options.moduleError
      const source=await urls.get(url)!.text()
      // A separate Worklet realm intentionally has no esbuild helpers/closures.
      runInNewContext(source,{
        AudioWorkletProcessor:ProcessorBase,Float32Array,Map,
        registerProcessor:(name:string,constructor:ProcessorConstructor)=>registered.set(name,constructor),
      })
    })}
    constructor(readonly configuration:unknown){contexts.push(this)}
  }
  class FakeNode {
    port:ProcessorPort={onmessage:null,postMessage:(data:unknown)=>this.processor.port.onmessage?.({data})}
    processor:Processor
    connect=vi.fn();disconnect=vi.fn()
    constructor(_context:unknown,name:string,_configuration:unknown) {
      const Constructor=registered.get(name)
      if(!Constructor) throw new DOMException('fixture processor missing','InvalidStateError')
      this.processor=new Constructor()
      this.processor.port.postMessage=(data:unknown)=>this.port.onmessage?.({data})
      nodes.push(this)
    }
  }
  const module={exports:{} as {PcmPlayer:PlayerConstructor}}
  runInNewContext(await productionPlayer(),{
    module,exports:module.exports,AudioContext:FakeContext,AudioWorkletNode:FakeNode,
    URL:{createObjectURL,revokeObjectURL},Blob,Float32Array,Uint8Array,Map,Set,atob,
  })
  const player=new module.exports.PcmPlayer(value=>receipts.push(value),value=>statuses.push(value))
  return{player,contexts,nodes,registered,receipts,statuses,createObjectURL,revokeObjectURL,urls}
}
const event=(payload:Record<string,unknown>):VoiceEvent=>({callId:'offline_call',epoch:1,seq:1,at:0,...payload}) as VoiceEvent

describe('production PCM player preparation, without audio hardware',()=>{
  it('loads and constructs the minified worklet in a clean realm and reports consumed frames only',async()=>{
    const f=await fixture()
    await f.player.prepare()
    expect(f.registered.has('elysia-voice-pcm')).toBe(true)
    expect(f.contexts[0]!.configuration).toEqual({sampleRate:24000})
    expect(f.contexts[0]!.state).toBe('running')
    expect(f.urls.size).toBe(0);expect(f.revokeObjectURL).toHaveBeenCalledOnce()
    f.player.reset(1)
    f.player.pcm(event({type:'pcm',segmentId:'s1',chunkIndex:0,sampleRate:24000,channels:1,format:'s16le',audio:'AAAAgP9/AAA='}) as Extract<VoiceEvent,{type:'pcm'}>)
    f.player.end(event({type:'segment-end',segmentId:'s1',frames:4,responseId:'r1'}) as Extract<VoiceEvent,{type:'segment-end'}>)
    expect(f.receipts).toEqual([])
    const output=new Float32Array(4)
    f.nodes[0]!.processor.process([],[[output]])
    expect([...output]).toEqual([0,-1,32767/32768,0])
    expect(f.receipts).toEqual([{type:'receipt',epoch:1,segmentId:'s1',playedFrames:4,fullyPlayed:true}])
    f.player.dispose()
    expect(f.contexts[0]!.close).toHaveBeenCalledOnce()
    expect(f.nodes[0]!.disconnect).toHaveBeenCalledOnce()
  })
  it('cleans up and propagates blocked module preparation without devices or upstream calls',async()=>{
    const failure=new DOMException('private browser message must not need to be displayed','SecurityError')
    const f=await fixture({moduleError:failure})
    await expect(f.player.prepare()).rejects.toBe(failure)
    expect(f.nodes).toHaveLength(0)
    expect(f.contexts[0]!.close).toHaveBeenCalledOnce()
    expect(f.urls.size).toBe(0);expect(f.revokeObjectURL).toHaveBeenCalledOnce()
  })
})

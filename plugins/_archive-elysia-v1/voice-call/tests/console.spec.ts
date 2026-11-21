// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { runInNewContext } from 'node:vm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { idleVoiceState, VOICE_CAPABILITY_HEADER, VOICE_SESSION_ID } from '../src/protocol.ts'
import type { VoiceEvent, VoiceEventPayload, VoiceControlRequest, VoiceStartResult, VoiceState } from '../src/protocol.ts'
import { VoiceController, type BrowserPorts } from '../src/console/controller.ts'
import { VoiceTransport, type PageFetch } from '../src/console/transport.ts'
import { SafeVoiceHttpError } from '../src/console/diagnostics.ts'
import { PcmDecoder, type CallPlayer, type PcmReceipt } from '../src/console/pcm-player.ts'
import { PCM_WORKLET_SOURCE } from '../src/console/pcm-worklet.ts'
import { apply, PANEL_ID } from '../src/console/client.tsx'
import { voiceRoutes, type VoiceHttpController } from '../src/server.ts'
import { VoicePanel, bindVoiceController } from '../src/console/panel.tsx'

async function settle() { for(let i=0;i<20;i++) await Promise.resolve() }
const owners: VoiceController[] = []
let root: Root | null = null
afterEach(async()=>{
  if(root) await act(async()=>{root!.unmount();root=null})
  bindVoiceController(null)
  for(const owner of owners.splice(0)) owner.dispose()
  document.body.innerHTML='';document.head.querySelectorAll('style[data-plugin]').forEach(node=>node.remove())
  vi.unstubAllGlobals();vi.useRealTimers()
})
const result: VoiceStartResult={callId:'call_test',capability:'fixture_private_cap',sdp:'v=0\r\nanswer',epoch:0,sessionId:VOICE_SESSION_ID,expiresAt:Date.now()+600000}
function fixture() {
  let incoming: (event:VoiceEvent)=>void=()=>{}
  let failStream: (reason:Error)=>void=()=>{}
  let state={...idleVoiceState(true,true),callId:result.callId,connection:'ready' as const,capture:'muted' as const,expiresAt:result.expiresAt}
  const track={enabled:true,onended:null as (()=>void)|null,stop:vi.fn()}
  const stream={getTracks:()=>[track],getAudioTracks:()=>[track]} as unknown as MediaStream
  const fakePeer={
    connectionState:'new',iceGatheringState:'complete',localDescription:null as RTCSessionDescriptionInit|null,
    onconnectionstatechange:null as (()=>void)|null,
    addTrack:vi.fn(),createDataChannel:vi.fn(),createOffer:vi.fn(async()=>({type:'offer' as const,sdp:'v=0\r\noffer'})),
    setLocalDescription:vi.fn(async(value:RTCSessionDescriptionInit)=>{fakePeer.localDescription=value}),
    setRemoteDescription:vi.fn(async()=>{fakePeer.connectionState='connected';fakePeer.onconnectionstatechange?.()}),
    close:vi.fn(()=>{fakePeer.connectionState='closed'}),addEventListener:vi.fn(),removeEventListener:vi.fn(),
  }
  let receipt:(value:PcmReceipt)=>void=()=>{}
  const player:CallPlayer={prepare:vi.fn(async()=>{}),reset:vi.fn(),pcm:vi.fn(),end:vi.fn(),dispose:vi.fn()}
  const api={
    state:vi.fn(async():Promise<VoiceState>=>({...state,callId:null,connection:'idle' as const})),
    start:vi.fn(async()=>result),
    control:vi.fn(async(value:VoiceControlRequest)=>{
      state={...state,epoch:value.action==='stop-playback'?state.epoch+1:state.epoch}
      return {...state,capture:value.action==='mute'?'muted' as const:'sending' as const}
    }),
    playback:vi.fn(async()=>({ok:true as const})),
    follow:vi.fn(async(_call:string,_cap:string,signal:AbortSignal,receive:(event:VoiceEvent)=>void)=>{
      incoming=receive
      await new Promise<void>((resolve,reject)=>{failStream=reject;signal.addEventListener('abort',()=>resolve(),{once:true})})
    }),
  }
  const ports:BrowserPorts={
    secure:()=>true,media:vi.fn(async()=>stream),peer:()=>fakePeer as unknown as RTCPeerConnection,
    player:fn=>{receipt=fn;return player},
  }
  const controller=new VoiceController(api,ports);owners.push(controller)
  const event=(payload:VoiceEventPayload,seq:number,epoch=0)=>({callId:result.callId,epoch,seq,at:1,...payload}) as VoiceEvent
  return {controller,api,ports,track,player,fakePeer,event,
    emit:(payload:VoiceEventPayload,seq:number,epoch=0)=>incoming(event(payload,seq,epoch)),
    ready:()=>incoming(event({type:'state',state},1)),
    fail:()=>failStream(new Error('fixture_network_loss')),
    receipt:(value:PcmReceipt)=>receipt(value)}
}

describe('native shell voice carrier',()=>{
  it('uses authenticated document-relative fetch and keeps capability only in headers',async()=>{
    const carrier=vi.fn<PageFetch>(async()=>new Response(JSON.stringify(idleVoiceState(true,true)),{headers:{'content-type':'application/json'}}))
    vi.stubGlobal('__DSH_TRANSPORT__',{fetch:carrier})
    const anonymous=vi.fn();vi.stubGlobal('fetch',anonymous)
    const transport=new VoiceTransport()
    await transport.state()
    await transport.control({callId:'call_test',epoch:0,action:'heartbeat'},'fixture_cap')
    expect(anonymous).not.toHaveBeenCalled()
    const [path,init]=carrier.mock.calls[1]!
    expect(path).toBe('api/voice-call/control')
    expect(new Headers(init.headers).get(VOICE_CAPABILITY_HEADER)).toBe('fixture_cap')
    expect(String(init.body)).not.toContain('fixture_cap')
    expect(path).not.toContain('fixture_cap')
  })
  it('combines a finite start deadline with local cancellation',async()=>{
    const deadline=new AbortController(),life=new AbortController()
    const timeout=vi.spyOn(AbortSignal,'timeout').mockReturnValue(deadline.signal)
    try {
      const carrier:PageFetch=async(_path,init)=>await new Promise((_resolve,reject)=>{
        init.signal?.addEventListener('abort',()=>reject(new Error('deadline_expired')),{once:true})
      })
      const pending=new VoiceTransport(carrier).start({requestId:'req',sdp:'v=0',privacyMode:'no-raw-audio'},life.signal)
      deadline.abort()
      await expect(pending).rejects.toThrow('deadline_expired')
      expect(life.signal.aborted).toBe(false);expect(timeout).toHaveBeenCalledWith(100_000)
    } finally { timeout.mockRestore() }
  })
  it('keeps a slow Start alive beyond 10 seconds without extending ordinary requests',async()=>{
    vi.useFakeTimers()
    const timeout=vi.spyOn(AbortSignal,'timeout').mockImplementation(ms=>{
      const timer=new AbortController()
      setTimeout(()=>timer.abort(new DOMException('expired','TimeoutError')),ms)
      return timer.signal
    })
    try {
      const carrier:PageFetch=async(_path,init)=>new Promise((resolve,reject)=>{
        const signal=init.signal!
        const timer=setTimeout(()=>resolve(new Response(JSON.stringify(result))),13_000)
        signal.addEventListener('abort',()=>{clearTimeout(timer);reject(signal.reason)},{once:true})
      })
      const transport=new VoiceTransport(carrier), life=new AbortController()
      const slow=transport.start({requestId:'r',sdp:'v=0',privacyMode:'no-raw-audio'},life.signal)
      const control=expect(transport.control({callId:'call_test',epoch:0,action:'heartbeat'},'cap')).rejects.toMatchObject({name:'TimeoutError'})
      await vi.advanceTimersByTimeAsync(10_000);await control
      expect(life.signal.aborted).toBe(false)
      await vi.advanceTimersByTimeAsync(3_000)
      await expect(slow).resolves.toEqual(result)
      const cancelled=transport.start({requestId:'r2',sdp:'v=0',privacyMode:'no-raw-audio'},life.signal)
      life.abort();await expect(cancelled).rejects.toMatchObject({name:'AbortError'})
    } finally {timeout.mockRestore()}
  })
  it('roundtrips the real raw routes and releases the owner on request abort',async()=>{
    let push!:(event:VoiceEvent)=>boolean|void
    const ended=vi.fn(async()=>{})
    const state={...idleVoiceState(true,true),callId:result.callId,connection:'ready' as const}
    const owner:VoiceHttpController={
      getState:()=>state,start:async()=>result,control:async()=>state,playback:async()=>{},
      subscribeEvents:(_id,cap,listener)=>{
        expect(cap).toBe(result.capability);push=listener
        listener({callId:result.callId,epoch:0,seq:1,at:1,type:'state',state})
        return{end:ended}
      },
    }
    const routes=voiceRoutes(owner)
    const carrier:PageFetch=async(path,init)=>{
      const request=new Request('https://fixture.invalid/'+path,init)
      return routes.find(route=>route.path===new URL(request.url).pathname)!.fetch(request)
    }
    const transport=new VoiceTransport(carrier)
    expect(await transport.state()).toEqual(state)
    expect(await transport.start({requestId:'req',sdp:'v=0',privacyMode:'no-raw-audio'},new AbortController().signal)).toEqual(result)
    const events:VoiceEvent[]=[],life=new AbortController()
    const pending=transport.follow(result.callId,result.capability,life.signal,event=>events.push(event))
    await vi.waitFor(()=>expect(events).toHaveLength(1))
    push({callId:result.callId,epoch:0,seq:2,at:1,type:'text',responseId:'r',text:'测试',stage:'generated'})
    await vi.waitFor(()=>expect(events).toHaveLength(2))
    life.abort();await pending
    expect(ended).toHaveBeenCalledTimes(1)
  })
  it('reads split UTF8 SSE and aborts the one stream without reconnecting',async()=>{
    let push!:ReadableStreamDefaultController<Uint8Array>
    const cancel=vi.fn()
    const carrier=vi.fn(async()=>new Response(new ReadableStream<Uint8Array>({start(c){push=c},cancel}),{headers:{'content-type':'text/event-stream'}}))
    const transport=new VoiceTransport(carrier)
    const life=new AbortController(),events:VoiceEvent[]=[]
    const pending=transport.follow('call_test','fixture_cap',life.signal,event=>events.push(event))
    await settle()
    const bytes=new TextEncoder().encode('event: voice-call\r\ndata: '+JSON.stringify({callId:'call_test',epoch:0,seq:1,at:0,type:'text',responseId:'r1',text:'爱莉',stage:'generated'})+'\r\n\r\n')
    for(let n=0;n<bytes.length;n+=2) push.enqueue(bytes.slice(n,n+2))
    await vi.waitFor(()=>expect(events).toHaveLength(1))
    expect(events[0]).toMatchObject({type:'text',text:'爱莉'})
    life.abort();await pending
    expect(cancel).toHaveBeenCalledTimes(1);expect(carrier).toHaveBeenCalledTimes(1)
  })
})

describe('safe startup diagnostics, fake inputs only',()=>{
  const privateText='PRIVATE_FIXTURE_KEY_SDP_DEVICE_URL'
  it.each(['start_failed_breeze_config','start_failed_agent_prepare','start_failed_credential_resolve','start_failed_provider_create','start_failed_call_ready'])(
    'keeps only the safe HTTP facts for %s',async(code)=>{
      const carrier:PageFetch=async()=>new Response(JSON.stringify({error:code,upstreamStatus:401,message:privateText,stack:privateText}),{
        status:502,headers:{'content-type':'application/json'},
      })
      const error=await new VoiceTransport(carrier).start({requestId:'r',sdp:'v=0',privacyMode:'no-raw-audio'},new AbortController().signal).catch(value=>value as unknown)
      expect(error).toBeInstanceOf(SafeVoiceHttpError)
      expect(error).toMatchObject({httpStatus:502,serverCode:code,upstreamStatus:401})
      expect(JSON.stringify(error)).not.toContain(privateText)
      expect(String(error)).not.toContain(privateText)
    },
  )
  it('drops unknown error codes and non-integer upstream status without retaining raw error JSON',async()=>{
    const carrier:PageFetch=async()=>new Response(JSON.stringify({error:privateText,upstreamStatus:'401 '+privateText,message:privateText}),{
      status:403,headers:{'content-type':'application/json'},
    })
    const error=await new VoiceTransport(carrier).start({requestId:'r',sdp:'v=0',privacyMode:'no-raw-audio'},new AbortController().signal).catch(value=>value as unknown)
    expect(error).toMatchObject({httpStatus:403,serverCode:null,upstreamStatus:null})
    expect(JSON.stringify(error)).not.toContain(privateText)
  })
  it('bounds a failing response body and cancels oversized streams',async()=>{
    const cancel=vi.fn()
    const carrier:PageFetch=async()=>new Response(new ReadableStream({
      start(controller){controller.enqueue(new Uint8Array(4097).fill(65))},cancel,
    }),{status:502,headers:{'content-type':'application/json'}})
    const error=await new VoiceTransport(carrier).start({requestId:'r',sdp:'v=0',privacyMode:'no-raw-audio'},new AbortController().signal).catch(value=>value as unknown)
    expect(error).toMatchObject({httpStatus:502,serverCode:null,upstreamStatus:null})
    expect(cancel).toHaveBeenCalledTimes(1)
  })
  it('identifies permission denial at microphone stage, without persisting browser message or stack',async()=>{
    const f=fixture()
    f.ports.media=vi.fn(async()=>{throw new DOMException(privateText,'NotAllowedError')})
    await f.controller.start(true)
    expect(f.controller.snapshot()).toMatchObject({
      error:'voice_start_failed_microphone',
      diagnostic:{stage:'microphone',kind:'browser',exceptionName:'NotAllowedError',httpStatus:null,serverCode:null},
    })
    expect(f.api.start).not.toHaveBeenCalled()
    expect(JSON.stringify(f.controller.snapshot())).not.toContain(privateText)
    expect(f.player.dispose).toHaveBeenCalledOnce()
  })
  it('identifies a player preparation failure before microphone access and preserves it through cleanup',async()=>{
    const f=fixture()
    vi.mocked(f.player.prepare).mockRejectedValue(new DOMException(privateText,'SecurityError'))
    await f.controller.start(true)
    const diagnostic=f.controller.snapshot().diagnostic
    expect(diagnostic).toMatchObject({stage:'audio_prepare',kind:'browser',exceptionName:'SecurityError'})
    expect(f.ports.media).not.toHaveBeenCalled();expect(f.api.start).not.toHaveBeenCalled()
    await f.controller.stop(null)
    expect(f.controller.snapshot()).toMatchObject({error:'voice_start_failed_audio_prepare',diagnostic})
    expect(JSON.stringify(f.controller.snapshot())).not.toContain(privateText)
  })
  it('keeps server preparation distinct from local microphone success and clears it on a new attempt',async()=>{
    const f=fixture()
    f.api.start.mockRejectedValueOnce(new SafeVoiceHttpError(502,'start_failed_agent_prepare',403))
    await f.controller.start(true)
    expect(f.controller.snapshot()).toMatchObject({
      error:'voice_start_failed_server_start',
      diagnostic:{stage:'server_start',kind:'http',exceptionName:null,httpStatus:502,serverCode:'start_failed_agent_prepare',upstreamStatus:403},
    })
    expect(f.track.stop).toHaveBeenCalledOnce();expect(f.fakePeer.close).toHaveBeenCalledOnce()
    await f.controller.stop(null)
    expect(f.controller.snapshot().diagnostic?.serverCode).toBe('start_failed_agent_prepare')
    await f.controller.start(true)
    expect(f.controller.snapshot().error).toBeNull();expect(f.controller.snapshot().diagnostic).toBeNull()
  })
  it('retains unknown classification, not arbitrary exception name/message/stack/extra fields',async()=>{
    const f=fixture()
    const failure=Object.assign(new Error(privateText),{name:privateText,deviceName:privateText,url:privateText})
    f.ports.media=vi.fn(async()=>{throw failure})
    await f.controller.start(true)
    expect(f.controller.snapshot().diagnostic).toEqual({
      stage:'microphone',kind:'unknown',exceptionName:null,httpStatus:null,serverCode:null,upstreamStatus:null,
    })
    expect(JSON.stringify(f.controller.snapshot())).not.toContain(privateText)
  })
  it('keeps offer and answer failures in their exact WebRTC stage',async()=>{
    const offer=fixture()
    offer.fakePeer.createOffer.mockRejectedValue(new DOMException(privateText,'OperationError'))
    await offer.controller.start(true)
    expect(offer.controller.snapshot().diagnostic).toMatchObject({stage:'webrtc_offer',exceptionName:'OperationError'})
    expect(offer.api.start).not.toHaveBeenCalled()
    const answer=fixture()
    answer.fakePeer.setRemoteDescription.mockRejectedValue(new DOMException(privateText,'OperationError'))
    await answer.controller.start(true)
    expect(answer.controller.snapshot().diagnostic).toMatchObject({stage:'webrtc_answer',exceptionName:'OperationError'})
    expect(answer.api.control.mock.calls.filter(([value])=>value.action==='hangup')).toHaveLength(1)
  })
  it('reports a fixed timeout name for ICE gathering, rather than the internal error message',async()=>{
    vi.useFakeTimers()
    const f=fixture();f.fakePeer.iceGatheringState='gathering'
    const pending=f.controller.start(true);await settle()
    await vi.advanceTimersByTimeAsync(10_000);await pending
    expect(f.controller.snapshot().diagnostic).toMatchObject({stage:'ice_gathering',exceptionName:'TimeoutError'})
    expect(f.api.start).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })
  it('does not turn a deliberately cancelled pending permission request into a failure',async()=>{
    const f=fixture()
    let reject!:(reason:unknown)=>void
    f.ports.media=vi.fn(()=>new Promise<MediaStream>((_resolve,fail)=>{reject=fail}))
    const pending=f.controller.start(true);await settle()
    await f.controller.stop(null)
    reject(new DOMException(privateText,'NotAllowedError'));await pending
    expect(f.controller.snapshot()).toMatchObject({error:null,diagnostic:null,state:{connection:'ended'}})
    expect(f.api.start).not.toHaveBeenCalled()
  })
  it.each([
    {stage:'server_start',label:'服务器准备爱莉的独立通话会话失败。'},
    {stage:'audio_prepare',label:'播放器准备阶段失败，具体原因未知。'},
  ])('renders a truthful $stage message without raw private text',async({stage,label})=>{
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true)
    const f=fixture()
    if(stage==='server_start') f.api.start.mockRejectedValue(new SafeVoiceHttpError(502,'start_failed_agent_prepare',401))
    else vi.mocked(f.player.prepare).mockRejectedValue(new Error(privateText))
    bindVoiceController(f.controller)
    const node=document.createElement('div');document.body.append(node);root=createRoot(node)
    await act(async()=>{root!.render(React.createElement(VoicePanel))})
    await act(async()=>{await f.controller.start(true)})
    const alert=node.querySelector('[role=alert]')!
    expect(alert.textContent).toContain(label)
    expect(alert.textContent).toContain(stage)
    expect(alert.textContent).not.toContain(privateText)
    expect(alert.textContent).not.toContain('请检查浏览器的麦克风和播放权限')
    if(stage==='server_start'){
      expect(alert.textContent).toContain('502');expect(alert.textContent).toContain('401')
      expect(alert.textContent).toContain('start_failed_agent_prepare')
    } else expect(alert.textContent).toContain('unknown')
  })
})

describe('PCM consumption and epochs',()=>{
  it('keeps an odd byte across chunks and rejects gaps or incomplete samples',()=>{
    const pcm=new PcmDecoder()
    expect(pcm.decode('seg',0,btoa(String.fromCharCode(0)))).toHaveLength(0)
    expect([...pcm.decode('seg',1,btoa(String.fromCharCode(128,255,127)))]).toEqual([-1,32767/32768])
    expect(()=>pcm.decode('seg',1,'')).toThrow('gap')
    expect(()=>pcm.finish('seg',3)).toThrow('frame_count')
    pcm.finish('seg',2)
    expect(()=>pcm.decode('seg',0,'AAA=')).toThrow('already_ended')
    pcm.decode('odd',0,btoa('a'))
    expect(()=>pcm.finish('odd')).toThrow('incomplete')
  })
  function worklet() {
    const messages:Array<Record<string,unknown>>=[]
    let Constructor!:new()=>{port:{onmessage:(event:{data:unknown})=>void};process:(i:unknown[],o:Float32Array[][])=>boolean}
    class Base {port={onmessage:(_event:{data:unknown})=>{},postMessage:(message:Record<string,unknown>)=>messages.push(message)}}
    runInNewContext(PCM_WORKLET_SOURCE,{AudioWorkletProcessor:Base,Float32Array,Map,registerProcessor:(_name:string,type:typeof Constructor)=>{Constructor=type}})
    const worker=new Constructor()
    const send=(data:unknown)=>worker.port.onmessage({data})
    const consume=(count:number)=>{const out=new Float32Array(count);worker.process([],[[out]]);return [...out]}
    return{send,consume,messages}
  }
  it('acknowledges only consumed frames, not queued bytes, and ignores old epochs',()=>{
    const w=worklet();w.send({type:'reset',epoch:1})
    w.send({type:'pcm',epoch:1,segmentId:'seg',samples:new Float32Array([1,0.5,0.25,0.125])})
    w.send({type:'end',epoch:1,segmentId:'seg',frames:4})
    expect(w.messages.filter(x=>x.type==='receipt')).toHaveLength(0)
    expect(w.consume(2)).toEqual([1,0.5])
    expect(w.messages.filter(x=>x.type==='receipt')).toHaveLength(0)
    expect(w.consume(2)).toEqual([0.25,0.125])
    expect(w.messages.filter(x=>x.type==='receipt')).toEqual([{type:'receipt',epoch:1,segmentId:'seg',playedFrames:4,fullyPlayed:true}])
    w.send({type:'reset',epoch:2})
    w.send({type:'pcm',epoch:1,segmentId:'late',samples:new Float32Array([1])})
    expect(w.consume(2)).toEqual([0,0])
  })
  it('reports partial consumption on reset and rejects unbounded audio buffering',()=>{
    const w=worklet();w.send({type:'reset',epoch:1})
    w.send({type:'pcm',epoch:1,segmentId:'partial',samples:new Float32Array(4).fill(1)})
    w.consume(2);w.send({type:'reset',epoch:2})
    expect(w.messages).toContainEqual({type:'receipt',epoch:1,segmentId:'partial',playedFrames:2,fullyPlayed:false})
    w.send({type:'pcm',epoch:2,segmentId:'huge',samples:new Float32Array(24000*9)})
    expect(w.messages).toContainEqual({type:'error',epoch:2,code:'pcm_player_protocol_error'})
    expect(w.consume(2)).toEqual([0,0])
  })
})

describe('browser call lifecycle with fake media only',()=>{
  it('does not acquire media or dial on load, and requires explicit privacy acceptance',async()=>{
    const f=fixture();await f.controller.load()
    expect(f.ports.media).not.toHaveBeenCalled();expect(f.api.start).not.toHaveBeenCalled()
    await f.controller.start(false)
    expect(f.controller.snapshot().error).toBe('privacy_confirmation_required')
    expect(f.ports.media).not.toHaveBeenCalled()
  })
  it('stops permission results arriving after hangup and never dials with them',async()=>{
    const f=fixture()
    let allow!:(stream:MediaStream)=>void
    const stream={getTracks:()=>[f.track],getAudioTracks:()=>[f.track]} as unknown as MediaStream
    f.ports.media=vi.fn(()=>new Promise<MediaStream>(resolve=>{allow=resolve}))
    const pending=f.controller.start(true);await settle()
    await f.controller.stop(null);allow(stream);await pending
    expect(f.track.stop).toHaveBeenCalledTimes(1)
    expect(f.api.start).not.toHaveBeenCalled()
  })
  it('keeps tracks disabled until server SSE readiness, RTC connection, and unmute acknowledgement',async()=>{
    const f=fixture();await f.controller.start(true)
    expect(f.fakePeer.connectionState).toBe('connected');expect(f.track.enabled).toBe(false)
    f.ready();await settle()
    expect(f.track.enabled).toBe(true)
    expect(f.api.control.mock.calls.filter(([value])=>value.action==='unmute')).toHaveLength(1)
    f.emit({type:'state',state:{...idleVoiceState(true,true),callId:'call_test',connection:'ready'}},2)
    await settle()
    expect(f.api.control.mock.calls.filter(([value])=>value.action==='unmute')).toHaveLength(1)
  })
  it('never treats generated text as played and drops duplicates, wrong calls, and old audio',async()=>{
    const f=fixture();await f.controller.start(true);f.ready();await settle()
    f.emit({type:'text',responseId:'r1',text:'测试文字',stage:'generated'},2)
    expect(f.controller.snapshot().text).toBe('测试文字')
    expect(f.api.playback).not.toHaveBeenCalled()
    const pcm={type:'pcm',segmentId:'s1',chunkIndex:0,sampleRate:24000,channels:1,format:'s16le',audio:'AAA='} as const
    f.emit(pcm,3);f.emit(pcm,3)
    f.controller.receive({...f.event(pcm,4),callId:'wrong_call'})
    expect(f.player.pcm).toHaveBeenCalledTimes(1)
    f.emit({type:'output-stop',reason:'speech_started'},4,1)
    f.emit({...pcm,chunkIndex:1},5,0)
    expect(f.player.pcm).toHaveBeenCalledTimes(1)
    f.emit({...pcm,segmentId:'s2'},6,1)
    expect(f.player.pcm).toHaveBeenCalledTimes(2)
    f.receipt({epoch:1,segmentId:'s2',playedFrames:1,fullyPlayed:true})
    await settle()
    expect(f.api.playback).toHaveBeenCalledWith({callId:'call_test',epoch:1,segmentId:'s2',playedFrames:1,fullyPlayed:true},result.capability)
  })
  it('ends the call if its microphone track ends externally',async()=>{
    const f=fixture();await f.controller.start(true);f.ready();await settle()
    f.track.onended?.();await settle()
    expect(f.controller.snapshot().error).toBe('microphone_disconnected')
    expect(f.track.enabled).toBe(false);expect(f.fakePeer.close).toHaveBeenCalledTimes(1)
  })
  it('stream failure stops every local resource and asks for hangup once, without redial',async()=>{
    const f=fixture();await f.controller.start(true);f.ready();await settle()
    f.fail();await settle()
    expect(f.track.stop).toHaveBeenCalledTimes(1);expect(f.fakePeer.close).toHaveBeenCalledTimes(1)
    expect(f.player.dispose).toHaveBeenCalledTimes(1)
    expect(f.api.control.mock.calls.filter(([value])=>value.action==='hangup')).toHaveLength(1)
    expect(f.api.start).toHaveBeenCalledTimes(1)
    expect(f.controller.snapshot().error).toBe('voice_event_stream_lost')
  })
  it('ends a stalled SSE readiness handshake with tracks disabled',async()=>{
    vi.useFakeTimers()
    const f=fixture();await f.controller.start(true)
    expect(f.track.enabled).toBe(false)
    await vi.advanceTimersByTimeAsync(15_000)
    expect(f.controller.snapshot().error).toBe('voice_connection_timeout')
    expect(f.track.stop).toHaveBeenCalledTimes(1)
    expect(f.api.start).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })
  it('stops capture when ready SSE goes silent even while HTTP heartbeats work',async()=>{
    vi.useFakeTimers()
    const f=fixture();await f.controller.start(true);f.ready();await settle()
    expect(f.track.enabled).toBe(true)
    await vi.advanceTimersByTimeAsync(15_000)
    expect(f.controller.snapshot().error).toBe('voice_event_stream_timeout')
    expect(f.track.stop).toHaveBeenCalledTimes(1)
    expect(f.api.control.mock.calls.filter(([value])=>value.action==='heartbeat').length).toBeGreaterThanOrEqual(2)
    expect(vi.getTimerCount()).toBe(0)
  })
  it('treats an explicit end as clean and does not reinterpret stream closure as failure',async()=>{
    const f=fixture();await f.controller.start(true);f.ready();await settle()
    f.emit({type:'end',reason:'finished'},2);await settle()
    f.fail();await settle()
    expect(f.controller.snapshot().state.connection).toBe('ended')
    expect(f.controller.snapshot().error).toBeNull()
    expect(f.api.control.mock.calls.filter(([value])=>value.action==='hangup')).toHaveLength(1)
  })
  it('rejects sequence gaps and emits only periodic bounded heartbeat controls',async()=>{
    vi.useFakeTimers()
    const f=fixture();await f.controller.start(true);f.ready();await settle()
    await vi.advanceTimersByTimeAsync(5000)
    expect(f.api.control.mock.calls.some(([value])=>value.action==='heartbeat')).toBe(true)
    f.emit({type:'text',responseId:'r',text:'late',stage:'generated'},3)
    await settle()
    expect(f.controller.snapshot().error).toBe('voice_event_sequence_gap')
    expect(f.track.stop).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('small native voice panel',()=>{
  it('permits a new explicit call after loading ended state that retains an audit callId',async()=>{
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true)
    const f=fixture()
    f.api.state.mockResolvedValue({...idleVoiceState(true,true),callId:'old_audit_call',connection:'ended'})
    bindVoiceController(f.controller)
    const node=document.createElement('div');document.body.append(node);root=createRoot(node)
    await act(async()=>{root!.render(React.createElement(VoicePanel))})
    const checkbox=node.querySelector('input[type=checkbox]') as HTMLInputElement
    await act(async()=>{checkbox.click()})
    const start=[...node.querySelectorAll('button')].find(button=>button.textContent==='开始通话')!
    expect(start.disabled).toBe(false)
    expect(node.textContent).not.toContain('没有该通话的控制权限')
    expect(f.ports.media).not.toHaveBeenCalled();expect(f.api.start).not.toHaveBeenCalled()
  })
  it('registers native slots, shows truthful generated-text status, and disposes without capturing',async()=>{
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true)
    const media=vi.fn();vi.stubGlobal('navigator',{mediaDevices:{getUserMedia:media}})
    const carrier=vi.fn(async()=>new Response(JSON.stringify(idleVoiceState(true,true)),{headers:{'content-type':'application/json'}}))
    vi.stubGlobal('__DSH_TRANSPORT__',{fetch:carrier})
    const disposers:Array<()=>void>=[],slots:unknown[]=[]
    const ctx={
      effect(effect:()=>()=>void){disposers.push(effect())},
      slots:{inject(_name:string,callback:()=>unknown){const off=callback();if(typeof off==='function') disposers.push(off as ()=>void)},
        register(spec:unknown,_component:unknown){slots.push(spec);return vi.fn()}},
    }
    apply(ctx)
    const node=document.createElement('div');document.body.append(node);root=createRoot(node)
    await act(async()=>{root!.render(React.createElement(VoicePanel))})
    expect(slots).toEqual(expect.arrayContaining([expect.objectContaining({name:'main',key:PANEL_ID}),expect.objectContaining({name:'sidebar.panellist',id:PANEL_ID})]))
    expect(document.body.textContent).toContain('生成文字不表示已经播放或听到')
    expect(document.body.textContent).toContain('不持久保存原声')
    expect(media).not.toHaveBeenCalled()
    const start=[...document.querySelectorAll('button')].find(node=>node.textContent==='开始通话')!
    expect(start.disabled).toBe(true)
    await act(async()=>{for(const dispose of disposers.reverse()) dispose()})
    expect(document.querySelector('style[data-plugin="'+PANEL_ID+'"]')).toBeNull()
  })
})

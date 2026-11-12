import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { LiveShow, type ShowHooks } from '../src/body/show'
import type { LiveChatEvent } from '../src/core/live'
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }

const event: LiveChatEvent = { kind: 'chat', platform: 'bilibili', id: 'fixture-raw', ts: 1, user: { id: 'viewer', name: 'viewer' }, text: 'full public fixture'.repeat(1000) }
function harness(extra: Partial<ShowHooks> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'elysia-livestream-fixture-'))
  const push = vi.fn(async () => true)
  const show = new LiveShow({ push, synthesize: vi.fn(async () => ({ audio: new Uint8Array([1]), timeline: [], audioMime: 'audio/wav' as const, durationMs: 3 })), ...extra }, { dataDir: dir, names: ['fixture'] })
  return { show, push, dir, stop() { show.dispose(); rmSync(dir, { recursive: true, force: true }) } }
}
describe('upstream live body with Elysia authority and playback', () => {
  it('awaits the full raw journal before making any context projection and creates no memory database', async () => {
    const release = deferred<{ ref: string; seq: number; bytes: number; hash: string }>()
    const journal = vi.fn(() => release.promise)
    const h = harness({ journalInput: journal })
    try {
      h.show.inject(event)
      await Promise.resolve()
      expect(journal).toHaveBeenCalledWith(event, false, expect.any(String), undefined)
      expect(h.show.status().pending.chats).toBe(0)
      release.resolve({ ref: 'fixture-full-ref', seq: 0, bytes: Buffer.byteLength(JSON.stringify(event)), hash: 'fixture' })
      await h.show.whenInputSettled()
      expect(h.show.status().pending.chats).toBe(1)
      expect(readdirSync(h.dir)).not.toContain('live-memory.db')
    } finally { h.stop() }
  })
  it('retains failed raw input and retries in arrival order rather than skipping it', async () => {
    const journal = vi.fn().mockRejectedValueOnce(new Error('fixture disk failure')).mockImplementation(async (e) => ({ ref: `fixture-${e.id}`, seq: 0, bytes: 1, hash: 'fixture' }))
    const h = harness({ journalInput: journal })
    try {
      h.show.inject(event)
      await expect(h.show.whenInputSettled()).rejects.toThrow('fixture disk failure')
      h.show.inject({ ...event, id: 'second' })
      expect(h.show.status().pending.chats).toBe(0)
      await h.show.retryInputs()
      expect(journal.mock.calls.map(call => call[0].id)).toEqual(['fixture-raw', 'fixture-raw', 'second'])
      expect(h.show.status().pending.chats).toBe(2)
    } finally { h.stop() }
  })
  it('counts speech only after a real ended receipt and carries WAV MIME through the original stage', async () => {
    const h = harness()
    const unsubscribe = h.show.stage.subscribe(e => { if (e.type === 'say') { expect(e.audioMime).toBe('audio/wav'); h.show.stage.said(e.id, 'ended') } })
    try {
      await expect(h.show.say('public fixture', '', new AbortController().signal)).resolves.toBe('public fixture')
      expect(h.show.status().lines).toHaveLength(1)
      expect(h.show.stats().spokenChars).toBe('public fixture'.length)
    } finally { unsubscribe(); h.stop() }
  })
  it('does not count failure or missing output as speech success', async () => {
    const h = harness()
    try {
      await expect(h.show.say('public fixture', '', new AbortController().signal)).rejects.toThrow('Playback failed')
      expect(h.show.status().lines).toHaveLength(0)
      expect(h.show.stats().spokenChars).toBe(0)
    } finally { h.stop() }
  })
})

describe('decoded input before UI deduplication and aggregation',()=>{
  it('journals original gift deltas and same-id changed chat while preserving the original display combo',async()=>{
    const raw: Array<import('../src/core/live').LiveEvent> = []
    const h=harness({journalInput:async(e)=>{raw.push(structuredClone(e));return{ref:`fixture-${raw.length}`,seq:raw.length,bytes:1,hash:'fixture'}}})
    const shown: unknown[]=[]
    const off=h.show.stage.subscribe(e=>{if(e.type==='live')shown.push(e.event)},false)
    try{
      const gift={kind:'gift' as const,id:'g',platform:'bilibili' as const,ts:Date.now(),user:{id:'v',name:'v'},giftName:'fixture',count:1,valueYuan:1}
      h.show.inject(gift);h.show.inject({...gift})
      h.show.inject({...event,text:'version-one'});h.show.inject({...event,text:'version-two'})
      await h.show.whenInputSettled();await Promise.resolve()
      expect(raw).toHaveLength(4)
      expect(raw.slice(0,2).map(e=>e.kind==='gift'?e.count:0)).toEqual([1,1])
      expect(raw.slice(2).map(e=>e.kind==='chat'?e.text:'')).toEqual(['version-one','version-two'])
      expect(shown).toContainEqual(expect.objectContaining({kind:'gift',count:2}))
    }finally{off();h.stop()}
  })
})

describe('recovery preflight before activation',()=>{
  it('rejects a broken intent without enabling onair, a director, or any model input',async()=>{
    vi.useFakeTimers()
    const h=harness()
    try{
      const plan={inputs:[],intents:[{version:1 as const,key:'broken',message:{id:'fixture',role:'user' as const,source:{kind:'user' as const},content:[{type:'text' as const,text:'fixture'}]},pages:[{ref:'missing',offset:0,nextOffset:4,totalBytes:4,complete:true}]}]}
      expect(()=>h.show.prepareInputRecovery(plan as never)).toThrow('pending source offset')
      await vi.advanceTimersByTimeAsync(60000)
      expect(h.show.isOnAir).toBe(false)
      expect(h.push).not.toHaveBeenCalled()
    }finally{h.stop();vi.useRealTimers()}
  })
})

import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId, pluginRecordOf, appendPluginRecord } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import { journalInput, readJournal, recoverLivestreamInputs, LIVESTREAM_SESSION_ID } from '../src/dsh/session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { LiveAttention } from '../src/core/attention/attention'
import type { Session } from '@deepseek-ai/dsh-session'
import type { LiveChatEvent } from '../src/core/live'

const event: LiveChatEvent = { kind: 'chat', id: 'fixture-event', platform: 'bilibili', ts: 1, user: { id: 'fixture-viewer', name: 'viewer' }, text: '公开 fixture🙂'.repeat(2000) }
async function harness(flush = true) {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  if (flush) ctx.on('session/flush', async () => {})
  const session = ctx.sessions.create(LIVESTREAM_SESSION_ID)
  return { ctx, session }
}
describe('native livestream protocol journal', () => {
  it('preserves full original input before exposing pages, with idempotent replay and attribution', async () => {
    const { ctx, session } = await harness()
    try {
      const first = await journalInput(ctx, session, event, false, 123)
      const replay = await journalInput(ctx, session, structuredClone(event), false, 123)
      expect(replay).toEqual(first)
      expect(Number(session.seq)).toBe(1)
      const record = pluginRecordOf(session.eventAt(0 as never)!)
      expect(record?.data).toMatchObject({ actor: { kind: 'external', id: 'fixture-viewer' }, source: { sessionId: LIVESTREAM_SESSION_ID, roomId: 123, instanceId: LIVESTREAM_SESSION_ID }, event })
      let offset = 0, text = ''
      do { const page = readJournal(session, first.ref, offset, 251); text += page.text; expect(page.text).not.toContain('�'); offset = page.nextOffset; if (page.complete) break } while (offset < first.bytes)
      expect(text).toBe(JSON.stringify(event))
      expect(offset).toBe(first.bytes)
    } finally { await ctx.fiber.dispose() }
  })
  it('keeps changed content under the same platform id as another immutable version', async () => {
    const { ctx, session } = await harness()
    try {
      const a = await journalInput(ctx, session, event, false, 123)
      const b = await journalInput(ctx, session, { ...event, text: 'changed fixture' }, false, 123)
      expect(a.ref).not.toBe(b.ref)
      let original = '', offset = 0
      while (true) { const page = readJournal(session, a.ref, offset, 32768); original += page.text; offset = page.nextOffset; if (page.complete) break }
      expect(JSON.parse(original).text).toBe(event.text)
    } finally { await ctx.fiber.dispose() }
  })
  it('fails closed without a durability listener and refuses every foreign session', async () => {
    const { ctx, session } = await harness(false)
    try {
      await expect(journalInput(ctx, session, event, false, 123)).rejects.toThrow('durability owner')
      const foreign = ctx.sessions.create(SessionId('another-fixture'))
      await expect(journalInput(ctx, foreign, event, false, 123)).rejects.toThrow('Foreign')
      expect(() => readJournal(foreign, 'anything')).toThrow('Foreign')
      expect(Number(foreign.seq)).toBe(0)
    } finally { await ctx.fiber.dispose() }
  })
})

async function replay(session: Session) {
  const ctx=new Context();await ctx.plugin(SessionStore)
  const restored=ctx.sessions.create(LIVESTREAM_SESSION_ID,{seed:JSON.parse(JSON.stringify(session.snapshotEvents()))})
  return {ctx,session:restored}
}
describe('durable native projection recovery boundaries',()=>{
  it('recovers a journalled input after a crash before any projection intent, without waking anything',async()=>{
    const {ctx,session}=await harness()
    try{
      const ref=await journalInput(ctx,session,event,false,123)
      const plan=recoverLivestreamInputs(session)
      expect(plan.inputs).toEqual([{event,ref:ref.ref,offset:0}])
      expect(plan.intents).toHaveLength(0)
    }finally{await ctx.fiber.dispose()}
  })
  it('preserves an unspliced durable intent and its exact original message identity',async()=>{
    const {ctx,session}=await harness()
    try{
      const ref=await journalInput(ctx,session,event,false,123)
      const page=readJournal(session,ref.ref,0,251)
      const message=createUserMessage({content:[{type:'text',text:'original projection fixture'}],source:{kind:'user'}})
      const intent={version:1 as const,key:'stable-fixture',message,pages:[{ref:page.ref,offset:page.offset,nextOffset:page.nextOffset,totalBytes:page.totalBytes,complete:page.complete}]}
      appendPluginRecord(session,'plugin:elysia-livestream/projection-intent',intent)
      const restored=await replay(session)
      const plan=recoverLivestreamInputs(restored.session)
      await restored.ctx.fiber.dispose()
      expect(plan.intents[0]?.message.id).toBe(message.id)
      const a=new LiveAttention(0)
      for(const input of plan.inputs)a.observe(input.event,false,0,input.ref,input.offset)
      const restoredTopic=a.restoreIntent(plan.intents[0]!,0)
      expect(restoredTopic.replayText).toBe('original projection fixture')
      expect(restoredTopic.records[0]?.nextOffset).toBe(page.nextOffset)
      a.acknowledge(restoredTopic)
      const next=a.next(1)
      if(next?.kind!=='events')throw new Error('missing remaining source page')
      expect(next.records[0]?.offset).toBe(page.nextOffset)
    }finally{await ctx.fiber.dispose()}
  })
  it('uses persisted native inbox insertion after a crash before volatile ack, and resumes the exact remaining UTF-8 offset',async()=>{
    const {ctx,session}=await harness()
    try{
      const ref=await journalInput(ctx,session,event,false,123)
      const first=readJournal(session,ref.ref,0,251)
      const message=createUserMessage({content:[{type:'text',text:'accepted first page'}],source:{kind:'user'}})
      appendPluginRecord(session,'plugin:elysia-livestream/projection-intent',{version:1,key:'accepted-fixture',message,pages:[{ref:ref.ref,offset:0,nextOffset:first.nextOffset,totalBytes:first.totalBytes,complete:false}]})
      session.append('agent/inbox/spliced',{target:'next-turn',start:0,inserted:[message]})
      await ctx.sessions.flush(session)
      const restored=await replay(session)
      const plan=recoverLivestreamInputs(restored.session)
      await restored.ctx.fiber.dispose()
      expect(plan.intents).toHaveLength(0)
      expect(plan.inputs[0]?.offset).toBe(first.nextOffset)
      const a=new LiveAttention(0)
      for(const input of plan.inputs)a.observe(input.event,false,0,input.ref,input.offset)
      let remaining='',expectedOffset=first.nextOffset
      while(true){const t=a.next(1);if(!t)break;if(t.kind!=='events')throw new Error('unexpected pulse');expect(t.records[0]?.offset).toBe(expectedOffset);remaining+=t.records[0]?.text;expectedOffset=t.records[0]!.nextOffset;a.acknowledge(t)}
      expect(first.text+remaining).toBe(JSON.stringify(event))
    }finally{await ctx.fiber.dispose()}
  })
  it('does not restore a complete page already represented by an accepted native inbox message',async()=>{
    const {ctx,session}=await harness()
    try{
      const short={...event,text:'short fixture'}
      const ref=await journalInput(ctx,session,short,false,123)
      const page=readJournal(session,ref.ref,0,8192)
      const message=createUserMessage({content:[{type:'text',text:'accepted full page'}],source:{kind:'user'}})
      appendPluginRecord(session,'plugin:elysia-livestream/projection-intent',{version:1,key:'full-fixture',message,pages:[{ref:ref.ref,offset:0,nextOffset:page.nextOffset,totalBytes:page.totalBytes,complete:true}]})
      session.append('agent/inbox/spliced',{target:'next-turn',start:0,inserted:[message]})
      const restored=await replay(session)
      expect(recoverLivestreamInputs(restored.session)).toEqual({inputs:[],intents:[]})
      await restored.ctx.fiber.dispose()
    }finally{await ctx.fiber.dispose()}
  })
})

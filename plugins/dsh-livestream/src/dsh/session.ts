/** Fixed Elysia livestream identity, scoped composition and native journal. */
import type { Context } from '@deepseek-ai/cordis'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-tools'
import { appendPluginRecord, pluginRecordOf, SessionId, type Session, type SessionSeq } from '@deepseek-ai/dsh-session'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import * as StandingPrompt from '@elysia/conscious-mind/standing-prompts'
import * as Integration from './agent'
import type { LiveEvent } from '../core/live'

export const LIVESTREAM_SESSION_ID = SessionId('elysia-livestream')
export const LIVESTREAM_SESSION_CWD = '/home/ayerelysia/Elysia/Elysium/Elysia-Harness/homes/web/livestream'
export interface SessionPromptConfig {
  baseDir: string
  files: string[]
  required?: string[]
  allowedWriteActions?: string[]
}
interface Receipt { fingerprint: string; ready: Promise<void>; complete: boolean }
const receipts = new WeakMap<Context, Receipt>()
function fixed(c: SessionPromptConfig) {
  return { baseDir: resolve(c.baseDir), files: [...c.files], required: [...c.required ?? ['SOUL.md']], allowedWriteActions: [...c.allowedWriteActions ?? []].sort() }
}
/** Install prompt and capabilities in this exact agent scope, never globally. */
export function composeLivestreamAgent(ctx: Context, config: SessionPromptConfig): Promise<void> {
  const selected = fixed(config)
  const fingerprint = JSON.stringify(selected)
  const prior = receipts.get(ctx)
  if (prior) return prior.fingerprint === fingerprint ? prior.ready : Promise.reject(new Error('Livestream scope has a different fixed composition'))
  const receipt: Receipt = { fingerprint, ready: Promise.resolve(), complete: false }
  receipts.set(ctx, receipt)
  receipt.ready = (async () => {
    const prompt = await ctx.plugin(StandingPrompt, { baseDir: selected.baseDir, files: selected.files, required: selected.required, complete: true })
    let integration: { dispose(): Promise<unknown> } | undefined
    let restrict: (() => void) | undefined
    try {
      integration = await ctx.plugin(Integration, { allowedWriteActions: selected.allowedWriteActions })
      // Native restrictions mask inherited/global capabilities only. The
      // integration owns its scope-local registration allowlist independently.
      restrict = ctx.tools.restrict({ allow: [] })
      ctx.effect(() => () => { if (receipts.get(ctx) === receipt) receipts.delete(ctx) }, 'elysia-dsh-livestream.composition')
      receipt.complete = true
    } catch (error) {
      const cleanup = await Promise.allSettled([Promise.resolve().then(() => restrict?.()), Promise.resolve().then(() => integration?.dispose()), Promise.resolve().then(() => prompt.dispose())])
      const failures = cleanup.filter((r): r is PromiseRejectedResult => r.status === 'rejected')
      if (failures.length) throw new AggregateError([error, ...failures.map(r => r.reason)], 'Livestream setup and cleanup failed')
      throw error
    }
  })().catch(error => { if (receipts.get(ctx) === receipt) receipts.delete(ctx); throw error })
  return receipt.ready
}
/** UI/native creation is already reserved by the native initialization owner. */
export function bindLivestreamAgentSetup(ctx: Context, config: SessionPromptConfig): () => void {
  const selected = fixed(config)
  return ctx.on('agent/created', async ({ agent }) => {
    if (agent.id === LIVESTREAM_SESSION_ID) await composeLivestreamAgent(agent.ctx, selected)
  })
}
/** Content-free failure details for an operator reproducing a setup failure. */
export function sessionFailureDetails(error: unknown, depth = 0): { name: string; code?: string; origin?: string; causes?: unknown[] } {
  if (!(error instanceof Error)) return { name: 'UnknownThrownValue' }
  const name=/^[A-Za-z][A-Za-z0-9]{0,63}Error$/.test(error.name) || error.name==='Error' ? error.name : 'Error'
  const candidate='code' in error ? error.code : undefined
  const code=typeof candidate==='string' && /^[A-Z][A-Z0-9_]{0,47}$/.test(candidate) ? candidate : undefined
  const origin=error.stack?.split('\n').slice(1).map(line=>/Elysia-Harness\/((?:plugins|dsh)\/[A-Za-z0-9_@./-]+\.[cm]?[jt]s:\d+:\d+)/.exec(line)?.[1]).find(Boolean)
  const nested=depth<3 ? (error instanceof AggregateError ? error.errors.slice(0,4) : error.cause === undefined ? [] : [error.cause]) : []
  return {name,...code ? {code}: {},...origin ? {origin}: {},...nested.length ? {causes:nested.map(cause=>sessionFailureDetails(cause,depth+1))}: {}}
}
function reportSessionFailure(phase: 'resume'|'create',error: unknown): void {
  process.stderr.write(`[elysia-livestream/session] ${JSON.stringify({phase,...sessionFailureDetails(error)})}\n`)
}
/** Reuse a compatible live agent, or resume the same durable id/cwd. */
export async function ensureLivestreamAgent(ctx: Context, config: SessionPromptConfig): Promise<AgentHandle> {
  const selected = fixed(config)
  const signature = JSON.stringify(selected)
  const borrow = async (): Promise<AgentHandle | undefined> => {
    const agent = ctx.agents.get(LIVESTREAM_SESSION_ID)
    if (!agent) return undefined
    const receipt = receipts.get(agent.ctx)
    if (receipt) {
      if (receipt.fingerprint !== signature) throw new Error('Livestream composition mismatch; refusing another writer')
      await receipt.ready
    } else await agent.runMaintenance(async signal => { signal.throwIfAborted(); await composeLivestreamAgent(agent.ctx, selected); signal.throwIfAborted() })
    const ready = receipts.get(agent.ctx)
    if (!ready?.complete || ready.fingerprint !== signature) throw new Error('Livestream composition is not ready')
    return { agent, dispose: async () => {} }
  }
  const existing = await borrow()
  if (existing) return existing
  const agentOptions = ctx.agentDefaultModel.currentSelection()
  const setup = (scope: Context) => composeLivestreamAgent(scope, selected)
  await mkdir(LIVESTREAM_SESSION_CWD, { recursive: true })
  try { return await ctx.agents.resume({ resumeSessionId: LIVESTREAM_SESSION_ID, agentOptions, setup }) }
  catch (error) {
    reportSessionFailure('resume',error)
    const concurrent = await borrow()
    if (concurrent) return concurrent
    // Native create refuses an existing durable identity; never rewrites its header.
    try { return await ctx.agents.create({ sessionId: LIVESTREAM_SESSION_ID, agentOptions, setup, meta: { cwd: LIVESTREAM_SESSION_CWD } }) }
    catch (createError) { reportSessionFailure('create',createError); const winner = await borrow(); if (winner) return winner; throw new AggregateError([error, createError], 'Cannot resume/create the fixed livestream session') }
  }
}
export interface InputJournal {
  version: 1
  actor: { kind: 'external'; id: string; name: string }
  source: { platform: string; roomId: number | null; sessionId: string; instanceId: string }
  occurrence: string
  occurredAt: number
  hash: string
  isUpdate: boolean
  event: LiveEvent
}
export interface JournalRef { ref: string; seq: number; bytes: number; hash: string }
declare module '@deepseek-ai/dsh-session/types' {
  interface PluginRecordMap {
    'plugin:elysia-livestream/input': InputJournal
    'plugin:elysia-livestream/projection-intent': ProjectionIntent
    'plugin:elysia-livestream/activity': { version: 1; actor: string; instanceId: string; sessionId: string; source: string; activity: Record<string, unknown> }
  }
}
const journals = new WeakMap<Session, Map<string, { seq: number; hash: string }>>()
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
/** Persist complete protocol input before permitting any attention projection. */
export async function journalInput(ctx: Context, session: Session, event: LiveEvent, isUpdate: boolean, roomId: number | null, receiptId?: string): Promise<JournalRef> {
  if (session.id !== LIVESTREAM_SESSION_ID) throw new Error('Foreign session journal refused')
  const json = JSON.stringify(event)
  const digest = hash(json)
  const occurrence = `${event.platform}:${roomId ?? 'simulation'}:${event.id}:${receiptId ?? digest}`
  let index = journals.get(session)
  if (!index) {
    index = new Map()
    for (let i = 0; i < Number(session.seq); i++) {
      const e = session.eventAt(i as SessionSeq)
      const r = e && pluginRecordOf(e)
      if (r?.type !== 'plugin:elysia-livestream/input') continue
      const d = r.data as Partial<InputJournal>
      if (d.version !== 1 || typeof d.occurrence !== 'string' || typeof d.hash !== 'string') throw new Error('Malformed livestream journal record')
      index.set(d.occurrence, { seq: Number(r.seq), hash: d.hash })
    }
    journals.set(session, index)
  }
  let entry = index.get(occurrence)
  if (!entry) {
    const seq = appendPluginRecord(session, 'plugin:elysia-livestream/input', {
      version: 1, actor: { kind: 'external', id: event.user.id, name: event.user.name },
      source: { platform: event.platform, roomId, sessionId: session.id, instanceId: LIVESTREAM_SESSION_ID },
      occurrence, occurredAt: event.ts, hash: digest, isUpdate, event: JSON.parse(json) as LiveEvent,
    })
    entry = { seq: Number(seq), hash: digest }
    index.set(occurrence, entry)
  }
  if (entry.hash !== digest) throw new Error('Livestream occurrence conflict')
  if (!await ctx.sessions.flush(session)) throw new Error('Livestream journal has no durability owner')
  return { ref: `elysia-livestream:${entry.seq}:${digest}`, seq: entry.seq, hash: digest, bytes: Buffer.byteLength(json) }
}
/** UTF-8 pagination of the complete raw event; only this fixed session is read. */
export function readJournal(session: Session, ref: string, offset = 0, maxBytes = 8192) {
  if (session.id !== LIVESTREAM_SESSION_ID) throw new Error('Foreign session journal refused')
  const match = /^elysia-livestream:(\d+):([a-f0-9]{64})$/.exec(ref)
  if (!match || !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(maxBytes) || maxBytes < 4 || maxBytes > 32768) throw new Error('Invalid journal page')
  const event = session.eventAt(Number(match[1]) as SessionSeq)
  const record = event && pluginRecordOf(event)
  if (record?.type !== 'plugin:elysia-livestream/input') throw new Error('Journal record not found')
  const data = record.data as InputJournal
  const text = JSON.stringify(data.event)
  if (data.version !== 1 || data.hash !== match[2] || hash(text) !== match[2]) throw new Error('Journal hash mismatch')
  const bytes = Buffer.from(text)
  if (offset > bytes.length || (offset < bytes.length && (bytes[offset]! & 0xc0) === 0x80)) throw new Error('Invalid UTF-8 offset')
  let end = Math.min(bytes.length, offset + maxBytes)
  while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--
  return { ref, offset, nextOffset: end, totalBytes: bytes.length, text: bytes.subarray(offset, end).toString('utf8'), complete: end === bytes.length }
}
export async function appendActivity(ctx: Context, session: Session, activity: Record<string, unknown>): Promise<void> {
  if (session.id !== LIVESTREAM_SESSION_ID) throw new Error('Foreign activity refused')
  appendPluginRecord(session, 'plugin:elysia-livestream/activity', { version: 1, actor: 'infrastructure', instanceId: LIVESTREAM_SESSION_ID, sessionId: session.id, source: 'dsh-livestream/body', activity: JSON.parse(JSON.stringify(activity)) as Record<string, unknown> })
  if (!await ctx.sessions.flush(session)) throw new Error('Livestream activity has no durability owner')
}
export interface ProjectionPage { ref: string; offset: number; nextOffset: number; totalBytes: number; complete: boolean }
export interface ProjectionIntent { version: 1; key: string; message: UserMessage; pages: ProjectionPage[] }
export interface RecoveredInput { event: LiveEvent; ref: string; offset: number }
export interface ReplayPlan { inputs: RecoveredInput[]; intents: ProjectionIntent[] }
interface NativeIndex {
  offset: number
  inputs: Array<{ entry: InputJournal; ref: string; seq: number }>
  intents: Map<string, ProjectionIntent>
  inserted: Set<string>
}
const nativeIndexes = new WeakMap<Session, NativeIndex>()
function nativeIndex(session: Session): NativeIndex {
  if (session.id !== LIVESTREAM_SESSION_ID) throw new Error('Foreign session projection refused')
  let index = nativeIndexes.get(session)
  if (!index) { index = { offset: 0, inputs: [], intents: new Map(), inserted: new Set() }; nativeIndexes.set(session,index) }
  for (; index.offset < Number(session.seq); index.offset++) {
    const event = session.eventAt(index.offset as SessionSeq)
    if (!event) throw new Error('Livestream native event gap')
    const record = pluginRecordOf(event)
    if (record?.type === 'plugin:elysia-livestream/input') {
      const d = record.data as InputJournal
      if (d.version !== 1 || d.source?.sessionId !== session.id || typeof d.hash !== 'string' || hash(JSON.stringify(d.event)) !== d.hash) throw new Error('Invalid livestream input record')
      index.inputs.push({ entry:d, ref:`elysia-livestream:${record.seq}:${d.hash}`, seq:Number(record.seq) })
    } else if (record?.type === 'plugin:elysia-livestream/projection-intent') {
      const d = record.data as ProjectionIntent
      if (d.version !== 1 || typeof d.key !== 'string' || !d.key || !Array.isArray(d.pages) || d.message?.role !== 'user' || typeof d.message.id !== 'string' || !Array.isArray(d.message.content)) throw new Error('Invalid livestream projection intent')
      const prior=index.intents.get(d.key)
      if (prior && JSON.stringify(prior) !== JSON.stringify(d)) throw new Error('Conflicting livestream projection intent')
      index.intents.set(d.key,d)
    } else if (event.type === 'agent/inbox/spliced') {
      for (const message of event.data.inserted) index.inserted.add(message.id)
    } else if (event.type === 'user/message') index.inserted.add(event.data.id)
  }
  return index
}
/** Pure native-history fold: accepted pages advance only contiguous UTF-8 offsets. */
export function recoverLivestreamInputs(session: Session): ReplayPlan {
  const index=nativeIndex(session)
  const accepted=new Map<string,ProjectionPage[]>()
  const pending: ProjectionIntent[]=[]
  for (const intent of index.intents.values()) {
    for (const page of intent.pages) {
      if (!Number.isSafeInteger(page.offset) || !Number.isSafeInteger(page.nextOffset) || page.offset < 0 || page.nextOffset <= page.offset || page.nextOffset > page.totalBytes) throw new Error('Invalid projection page bounds')
      const actual=readJournal(session,page.ref,page.offset,Math.min(32768,page.nextOffset-page.offset))
      if (actual.nextOffset !== page.nextOffset || actual.totalBytes !== page.totalBytes || actual.complete !== page.complete) throw new Error('Projection page does not match its immutable source')
    }
    if (!index.inserted.has(intent.message.id)) { pending.push(intent); continue }
    for(const page of intent.pages) { const ranges=accepted.get(page.ref)??[];ranges.push(page);accepted.set(page.ref,ranges) }
  }
  const inputs: RecoveredInput[]=[]
  for(const input of index.inputs) {
    const ranges=(accepted.get(input.ref)??[]).sort((a,b)=>a.offset-b.offset)
    let offset=0
    for(const page of ranges) {
      if(page.offset>offset) throw new Error('Livestream projection offset gap')
      offset=Math.max(offset,page.nextOffset)
    }
    const bytes=Buffer.byteLength(JSON.stringify(input.entry.event))
    if(offset>bytes) throw new Error('Livestream projection exceeds source')
    if(offset<bytes) inputs.push({event:input.entry.event,ref:input.ref,offset})
  }
  return {inputs,intents:pending}
}
interface Delivery { intent: ProjectionIntent; queued: boolean; flushed: boolean }
const deliveries = new WeakMap<Context, Map<string, Delivery>>()
export function clearLivestreamDeliveries(ctx: Context): void { deliveries.get(ctx)?.clear(); deliveries.delete(ctx) }
/** Stable intent is durable before waking; native inbox identity proves acceptance after restart. */
export async function pushLivestream(ctx: Context, config: SessionPromptConfig, id: string, text: string, now = false, deliveryKey?: string, pages: readonly ProjectionPage[] = []): Promise<boolean> {
  if (id !== LIVESTREAM_SESSION_ID) throw new Error('Foreign livestream target refused')
  const handle = await ensureLivestreamAgent(ctx, config)
  const session=handle.agent.session
  const index=nativeIndex(session)
  let cache = deliveries.get(ctx)
  if (!cache) {
    cache = new Map(); deliveries.set(ctx, cache)
    ctx.effect(() => () => { cache!.clear(); deliveries.delete(ctx) }, 'elysia-livestream.delivery-cache')
  }
  const key = deliveryKey ?? randomUUID()
  let delivery = cache.get(key)
  if (!delivery) {
    if (cache.size >= 256) {
      const evict = [...cache].find(([, value]) => value.flushed)?.[0]
      if (evict === undefined) throw new Error('Livestream pending delivery budget exhausted')
      cache.delete(evict)
    }
    let intent=index.intents.get(key)
    if (!intent) {
      intent={version:1,key,message:createUserMessage({content:[{type:'text',text}],source:{kind:'user'}}),pages:pages.map(p=>({...p}))}
      appendPluginRecord(session,'plugin:elysia-livestream/projection-intent',intent)
      nativeIndex(session)
    }
    delivery = { intent, queued: index.inserted.has(intent.message.id), flushed: false }
    cache.set(key, delivery)
  }
  // Persist the exact intent/message identity before any wakeup. Retrying a failed
  // barrier or process restart reuses this tuple rather than inventing another id.
  if (!await ctx.sessions.flush(session)) throw new Error('Livestream intent has no durability owner')
  if (!delivery.queued && !nativeIndex(session).inserted.has(delivery.intent.message.id)) {
    if (now) handle.agent.steer(delivery.intent.message); else handle.agent.followup(delivery.intent.message)
    delivery.queued = true
  }
  if (!await ctx.sessions.flush(session)) throw new Error('Livestream input has no durability owner')
  delivery.flushed = true
  return true
}

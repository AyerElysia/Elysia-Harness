/** Voice in an isolated conversation or the original main DSH Session. */
import { randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage } from 'node:http'
import { lstat, mkdir, readFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-workspace'
import { createUserMessage, type MessageId, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createVoiceAgent, VoiceAgent, type VoiceDriverRequest } from '@elysia/voice-call/src/session.ts'
import { prepareVoiceSession } from '@elysia/voice-call/src/persistence.ts'
import { acceptsCallMode, equalSecret, LIMIT, MAIN_SESSION, PREFIX, record, ROOM, SESSION, workerEvent, type InputMode, type WorkerEvent } from './bridge.ts'
import { submitMainVoice, type MainVoiceReply } from './main-session.ts'

import { NativeTurn } from './native-turn.ts'

const HOME = process.env.DSH_HOME ?? resolve('homes/web')
const SID = SessionId(SESSION)
const MAIN_SID = SessionId(MAIN_SESSION)
const MAIN_CWD = resolve(import.meta.dirname, '../../../homes/web/conscious-mind')
const BROKER = 'http://127.0.0.1:18794'
const MODEL = 'gemini-3.8-flash'
const MAX_CALL = 630_000
export const name = 'elysia-gemini-cascade'
export const inject = ['sessions', 'agents', 'systemPrompt', 'sessionPersistence', 'connection', 'tools', 'workspaceRegistry']
export interface Config { enabled?: boolean; cwd?: string; promptsDir?: string; bridgeKeyFile?: string; inputMode?: InputMode; mainSessionVoice?: boolean }
export const Config = z.object({
  enabled: z.boolean().default(false),
  mainSessionVoice: z.boolean().default(false),
  cwd: z.string().default(join(HOME, 'gemini-cascade')),
  promptsDir: z.string().default(join(HOME, 'standing-prompts')),
  bridgeKeyFile: z.string().default(process.env.ELYSIA_GEMINI_CASCADE_BRIDGE_KEY_FILE ?? ''),
  inputMode: z.union([z.const('direct-audio'), z.const('local-asr')]).default(
    process.env.ELYSIA_GEMINI_CASCADE_LOCAL_ASR === '1' ? 'local-asr' : 'direct-audio',
  ),
})

type TurnInput = Extract<WorkerEvent, { type: 'user' }>
type History = { role: 'user' | 'assistant'; content: string }
type PendingTurn = { input: TurnInput; reply: NativeTurn }
type Call = {
  roomName: string; token: string; timer: ReturnType<typeof setTimeout>
  sessionId: SessionId; mainAgent?: Agent; mainReplies: Map<number, MainVoiceReply>
  pending: Map<number, PendingTurn>; settled: Set<number>; closing?: Promise<void>
}
type Opened = { agent: VoiceAgent; close: () => Promise<void> }
class Failure extends Error {
  constructor(readonly code: string, readonly status: number) { super(code) }
}
const fail = (code: string, status: number): never => { throw new Failure(code, status) }
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } })
const errorResponse = (error: unknown) => error instanceof Failure
  ? json({ error: error.code }, error.status)
  : json({ error: 'cascade_unavailable' }, 503)

async function readBrowser(request: Request): Promise<Record<string, unknown>> {
  if (!/^application\/json(?:;|$)/iu.test(request.headers.get('content-type') ?? '')) fail('invalid_content_type', 400)
  const reader = request.body?.getReader() ?? fail('invalid_body', 400)
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    for (;;) {
      request.signal.throwIfAborted()
      const next = await reader.read()
      if (next.done) break
      if ((bytes += next.value.byteLength) > 1024) fail('invalid_body', 400)
      chunks.push(next.value)
    }
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (record(value)) return value
  } catch { fail('invalid_body', 400) }
  finally { await reader.cancel().catch(() => undefined); reader.releaseLock() }
  return fail('invalid_body', 400)
}
async function readWorker(request: IncomingMessage, mode: InputMode): Promise<WorkerEvent> {
  if (!/^application\/json(?:;|$)/iu.test(request.headers['content-type'] ?? '')) fail('invalid_content_type', 400)
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of request) {
    const data = Buffer.from(chunk)
    if ((bytes += data.byteLength) > LIMIT) fail('invalid_event_body', 400)
    chunks.push(data)
  }
  try { return workerEvent(JSON.parse(Buffer.concat(chunks).toString('utf8')), mode) }
  catch { return fail('invalid_event_body', 400) }
}
function isExact(data: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(data).length === keys.length && keys.every(key => Object.hasOwn(data, key))
}
function* responseChunks(text: string): Generator<StreamChunk> {
  if (text) {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
  }
  yield { type: 'finish', reason: { kind: 'stop' } }
}
export async function apply(ctx: Context, raw: Config = {}): Promise<void> {
  const config = Config(raw)
  if (!config.enabled) return
  if (![config.cwd, config.promptsDir, config.bridgeKeyFile].every(isAbsolute)) fail('invalid_config', 503)
  const file = await lstat(config.bridgeKeyFile)
  if (!file.isFile() || (file.mode & 0o077) !== 0 || file.uid !== process.getuid?.() || file.size > 129) fail('invalid_bridge_key', 503)
  const secret = (await readFile(config.bridgeKeyFile, 'utf8')).trim()
  if (!/^[a-f0-9]{64}$/u.test(secret)) fail('invalid_bridge_key', 503)

  let active: Call | undefined
  let starting = false
  let disposed = false
  let current: Opened | undefined
  let opening: Promise<Opened> | undefined
  const external = new Map<MessageId, NativeTurn>()
  const history: History[] = []
  const remember = (...items: History[]) => {
    history.push(...items)
    history.splice(0, Math.max(0, history.length - 16))
  }
  async function broker(path: 'start' | 'stop' | 'text', body: unknown, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const timeout = AbortSignal.timeout(path === 'text' ? (config.inputMode === 'local-asr' ? 78_000 : 48_000) : 8_000)
    const response = await fetch(BROKER + '/' + path, {
      method: 'POST', headers: { 'authorization': 'Bearer ' + secret, 'content-type': 'application/json' },
      body: JSON.stringify(body), signal: signal ? AbortSignal.any([signal, timeout]) : timeout, redirect: 'error',
    })
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined)
      return fail(response.status === 409 ? 'cascade_busy' : 'cascade_broker_failed', response.status === 409 ? 409 : 502)
    }
    const size = Number(response.headers.get('content-length') ?? '0')
    if (size > LIMIT) fail('cascade_broker_protocol', 502)
    const result: unknown = await response.json()
    return record(result) ? result : fail('cascade_broker_protocol', 502)
  }
  async function* drive(request: VoiceDriverRequest): AsyncGenerator<StreamChunk> {
    const projected = request.messages.find(message => external.has(message.id))
    if (projected) {
      const answer = external.get(projected.id)!
      external.delete(projected.id)
      yield* answer.chunks(request.signal)
      return
    }
    if (active?.sessionId === SID || starting) fail('use_call_text_box', 409)
    const text = request.messages.flatMap(message => message.content.flatMap(block => block.type === 'text' ? [block.text] : [])).join('\n').trim()
    if (!text || text.length > 2000) fail('invalid_text', 400)
    const result = await broker('text', { messages: [
      { role: 'system', content: request.instructions }, ...history, { role: 'user', content: text },
    ] }, request.signal)
    if (typeof result.text !== 'string' || !result.text.trim() || result.text.length > 4096) return fail('cascade_broker_protocol', 502)
    yield* responseChunks(result.text)
    remember({ role: 'user', content: text }, { role: 'assistant', content: result.text })
  }
  // Dedicated identity: prevent the default factory from restoring it with a different model.
  ctx.on('agent/created', ({ agent }) => {
    if (agent.id !== SID) return
    if (agent instanceof VoiceAgent) {
      let fiber = agent.ctx.fiber
      for (;;) {
        if (fiber === ctx.fiber) return
        const parent = fiber.parent.fiber
        if (parent === fiber) break
        fiber = parent
      }
    }
    fail('cascade_session_reserved', 409)
  }, { prepend: true })
  async function openSession(): Promise<Opened> {
    if (disposed) fail('cascade_unavailable', 503)
    if (current) return current
    if (opening) return opening
    opening = (async () => {
      await mkdir(config.cwd, { recursive: true, mode: 0o700 })
      const workspace = await ctx.workspaceRegistry.create(config.cwd, '和爱莉通话 · 试用')
      const prepared = await prepareVoiceSession(ctx, { cwd: config.cwd, sessionId: SID })
      let voice: Awaited<ReturnType<typeof createVoiceAgent>> | undefined
      try {
        voice = await createVoiceAgent(ctx, {
          session: prepared.session, restore: prepared.restore, sessionId: SID, cwd: config.cwd, promptsDir: config.promptsDir,
          driver: { run: drive }, provider: 'nexusai-a6', model: MODEL,
        })
        voice.agent.cancel({ kind: 'hook', reason: 'Previous voice media cannot be replayed' })
        if (!await ctx.sessions.flush(voice.agent.session)) fail('cascade_session_checkpoint', 503)
        await workspace.attachSession(SID)
        if (disposed) fail('cascade_unavailable', 503)
        const owner = voice
        return current = { agent: owner.agent, close: async () => {
          try { await owner.dispose() } finally { await prepared.handle.close() }
        } }
      } catch (error) {
        try { await voice?.dispose() } finally { await prepared.handle.close() }
        throw error
      }
    })()
    try { return await opening } finally { opening = undefined }
  }
  function mainTarget(): Agent {
    if (!config.mainSessionVoice || config.inputMode !== 'local-asr') return fail('cascade_main_disabled', 409)
    // Never create or resume here. The main plugin owns the only Agent and its
    // scoped setup; reject an unprepared generic Web agent with the same id.
    const agent = ctx.agents.get(MAIN_SID)
    if (!agent || agent.session.header.cwd !== MAIN_CWD || !ctx.tools.get('pass', agent)) {
      return fail('cascade_main_unavailable', 503)
    }
    return agent
  }

  async function closeCall(call: Call, notifyBroker: boolean): Promise<void> {
    if (call.closing) return call.closing
    clearTimeout(call.timer)
    call.closing = (async () => {
      try {
        for (const turn of call.pending.keys()) settle(call, turn, 'interrupted')
        for (const reply of call.mainReplies.values()) reply.detach()
        call.mainReplies.clear()
        if (notifyBroker) await broker('stop', { roomName: call.roomName }).catch(() => undefined)
      } finally { if (active === call) active = undefined }
    })()
    return call.closing
  }
  async function projectInput(call: Call, input: TurnInput): Promise<void> {
    const { turn } = input
    if (call.closing || call.settled.has(turn) || call.pending.has(turn) || !current) return
    if (call.pending.size >= 8) fail('cascade_event_backlog', 409)
    const reply = new NativeTurn()
    call.pending.set(turn, { input, reply })
    const message = input.text ? createUserMessage({ content: [{ type: 'text', text: input.text }], source:
      input.input === 'voice' ? { kind: 'elysia-cascade-voice-transcript', provider: 'sensevoice-local', roomName: call.roomName, turn, rawAudioStored: false }
        : { kind: 'elysia-cascade-typed-input', roomName: call.roomName, turn } })
      : createUserMessage({ content: [], source: {
          kind: 'elysia-cascade-voice-input', form: 'notice',
          summary: '语音发言（无转写，原声不保存）', roomName: call.roomName, turn,
        } })
    external.set(message.id, reply)
    try { await current.agent.acceptInput(message) }
    catch (error) {
      external.delete(message.id)
      call.pending.delete(turn)
      reply.settle('error')
      throw error
    }
  }
  function settle(call: Call, turn: number, kind: 'done' | 'interrupted' | 'error', text = ''): void {
    const pending = call.pending.get(turn)
    if (!pending) return
    call.pending.delete(turn)
    call.settled.add(turn)
    const done = pending.reply.settle(kind, text)
    if (pending.input.text) remember({ role: 'user', content: pending.input.text })
    if (done) remember({ role: 'assistant', content: text })
  }
  function mainEvent(call: Call, agent: Agent, event: WorkerEvent): unknown {
    if (call.closing) return fail('cascade_call_closed', 409)
    if (event.type === 'poll') {
      const reply = call.mainReplies.get(event.turn)
      if (reply) return reply.poll(event.seq)
      if (call.settled.has(event.turn)) return { seq: event.seq, text: '', done: true }
      return fail('cascade_main_turn_unknown', 404)
    }
    if (event.type === 'interrupted' || event.type === 'error') {
      call.mainReplies.get(event.turn)?.detach()
      call.mainReplies.delete(event.turn)
      call.settled.add(event.turn)
      return { ok: true }
    }
    if (event.type !== 'user' || event.input !== 'voice' || !event.text) return fail('cascade_main_event_invalid', 400)
    if (call.settled.has(event.turn) || call.mainReplies.has(event.turn)) return { ok: true }
    let pending = 0
    for (const [number, reply] of call.mainReplies) {
      if (reply.done) {
        reply.detach()
        call.mainReplies.delete(number)
        call.settled.add(number)
      } else pending++
    }
    if (pending >= 8) return fail('cascade_event_backlog', 409)
    if (mainTarget() !== agent) return fail('cascade_main_unavailable', 503)
    call.mainReplies.set(event.turn, submitMainVoice(ctx, agent, event.text))
    return { ok: true }
  }
  async function applyEvent(event: WorkerEvent): Promise<unknown> {
    const call = active
    if (!call || call.roomName !== event.roomName) return fail('cascade_room_mismatch', 404)
    if (event.type === 'closed') await closeCall(call, false)
    else if (call.mainAgent) return mainEvent(call, call.mainAgent, event)
    else if (event.type === 'poll') return fail('cascade_main_event_invalid', 400)
    else if (event.type === 'user') await projectInput(call, event)
    else if (event.type === 'delta') call.pending.get(event.turn)?.reply.delta(event.text)
    else if (event.type === 'done') settle(call, event.turn, 'done', event.text)
    else if (event.type === 'error' || event.type === 'interrupted') settle(call, event.turn, event.type)
    return { ok: true }
  }
  const sink = createServer({ headersTimeout: 4000, requestTimeout: 5000 }, (req, res) => {
    void (async () => {
      let response: Response
      try {
        if (req.url !== '/events' || req.method !== 'POST') fail('not_found', 404)
        if (!equalSecret(req.headers.authorization, 'Bearer ' + secret)) fail('forbidden', 403)
        response = json(await applyEvent(await readWorker(req, config.inputMode)))
      } catch (error) { response = errorResponse(error) }
      if (!res.destroyed) {
        res.writeHead(response.status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
        res.end(await response.text())
      }
    })().catch(() => res.destroy())
  })
  await new Promise<void>((ok, bad) => {
    sink.once('error', bad)
    sink.listen(18793, '127.0.0.1', () => { sink.off('error', bad); ok() })
  })
  ctx.effect(() => async () => {
    disposed = true
    if (active) await closeCall(active, true)
    sink.close()
    sink.closeAllConnections()
    await opening?.catch(() => undefined)
    await current?.close()
    external.clear()
    history.length = 0
  }, 'gemini-cascade.owner')

  for (const action of ['open', 'start', 'stop'] as const) {
    ctx.effect(() => ctx.connection.fetch.register({
      path: PREFIX + '/' + action, methods: ['POST'], requestBody: 'streaming',
      async fetch(request: Request): Promise<Response> {
        try {
          const data = await readBrowser(request)
          // The DSH fetch bridge uses dsh.internal for Request.url; the
          // independently authenticated browser authority is in Host/Origin.
          const host = request.headers.get('host')
          if ((host !== '127.0.0.1:3299' && host !== '127.0.0.1:18795') || request.headers.get('origin') !== 'http://' + host) {
            fail('cascade_local_only', 403)
          }
          if (new URL(request.url).search) fail('invalid_query', 400)
          if (action === 'open') {
            if (isExact(data, ['sessionId']) && data.sessionId === MAIN_SID) {
              mainTarget()
              return json({ sessionId: MAIN_SID, inputMode: config.inputMode })
            }
            if (isExact(data, [])) {
              await openSession()
              return json({ sessionId: SID, inputMode: config.inputMode })
            }
            return fail('invalid_request', 400)
          }
          const sessionId = data.sessionId === MAIN_SID ? MAIN_SID : data.sessionId === SID ? SID : fail('invalid_session', 400)
          if (action === 'stop') {
            const call = active
            if (!isExact(data, ['sessionId', 'roomName', 'callToken'])) fail('invalid_request', 400)
            if (!call || call.sessionId !== sessionId || call.roomName !== data.roomName || !equalSecret(data.callToken, call.token)) {
              return fail('cascade_call_not_found', 404)
            }
            await closeCall(call, true)
            return json({ ok: true })
          }
          if (!isExact(data, ['sessionId']) && !isExact(data, ['sessionId', 'inputMode'])) fail('invalid_request', 400)
          if (!acceptsCallMode(data.inputMode, config.inputMode)) fail('cascade_input_mode_changed', 409)
          if (starting || active || (sessionId === SID && current?.agent.status === 'running')) fail('cascade_busy', 409)
          starting = true
          try {
            const mainAgent = sessionId === MAIN_SID ? mainTarget() : undefined
            if (!mainAgent && (await openSession()).agent.status === 'running') fail('cascade_busy', 409)
            if (disposed) fail('cascade_busy', 409)
            request.signal.throwIfAborted()
            const result = await broker('start', { inputMode: config.inputMode, ...(mainAgent ? { turnMode: 'main-session' } : {}) })
            const { roomName, serverUrl, participantToken, participantIdentity } = result
            if (result.inputMode !== config.inputMode || typeof roomName !== 'string' || !ROOM.test(roomName) || serverUrl !== 'ws://127.0.0.1:18780'
              || (mainAgent && result.turnMode !== 'main-session')
              || typeof participantToken !== 'string' || participantToken.length > 8192
              || typeof participantIdentity !== 'string' || !/^pilot-user-[a-f0-9]{24}$/u.test(participantIdentity)) {
              if (typeof roomName === 'string' && ROOM.test(roomName)) await broker('stop', { roomName }).catch(() => undefined)
              return fail('cascade_broker_protocol', 502)
            }
            const token = randomBytes(32).toString('hex')
            const timer = setTimeout(() => { if (active?.roomName === roomName) void closeCall(active, true).catch(() => undefined) }, MAX_CALL)
            timer.unref()
            const call: Call = active = {
              roomName, token, timer, sessionId, ...(mainAgent ? { mainAgent } : {}),
              mainReplies: new Map(), pending: new Map(), settled: new Set(),
            }
            if (mainAgent && ctx.agents.get(MAIN_SID) !== mainAgent) { await closeCall(call, true); return fail('cascade_main_unavailable', 503) }
            if (request.signal.aborted || disposed) { await closeCall(call, true); return fail('cascade_aborted', 409) }
            return json({ roomName, serverUrl, participantToken, participantIdentity, callToken: token, inputMode: config.inputMode })
          } finally { starting = false }
        } catch (error) { return errorResponse(error) }
      },
    }), 'gemini-cascade.http:' + action)
  }
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'elysia-cascade-typed-input': { kind: 'elysia-cascade-typed-input'; roomName: string; turn: number }
    'elysia-cascade-voice-transcript': {
      kind: 'elysia-cascade-voice-transcript'; provider: 'sensevoice-local'; roomName: string; turn: number; rawAudioStored: false
    }
    'elysia-cascade-voice-input': {
      kind: 'elysia-cascade-voice-input'; form: 'notice'; summary: string; roomName: string; turn: number
    }
  }
}

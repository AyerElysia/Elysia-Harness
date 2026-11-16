import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { lstat, readFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { equalSecret } from './bridge.ts'
import { DesktopPerform, exact, type DesktopIngress } from './desktop-perform.ts'
import { submitMainVoice, type MainVoiceReply } from './main-session.ts'

const contextKind = 'elysia-desktop-context'
const helpers = new Set(['runtime-context', 'agent-instructions', 'time-context', 'elysia-calendar-context', contextKind])
const loopback = '127.0.0.1'
const group = 'elysia-desktop.owner'
type Driver = {
  target(): Agent
  start(source: DesktopIngress, signal: AbortSignal): Promise<unknown>
  stop(deviceId: string, roomName: unknown, token: unknown): Promise<void>
}

export async function mountDesktopHost(ctx: Context, keyFile: string, driver: Driver, port = 18797): Promise<number> {
  if (!isAbsolute(keyFile)) throw new Error('desktop_key_path')
  const stat = await lstat(keyFile)
  if (!stat.isFile() || (stat.mode & 0o077) || stat.uid !== process.getuid?.() || stat.size > 65) throw new Error('desktop_key_permissions')
  const key = (await readFile(keyFile, 'utf8')).trim()
  if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('desktop_key_format')
  const deviceId = createHash('sha256').update('elysia-desktop-device-v1:').update(key).digest('hex').slice(0, 32)
  const instruction = await readFile(join(import.meta.dirname, 'DESKTOP-TOOLS.md'), 'utf8')
  const avatar = new DesktopPerform()
  const replies = new Map<string, { reply: MainVoiceReply; expires: number }>()
  // Retain accepted request IDs for the whole process; never silently admit old IDs.
  const accepted = new Map<string, string>()
  const activeTurn = new WeakMap<Agent, { turn: number; media: Set<'text' | 'voice'>; mixed: boolean; signal?: AbortSignal }>()
  let registered: Agent | undefined
  let unregister: (() => void) | undefined
  function origin(medium: DesktopIngress['medium']): DesktopIngress { return { surface: 'desktop', medium, deviceId } }
  function canPerform(agent: Agent): boolean {
    const turn = activeTurn.get(agent)
    return agent === registered && !!turn && !turn.mixed && turn.media.size > 0
  }

  function register(agent: Agent) {
    if (registered === agent) return
    unregister?.()
    registered = agent
    const name = 'desktop_perform'
    // The writable scope belongs to the exact, already-composed live main Agent.
    unregister = agent.ctx.tools.register({
      name,
      description: '查询或控制你自己在 Windows 上的桌宠。list 查询当前模型已登记的表情和动作；play 按顺序执行 1–4 个已登记的项目。只能选择 list 返回的 ID。工具只控制桌宠表情和动作，不发送消息、不录音、不截图、不操作电脑。started 只表示开始；未知时不要自动重试。',
      parameters: {
          type: 'object', additionalProperties: false, required: ['action'],
          properties: {
            action: { type: 'string', enum: ['list', 'play'] },
            catalog_rev: { type: 'string', description: 'play 时必须原样填 list 返回的目录版本。' },
            steps: { type: 'array', minItems: 1, maxItems: 4, items: {
              type: 'object', additionalProperties: false, required: ['kind', 'id'],
              properties: {
                kind: { type: 'string', enum: ['expression', 'motion'] }, id: { type: 'string' }, hold_ms: { type: 'integer', minimum: 200, maximum: 4000 },
              },
            } },
          },
      },
      output: {
        schema: {
          type: 'object', additionalProperties: false, required: ['status'],
          properties: {
            status: { type: 'string', enum: ['catalog', 'started', 'unknown', 'rejected'] },
            code: { type: 'string' }, performance_id: { type: 'string' }, catalog_rev: { type: 'string' },
            expressions: { type: 'array', items: { type: 'object', required: ['id', 'label'], additionalProperties: false, properties: { id: { type: 'string' }, label: { type: 'string' } } } },
            motions: { type: 'array', items: { type: 'object', required: ['id', 'label'], additionalProperties: false, properties: { id: { type: 'string' }, label: { type: 'string' } } } },
          },
        },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      execute: async (args, exec) => {
        return await avatar.run(exec.agent === agent && canPerform(agent), args, exec.signal)
      },
    }, { when: ({ agent: subject, signal }) => {
      if (subject !== agent || !canPerform(agent)) return false
      activeTurn.get(agent)!.signal = signal
      return true
    } })
  }

  ctx.on('elysia/main-prompt-addon', (signal) => registered && canPerform(registered) &&
    activeTurn.get(registered)?.signal === signal && !signal.aborted ? instruction : undefined)

  // Claims happen before tool admission and system prompt assembly. Read only
  // out-of-band source metadata attached by the authenticated desktop ingress.
  ctx.on('agent/inbox/claimed', ({ agent, message, turn }) => {
    if (agent !== registered || helpers.has(message.source.kind)) return
    let current = activeTurn.get(agent)
    if (!current || current.turn !== turn) {
      current = { turn, media: new Set(), mixed: false }
      activeTurn.set(agent, current)
    }
    const source = message.source as { kind: string; elysiaIngress?: DesktopIngress }
    const from = source.elysiaIngress
    if (source.kind === 'user' && from?.surface === 'desktop' && from.deviceId === deviceId && (from.medium === 'text' || from.medium === 'voice')) current.media.add(from.medium)
    else current.mixed = true
  })
  ctx.on('session/event', (session, event) => {
    if (registered?.session === session && event.type === 'turn/end') activeTurn.delete(registered)
  })
  ctx.on('agent/pre-step', async ({ agent, turn, messages, signal }, next) => {
    const decision = await next()
    if (agent !== registered || decision.kind === 'reject' || signal.aborted) return decision
    const current = activeTurn.get(agent)
    if (!current?.media.size || current.turn !== turn || !messages.length) return decision
    const label = [...current.media].map(value => value === 'voice' ? '桌面 · 语音' : '桌面 · 打字').join('、')
    const text = `服务端已验证当轮消息来源：${label}。${current.mixed ? '本轮也有其他输入；不能对桌面执行表演。' : '本轮来源为已配对桌宠。'}`
    return { ...decision, messages: [...decision.messages, createUserMessage({
      content: [{ type: 'text', text }], source: { kind: contextKind, form: 'snapshot', sections: [{ name: contextKind, text }] },
    })] }
  }, { prepend: true })

  const consumer = createServer({ headersTimeout: 3500, requestTimeout: 9000 }, (req, res) => {
    const abort = new AbortController()
    res.on('close', () => { if (!res.writableFinished) abort.abort() })
    const respond = (status: number, data: unknown) => {
      if (!res.destroyed) res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(data))
    }
    void (async () => {
      if (req.method !== 'POST' || req.headers.host !== `${loopback}:${port}` || req.headers.origin || req.headers.cookie
        || !equalSecret(req.headers.authorization, `Bearer ${key}`)) return respond(403, { error: 'forbidden' })
      if ((req.headers['content-type'] ?? '') !== 'application/json') return respond(400, { error: 'invalid_request' })
      let bytes = 0
      const chunks: Buffer[] = []
      for await (const chunk of req) {
        const data = Buffer.from(chunk)
        if ((bytes += data.length) > 24000) return respond(413, { error: 'too_large' })
        chunks.push(data)
      }
      let body: unknown
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) }
      catch { return respond(400, { error: 'invalid_request' }) }
      let result: unknown
      if (req.url === '/desktop/stop' && exact(body, ['roomName', 'callToken'])) {
        await driver.stop(deviceId, body.roomName, body.callToken)
        return respond(200, { ok: true })
      }
      // An accepted request retains its own receipt even if the live Agent goes away.
      if (req.url === '/desktop/reply' && exact(body, ['id']) && typeof body.id === 'string') {
        avatar.seen()
        const entry = replies.get(body.id)
        if (entry && entry.expires > Date.now()) {
          const failure = entry.reply.failure
          return respond(200, { ...entry.reply.poll(0), ...(failure === undefined ? {} : { error: failure }) })
        }
        if (entry) { entry.reply.detach(); replies.delete(body.id) }
        return respond(200, { seq: 0, text: '', done: true, error: accepted.has(body.id) ? 'expired' : 'no_reply' })
      }
      const agent = driver.target()
      register(agent)
      avatar.seen()
      if (req.url === '/desktop/probe' && exact(body, [])) result = { ok: true }
      if (req.url === '/desktop/start' && exact(body, [])) result = await driver.start(origin('voice'), abort.signal)
      if (req.url === '/desktop/catalog' && avatar.catalogUpdate(body)) result = { ok: true }
      if (req.url === '/desktop/performance' && exact(body, [])) result = { job: avatar.take() ?? null }
      if (req.url === '/desktop/ack' && avatar.ack(body)) result = { ok: true }
      if (req.url === '/desktop/text' && exact(body, ['id', 'text']) && typeof body.id === 'string'
        && /^[0-9a-f-]{36}$/.test(body.id) && typeof body.text === 'string' && body.text.trim() && body.text.length <= 2000) {
        for (const [id, entry] of replies) if (entry.expires <= Date.now()) { entry.reply.detach(); replies.delete(id) }
        const digest = createHash('sha256').update(body.text).digest('hex')
        if (accepted.has(body.id)) return respond(accepted.get(body.id) === digest ? 200 : 409,
          accepted.get(body.id) === digest ? { ok: true } : { error: 'duplicate_id' })
        if ([...replies.values()].filter(entry => !entry.reply.done).length >= 8 || replies.size >= 64 || accepted.size >= 65536)
          return respond(429, { error: 'desktop_busy' })
        const reply = submitMainVoice(ctx, agent, body.text, origin('text'))
        accepted.set(body.id, digest)
        replies.set(body.id, { reply, expires: Date.now() + 300000 })
        result = { ok: true }
      }
      return result === undefined ? respond(400, { error: 'invalid_request' }) : respond(200, result)
    })().catch(() => respond(503, { error: 'desktop_unavailable' }))
  })
  await new Promise<void>((resolve, reject) => {
    consumer.once('error', reject)
    consumer.listen(port, loopback, () => { consumer.off('error', reject); resolve() })
  })
  const address = consumer.address()
  if (!address || typeof address === 'string') throw new Error('desktop_address')
  port = address.port
  ctx.effect(() => () => {
    unregister?.()
    for (const entry of replies.values()) entry.reply.detach()
    replies.clear(); accepted.clear()
    consumer.close(); consumer.closeAllConnections()
  }, group)
  return port
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    'elysia/main-prompt-addon'(signal: AbortSignal): string | undefined
  }
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'elysia-desktop-context': { kind: 'elysia-desktop-context'; form: 'snapshot'; sections: { name: string; text: string }[] }
  }
}

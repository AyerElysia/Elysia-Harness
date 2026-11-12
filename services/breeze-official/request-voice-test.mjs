/**
 * Send one explicitly attributed operator request through the native session API,
 * or inspect only its voice-tool result metadata. Credentials stay in memory.
 */
import { readFile } from 'node:fs/promises'
import { randomUUID, createHash } from 'node:crypto'

const mode = process.argv[2]
const requestId = process.argv[3]
const conversation = process.argv[4]
if (!['send', 'observe'].includes(mode) || !/^[0-9a-f-]{36}$/u.test(requestId ?? '')) throw new Error('mode and stable UUID required')
if (!/^kook:direct:\d{6,20}$/u.test(conversation ?? '')) throw new Error('verified KOOK direct conversation required')
const origin = 'http://127.0.0.1:3299'
const sessionId = 'elysia-conscious-mind'
const log = await readFile('/home/ayerelysia/Elysia/DataInfra/logs/elyharn-web.log', 'utf8')
const token = [...log.matchAll(/http:\/\/127\.0\.0\.1:3299\/\?token=([A-Za-z0-9_-]+)/gu)].at(-1)?.[1]
if (!token) throw new Error('No current local session credential')
const connected = await fetch(`${origin}/connect?token=${encodeURIComponent(token)}&interactions=none`, { redirect: 'manual', signal: AbortSignal.timeout(10000) })
if (connected.status !== 302) throw new Error(`Local API connect HTTP ${connected.status}`)
const cookie = connected.headers.get('set-cookie')?.split(';', 1)[0]
if (!cookie) throw new Error('No local API cookie')
async function rpc(method, args) {
  const rpcId = randomUUID()
  const res = await fetch(`${origin}/api/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ type: 'client-request', rpcId, method, payload: { args } }),
    signal: AbortSignal.timeout(30000),
  })
  if (!res.ok) throw new Error(`Local RPC ${method} HTTP ${res.status}`)
  const envelope = await res.json()
  if (envelope.rpcId !== rpcId || envelope.result?.ok !== true) throw new Error(`Local RPC ${method} rejected`)
  return envelope.result.value
}
async function snapshot() {
  const p = await rpc('session/projections', { request: { sessionId } })
  if (p.kind !== 'sequenced' || !Number.isSafeInteger(p.asOfSeq)) throw new Error('Unexpected projection shape')
  const page = await rpc('session/page', { request: { address: { kind: 'session', sessionId }, throughSeq: p.asOfSeq, maxMessages: 50 } })
  const events = page.records.filter(x => x.type === 'event').map(x => x.event).sort((a, b) => a.seq - b.seq)
  const anchor = events.find(x => x.type === 'user/message' && x.data.source?.rpcId === requestId)
  const listed = await rpc('session/list', { _request: {} })
  const state = (listed.items ?? listed).find(x => x.sessionId === sessionId)
  return { asOfSeq: p.asOfSeq, events, anchor, state, hasMore: page.hasMore }
}
if (mode === 'send') {
  const before = await snapshot()
  if (before.anchor) {
    console.log(JSON.stringify({ requestId, alreadyRecorded: true, anchorSeq: before.anchor.seq }))
  } else {
    const text = `【Codex 代用户转达的运维测试消息，不是平台新入站】用户已授权将 BreezeTTS2 推理替换为官方实现，并让你给他发语音测试。官方服务已完成合成兼容检查，现有默认爱莉参考音频未改。用户确认 KOOK 也可以，且已通过机器人账户列表核对 AyerElysia 的私聊目标为 ${conversation}。请使用 send_voice，channel=kook、conversation=${conversation}，给 AyerElysia 发一条简短语音；具体说什么由你表达，不用照读这段工程说明，不改变默认参考音色。请只尝试一次；若合成或发送失败就如实反馈，不自动重复投递，尤其 unknown 不能重发。不要改动主体文件或原有事项。完成后在本会话说明工具返回的发送状态。`
    await rpc('session/prompt', { request: { requestId, sessionId, mode: 'queue', content: [{ type: 'text', text }], clientTimeZone: 'Asia/Shanghai' } })
    console.log(JSON.stringify({ requestId, submitted: true, sessionId, mode: 'queue', targetChannel: 'kook', targetAccount: 'AyerElysia' }))
  }
} else {
  const s = await snapshot()
  const calls = new Map()
  let turnEnded = false
  if (s.anchor) {
    for (const e of s.events.filter(x => x.seq > s.anchor.seq)) {
      if (e.type === 'turn/end') { turnEnded = true; break }
      if (e.type === 'tool/call' && e.data.name === 'send_voice') {
        const a = JSON.parse(e.data.arguments)
        if (a.channel !== 'kook' || a.conversation !== conversation) continue
        calls.set(e.data.callId, { callId: e.data.callId, callSeq: e.seq, targetChannel: a.channel,
          targetAccount: 'AyerElysia', textCharacters: Array.from(a.text ?? '').length,
          textSha256: createHash('sha256').update(a.text ?? '').digest('hex'),
          hasExpression: Boolean(a.expression_instruction) })
      }
      if (e.type === 'tool/result' && calls.has(e.data.message?.toolCallId)) {
        const item = calls.get(e.data.message.toolCallId)
        for (const part of e.data.message.content ?? []) {
          if (part.type !== 'text') continue
          try {
            const value = JSON.parse(part.text)
            if (typeof value.status === 'string') Object.assign(item, { resultSeq: e.seq, status: value.status,
              audioBytes: value.audioBytes, messageId: value.messageId, error: value.error })
          } catch {}
        }
      }
    }
  }
  console.log(JSON.stringify({ requestId, asOfSeq: s.asOfSeq, anchorFound: Boolean(s.anchor),
    anchorSeq: s.anchor?.seq, running: s.state?.running, agentAvailable: s.state?.agentAvailable,
    turnEnded, hasMore: s.hasMore, voiceCalls: [...calls.values()] }))
}

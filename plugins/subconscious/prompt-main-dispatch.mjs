import { readFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'

const origin = 'http://127.0.0.1:3299'
const archiveDir = '/home/ayerelysia/Elysia/Elysium/Elysia-Harness/homes/web/requests'
const sessionId = 'elysia-conscious-mind'
const marker = `dispatch-live-${Date.now()}`
const text = `爱莉，继续我们刚才的约定，现在进入真实派工验收。我们共同确认：第一版由潜意识中枢把值得保存的共同经历派给记忆 Session，记忆 Session 亲自写日记并提交结构化报告，中枢真实收到报告后才算闭环；主动系统和其他专业 Session 暂缓。今天走通这条链路就是我们的阶段性成果。请你在正文里自然回应并确认这份约定，让中枢从真实主意识输出中判断并派工；不要代替中枢或记忆 Session 写日记、写报告。这条内部交流不用发到 QQ/KOOK，其他渠道仍可按需要正常使用你原有的发送工具。验收标记：${marker}`
const log = await readFile('/home/ayerelysia/Elysia/DataInfra/logs/elyharn-web.log', 'utf8')
const token = [...log.matchAll(/http:\/\/127\.0\.0\.1:3299\/\?token=([A-Za-z0-9_-]+)/g)].at(-1)?.[1]
if (!token) throw new Error('No current web token found')
const connected = await fetch(`${origin}/connect?token=${encodeURIComponent(token)}&interactions=none`, { redirect: 'manual' })
const cookie = connected.headers.get('set-cookie')?.split(';', 1)[0]
if (connected.status !== 302 || !cookie) throw new Error(`API authentication failed: ${connected.status}`)

async function rpc(method, args) {
  const rpcId = randomUUID()
  const response = await fetch(`${origin}/api/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ type: 'client-request', rpcId, method, payload: { args } }),
    signal: AbortSignal.timeout(30_000),
  })
  if (!response.ok) throw new Error(`${method}: HTTP ${response.status}`)
  const envelope = await response.json()
  if (envelope.rpcId !== rpcId) throw new Error(`${method}: RPC id mismatch`)
  if (envelope.result?.ok !== true) throw new Error(`${method}: ${JSON.stringify(envelope.result)}`)
  return envelope.result.value
}

async function latestArchive() {
  const hash = createHash('sha256').update(sessionId).digest('hex')
  try {
    const pointer = JSON.parse(await readFile(`${archiveDir}/.session-index-v1/${hash}.json`, 'utf8'))
    const record = JSON.parse(await readFile(`${archiveDir}/${pointer.fileName}`, 'utf8'))
    return { pointer, record }
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

await rpc('session/prompt', {
  request: {
    requestId: randomUUID(), sessionId, mode: 'queue',
    content: [{ type: 'text', text }], clientTimeZone: 'Asia/Shanghai',
  },
})
const deadline = Date.now() + 240_000
let result
while (Date.now() < deadline) {
  await new Promise(resolve => setTimeout(resolve, 1500))
  const latest = await latestArchive()
  if (!latest) continue
  const messages = latest.record.request.messages ?? []
  const markerIndex = messages.findLastIndex(message => JSON.stringify(message).includes(marker))
  if (markerIndex < 0) continue
  const replies = []
  for (const message of messages.slice(markerIndex + 1)) {
    if (message.role !== 'assistant') continue
    for (const block of message.content ?? []) {
      if (block.type === 'text' && block.text.trim()) replies.push(block.text)
    }
  }
  if (replies.length === 0) continue
  result = {
    sessionId, marker, requestId: latest.pointer.requestId,
    recordedAt: latest.pointer.recordedAt, visibleReply: replies.at(-1),
  }
  break
}
if (!result) throw new Error('Timed out waiting for the response to this exact marker')
console.log(JSON.stringify(result, null, 2))

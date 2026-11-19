import { readFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'

const origin = 'http://127.0.0.1:3299'
const archiveDir = '/home/ayerelysia/Elysia/Elysium/Elysia-Harness/homes/web/requests'
const sessionId = 'elysia-conscious-mind'
const marker = `meaningful-memory-${Date.now()}`
const text = `爱莉，今天我们真实完成了潜意识派工与记忆整理的最小闭环。我想把这段经历作为一篇有实际内容的记忆留下，而不是做一次空测试。请你在正文里以自己的理解自然总结这段共同经历，供以后的自己回顾：一、主意识表界活动如何形成 Observation 和 Batch，由潜意识中枢理解后自主派工；二、长期记忆 Session 如何亲自写日记、提交结构化报告，报告真正回到中枢才算闭环；三、为什么采用「先回传 Report、再执行 Assignment、最后消费新 Batch」的顺序；四、当前边界仍然是潜意识不能直接对外发送，主动系统、自动续接和其他专业 Session 尚未实现，旧工具模仿与派工粒度仍需治理。请让潜意识中枢从这些真实输入和你的真实输出中判断并派发值得保存的记忆任务；不要代替中枢或记忆 Session 写日记、写报告。这条内部交流不用发到 QQ/KOOK，其他渠道仍可按需要正常使用你原有的发送工具。验收标记：${marker}`
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
    archiveFile: latest.pointer.fileName,
  }
  break
}
if (!result) throw new Error('Timed out waiting for the response to this exact marker')
console.log(JSON.stringify(result, null, 2))

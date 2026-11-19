import { readFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'

const origin = 'http://127.0.0.1:3299'
const archiveDir = '/home/ayerelysia/Elysia/Elysium/Elysia-Harness/homes/web/requests'
const sessionId = 'elysia-subconscious-router'
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
    return pointer
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

async function sessionState() {
  const listed = await rpc('session/list', { _request: {} })
  const sessions = Array.isArray(listed) ? listed : listed.items
  return sessions.find(item => item.sessionId === sessionId)
}

const before = await latestArchive()
const initial = await sessionState()
if (initial?.running) throw new Error('Router is still running; refusing to compact a busy Session')
await rpc('session/prompt', {
  request: {
    requestId: randomUUID(), sessionId, mode: 'queue',
    content: [{ type: 'text', text: '/compact' }], clientTimeZone: 'Asia/Shanghai',
  },
})
const deadline = Date.now() + 240_000
let latest = before
let state = initial
let sawActivity = false
while (Date.now() < deadline) {
  await new Promise(resolve => setTimeout(resolve, 2000))
  latest = await latestArchive()
  state = await sessionState()
  sawActivity ||= state?.running === true || latest?.requestId !== before?.requestId
  if (sawActivity && state?.running === false && latest?.requestId !== before?.requestId) break
}
console.log(JSON.stringify({ sessionId, before, latest, state, sawActivity }, null, 2))
if (!sawActivity || state?.running !== false || latest?.requestId === before?.requestId) {
  throw new Error('Manual compaction did not reach a new completed archived request')
}

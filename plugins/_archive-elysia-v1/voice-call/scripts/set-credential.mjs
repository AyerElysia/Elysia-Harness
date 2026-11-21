/** Operator-only setup: reads the secret from stdin, never argv or source. */
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'

const describeOnly = process.argv.includes('--describe')
let input = ''
if (!describeOnly) for await (const part of process.stdin) input += part.toString('utf8')
const value = input.trim()
if (!describeOnly && (!value.startsWith('sk-') || value.length < 24 || value.length > 4096)) throw new Error('Expected one API credential on stdin')
const origin = 'http://127.0.0.1:3299'
const ref = 'OPENAI_REALTIME_API_KEY'
const log = await readFile('/home/ayerelysia/Elysia/DataInfra/logs/elyharn-web.log', 'utf8')
const token = [...log.matchAll(/http:\/\/127\.0\.0\.1:3299\/\?token=([A-Za-z0-9_-]+)/gu)].at(-1)?.[1]
if (!token) throw new Error('Current local operator access is unavailable')
const connected = await fetch(`${origin}/connect?token=${encodeURIComponent(token)}&interactions=none`, { redirect: 'manual', signal: AbortSignal.timeout(10000) })
const cookie = connected.headers.get('set-cookie')?.split(';', 1)[0]
if (connected.status !== 302 || !cookie) throw new Error('Local operator authentication failed')
async function rpc(method, args) {
  const rpcId = randomUUID()
  const response = await fetch(`${origin}/api/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ type: 'client-request', rpcId, method, payload: { args } }),
    signal: AbortSignal.timeout(10000),
  })
  if (!response.ok) throw new Error(`Credential operation HTTP ${response.status}`)
  const envelope = await response.json()
  if (envelope.rpcId !== rpcId || envelope.result?.ok !== true) throw new Error('Credential operation rejected')
  return envelope.result.value
}
if (!describeOnly) await rpc('credentials/set', { ref, value })
input = ''
const described = await rpc('credentials/describe', { refs: [ref] })
const candidates = Array.isArray(described) ? described : (described?.items ?? described?.descriptors ?? [])
const metadata = described?.[ref] ?? candidates.find(item => item.ref === ref || item.name === ref)
console.log(JSON.stringify({ ref, saved: !describeOnly, configured: metadata?.configured ?? null, source: metadata?.source ?? null }))

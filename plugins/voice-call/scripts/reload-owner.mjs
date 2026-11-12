/** Targeted native disable -> enable for voice-call, never a process/profile restart. */
import { readFile, readlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const origin = 'http://127.0.0.1:3299'
const target = '@elysia/voice-call'
const logPath = '/home/ayerelysia/Elysia/DataInfra/logs/elyharn-web.log'
const root = '/home/ayerelysia/Elysia/Elysium/Elysia-Harness'
const exec = promisify(execFile)

async function processIdentity() {
  const lines = (await exec('ss', ['-lntp'])).stdout.split('\n').filter(line => line.includes('127.0.0.1:3299'))
  const pid = Number(lines.length === 1 ? lines[0].match(/pid=(\d+)/u)?.[1] : NaN)
  if (!Number.isSafeInteger(pid) || await readlink(`/proc/${pid}/cwd`) !== `${root}/dsh`) throw new Error('Web process owner is unavailable')
  const starttime = (await readFile(`/proc/${pid}/stat`, 'utf8')).split(') ').at(-1)?.split(' ')[19]
  return { pid, starttime }
}

const log = await readFile(logPath, 'utf8')
const token = [...log.matchAll(/http:\/\/127\.0\.0\.1:3299\/\?token=([A-Za-z0-9_-]+)/gu)].at(-1)?.[1]
if (!token) throw new Error('Local operator access is unavailable')
const connected = await fetch(`${origin}/connect?token=${encodeURIComponent(token)}&interactions=none`, { redirect: 'manual', signal: AbortSignal.timeout(10_000) })
const cookie = connected.headers.get('set-cookie')?.split(';', 1)[0]
if (connected.status !== 302 || !cookie) throw new Error('Local operator authentication failed')

async function rpc(method, args) {
  const rpcId = randomUUID()
  const response = await fetch(`${origin}/api/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ type: 'client-request', rpcId, method, payload: { args } }),
    signal: AbortSignal.timeout(90_000),
  })
  if (!response.ok) throw new Error(`Native management HTTP ${response.status}`)
  const envelope = await response.json()
  if (envelope.rpcId !== rpcId || envelope.result?.ok !== true) throw new Error('Native management rejected the operation')
  return envelope.result.value
}

async function runtime() {
  const plugins = await rpc('pluginManager/listPlugins', {})
  const main = plugins.find(row => row.moduleName === '@elysia/conscious-mind')
  const voice = plugins.find(row => row.moduleName === target)
  const sessions = await rpc('session/list', { _request: {} })
  const mainAgent = sessions.items?.find(item => item.sessionId === 'elysia-conscious-mind')
  const response = await fetch(`${origin}/api/voice-call/state`, { headers: { cookie }, signal: AbortSignal.timeout(10_000) })
  if (!response.ok) throw new Error('Voice state is unavailable')
  const state = await response.json()
  return {
    main: { enabled: main?.enabled, fiberPhase: main?.fiberPhase },
    mainAgent: { available: mainAgent?.agentAvailable, running: mainAgent?.running },
    voice: { enabled: voice?.enabled, fiberPhase: voice?.fiberPhase },
    state: { enabled: state.enabled, credentialConfigured: state.credentialConfigured, callId: state.callId,
      connection: state.connection, generation: state.generation, capture: state.capture, playback: state.playback, errorCode: state.errorCode },
  }
}

const processBefore = await processIdentity()
const before = await runtime()
if (before.main.enabled !== true || before.main.fiberPhase !== 'active' || before.mainAgent.available !== true) throw new Error('Main runtime is not healthy')
if (before.voice.enabled !== true || before.voice.fiberPhase !== 'active') throw new Error('Voice owner is not active')
if (before.state.callId !== null || before.state.connection !== 'idle' || before.state.capture !== 'inactive') throw new Error('An active or unresolved call blocks reload')

const transitions = []
let disabled = false
try {
  const stopping = await rpc('pluginManager/setBundleEnabled', { name: target, enabled: false })
  disabled = true
  transitions.push({ enabled: false, application: stopping.application, changed: stopping.changed, errorCode: stopping.error?.code ?? null })
  if (stopping.application !== 'applied') throw new Error('Voice disable was not applied')
  const starting = await rpc('pluginManager/setBundleEnabled', { name: target, enabled: true })
  disabled = false
  transitions.push({ enabled: true, application: starting.application, changed: starting.changed, errorCode: starting.error?.code ?? null })
  if (starting.application !== 'applied') throw new Error('Voice enable was not applied')
} finally {
  if (disabled) {
    try { await rpc('pluginManager/setBundleEnabled', { name: target, enabled: true }) }
    catch (error) { console.error('Voice owner rollback enable failed:', error instanceof Error ? error.message : 'unknown error') }
  }
}

const after = await runtime()
const processAfter = await processIdentity()
if (after.main.enabled !== true || after.main.fiberPhase !== 'active' || after.mainAgent.available !== true
  || after.voice.enabled !== true || after.voice.fiberPhase !== 'active' || after.state.enabled !== true
  || after.state.callId !== null || after.state.connection !== 'idle' || JSON.stringify(processBefore) !== JSON.stringify(processAfter)) {
  console.log(JSON.stringify({ ok: false, transitions, processBefore, processAfter, before, after }))
  process.exitCode = 1
} else {
  console.log(JSON.stringify({ ok: true, transitions, sameProcess: true, before, after }))
}

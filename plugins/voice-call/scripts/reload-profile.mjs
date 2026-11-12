/** Native whole-profile coordination, guarded by an explicit owner-handoff snapshot. */
import { readFile, readdir, stat, readlink, writeFile, open } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'

const root = '/home/ayerelysia/Elysia/Elysium/Elysia-Harness'
const origin = 'http://127.0.0.1:3299'
const logPath = '/home/ayerelysia/Elysia/DataInfra/logs/elyharn-web.log'
const profile = `${root}/homes/web/profiles/web`
const target = '@elysia/voice-call'
const exec = promisify(execFile)
const mode = process.argv[2]
const baselinePath = process.argv[3]
const coordinationRef = process.argv[4]
const buildParentPath = process.argv[5]
if (!['--capture', '--reconcile-once'].includes(mode) || !baselinePath?.startsWith('/tmp/voice-reload-baseline-')
  || !coordinationRef || !/^[A-Za-z0-9_:/+.-]{1,180}$/u.test(coordinationRef)) throw new Error('Explicit snapshot path and owner coordination reference are required')

const hashFile = async path => createHash('sha256').update(await readFile(path)).digest('hex')
async function profileHashes() {
  return Object.fromEntries(await Promise.all(['package.json', 'cordis.patch.yml', 'pnpm-lock.yaml']
    .map(async name => [name, await hashFile(join(profile, name))])))
}
async function sourceFingerprint() {
  const rows = []
  async function visit(directory) {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue
      const path = join(directory, entry.name)
      if (path === `${root}/plugins/voice-call`) continue
      if (entry.isDirectory()) await visit(path)
      else if (entry.isFile() && /\.(?:[cm]?js|tsx?)$/u.test(entry.name)) {
        const value = await stat(path)
        rows.push([path, value.ino, value.size, value.mtimeMs])
      }
    }
  }
  for (const relative of ['plugins', 'dsh/packages', 'dsh/vendor', 'dsh/apps/cli/src']) await visit(join(root, relative))
  return { files: rows.length, fingerprint: createHash('sha256').update(JSON.stringify(rows)).digest('hex') }
}
async function voiceRuntimeHashes() {
  const files = []
  async function visit(directory) {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await visit(path)
      else if (entry.isFile() && /\.(?:[cm]?js|tsx?)$/u.test(entry.name)) files.push(path)
    }
  }
  for (const name of ['src', 'tests', 'scripts']) await visit(`${root}/plugins/voice-call/${name}`)
  for (const entry of await readdir(`${root}/plugins/voice-call`, { withFileTypes: true })) {
    if (entry.isFile() && /^(?:package\.json|cordis\.patch\.yml|build\.mjs|tsconfig[^/]*\.json)$/u.test(entry.name)) files.push(`${root}/plugins/voice-call/${entry.name}`)
  }
  files.push(`${root}/plugins/voice-call/lib/client.js`)
  const hashes = Object.fromEntries(await Promise.all(files.sort().map(async path => [path.slice(root.length + 1), await hashFile(path)])))
  const index = await readFile(`${root}/plugins/voice-call/src/index.ts`, 'utf8')
  if (!/^export const inject = \[[^\n]*['"]tools['"]/mu.test(index)) throw new Error('Voice owner lost required tools injection; refusing coordination')
  return { files: files.length, hashes }
}
const exceptBuiltClient = snapshot => Object.fromEntries(Object.entries(snapshot.hashes).filter(([path]) => path !== 'plugins/voice-call/lib/client.js'))
async function closedCallEvidence(callId) {
  const directory = `${root}/homes/web/storages/elysia_voice_infrastructure/events`
  const records = []
  for (const name of await readdir(directory)) {
    if (!name.endsWith('.json')) continue
    const record = JSON.parse(await readFile(join(directory, name), 'utf8')).record
    if (record?.actor === 'infrastructure' && record.source === 'elysia-voice-call/controller' && record.callId === callId) records.push(record)
  }
  records.sort((a, b) => a.at - b.at)
  const last = records.at(-1)
  if (last?.type !== 'call-ended') return null
  return { callId, endedAt: last.at, cleanupFailed: last.details?.cleanupFailed,
    agentRegistered: last.details?.agentRegistered, providerCreated: last.details?.providerCreated,
    providerHangupConfirmed: last.details?.providerHangupConfirmed }
}
async function processIdentity() {
  const lines = (await exec('ss', ['-lntp'])).stdout.split('\n').filter(line => line.includes('127.0.0.1:3299'))
  const pid = Number(lines.length === 1 ? lines[0].match(/pid=(\d+)/u)?.[1] : NaN)
  if (!Number.isSafeInteger(pid) || await readlink(`/proc/${pid}/cwd`) !== `${root}/dsh`) throw new Error('Web process owner is unavailable')
  const starttime = (await readFile(`/proc/${pid}/stat`, 'utf8')).split(') ').at(-1)?.split(' ')[19]
  return { pid, starttime }
}
// Reuse the existing set-credential.mjs local operator-token -> cookie handoff.
// It does not resolve or read an OpenAI credential, and never prints auth data.
const log = await readFile(logPath, 'utf8')
const token = [...log.matchAll(/http:\/\/127\.0\.0\.1:3299\/\?token=([A-Za-z0-9_-]+)/gu)].at(-1)?.[1]
if (!token) throw new Error('Local operator access is unavailable')
const connected = await fetch(`${origin}/connect?token=${encodeURIComponent(token)}&interactions=none`, { redirect: 'manual', signal: AbortSignal.timeout(10000) })
const cookie = connected.headers.get('set-cookie')?.split(';', 1)[0]
if (connected.status !== 302 || !cookie) throw new Error('Local operator authentication failed')
async function rpc(method, args) {
  const rpcId = randomUUID()
  const response = await fetch(`${origin}/api/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ type: 'client-request', rpcId, method, payload: { args } }),
    signal: AbortSignal.timeout(method === 'pluginManager/setBundleEnabled' ? 90000 : 10000),
  })
  if (!response.ok) throw new Error(`Native management HTTP ${response.status}`)
  const envelope = await response.json()
  if (envelope.rpcId !== rpcId || envelope.result?.ok !== true) throw new Error('Native management rejected the operation')
  return envelope.result.value
}
async function runtimeMetadata() {
  const rows = await rpc('pluginManager/listPlugins', {})
  const main = rows.find(row => row.moduleName === '@elysia/conscious-mind')
  const voice = rows.find(row => row.moduleName === target)
  const listed = await rpc('session/list', { _request: {} })
  const agent = listed.items?.find(item => item.sessionId === 'elysia-conscious-mind')
  const voiceAgent = listed.items?.find(item => item.sessionId === 'elysia-voice-call')
  const stateResponse = await fetch(`${origin}/api/voice-call/state`, { headers: { cookie }, signal: AbortSignal.timeout(10000) })
  if (!stateResponse.ok) throw new Error('Voice state is unavailable')
  const value = await stateResponse.json()
  return {
    main: main ? { entryId: main.entryId, enabled: main.enabled, phaseExposed: Object.hasOwn(main, 'fiberPhase'), fiberPhase: main.fiberPhase } : null,
    voice: voice ? { entryId: voice.entryId, enabled: voice.enabled, fiberPhase: voice.fiberPhase } : null,
    mainAgent: agent ? { sessionId: agent.sessionId, available: agent.agentAvailable, running: agent.running } : null,
    voiceAgent: voiceAgent ? { sessionId: voiceAgent.sessionId, available: voiceAgent.agentAvailable, running: voiceAgent.running } : null,
    closedCallEvidence: ['ended', 'failed'].includes(value.connection) && typeof value.callId === 'string' ? await closedCallEvidence(value.callId) : null,
    voiceState: { enabled: value.enabled, credentialConfigured: value.credentialConfigured, callId: value.callId,
      connection: value.connection, generation: value.generation, capture: value.capture, playback: value.playback, errorCode: value.errorCode },
  }
}
function requireIdleVoiceAndLiveMain(runtime) {
  if (runtime.main?.enabled !== true || runtime.mainAgent?.available !== true
    || (runtime.main.phaseExposed && runtime.main.fiberPhase !== 'active')) throw new Error('Main runtime is not healthy')
  const idle = runtime.voiceState.callId === null && runtime.voiceState.connection === 'idle'
    && runtime.voiceAgent?.available !== true
  const evidence = runtime.closedCallEvidence
  const inactiveClosed = ['ended', 'failed'].includes(runtime.voiceState.connection) && runtime.voiceState.capture === 'inactive'
    && runtime.voiceState.errorCode !== 'cleanup_failed'
    && runtime.voiceState.generation === 'idle' && ['stopped', 'idle'].includes(runtime.voiceState.playback)
    && runtime.voiceAgent?.available !== true && evidence?.callId === runtime.voiceState.callId
    && evidence.cleanupFailed === false && evidence.agentRegistered === false
    && (evidence.providerCreated === false || evidence.providerHangupConfirmed === true)
  if (runtime.voice?.fiberPhase !== 'active' || (!idle && !inactiveClosed)) {
    console.log(JSON.stringify({ refused: true, preconditionRuntime: runtime }))
    throw new Error('Voice has no proven inactive/closed owner; coordination refused')
  }
}
if (mode === '--capture') {
  const runtime = await runtimeMetadata()
  requireIdleVoiceAndLiveMain(runtime)
  const logStat = await stat(logPath)
  const baseline = { version: 1, kind: 'voice-native-profile-coordination', capturedAt: Date.now(),
    provenance: { coordinationRef, authority: 'root-relayed-ElyHarn-owner-confirmation',
      assertion: 'pass.ts loaded in current Web; owner reports no pending source/profile changes and no further service reloads',
      scope: 'one native whole-profile reconcile; no process restart, main cancellation, audio or cloud API calls' },
    process: await processIdentity(), nonVoiceSource: await sourceFingerprint(), voiceRuntime: await voiceRuntimeHashes(), profile: await profileHashes(),
    runtime, log: { inode: logStat.ino, size: logStat.size } }
  if (buildParentPath) {
    const parent = JSON.parse(await readFile(buildParentPath, 'utf8'))
    if (parent.provenance?.coordinationRef !== coordinationRef || JSON.stringify(parent.process) !== JSON.stringify(baseline.process)
      || JSON.stringify(parent.nonVoiceSource) !== JSON.stringify(baseline.nonVoiceSource) || JSON.stringify(parent.profile) !== JSON.stringify(baseline.profile)
      || JSON.stringify(exceptBuiltClient(parent.voiceRuntime)) !== JSON.stringify(exceptBuiltClient(baseline.voiceRuntime))) {
      throw new Error('Source/profile changed while tests/build ran; new snapshot refused')
    }
    baseline.buildTransition = { parent: buildParentPath, allowedChangedFile: 'plugins/voice-call/lib/client.js', sourceBytesUnchanged: true }
  }
  await writeFile(baselinePath, JSON.stringify(baseline, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  console.log(JSON.stringify({ captured: true, baselinePath, provenance: baseline.provenance, process: baseline.process,
    nonVoiceSource: baseline.nonVoiceSource, voiceRuntime: baseline.voiceRuntime, profile: baseline.profile, runtime }))
} else {
  const baseline = JSON.parse(await readFile(baselinePath, 'utf8'))
  if (baseline.kind !== 'voice-native-profile-coordination' || baseline.provenance?.coordinationRef !== coordinationRef) throw new Error('Coordination provenance mismatch')
  if (!baseline.voiceRuntime) throw new Error('Snapshot predates voice source guards; preserve it and capture a new distinct baseline')
  const before = await runtimeMetadata()
  requireIdleVoiceAndLiveMain(before)
  if (before.mainAgent?.running !== false) throw new Error('Main Agent is working; coordination refused')
  if (JSON.stringify(await processIdentity()) !== JSON.stringify(baseline.process)
    || JSON.stringify(await sourceFingerprint()) !== JSON.stringify(baseline.nonVoiceSource)
    || JSON.stringify(await voiceRuntimeHashes()) !== JSON.stringify(baseline.voiceRuntime)
    || JSON.stringify(await profileHashes()) !== JSON.stringify(baseline.profile)) throw new Error('Read-only coordination baseline changed; no write was made')
  const finalCheck = await runtimeMetadata()
  requireIdleVoiceAndLiveMain(finalCheck)
  if (finalCheck.mainAgent?.running !== false || JSON.stringify(await processIdentity()) !== JSON.stringify(baseline.process)) {
    throw new Error('Main Agent or Web process changed before coordination; no write was made')
  }
  await writeFile(`${baselinePath}.attempted`, JSON.stringify({ at: Date.now(), coordinationRef }) + '\n', { flag: 'wx', mode: 0o600 })
  const result = await rpc('pluginManager/setBundleEnabled', { name: target, enabled: true })
  const after = await runtimeMetadata()
  const processAfter = await processIdentity()
  const sourceAfter = await sourceFingerprint()
  const voiceAfter = await voiceRuntimeHashes()
  const profileAfter = await profileHashes()
  const logNow = await stat(logPath)
  const lifecycle = []
  let lifecycleLogComplete = logNow.ino === baseline.log.inode && logNow.size >= baseline.log.size && logNow.size - baseline.log.size <= 1024 * 1024
  if (lifecycleLogComplete) {
    const file = await open(logPath, 'r')
    try {
      const buffer = Buffer.alloc(logNow.size - baseline.log.size)
      await file.read(buffer, 0, buffer.length, baseline.log.size)
      for (const raw of buffer.toString('utf8').split('\n')) {
        const line = raw.replace(/\x1b\[[0-9;]*m/gu, '')
        const event = line.match(/\b(apply|reload|unload) plugin\s+[`'"]?(@[a-z0-9_-]+\/[a-z0-9_-]+)/iu)
        if (event) lifecycle.push({ event: event[1], module: event[2] })
      }
    } finally { await file.close() }
  }
  const sameProcess = JSON.stringify(processAfter) === JSON.stringify(baseline.process)
  const nonVoiceSourceUnchanged = JSON.stringify(sourceAfter) === JSON.stringify(baseline.nonVoiceSource)
  const voiceRuntimeUnchanged = JSON.stringify(voiceAfter) === JSON.stringify(baseline.voiceRuntime)
  const profileUnchanged = JSON.stringify(profileAfter) === JSON.stringify(baseline.profile)
  console.log(JSON.stringify({ api: 'native whole-profile reconcile; not a targeted reload API', writes: 1,
    application: result.application, changed: result.changed, restartReason: result.restartReason ?? null,
    errorCode: result.error?.code ?? null, warningCount: result.warnings?.length ?? 0,
    pendingExposed: Array.isArray(result.pending), pendingCount: Array.isArray(result.pending) ? result.pending.length : null,
    sameProcess, processBefore: baseline.process, processAfter, nonVoiceSourceUnchanged, voiceRuntimeUnchanged, profileUnchanged,
    lockUnchanged: profileAfter['pnpm-lock.yaml'] === baseline.profile['pnpm-lock.yaml'], before, after,
    lifecycleLogComplete, lifecycle, mainReloadLogEvents: lifecycle.filter(event => event.module === '@elysia/conscious-mind').length,
    voiceReloadLogEvents: lifecycle.filter(event => event.module === target).length,
    evidenceLimit: 'Native result has no module/entry reload list or fiber identity; lifecycle lines are positive evidence, absence is not a mathematical guarantee' }))
  if (result.application !== 'applied' || !sameProcess || !nonVoiceSourceUnchanged || !voiceRuntimeUnchanged || !profileUnchanged
    || after.mainAgent?.available !== true || after.main?.fiberPhase !== 'active' || after.voice?.fiberPhase !== 'active') process.exitCode = 1
}

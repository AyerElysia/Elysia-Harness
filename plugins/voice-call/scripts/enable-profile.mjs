/** Operator-only native profile activation; never reads an API credential or subject content. */
import { readFile, readlink, realpath, readdir, stat } from 'node:fs/promises'
import { randomUUID, createHash } from 'node:crypto'
import { join } from 'node:path'

const root = '/home/ayerelysia/Elysia/Elysium/Elysia-Harness'
const origin = 'http://127.0.0.1:3299'
const target = '@elysia/voice-call'
const baseline = JSON.parse(await readFile('/tmp/voice-stage-baseline.json', 'utf8'))
const expectedPid = baseline.pid
const enabling = process.argv.includes('--enable')
if (!enabling && !process.argv.includes('--check')) throw new Error('Use --check or --enable explicitly')
const processIdentity = async () => ({
  cwd: await readlink(`/proc/${expectedPid}/cwd`),
  stat: (await readFile(`/proc/${expectedPid}/stat`, 'utf8')).split(') ').at(-1)?.split(' ')[19],
})
const beforeProcess = await processIdentity()
if (beforeProcess.cwd !== `${root}/dsh` || beforeProcess.stat !== baseline.starttime) throw new Error('Expected Web owner is unavailable')
const digest = async path => createHash('sha256').update(await readFile(path)).digest('hex')
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
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex')
}
if (await sourceFingerprint() !== baseline.sourceFingerprint) throw new Error('Unrelated runtime source changed after handoff snapshot')
for (const [name, expected] of Object.entries(baseline.profileAfter)) {
  if (await digest(`${root}/homes/web/profiles/web/${name}`) !== expected) throw new Error('Profile changed after staging')
}
const profile = JSON.parse(await readFile(`${root}/homes/web/profiles/web/package.json`, 'utf8'))
if (profile.dependencies?.[target] !== 'file:../../../../plugins/voice-call') throw new Error('Exact profile dependency is missing')
if (await realpath(`${root}/homes/web/profiles/web/node_modules/@elysia/voice-call`) !== `${root}/plugins/voice-call`) {
  throw new Error('Profile plugin link does not resolve to the approved checkout')
}
if (enabling && profile.dsh?.profile?.bundles?.includes(target)) throw new Error('Bundle was selected before native activation')

// Same operator-token -> cookie handoff already used by set-credential.mjs.
// Nothing from this log, cookie, headers or response bodies is printed.
const log = await readFile('/home/ayerelysia/Elysia/DataInfra/logs/elyharn-web.log', 'utf8')
const token = [...log.matchAll(/http:\/\/127\.0\.0\.1:3299\/\?token=([A-Za-z0-9_-]+)/gu)].at(-1)?.[1]
if (!token) throw new Error('Current local operator access is unavailable')
const connected = await fetch(`${origin}/connect?token=${encodeURIComponent(token)}&interactions=none`, {
  redirect: 'manual', signal: AbortSignal.timeout(10000),
})
const cookie = connected.headers.get('set-cookie')?.split(';', 1)[0]
if (connected.status !== 302 || !cookie) throw new Error('Local operator authentication failed')
async function rpc(method, args) {
  const rpcId = randomUUID()
  const response = await fetch(`${origin}/api/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ type: 'client-request', rpcId, method, payload: { args } }),
    signal: AbortSignal.timeout(enabling ? 90000 : 10000),
  })
  if (!response.ok) throw new Error(`Native plugin operation HTTP ${response.status}`)
  const envelope = await response.json()
  if (envelope.rpcId !== rpcId || envelope.result?.ok !== true) throw new Error('Native plugin operation rejected')
  return envelope.result.value
}
const before = await rpc('pluginManager/listPlugins', {})
const mainBefore = before.find(row => row.moduleName === '@elysia/conscious-mind')
if (!mainBefore || (Object.hasOwn(mainBefore, 'fiberPhase') && mainBefore.fiberPhase !== 'active')) throw new Error('Main consciousness plugin is not active')
const mainSessionsBefore = await rpc('session/list', { _request: {} })
const mainSessionBefore = mainSessionsBefore.items?.find(item => item.sessionId === 'elysia-conscious-mind')
if (mainSessionBefore?.agentAvailable !== true) throw new Error('Main consciousness Agent is not available')
const result = enabling ? await rpc('pluginManager/setBundleEnabled', { name: target, enabled: true }) : undefined
const after = await rpc('pluginManager/listPlugins', {})
const voice = after.find(row => row.moduleName === target)
const mainAfter = after.find(row => row.entryId === mainBefore.entryId)
const mainSessionsAfter = await rpc('session/list', { _request: {} })
const mainSessionAfter = mainSessionsAfter.items?.find(item => item.sessionId === 'elysia-conscious-mind')
const afterProcess = await processIdentity()
const sameProcess = beforeProcess.cwd === afterProcess.cwd && beforeProcess.stat === afterProcess.stat
let state
if (voice?.fiberPhase === 'active') {
  const response = await fetch(`${origin}/api/voice-call/state`, { headers: { cookie }, signal: AbortSignal.timeout(10000) })
  if (response.ok) {
    const actual = await response.json()
    state = { enabled: actual.enabled, credentialConfigured: actual.credentialConfigured,
      connection: actual.connection, sessionId: actual.sessionId, rawAudioRecorded: actual.rawAudioRecorded }
  } else state = { httpStatus: response.status }
}
console.log(JSON.stringify({
  mode: enabling ? 'enable' : 'check', pid: expectedPid, sameProcess,
  ...(result ? { changed: result.changed, application: result.application,
    restartReason: result.restartReason ?? null, errorCode: result.error?.code ?? null,
    pendingExposed: Array.isArray(result.pending), pendingCount: Array.isArray(result.pending) ? result.pending.length : null,
    warningCount: Array.isArray(result.warnings) ? result.warnings.length : 0 } : {}),
  voiceActive: voice?.fiberPhase === 'active', mainActive: mainAfter?.fiberPhase === 'active',
  mainAgentBefore: { sessionId: mainSessionBefore.sessionId, available: mainSessionBefore.agentAvailable, running: mainSessionBefore.running },
  mainAgentAfter: mainSessionAfter ? { sessionId: mainSessionAfter.sessionId, available: mainSessionAfter.agentAvailable, running: mainSessionAfter.running } : null,
  lockUnchanged: await digest(`${root}/homes/web/profiles/web/pnpm-lock.yaml`) === baseline.profileAfter['pnpm-lock.yaml'],
  unrelatedSourceUnchanged: await sourceFingerprint() === baseline.sourceFingerprint,
  mainReloadEvidence: 'No public fiber-identity/preview endpoint; compare stable process and live identity/status only',
  state: state ?? null,
}))
if (!sameProcess || mainAfter?.fiberPhase !== 'active' || mainSessionAfter?.agentAvailable !== true) throw new Error('Runtime owner/state changed during activation')
if (enabling && (result?.application !== 'applied' || voice?.fiberPhase !== 'active' || state?.enabled !== true)) {
  throw new Error('Native voice activation did not reach the requested active state')
}

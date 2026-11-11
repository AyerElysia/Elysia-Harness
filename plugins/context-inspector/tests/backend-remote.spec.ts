import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import RemoteAccessService, { type RemoteAccessBinding } from '@deepseek-ai/dsh-api-remote-access'
import Gateway from '@deepseek-ai/dsh-api-gateway'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import { Peer } from '@deepseek-ai/dsh-client-connection'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { RequestArchiveIndex } from '@elysia/request-archive/index-store'
import { afterEach, describe, expect, it } from 'vitest'
import * as Inspector from '../src/index.ts'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface PrincipalMap {
    'context-fixture': { kind: 'context-fixture'; id: string }
  }
}
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'elysia-inspector-remote-'))
  const ctx = new Context()
  cleanups.push(async () => { await ctx.fiber.dispose(); await rm(dir, { recursive: true, force: true }) })
  await ctx.plugin(TypertRegistry)
  await ctx.plugin(RemoteAccessService)
  await ctx.plugin(Gateway)
  await ctx.plugin(SessionProjections)
  ctx.typert.resources.register('session', { field: 'sessionId' })
  ctx.provide('sessionController', {})
  const mounted = await ctx.plugin(Inspector, { dir, metrics: { tokenizerEnabled: false } })
  const raw = JSON.stringify({
    id: 'remote-fixture', recordedAt: '2026-11-09T00:00:00.000Z', loop: true,
    request: { sessionId: 'allowed', provider: 'fixture', model: 'fixture', messages: [], tools: [] },
  })
  await writeFile(join(dir, 'remote-fixture.json'), raw)
  await new RequestArchiveIndex(dir).record({
    version: 1, sessionId: 'allowed', requestId: 'remote-fixture', fileName: 'remote-fixture.json',
    recordedAt: '2026-11-09T00:00:00.000Z', bytes: Buffer.byteLength(raw),
  })
  let bindings: readonly RemoteAccessBinding[] = []
  ctx.remoteAccess.registerPolicy('context-fixture', { bindings: () => bindings })
  const guest = new Peer(ctx, { principal: { kind: 'context-fixture', id: 'reader' } })
  const owner = new Peer(ctx, { principal: { kind: 'owner' } })
  const grant = (id: string): void => {
    bindings = [{
      role: { name: 'fixture-reader', resource: 'session', actions: ['contextInspector/latest', 'contextInspector/read'] },
      resource: { kind: 'session', id: id as SessionId },
    }]
  }
  const call = (peer: Peer, method: string, request: object) => ctx.typertGateway.invoke({
    peer, namespace: 'contextInspector', method, args: { request },
  })
  return { ctx, mounted, guest, owner, grant, call, dir }
}

describe('contextInspector native Remote access', () => {
  it('permits the authenticated owner through the existing Gateway', async () => {
    const { owner, call } = await setup()
    const value = await call(owner, 'latest', { sessionId: 'allowed' })
    expect(value).toMatchObject({ request: { requestId: 'remote-fixture', sessionId: 'allowed' } })
  })
  it('denies ungranted and different-session reads before inspecting archives', async () => {
    const { guest, grant, call } = await setup()
    await expect(call(guest, 'latest', { sessionId: 'allowed' })).rejects.toMatchObject({ code: 'remote-access/denied' })
    grant('allowed')
    expect(await call(guest, 'latest', { sessionId: 'allowed' })).toMatchObject({ request: { sessionId: 'allowed' } })
    await expect(call(guest, 'read', { sessionId: 'other', requestId: 'remote-fixture', section: 'raw', offset: 0 })).rejects.toMatchObject({ code: 'remote-access/denied' })
    await expect(call(guest, 'latest', {})).rejects.toMatchObject({ code: 'remote-access/denied' })
  })
  it('unmounts only the inspector and disposes its reader/cache', async () => {
    const { ctx, mounted, owner, call, dir } = await setup()
    await call(owner, 'latest', { sessionId: 'allowed' })
    const reader = ctx.contextInspector.reader
    const session = Session.create(SessionId('inspector-lifecycle'))
    expect(ctx.sessionProjections.snapshot(session).values.elysiaContextMetrics).toBeDefined()
    await mounted.dispose()
    await expect(reader.latest('allowed', new AbortController().signal)).rejects.toMatchObject({ code: 'disposed' })
    expect(ctx.sessionProjections.snapshot(session).values.elysiaContextMetrics).toBeUndefined()
    const remounted = await ctx.plugin(Inspector, { dir, metrics: { tokenizerEnabled: false } })
    expect(ctx.sessionProjections.snapshot(session).values.elysiaContextMetrics).toBeDefined()
    await remounted.dispose()
    expect(ctx.sessionProjections.snapshot(session).values.elysiaContextMetrics).toBeUndefined()
  })
})

import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  AylaAuth, AylaAuthError, LOGIN_PATH, REFRESH_PATH, RefreshTokenStore, defaultRefreshFile, endpointUrl,
  readTokenExpiry,
} from '../src/auth.ts'
import type { AylaFetch, AylaHttpResponse } from '../src/auth.ts'

const roots: string[] = []

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function store(): Promise<RefreshTokenStore> {
  const root = await mkdtemp(join(tmpdir(), 'ayla-auth-'))
  roots.push(root)
  return new RefreshTokenStore(join(root, 'ayla-app', 'refresh.json'))
}

interface Call {
  url: string
  method: string
  body: unknown
}

function response(status: number, body: unknown): AylaHttpResponse {
  return { ok: status >= 200 && status < 300, status, json: async () => body }
}

/** A fetch double that answers from a scripted list of (path, status, body) rules. */
function scripted(rules: { path: string; status: number; body: unknown }[]): { fetch: AylaFetch; calls: Call[] } {
  const calls: Call[] = []
  const queue = [...rules]
  const fetchImpl: AylaFetch = async (url, init) => {
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body === undefined ? undefined : JSON.parse(init.body) })
    const rule = queue.shift()
    if (rule === undefined) throw new Error('unexpected request: ' + url)
    if (!url.endsWith(rule.path)) throw new Error('unexpected path: ' + url)
    return response(rule.status, rule.body)
  }
  return { fetch: fetchImpl, calls }
}

function auth(fetchImpl: AylaFetch, storeImpl: RefreshTokenStore): AylaAuth {
  return new AylaAuth({
    baseUrl: new URL('http://127.0.0.1:8100'),
    username: 'elysia',
    password: 'secret',
    store: storeImpl,
    fetch: fetchImpl,
  })
}

describe('Ayla login', () => {
  it('exchanges the account password for a token pair', async () => {
    const { fetch: fetchImpl, calls } = scripted([
      { path: LOGIN_PATH, status: 200, body: { access: 'a1', refresh: 'r1' } },
    ])
    const authImpl = auth(fetchImpl, await store())
    await expect(authImpl.login()).resolves.toBe('a1')
    expect(calls).toHaveLength(1)
    expect(calls[0]?.method).toBe('POST')
    expect(calls[0]?.body).toEqual({ username: 'elysia', password: 'secret' })
    expect(authImpl.currentAccess).toBe('a1')
  })

  it('persists the refresh token and nothing else, readable only by its owner', async () => {
    const storeImpl = await store()
    const { fetch: fetchImpl } = scripted([
      { path: LOGIN_PATH, status: 200, body: { access: 'a1', refresh: 'r1' } },
    ])
    await auth(fetchImpl, storeImpl).login()
    const written = await readFile(storeImpl.file, 'utf8')
    expect(JSON.parse(written)).toEqual({ refresh: 'r1' })
    expect(written).not.toContain('a1')
    if (process.platform !== 'win32') {
      const mode = (await stat(storeImpl.file)).mode & 0o777
      expect(mode).toBe(0o600)
    }
  })

  it('names the status code instead of echoing credentials', async () => {
    const { fetch: fetchImpl } = scripted([{ path: LOGIN_PATH, status: 401, body: { detail: 'no' } }])
    const failure = await auth(fetchImpl, await store()).login().catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(AylaAuthError)
    expect((failure as Error).message).toContain('401')
    expect((failure as Error).message).not.toContain('secret')
  })
})

describe('Ayla refresh', () => {
  it('replays one refused request after refreshing, and keeps the rotated refresh', async () => {
    const storeImpl = await store()
    const { fetch: fetchImpl, calls } = scripted([
      { path: LOGIN_PATH, status: 200, body: { access: 'a1', refresh: 'r1' } },
      { path: '/api/v1/media/m1:sign', status: 401, body: { detail: 'expired' } },
      { path: REFRESH_PATH, status: 200, body: { access: 'a2', refresh: 'r2' } },
      { path: '/api/v1/media/m1:sign', status: 200, body: { url: 'https://cdn/m1' } },
    ])
    const authImpl = auth(fetchImpl, storeImpl)
    await expect(authImpl.requestJson('/api/v1/media/m1:sign', { method: 'POST', body: '{}' }))
      .resolves.toEqual({ url: 'https://cdn/m1' })
    expect(calls.map(call => call.url.replace('http://127.0.0.1:8100', '')))
      .toEqual([LOGIN_PATH, '/api/v1/media/m1:sign', REFRESH_PATH, '/api/v1/media/m1:sign'])
    expect(JSON.parse(await readFile(storeImpl.file, 'utf8'))).toEqual({ refresh: 'r2' })
  })

  it('fails loudly when the refresh itself is refused, without looping', async () => {
    const storeImpl = await store()
    const { fetch: fetchImpl, calls } = scripted([
      { path: LOGIN_PATH, status: 200, body: { access: 'a1', refresh: 'r1' } },
      { path: REFRESH_PATH, status: 401, body: { detail: 'blacklisted' } },
    ])
    const authImpl = auth(fetchImpl, storeImpl)
    await authImpl.login()
    await expect(authImpl.refreshOnce()).rejects.toBeInstanceOf(AylaAuthError)
    expect(calls).toHaveLength(2)
  })

  it('shares one rotation between concurrent callers', async () => {
    const storeImpl = await store()
    const { fetch: fetchImpl, calls } = scripted([
      { path: LOGIN_PATH, status: 200, body: { access: 'a1', refresh: 'r1' } },
      { path: REFRESH_PATH, status: 200, body: { access: 'a2', refresh: 'r2' } },
    ])
    const authImpl = auth(fetchImpl, storeImpl)
    await authImpl.login()
    const [first, second] = await Promise.all([authImpl.refreshOnce(), authImpl.refreshOnce()])
    expect([first, second]).toEqual(['a2', 'a2'])
    expect(calls.filter(call => call.url.endsWith(REFRESH_PATH))).toHaveLength(1)
  })

  it('restores a persisted refresh token instead of logging in again', async () => {
    const storeImpl = await store()
    await storeImpl.write('r1')
    const { fetch: fetchImpl, calls } = scripted([
      { path: REFRESH_PATH, status: 200, body: { access: 'a2', refresh: 'r2' } },
    ])
    await expect(auth(fetchImpl, storeImpl).accessToken()).resolves.toBe('a2')
    expect(calls.map(call => call.url.endsWith(REFRESH_PATH))).toEqual([true])
  })

  it('falls back to a password login when the stored refresh token is dead', async () => {
    const storeImpl = await store()
    await storeImpl.write('stale')
    const { fetch: fetchImpl, calls } = scripted([
      { path: REFRESH_PATH, status: 401, body: {} },
      { path: LOGIN_PATH, status: 200, body: { access: 'a9', refresh: 'r9' } },
    ])
    await expect(auth(fetchImpl, storeImpl).accessToken()).resolves.toBe('a9')
    expect(calls).toHaveLength(2)
    expect(JSON.parse(await readFile(storeImpl.file, 'utf8'))).toEqual({ refresh: 'r9' })
  })
})

describe('Ayla access token expiry', () => {
  /** Build an unsigned JWT-shaped token with the given exp (epoch seconds). */
  function jwtWithExp(expSeconds: number): string {
    const payload = Buffer.from(JSON.stringify({ exp: expSeconds }), 'utf8').toString('base64url')
    return 'header.' + payload + '.signature'
  }

  it('reads exp from a JWT, and returns undefined when it cannot', () => {
    expect(readTokenExpiry(jwtWithExp(1_800_000_000))).toBe(1_800_000_000_000)
    // Not a JWT: unknown lifetime, never "expired" — guessing would rotate on
    // every single call.
    expect(readTokenExpiry('a1')).toBeUndefined()
    expect(readTokenExpiry('a.b')).toBeUndefined()
  })

  it('rotates instead of returning a token that already expired', async () => {
    // A cached-but-expired token must never be handed out: every caller would
    // retry with it and be refused, and the socket would loop forever on 4401.
    const past = Math.floor(Date.now() / 1000) - 3600
    const future = Math.floor(Date.now() / 1000) + 3600
    const { fetch: fetchImpl, calls } = scripted([
      { path: LOGIN_PATH, status: 200, body: { access: jwtWithExp(past), refresh: 'r1' } },
      { path: REFRESH_PATH, status: 200, body: { access: jwtWithExp(future) } },
    ])
    const authImpl = auth(fetchImpl, await store())
    await authImpl.login()
    expect(authImpl.currentAccess).toBe(jwtWithExp(past))

    await expect(authImpl.accessToken()).resolves.toBe(jwtWithExp(future))
    expect(calls.map(call => call.path ?? call.url.slice(call.url.indexOf('/api')))).toEqual([
      LOGIN_PATH, REFRESH_PATH,
    ])
  })

  it('reuses a token that is still valid', async () => {
    const future = Math.floor(Date.now() / 1000) + 3600
    const { fetch: fetchImpl } = scripted([
      { path: LOGIN_PATH, status: 200, body: { access: jwtWithExp(future), refresh: 'r1' } },
    ])
    const authImpl = auth(fetchImpl, await store())
    await authImpl.login()
    // No refresh rule is scripted: a second request would throw.
    await expect(authImpl.accessToken()).resolves.toBe(jwtWithExp(future))
  })
})

describe('Ayla endpoint resolution', () => {
  it('keeps a base path prefix, so a mounted backend is not split in half', () => {
    expect(endpointUrl(new URL('http://127.0.0.1:8100'), LOGIN_PATH))
      .toBe('http://127.0.0.1:8100/api/v1/auth/login/')
    expect(endpointUrl(new URL('https://ayla.example/backend/'), REFRESH_PATH))
      .toBe('https://ayla.example/backend/api/v1/auth/refresh/')
  })

  it('drops a query or fragment the operator left on the base URL', () => {
    expect(endpointUrl(new URL('https://ayla.example/?x=1#y'), '/api/v1/media/m1:sign'))
      .toBe('https://ayla.example/api/v1/media/m1:sign')
  })
})

describe('Ayla refresh file location', () => {
  it('lives under the harness home and outside the repository', () => {
    expect(defaultRefreshFile({ DSH_HOME: 'C:/dsh-home' }, 'C:/Users/x'))
      .toBe(join('C:/dsh-home', 'ayla-app', 'refresh.json'))
    expect(defaultRefreshFile({}, 'C:/Users/x')).toBe(join('C:/Users/x', '.dsh', 'ayla-app', 'refresh.json'))
  })

  it('treats a corrupt cache as no token rather than failing the mount', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ayla-auth-'))
    roots.push(root)
    const storeImpl = new RefreshTokenStore(join(root, 'refresh.json'))
    await storeImpl.write('r1')
    await rm(storeImpl.file)
    await expect(storeImpl.read()).resolves.toBeUndefined()
  })
})

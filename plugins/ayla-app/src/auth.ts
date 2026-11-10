/**
 * Ayla account credentials and token rotation.
 *
 * Ayla issues a short-lived access token and a refresh token that rotates on
 * every refresh (ROTATE_REFRESH_TOKENS). The access token stays in memory; the
 * refresh token is the only durable secret and lives in one 0600 file under the
 * harness home, because losing the rotated value logs the account out
 * (REQUIREMENTS.zh.md §6). Nothing here writes a token to a log or an error
 * message: failures name the status code and the endpoint only.
 * @module @elysia/ayla-app/auth
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** One token pair as Ayla returns it. */
export interface AylaTokens {
  access: string
  refresh: string
}

/** The part of an HTTP response this module reads. */
export interface AylaHttpResponse {
  readonly ok: boolean
  readonly status: number
  json(): Promise<unknown>
}

/** Request fields this module sets; the deployment may substitute its own fetch. */
export interface AylaRequestInit {
  method?: string
  headers?: Record<string, string>
  body?: string
}

/** Minimal HTTP client port, satisfied by the global fetch. */
export type AylaFetch = (input: string, init?: AylaRequestInit) => Promise<AylaHttpResponse>

/** Authentication failed for a reason the caller must not retry blindly. */
export class AylaAuthError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message)
    this.name = 'AylaAuthError'
  }
}

/** An HTTP call reached Ayla but was refused. */
export class AylaHttpError extends Error {
  constructor(message: string, readonly status: number, readonly path: string) {
    super(message)
    this.name = 'AylaHttpError'
  }
}

/**
 * Resolve the durable refresh-token file under the harness home.
 * @param env - environment carrying an optional DSH_HOME override.
 * @param home - operating-system home used when DSH_HOME is unset.
 * @returns absolute path of the refresh file.
 */
export function defaultRefreshFile(
  env: Record<string, string | undefined> = process.env,
  home: string = homedir(),
): string {
  const configured = env.DSH_HOME?.trim()
  const root = configured !== undefined && configured.length > 0 ? configured : join(home, '.dsh')
  return join(root, 'ayla-app', 'refresh.json')
}

/**
 * One refresh token on disk.
 *
 * The file holds no access token: an access token that outlives the process
 * would only widen the window in which a copied file is usable.
 */
export class RefreshTokenStore {
  /** @param file - absolute path of the refresh file. */
  constructor(readonly file: string) {}

  /**
   * Read the stored refresh token.
   * @returns the token, or undefined when the file is absent or unreadable as a token.
   */
  async read(): Promise<string | undefined> {
    let raw: string
    try {
      raw = await readFile(this.file, 'utf8')
    } catch (error) {
      // ENOENT is the ordinary first run; anything else is a real failure.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
    let decoded: unknown
    try {
      decoded = JSON.parse(raw)
    } catch {
      // A corrupt cache costs one login, so it is not worth failing the mount.
      return undefined
    }
    if (decoded === null || typeof decoded !== 'object') return undefined
    const refresh = (decoded as { refresh?: unknown }).refresh
    return typeof refresh === 'string' && refresh.length > 0 ? refresh : undefined
  }

  /**
   * Replace the stored refresh token, readable only by this account.
   * @param refresh - the freshly rotated token.
   */
  async write(refresh: string): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 })
    const temporary = this.file + '.tmp'
    await writeFile(temporary, JSON.stringify({ refresh }), { encoding: 'utf8', mode: 0o600 })
    await rename(temporary, this.file)
  }
}

/** Construction inputs for {@link AylaAuth}. */
export interface AylaAuthOptions {
  /** Backend base URL; endpoint paths are resolved against it. */
  baseUrl: URL
  /** Ayla account name. */
  username: string
  /** That account's password. Never logged. */
  password: string
  /** Durable refresh-token file. */
  store: RefreshTokenStore
  /** HTTP port; defaults to the global fetch. */
  fetch?: AylaFetch
}

/** Login path on the Ayla backend. */
export const LOGIN_PATH = '/api/v1/auth/login/'

/** Refresh path on the Ayla backend. */
export const REFRESH_PATH = '/api/v1/auth/refresh/'

/**
 * Resolve one endpoint against the configured base URL, keeping any path
 * prefix the operator put on it.
 *
 * The bridge URL keeps that prefix too, so a backend mounted under
 * `https://host/backend/` gets both its HTTP calls and its socket on the same
 * mount instead of half of them at the origin root.
 * @param baseUrl - configured backend URL.
 * @param path - absolute endpoint path such as `/api/v1/auth/login/`.
 * @returns the full URL.
 */
export function endpointUrl(baseUrl: URL, path: string): string {
  const url = new URL(baseUrl.toString())
  url.pathname = baseUrl.pathname.replace(/\/+$/u, '') + path
  url.search = ''
  url.hash = ''
  return url.toString()
}

function readTokenPair(body: unknown, path: string): AylaTokens {
  if (body === null || typeof body !== 'object') {
    throw new AylaAuthError(`Ayla ${path} 响应不是对象`)
  }
  const access = (body as { access?: unknown }).access
  const refresh = (body as { refresh?: unknown }).refresh
  if (typeof access !== 'string' || access.length === 0) {
    throw new AylaAuthError(`Ayla ${path} 响应缺少 access`)
  }
  if (typeof refresh !== 'string' || refresh.length === 0) {
    throw new AylaAuthError(`Ayla ${path} 响应缺少 refresh`)
  }
  return { access, refresh }
}

/**
 * Account session for one Ayla backend.
 *
 * A refresh is single-flight: concurrent callers share one rotation, because
 * two rotations of the same token would invalidate the one persisted first.
 */
export class AylaAuth {
  private access: string | undefined
  private refresh: string | undefined
  private refreshing: Promise<string> | undefined
  private readonly baseUrl: URL
  private readonly fetchImpl: AylaFetch

  constructor(private readonly options: AylaAuthOptions) {
    this.baseUrl = options.baseUrl
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init))
  }

  /** The access token currently held in memory, if any. */
  get currentAccess(): string | undefined {
    return this.access
  }

  /**
   * Read a usable access token, logging in or refreshing when none is held.
   * @returns the access token.
   */
  async accessToken(): Promise<string> {
    if (this.access !== undefined) return this.access
    return await this.restore()
  }

  /**
   * Exchange the account password for a token pair and persist the refresh.
   * @returns the new access token.
   */
  async login(): Promise<string> {
    const body = await this.post(LOGIN_PATH, {
      username: this.options.username,
      password: this.options.password,
    })
    const tokens = readTokenPair(body, LOGIN_PATH)
    await this.remember(tokens)
    return tokens.access
  }

  /**
   * Rotate the refresh token once.
   *
   * A failure is reported, never retried here: a rejected refresh means the
   * stored credential is gone, and repeating the request cannot restore it.
   * @returns the new access token.
   */
  refreshOnce(): Promise<string> {
    this.refreshing ??= this.rotate().finally(() => {
      this.refreshing = undefined
    })
    return this.refreshing
  }

  /**
   * Call one authenticated JSON endpoint, refreshing once when it is refused.
   * @param path - absolute path on the backend, such as `/api/v1/media/x:sign`.
   * @param init - optional method and JSON body.
   * @returns the decoded JSON body.
   */
  async requestJson(path: string, init: { method?: string; body?: string } = {}): Promise<unknown> {
    let token = await this.accessToken()
    let response = await this.send(path, token, init)
    if (response.status === 401 || response.status === 403) {
      token = await this.refreshOnce()
      response = await this.send(path, token, init)
    }
    if (!response.ok) {
      throw new AylaHttpError(`Ayla ${path} 返回 ${String(response.status)}`, response.status, path)
    }
    return await response.json()
  }

  /** Reuse the stored refresh token when possible, otherwise log in. */
  private async restore(): Promise<string> {
    const stored = this.refresh ?? await this.options.store.read()
    if (stored !== undefined) {
      this.refresh = stored
      try {
        return await this.refreshOnce()
      } catch {
        // A stale or already-rotated token is expected after a manual logout;
        // the password below is the one bounded recovery.
      }
    }
    return await this.login()
  }

  private async rotate(): Promise<string> {
    if (this.refresh === undefined) throw new AylaAuthError('Ayla refresh token 不存在; 需要重新登录')
    const body = await this.post(REFRESH_PATH, { refresh: this.refresh })
    if (body === null || typeof body !== 'object') {
      throw new AylaAuthError(`Ayla ${REFRESH_PATH} 响应不是对象`)
    }
    const access = (body as { access?: unknown }).access
    const rotated = (body as { refresh?: unknown }).refresh
    if (typeof access !== 'string' || access.length === 0) {
      throw new AylaAuthError(`Ayla ${REFRESH_PATH} 响应缺少 access`)
    }
    // ROTATE_REFRESH_TOKENS returns a new refresh; a deployment without it
    // keeps the current one, which must stay persisted unchanged.
    const next = typeof rotated === 'string' && rotated.length > 0 ? rotated : this.refresh
    this.access = access
    if (next !== this.refresh) {
      this.refresh = next
      await this.options.store.write(next)
    }
    return access
  }

  private async remember(tokens: AylaTokens): Promise<void> {
    this.access = tokens.access
    this.refresh = tokens.refresh
    await this.options.store.write(tokens.refresh)
  }

  private send(path: string, token: string, init: { method?: string; body?: string }): Promise<AylaHttpResponse> {
    return this.fetchImpl(endpointUrl(this.baseUrl, path), {
      method: init.method ?? 'GET',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      ...init.body === undefined ? {} : { body: init.body },
    })
  }

  private async post(path: string, body: Record<string, string>): Promise<unknown> {
    const response = await this.fetchImpl(endpointUrl(this.baseUrl, path), {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
    })
    if (!response.ok) {
      throw new AylaAuthError(`Ayla ${path} 返回 ${String(response.status)}`, response.status)
    }
    return await response.json()
  }
}

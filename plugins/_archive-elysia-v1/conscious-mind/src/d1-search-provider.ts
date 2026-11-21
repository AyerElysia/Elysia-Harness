import { WebError } from '@deepseek-ai/dsh-web'
import type {
  WebSearchProvider,
  WebSearchRequest,
  WebSearchResult,
  WebSearchSource,
} from '@deepseek-ai/dsh-web'

export const D1_SEARCH_PROVIDER_ID = 'd1-openai'
export const D1_SEARCH_DEFAULT_BASE_URL = 'https://d1api.xin/v1'
export const D1_SEARCH_DEFAULT_MODEL = 'deepseek-v4.1-flash'
export const D1_SEARCH_DEFAULT_PROTOCOL = 'openai-responses'
export const D1_SEARCH_DEFAULT_MAX_TOKENS = 4096
export const D1_SEARCH_DEFAULT_TIMEOUT_MS = 90_000

export type D1SearchProtocol = 'openai-responses' | 'openai-chat-completions'

export interface D1SearchLlmRequest {
  readonly endpoint: string
  readonly protocol: D1SearchProtocol
  readonly body: Readonly<Record<string, unknown>>
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Secret-free auxiliary D1 request recorded immediately before dispatch. */
    'web/d1-search-llm-request': D1SearchLlmRequest
  }
}

export interface D1SearchProviderOptions {
  readonly resolveApiKey: () => Promise<string | undefined>
  readonly apiKeyEnv: string
  readonly baseURL: string
  readonly model: string
  readonly protocol: D1SearchProtocol
  readonly maxTokens: number
  readonly timeoutMs: number
  readonly recordRequest?: (request: D1SearchLlmRequest) => void
}

interface D1SearchProviderSnapshot {
  readonly resolveApiKey: () => Promise<string | undefined>
  readonly apiKeyEnv: string
  readonly baseURL: string
  readonly model: string
  readonly protocol: D1SearchProtocol
  readonly maxTokens: number
  readonly timeoutMs: number
  readonly recordRequest?: (request: D1SearchLlmRequest) => void
}

/** Convert only structured provider search evidence; never scrape URLs from model prose. */
export function mapD1Response(protocol: D1SearchProtocol, payload: unknown): WebSearchResult {
  if (!isRecord(payload)) throw providerError('D1 returned a non-object response')
  const sources = protocol === 'openai-responses'
    ? responsesSources(payload)
    : chatSources(payload)
  const seen = new Set<string>()
  const normalized: WebSearchSource[] = []
  for (const source of sources) {
    const url = normalizeUrl(source.url)
    if (url === undefined || seen.has(url)) continue
    seen.add(url)
    normalized.push({
      url,
      ...typeof source.title === 'string' && source.title.length > 0 ? { title: source.title } : {},
      ...typeof source.snippet === 'string' && source.snippet.length > 0 ? { snippet: source.snippet } : {},
    })
  }
  if (normalized.length === 0) {
    throw providerError(
      protocol === 'openai-responses'
        ? 'D1 returned no structured web_search_call sources; the upstream may have converted or ignored the native search tool'
        : 'D1 returned no structured search citations; ordinary assistant text is not accepted as search evidence',
    )
  }
  return { sources: normalized, truncated: false }
}

export class D1SearchProvider implements WebSearchProvider {
  readonly id = D1_SEARCH_PROVIDER_ID

  constructor(private readonly resolveOptions: () => D1SearchProviderOptions) {}

  available(): boolean {
    const options = this.resolveOptions()
    return URL.canParse(options.baseURL)
      && options.model.trim().length > 0
      && Number.isInteger(options.maxTokens) && options.maxTokens > 0
      && Number.isInteger(options.timeoutMs) && options.timeoutMs > 0
  }

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    const options: D1SearchProviderSnapshot = { ...this.resolveOptions() }
    const endpoint = `${options.baseURL.replace(/\/+$/u, '')}${options.protocol === 'openai-responses' ? '/responses' : '/chat/completions'}`
    const apiKey = await resolveCredential(options, signal)
    throwIfAborted(signal)
    const body = requestBody(options, request.query)
    options.recordRequest?.({ endpoint, protocol: options.protocol, body })

    const controller = new AbortController()
    let timedOut = false
    const onAbort = () => controller.abort(signal?.reason)
    if (signal?.aborted === true) onAbort()
    else signal?.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort(new Error('D1 search timed out'))
    }, options.timeoutMs)

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        redirect: 'error',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
          accept: 'application/json',
          'user-agent': 'elysia-d1-search/0.1.0',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      if (!response.ok) {
        let detail = ''
        try {
          const payload = await response.json() as unknown
          if (isRecord(payload)) {
            const error = payload.error
            const message = isRecord(error) ? error.message : error ?? payload.message
            if (typeof message === 'string') detail = `: ${redact(message, apiKey)}`
          }
        } catch {
          // HTTP status remains authoritative when the gateway returns a non-JSON error body.
        }
        throw providerError(`D1 API error (HTTP ${response.status})${detail}`)
      }
      const payload = await response.json() as unknown
      return mapD1Response(options.protocol, payload)
    } catch (error) {
      if (signal?.aborted === true) throw new WebError('D1 search aborted', 'WEB_ABORTED', { cause: signal.reason })
      if (error instanceof WebError) throw error
      if (timedOut) throw providerError(`D1 search timed out after ${options.timeoutMs} ms`, error)
      throw providerError(`D1 search request failed: ${redact(String(error), apiKey)}`, error)
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
  }
}

function requestBody(options: D1SearchProviderSnapshot, query: string): Record<string, unknown> {
  const prompt = `Perform a web search for the query: ${query}`
  if (options.protocol === 'openai-responses') {
    return {
      model: options.model,
      input: [{ role: 'user', content: [{ type: 'input_text', text: prompt }] }],
      tools: [{ type: 'web_search' }],
      tool_choice: { type: 'web_search' },
      include: ['web_search_call.action.sources'],
      max_output_tokens: options.maxTokens,
      store: false,
      stream: false,
    }
  }
  return {
    model: options.model,
    messages: [{ role: 'user', content: prompt }],
    web_search_options: { enable: true },
    max_tokens: options.maxTokens,
    stream: false,
  }
}

function responsesSources(payload: Record<string, unknown>): WebSearchSource[] {
  if (!Array.isArray(payload.output)) throw providerError('D1 Responses body has no output array')
  const calls = payload.output.filter(isRecord).filter(item => item.type === 'web_search_call')
  const completed = calls.filter(item => item.status === 'completed')
  if (completed.length === 0) {
    throw providerError('D1 returned no completed web_search_call; a message-only response is not native search')
  }
  const sources: WebSearchSource[] = []
  for (const call of completed) {
    if (!isRecord(call.action) || !Array.isArray(call.action.sources)) continue
    for (const source of call.action.sources.filter(isRecord)) {
      sources.push({
        url: typeof source.url === 'string' ? source.url : '',
        ...typeof source.title === 'string' ? { title: source.title } : {},
      })
    }
  }
  for (const item of payload.output.filter(isRecord)) {
    if (item.type !== 'message' || !Array.isArray(item.content)) continue
    for (const block of item.content.filter(isRecord)) {
      if (block.type !== 'output_text' || !Array.isArray(block.annotations)) continue
      for (const annotation of block.annotations.filter(isRecord)) {
        if (annotation.type !== 'url_citation') continue
        sources.push(annotationSource(annotation))
      }
    }
  }
  return sources
}

function chatSources(payload: Record<string, unknown>): WebSearchSource[] {
  if (!Array.isArray(payload.choices)) throw providerError('D1 Chat Completions body has no choices array')
  const sources: WebSearchSource[] = []
  for (const choice of payload.choices.filter(isRecord)) {
    if (!isRecord(choice.message) || !Array.isArray(choice.message.annotations)) continue
    for (const annotation of choice.message.annotations.filter(isRecord)) {
      if (annotation.type === 'url_citation') sources.push(annotationSource(annotation))
    }
  }
  if (Array.isArray(payload.citations)) {
    for (const citation of payload.citations) {
      if (typeof citation === 'string') sources.push({ url: citation })
      else if (isRecord(citation)) sources.push(annotationSource(citation))
    }
  }
  return sources
}

function annotationSource(annotation: Record<string, unknown>): WebSearchSource {
  const nested = isRecord(annotation.url_citation) ? annotation.url_citation : annotation
  return {
    url: typeof nested.url === 'string' ? nested.url : '',
    ...typeof nested.title === 'string' ? { title: nested.title } : {},
    ...typeof nested.snippet === 'string' ? { snippet: nested.snippet } : {},
  }
}

function normalizeUrl(value: string): string | undefined {
  try {
    const url = new URL(value)
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) return undefined
    return url.href
  } catch {
    return undefined
  }
}

async function resolveCredential(options: D1SearchProviderSnapshot, signal?: AbortSignal): Promise<string> {
  throwIfAborted(signal)
  try {
    const value = await options.resolveApiKey()
    throwIfAborted(signal)
    if (value !== undefined && value.trim().length > 0) return value.trim()
    throw providerError(`D1 search has no API key for "${options.apiKeyEnv}"`)
  } catch (error) {
    if (signal?.aborted === true) throw new WebError('D1 search aborted', 'WEB_ABORTED', { cause: signal.reason })
    if (error instanceof WebError) throw error
    throw providerError(`D1 search credential resolution failed: ${String(error)}`, error)
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) throw new WebError('D1 search aborted', 'WEB_ABORTED', { cause: signal.reason })
}

function providerError(message: string, cause?: unknown): WebError {
  return new WebError(message, 'WEB_PROVIDER_ERROR', cause === undefined ? undefined : { cause })
}

function redact(value: string, secret: string): string {
  return secret.length > 0 ? value.split(secret).join('[redacted]') : value
}

function isRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  D1SearchProvider,
  mapD1Response,
  type D1SearchProviderOptions,
} from '../src/d1-search-provider.ts'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function options(overrides: Partial<D1SearchProviderOptions> = {}): D1SearchProviderOptions {
  return {
    resolveApiKey: async () => 'test-d1-key',
    apiKeyEnv: 'D1API_API_KEY',
    baseURL: 'https://d1api.xin/v1',
    model: 'deepseek-v4.1-flash',
    protocol: 'openai-responses',
    maxTokens: 1024,
    timeoutMs: 1000,
    ...overrides,
  }
}

describe('mapD1Response', () => {
  it('maps completed Responses search calls and citations, deduplicating URLs', () => {
    const result = mapD1Response('openai-responses', {
      output: [
        {
          type: 'web_search_call',
          status: 'completed',
          action: {
            type: 'search',
            sources: [{ type: 'url', url: 'https://example.com', title: 'Example' }],
          },
        },
        {
          type: 'message',
          content: [{
            type: 'output_text',
            text: 'provider prose is not returned',
            annotations: [
              { type: 'url_citation', url: 'https://example.com', title: 'Duplicate' },
              { type: 'url_citation', url: 'https://deepseek.com', title: 'DeepSeek' },
            ],
          }],
        },
      ],
    })
    expect(result).toEqual({
      sources: [
        { url: 'https://example.com/', title: 'Example' },
        { url: 'https://deepseek.com/', title: 'DeepSeek' },
      ],
      truncated: false,
    })
  })

  it('rejects a message-only Responses answer even when it claims to have searched', () => {
    expect(() => mapD1Response('openai-responses', {
      output: [{
        type: 'message',
        content: [{
          type: 'output_text',
          text: 'I searched and found https://deepseek.com',
          annotations: [],
        }],
      }],
    })).toThrowError('no completed web_search_call')
  })

  it('rejects a failed Responses search call instead of using its prose', () => {
    expect(() => mapD1Response('openai-responses', {
      output: [
        { type: 'web_search_call', status: 'failed', action: { sources: [{ url: 'https://example.com' }] } },
        { type: 'message', content: [] },
      ],
    })).toThrowError('no completed web_search_call')
  })

  it('maps structured Chat Completions annotations and top-level citations', () => {
    const result = mapD1Response('openai-chat-completions', {
      choices: [{
        message: {
          role: 'assistant',
          content: 'not returned',
          annotations: [{
            type: 'url_citation',
            url_citation: { url: 'https://example.com/source', title: 'Source' },
          }],
        },
      }],
      citations: ['https://deepseek.com'],
    })
    expect(result.sources).toEqual([
      { url: 'https://example.com/source', title: 'Source' },
      { url: 'https://deepseek.com/' },
    ])
  })

  it('rejects Chat Completions prose without structured search evidence', () => {
    expect(() => mapD1Response('openai-chat-completions', {
      choices: [{ message: { content: 'I searched https://example.com' } }],
    })).toThrowError('no structured search citations')
  })
})

describe('D1SearchProvider', () => {
  it('sends the native Responses tool with the D1 credential and records a secret-free request', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      output: [{
        type: 'web_search_call',
        status: 'completed',
        action: { sources: [{ url: 'https://example.com', title: 'Example' }] },
      }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    const recordRequest = vi.fn()
    const provider = new D1SearchProvider(() => options({ recordRequest }))

    const result = await provider.search({ query: 'DeepSeek official website', maxResults: 3 })
    expect(result.sources[0]?.url).toBe('https://example.com/')
    expect(fetchMock).toHaveBeenCalledOnce()
    const [endpoint, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(endpoint).toBe('https://d1api.xin/v1/responses')
    expect(init.headers).toMatchObject({ authorization: 'Bearer test-d1-key' })
    expect(JSON.parse(String(init.body))).toMatchObject({
      model: 'deepseek-v4.1-flash',
      tools: [{ type: 'web_search' }],
      tool_choice: { type: 'web_search' },
      include: ['web_search_call.action.sources'],
      store: false,
      stream: false,
    })
    expect(JSON.stringify(recordRequest.mock.calls[0])).not.toContain('test-d1-key')
  })

  it('uses the configured Chat Completions operation without fallback', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: 'plain text', annotations: [] } }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    const provider = new D1SearchProvider(() => options({ protocol: 'openai-chat-completions' }))

    await expect(provider.search({ query: 'test' })).rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR' })
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://d1api.xin/v1/chat/completions')
    expect(JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body))).toMatchObject({
      web_search_options: { enable: true },
    })
  })

  it('redacts the credential from upstream HTTP errors', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: { message: 'rejected test-d1-key' },
    }), { status: 401, headers: { 'content-type': 'application/json' } })))
    const provider = new D1SearchProvider(() => options())

    await expect(provider.search({ query: 'test' })).rejects.toThrowError('rejected [redacted]')
  })
})

import { Context } from '@deepseek-ai/cordis'
import WebRuntime from '@deepseek-ai/dsh-web'
import { expect, it, onTestFinished, vi } from 'vitest'
import * as D1Search from '../src/d1-search.ts'

it('registers d1-openai in the existing web seam and resolves the configured credential', async () => {
  const ctx = new Context()
  const previous = process.env.D1_TEST_API_KEY
  process.env.D1_TEST_API_KEY = 'test-credential'
  onTestFinished(async () => {
    if (previous === undefined) delete process.env.D1_TEST_API_KEY
    else process.env.D1_TEST_API_KEY = previous
    vi.unstubAllGlobals()
    await ctx.fiber.dispose()
  })
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
    output: [{
      type: 'web_search_call',
      status: 'completed',
      action: { sources: [{ url: 'https://example.com', title: 'Example' }] },
    }],
  }), { status: 200, headers: { 'content-type': 'application/json' } })))

  await ctx.plugin(WebRuntime, { searchProvider: 'd1-openai' })
  await ctx.plugin(D1Search, { apiKeyEnv: 'D1_TEST_API_KEY' })
  const result = await ctx.web.search({ query: 'example' })

  expect(result.sources).toEqual([{ url: 'https://example.com/', title: 'Example' }])
  expect(vi.mocked(fetch).mock.calls[0]?.[1]?.headers).toMatchObject({
    authorization: 'Bearer test-credential',
  })
})

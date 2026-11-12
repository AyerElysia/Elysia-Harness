import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import { createScope } from '@deepseek-ai/dsh-scope'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import WebRuntime from '@deepseek-ai/dsh-web'
import { expect, it, onTestFinished } from 'vitest'
import * as WebCapabilities from '../src/web-capabilities.ts'

it('runs native web tools only in Elysia scope and removes them on dispose', async () => {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime, { mode: 'native' })
  await ctx.plugin(WebRuntime, { searchProvider: 'fixture-search', fetchProvider: 'fixture-fetch' })

  const queries: string[] = []
  ctx.web.registerSearchProvider({
    id: 'fixture-search',
    available: () => true,
    search: async request => {
      queries.push(request.query)
      return {
        sources: [{ url: `https://example.com/${request.query}`, title: request.query, snippet: 'fixture snippet' }],
        truncated: false,
      }
    },
  })
  ctx.web.registerFetchProvider({
    id: 'fixture-fetch',
    available: () => true,
    fetch: async request => ({
      url: request.url,
      statusCode: 200,
      body: {
        kind: 'html',
        content: '<html><body><script>alert(1)</script><h1>Public page</h1></body></html>',
      },
      truncated: false,
    }),
  })

  const makeAgent = (id: string) => {
    const key = { session: { id } } as unknown as Agent
    const scope = createScope(ctx, key)
    Object.assign(key, { ctx: scope.ctx })
    return { key, scope }
  }
  const elysia = makeAgent('elysia-web-fixture')
  const other = makeAgent('other-web-fixture')
  const otherBefore = ctx.tools.schemas(other.key).map(tool => tool.name)
  expect(ctx.tools.get('web_search')).toBeUndefined()
  expect(ctx.tools.get('web_fetch')).toBeUndefined()

  const mounted = await elysia.scope.ctx.plugin(WebCapabilities)
  expect(ctx.tools.schemas(elysia.key).map(tool => tool.name)).toEqual(expect.arrayContaining(['web_search', 'web_fetch']))
  expect(ctx.tools.schemas(other.key).map(tool => tool.name)).toEqual(otherBefore)
  expect(ctx.tools.get('web_search')).toBeUndefined()
  expect(ctx.tools.get('web_fetch')).toBeUndefined()

  let sequence = 0
  const execute = (name: string, args: unknown) => ctx.tools.execute({
    callId: `web-${++sequence}` as ToolCallId,
    name,
    arguments: args,
    agent: elysia.key,
    signal: new AbortController().signal,
  })
  const searched = await execute('web_search', { queries: ['alpha', 'beta', 'alpha'] })
  expect(searched).toMatchObject({ isError: false })
  expect(queries).toEqual(['alpha', 'beta'])
  expect(JSON.stringify(searched)).toContain('https://example.com/alpha')
  expect(JSON.stringify(searched)).toContain('untrusted data')

  const fetched = await execute('web_fetch', { url: 'https://example.com/page' })
  expect(fetched).toMatchObject({ isError: false })
  expect(JSON.stringify(fetched.content)).toContain('Public page')
  expect(JSON.stringify(fetched.content)).not.toContain('alert(1)')
  // DSH retains the provider's raw value for programmatic consumers; only the
  // sanitized content blocks are presented to the model.
  expect(JSON.stringify(fetched.value)).toContain('alert(1)')

  await mounted.dispose()
  expect(ctx.tools.get('web_search', elysia.key)).toBeUndefined()
  expect(ctx.tools.get('web_fetch', elysia.key)).toBeUndefined()
  expect(ctx.tools.schemas(other.key).map(tool => tool.name)).toEqual(otherBefore)
})

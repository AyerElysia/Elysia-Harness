import type { Context, Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-web'
import {
  D1SearchProvider,
  D1_SEARCH_DEFAULT_BASE_URL,
  D1_SEARCH_DEFAULT_MAX_TOKENS,
  D1_SEARCH_DEFAULT_MODEL,
  D1_SEARCH_DEFAULT_PROTOCOL,
  D1_SEARCH_DEFAULT_TIMEOUT_MS,
} from './d1-search-provider.ts'
import type { D1SearchProtocol } from './d1-search-provider.ts'

export * from './d1-search-provider.ts'

export const name = 'web-search-d1'
export const inject = ['web']

export interface Config {
  /** Credential reference resolved afresh for every search. */
  apiKeyEnv: Volatile<string>
  /** OpenAI-compatible base URL, including `/v1`; the operation path is appended. */
  baseURL: Volatile<string>
  model: Volatile<string>
  protocol: Volatile<D1SearchProtocol>
  maxTokens: Volatile<number>
  timeoutMs: Volatile<number>
}

export const Config = z.object({
  apiKeyEnv: z.string().role('credential-ref').default('D1API_API_KEY').volatile(),
  baseURL: z.string().default(D1_SEARCH_DEFAULT_BASE_URL).volatile(),
  model: z.string().default(D1_SEARCH_DEFAULT_MODEL).volatile(),
  protocol: z.union([
    z.const('openai-responses'),
    z.const('openai-chat-completions'),
  ]).default(D1_SEARCH_DEFAULT_PROTOCOL).volatile(),
  maxTokens: z.number().step(1).min(1).default(D1_SEARCH_DEFAULT_MAX_TOKENS).volatile(),
  timeoutMs: z.number().step(1).min(1).default(D1_SEARCH_DEFAULT_TIMEOUT_MS).volatile(),
})

/** Register the D1 OpenAI protocol adapter without changing the conversation model route. */
export function apply(ctx: Context, config: Config): void {
  ctx.web.registerSearchProvider(new D1SearchProvider(() => {
    const apiKeyEnv = credentialRef(config.apiKeyEnv.get())
    return {
      apiKeyEnv,
      baseURL: config.baseURL.get(),
      model: config.model.get(),
      protocol: config.protocol.get(),
      maxTokens: config.maxTokens.get(),
      timeoutMs: config.timeoutMs.get(),
      resolveApiKey: async () => {
        const credentials = ctx.get('credentials')
        if (credentials !== undefined) return (await credentials.resolve(apiKeyEnv))?.value
        const value = process.env[apiKeyEnv]
        return value !== undefined && value.length > 0 ? value : undefined
      },
      recordRequest: request => {
        ctx.get('agents')?.currentInitiator()?.session.append('web/d1-search-llm-request', request)
      },
    }
  }))
}

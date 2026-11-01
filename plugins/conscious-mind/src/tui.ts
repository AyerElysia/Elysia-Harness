/**
 * Terminal chat with Elysia. Each turn re-assembles the standing-prompt prefix
 * and sends it as the system message. The assistant text is printed here;
 * it is not delivered to QQ, Feishu, or Kook.
 * @module @elysia/conscious-mind/tui
 */

import { Context } from '@deepseek-ai/cordis'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import { createInterface } from 'node:readline'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as ConsciousMind from './index.ts'
import * as StandingPrompt from './standing-prompts.ts'
import { StandingPromptError } from './load.ts'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createScope } from '@deepseek-ai/dsh-scope'
import type { SessionId } from '@deepseek-ai/dsh-session'

/** Standing-prompt directory; `ELYSIA_PROMPTS_DIR` overrides it, else it sits under `ELYSIA_ROOT`. */
const PROMPTS = process.env.ELYSIA_PROMPTS_DIR
  ?? join(process.env.ELYSIA_ROOT ?? '/home/ayerelysia/Elysia', 'Data/standing-prompts')
const MODELS_TOML = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../config/models.toml')
const FILES = ['SOUL.md', 'USER.md', 'MEMORY.md', 'EXISTENCE.md', 'TOOLS.md']

interface ChatConfig {
  baseURL: string
  apiKey: string
  model: string
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

interface TuiContext {
  ctx: Context
  key: Agent
}

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  const value = index === -1 ? undefined : process.argv[index + 1]
  return value === undefined || value.startsWith('--') ? undefined : value
}

function tomlString(section: string, key: string, source: string): string | undefined {
  const body = source.split(/\n(?=\s*\[)/).find(block => block.trimStart().startsWith(`[${section}]`))
  if (body === undefined) return undefined
  const match = new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`, 'm').exec(body)
  return match?.[1]
}

function loadChatConfig(): ChatConfig {
  let baseURL = process.env.ELYSIA_BASE_URL
  let apiKey = process.env.ELYSIA_API_KEY
  const model = argValue('--model') ?? process.env.ELYSIA_MODEL ?? 'gemini-3.8-flash'
  const baseFromArg = argValue('--base-url')
  if (baseFromArg !== undefined) baseURL = baseFromArg
  if (baseURL === undefined || apiKey === undefined) {
    let source = ''
    try {
      source = readFileSync(MODELS_TOML, 'utf8')
    } catch (error) {
      if (baseURL === undefined || apiKey === undefined) {
        throw new StandingPromptError(
          `set ELYSIA_BASE_URL and ELYSIA_API_KEY, or keep ${MODELS_TOML} readable (${error instanceof Error ? error.message : 'unreadable'})`,
        )
      }
    }
    baseURL ??= tomlString('providers.NexusAI', 'base_url', source)
    apiKey ??= tomlString('providers.NexusAI', 'api_key', source)
  }
  if (baseURL === undefined || baseURL.length === 0 || apiKey === undefined || apiKey.length === 0) {
    throw new StandingPromptError('model endpoint is incomplete: need a base URL and an API key')
  }
  return { baseURL: baseURL.replace(/\/+$/, ''), apiKey, model }
}

async function mount(): Promise<TuiContext> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, { includeHarnessIdentity: false, includeRuntimeContext: false })
  await ctx.plugin(ConsciousMind, { baseDir: PROMPTS, files: FILES })
  const key = { id: 'elysia-tui' as SessionId } as Agent
  const scope = createScope(ctx, key)
  await scope.ctx.plugin(StandingPrompt, { baseDir: PROMPTS, files: FILES })
  return { ctx, key }
}

async function prefix(app: TuiContext): Promise<string> {
  return renderPrompt(await app.ctx.systemPrompt.assemble({ scope: app.key }))
}

async function complete(config: ChatConfig, messages: readonly ChatMessage[]): Promise<string> {
  const response = await fetch(`${config.baseURL}/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${config.apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: config.model,
      messages,
      temperature: 0.8,
      stream: true,
    }),
  })
  if (!response.ok) {
    const detail = await response.text()
    throw new Error(`model request failed (${response.status}): ${detail.slice(0, 500)}`)
  }
  const contentType = response.headers.get('content-type') ?? ''
  if (!contentType.includes('text/event-stream') || response.body === null) {
    const body = await response.json() as { choices?: { message?: { content?: string } }[] }
    const text = body.choices?.[0]?.message?.content ?? ''
    process.stdout.write(`\n爱莉> ${text}\n\n`)
    return text
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let pending = ''
  let text = ''
  process.stdout.write('\n爱莉> ')
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    pending += decoder.decode(value, { stream: true })
    const lines = pending.split('\n')
    pending = lines.pop() ?? ''
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('data:')) continue
      const data = trimmed.slice(5).trim()
      if (data === '[DONE]') continue
      const event = JSON.parse(data) as { choices?: { delta?: { content?: string | null } }[] }
      const delta = event.choices?.[0]?.delta?.content
      if (typeof delta !== 'string' || delta.length === 0) continue
      text += delta
      process.stdout.write(delta)
    }
  }
  process.stdout.write('\n\n')
  return text
}

async function turn(app: TuiContext, config: ChatConfig, history: ChatMessage[], input: string): Promise<void> {
  const system = await prefix(app)
  const messages: ChatMessage[] = [{ role: 'system', content: system }, ...history, { role: 'user', content: input }]
  const reply = await complete(config, messages)
  history.push({ role: 'user', content: input }, { role: 'assistant', content: reply })
}

async function main(): Promise<void> {
  const config = loadChatConfig()
  const app = await mount()
  try {
    const system = await prefix(app)
    const once = argValue('--once')
    process.stderr.write(`爱莉  ${config.model}\n前缀 ${PROMPTS}  ${system.length} 字\n终端里看到的是模型正文，还没有发到外部渠道。\n`)
    if (once !== undefined) {
      await turn(app, config, [], once)
      return
    }
    const input = createInterface({ input: process.stdin, output: process.stdout })
    const history: ChatMessage[] = []
    const ask = (): void => { input.setPrompt('你> '); input.prompt() }
    input.on('line', (line) => {
      const text = line.trim()
      if (text === '/quit' || text === '/exit') {
        input.close()
        return
      }
      if (text.length === 0 || text.startsWith('/')) {
        if (text.startsWith('/')) process.stdout.write('可用命令：/quit\n')
        ask()
        return
      }
      input.pause()
      void turn(app, config, history, text).then(() => {
        input.resume()
        ask()
      }).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        process.stderr.write(`\n${message}\n`)
        input.resume()
        ask()
      })
    })
    ask()
    await new Promise<void>((resolveClose) => { input.on('close', () => resolveClose()) })
  } finally {
    await app.ctx.fiber.dispose()
  }
}

if (import.meta.main) {
  await main()
}

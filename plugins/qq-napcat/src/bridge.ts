/**
 * QQ ingress for the conscious mind. Pending and the reply turn live in the
 * conscious-mind plugin. This file only carries NapCat text into that queue.
 */
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as ConsciousMind from '@elysia/conscious-mind'
import { createSendTextTurn } from '@elysia/conscious-mind/turn'
import { defineSendTextTool } from '@elysia/conscious-mind/send-text'
import type { SendTextResult } from '@elysia/conscious-mind/send-text'
import { loadElysiumNapcatConfig } from './config.ts'
import { NapcatLink } from './link.ts'

/** Standing-prompt directory; `ELYSIA_PROMPTS_DIR` overrides it, else it sits under `ELYSIA_ROOT`. */
const PROMPTS = process.env.ELYSIA_PROMPTS_DIR
  ?? join(process.env.ELYSIA_ROOT ?? '/home/ayerelysia/Elysia', 'Data/standing-prompts')
const MODELS_TOML = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../config/models.toml')
const FILES = ['SOUL.md', 'USER.md', 'MEMORY.md', 'EXISTENCE.md', 'TOOLS.md']

function tomlString(section: string, key: string, source: string): string | undefined {
  const body = source.split(/\n(?=\s*\[)/).find(block => block.trimStart().startsWith(`[${section}]`))
  const match = body === undefined ? undefined : new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`, 'm').exec(body)
  return match?.[1]
}

function loadChatConfig(): { baseURL: string; apiKey: string; model: string } {
  const source = readFileSync(MODELS_TOML, 'utf8')
  const baseURL = tomlString('providers.NexusAI', 'base_url', source)
  const apiKey = tomlString('providers.NexusAI', 'api_key', source)
  if (baseURL === undefined || apiKey === undefined) throw new Error('NexusAI 配置不完整')
  return { baseURL: baseURL.replace(/\/+$/, ''), apiKey, model: 'claude-opus-4-6' }
}

const port = Number(process.argv[2] ?? '8097')
const settings = loadElysiumNapcatConfig()
settings.port = port
const chat = loadChatConfig()
const ctx = new Context()
await ctx.plugin(SystemPrompt, { includeHarnessIdentity: false, includeRuntimeContext: false })
await ctx.plugin(ConsciousMind, { baseDir: PROMPTS, files: FILES })
const tool = defineSendTextTool(ctx.outboundText)
ctx.inboundPending.replyWith(createSendTextTurn({
  ...chat,
  parameters: tool.parameters,
  execute: async args => await tool.execute(args, { signal: new AbortController().signal } as never) as SendTextResult,
}, async () => ConsciousMind.loadStandingPrompt(PROMPTS, FILES, ['SOUL.md'])))

const link = new NapcatLink(settings, message => ctx.inboundPending.receive({
  channel: message.channel,
  conversation: message.conversation,
  messageId: message.messageId,
  senderId: message.senderId,
  senderName: message.senderName,
  content: [{ type: 'text', text: message.text }],
}))
ctx.outboundText.register('qq', delivery => link.session.sendText(delivery))
await link.start()
process.stderr.write(`新架构在听 127.0.0.1:${port}\n`)
await link.waitForConnection(45_000)
process.stderr.write('NapCat 已连接\n')
await new Promise(() => {})

/**
 * Acceptance probe for the special-tool face.
 *
 * Run from plugins/villv-helix:
 *   node scripts/verify-unknown-tool.mjs
 *
 * Checks:
 *  - bash and pwsh are part of the special-tool catalog;
 *  - a never-enabled special tool is declared but executes as UNKNOWN_TOOL;
 *  - an enabled special tool is actually usable;
 *  - add/remove notices are queued and only injected at the next pre-step;
 *  - the injected notice is detailed and includes the current face.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  mountAgentLoopTestDependencies, mountAgentLoopTestHarness,
} from '@deepseek-ai/dsh-agent-loop-testkit'
import * as helix from '../lib/index.js'
import { MANAGED_TOOL_IDS } from '../lib/tool-mounts.js'

const stateDir = await mkdtemp(join(tmpdir(), 'villv-helix-special-'))
const ctx = new Context()
await mountAgentLoopTestDependencies(ctx, {
  workingDirectory: true,
  systemPrompt: { personaPrefix: '', personaSuffix: '' },
})
ctx.provide('pluginMarket', { listIndexes: () => [] })
ctx.provide('pluginManager', { listVersionExemptions: () => ({ exemptions: [] }) })
ctx.provide('sandboxPolicy', { resolve: () => ({ mode: 'read-only', approval: 'never' }) })
const harness = await mountAgentLoopTestHarness(ctx)
const fiber = await ctx.plugin(helix, { stateDir })
const agent = await harness.create(SessionId('probe-special-tools'), { provider: 'mock', model: 'mock' })
const signal = new AbortController().signal
const resolve = () => ctx.tools.resolve({
  agent,
  modelSelection: { provider: 'mock', model: 'mock' },
  signal,
})
const execute = async (name, args) => {
  const toolSet = await resolve()
  const batch = await ctx.tools.execute({
    agent,
    signal,
    toolSet,
    calls: [{ type: 'tool-call', id: ToolCallId(`probe-${name}`), name, arguments: JSON.stringify(args) }],
  })
  return batch.results[0]?.result
}
const messages = () => agent.session.snapshotEvents()
  .filter(event => event.type === 'developer/message')

try {
  await ctx.villvHelix.setMode(agent.session.id, true)
  const catalog = [...MANAGED_TOOL_IDS].sort()
  for (const required of ['bash', 'pwsh', 'read', 'glob']) {
    if (!catalog.includes(required)) throw new Error(`catalog is missing ${required}`)
  }

  // Never enabled: declaration present, execution denied.
  if (!ctx.tools.schemas(agent).some(tool => tool.name === 'read')) {
    throw new Error('read declaration is missing before first enable')
  }
  const neverEnabled = await execute('read', { file_path: 'README.md' })
  if (neverEnabled?.error?.info?.code !== 'UNKNOWN_TOOL') {
    throw new Error(`never-enabled read did not fail closed: ${JSON.stringify(neverEnabled)}`)
  }

  // Enable: queued notice, then usable.
  const beforeEnableNotice = messages().length
  await ctx.villvHelix.setTool(agent.session.id, 'read', true)
  if (messages().length !== beforeEnableNotice) {
    throw new Error('enable notice was appended immediately instead of queued')
  }
  await ctx.waterfall('agent/pre-step', {
    agent,
    messages: [],
    turn: 2,
    step: 1,
    signal,
    modelSelection: { provider: 'mock', model: 'mock' },
  }, async () => ({ kind: 'enter', messages: [] }))
  const enableNotice = messages().at(-1)
  const enableText = enableNotice?.type === 'developer/message'
    ? enableNotice.data.message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
    : ''
  if (!enableText.includes('特殊工具面已更新') || !enableText.includes('本轮启用')) {
    throw new Error(`enable notice is not detailed: ${JSON.stringify(enableText)}`)
  }
  const enabledRead = await execute('read', { file_path: 'README.md' })
  if (enabledRead?.isError) {
    throw new Error(`enabled read failed: ${JSON.stringify(enabledRead)}`)
  }

  // Disable: no immediate notice; next pre-step gets a removal + detailed face.
  const beforeRemoveNotice = messages().length
  await ctx.villvHelix.setTool(agent.session.id, 'read', false)
  const immediateRemoval = messages().slice(beforeRemoveNotice).some(event => event.type === 'developer/message'
    && event.data.message.content.some(block => block.type === 'tool-removal' && block.toolName === 'read'))
  if (immediateRemoval) throw new Error('disable notice was appended immediately')
  await ctx.waterfall('agent/pre-step', {
    agent,
    messages: [],
    turn: 3,
    step: 1,
    signal,
    modelSelection: { provider: 'mock', model: 'mock' },
  }, async () => ({ kind: 'enter', messages: [] }))
  const removeMessages = messages().slice(beforeRemoveNotice)
  const removeText = removeMessages
    .flatMap(event => event.type === 'developer/message' ? event.data.message.content : [])
    .flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
  const hasRemoval = removeMessages.some(event => event.type === 'developer/message'
    && event.data.message.content.some(block => block.type === 'tool-removal' && block.toolName === 'read'))
  const disabledRead = await execute('read', { file_path: 'README.md' })

  console.log(JSON.stringify({
    catalog,
    neverEnabledCode: neverEnabled?.error?.info?.code ?? null,
    enabledReadIsError: enabledRead?.isError ?? null,
    enableNoticeDetailed: enableText.includes('特殊工具面已更新') && enableText.includes('本轮启用'),
    immediateDisableNotice: immediateRemoval,
    disableNoticeDetailed: removeText.includes('特殊工具面已更新') && removeText.includes('本轮停用'),
    disableNoticeHasToolRemoval: hasRemoval,
    disabledReadCode: disabledRead?.error?.info?.code ?? null,
  }, null, 2))

  if (disabledRead?.error?.info?.code !== 'UNKNOWN_TOOL') {
    throw new Error(`disabled read did not fail closed: ${JSON.stringify(disabledRead)}`)
  }
  if (!hasRemoval || !removeText.includes('特殊工具面已更新')) {
    throw new Error('removal notice is incomplete')
  }
} finally {
  await fiber.dispose()
  await ctx.fiber.dispose()
  await rm(stateDir, { recursive: true, force: true })
}

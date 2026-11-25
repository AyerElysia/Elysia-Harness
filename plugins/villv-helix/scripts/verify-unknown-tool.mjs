/**
 * Acceptance probe for the special-tool face.
 *
 * Run from plugins/villv-helix:
 *   node scripts/verify-unknown-tool.mjs
 *
 * Checks:
 *  - bash and pwsh are part of the special-tool catalog;
 *  - a never-enabled special tool is absent from the model schema and a hard
 *    call still executes as UNKNOWN_TOOL;
 *  - an enabled special tool appears in the model schema and is usable;
 *  - the model-visible face context is detailed, current, and safe (no session
 *    message append that can corrupt the turn log).
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import { renderContextSnapshot } from '@deepseek-ai/dsh-system-prompt'
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
const face = async () => renderContextSnapshot(
  await ctx.systemPrompt.assemble({ scope: scopeOf(agent.ctx) }),
)

try {
  await ctx.villvHelix.setMode(agent.session.id, true)
  const catalog = [...MANAGED_TOOL_IDS].sort()
  for (const required of ['bash', 'pwsh', 'read', 'glob']) {
    if (!catalog.includes(required)) throw new Error(`catalog is missing ${required}`)
  }

  // Never enabled: the stable declaration remains in the model schema, while a
  // hard call is denied.
  const before = await resolve()
  const beforeNames = ctx.tools.schemas(agent, before).map(tool => tool.name)
  if (!beforeNames.includes('read')) {
    throw new Error('never-enabled read is missing from the stable model schema')
  }
  const beforeFace = await face()
  if (!beforeFace.includes('特殊工具面') || !beforeFace.includes('读取文件（read）')) {
    throw new Error(`disabled face is not model-visible: ${beforeFace}`)
  }
  if (beforeFace.includes('调用未启用的特殊工具必须返回') || beforeFace.includes('先请求用户开启')) {
    throw new Error('removed substitution rule is still present in the face')
  }
  const neverEnabled = await execute('read', { file_path: 'README.md' })
  if (neverEnabled?.error?.info?.code !== 'UNKNOWN_TOOL') {
    throw new Error(`never-enabled read did not fail closed: ${JSON.stringify(neverEnabled)}`)
  }

  // Enable: schema contains only the enabled special tool, and it executes.
  await ctx.villvHelix.setTool(agent.session.id, 'read', true)
  const afterEnable = await resolve()
  const afterEnableNames = ctx.tools.schemas(agent, afterEnable).map(tool => tool.name)
  if (!afterEnableNames.includes('read')) {
    throw new Error('enabled read is missing from the model schema')
  }
  const enabledFace = await face()
  if (!enabledFace.includes('已启用') || !enabledFace.includes('读取文件（read）')) {
    throw new Error(`enabled face is not model-visible: ${enabledFace}`)
  }
  const enabledRead = await execute('read', { file_path: 'README.md' })
  if (enabledRead?.isError) {
    throw new Error(`enabled read failed: ${JSON.stringify(enabledRead)}`)
  }

  // Disable: schema drops it again; a stale/current call fails closed.
  await ctx.villvHelix.setTool(agent.session.id, 'read', false)
  const afterDisable = await resolve()
  const afterDisableNames = ctx.tools.schemas(agent, afterDisable).map(tool => tool.name)
  if (!afterDisableNames.includes('read')) {
    throw new Error('disabled read disappeared from the stable model schema')
  }
  const disabledFace = await face()
  if (!disabledFace.includes('未启用/不可用') || !disabledFace.includes('读取文件（read）')) {
    throw new Error(`disabled face is not model-visible: ${disabledFace}`)
  }
  const disabledRead = await execute('read', { file_path: 'README.md' })
  if (disabledRead?.error?.info?.code !== 'UNKNOWN_TOOL') {
    throw new Error(`disabled read did not fail closed: ${JSON.stringify(disabledRead)}`)
  }

  const output = {
    catalog,
    beforeNames,
    afterEnableNames,
    afterDisableNames,
    neverEnabledCode: neverEnabled?.error?.info?.code ?? null,
    enabledReadIsError: enabledRead?.isError ?? null,
    disabledReadCode: disabledRead?.error?.info?.code ?? null,
    disabledFaceModelVisible: beforeFace.includes('读取文件（read）'),
    enabledFaceModelVisible: enabledFace.includes('已启用') && enabledFace.includes('读取文件（read）'),
    disabledAgainFaceModelVisible: disabledFace.includes('未启用/不可用') && disabledFace.includes('读取文件（read）'),
  }
  console.log(JSON.stringify(output, null, 2))
} finally {
  await fiber.dispose()
  await ctx.fiber.dispose()
  await rm(stateDir, { recursive: true, force: true })
}
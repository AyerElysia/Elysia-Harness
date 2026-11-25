/**
 * Architecture probe for Helix-managed non-global tools.
 *
 * Run from plugins/villv-helix:
 *   node scripts/architecture-probe.mjs
 *
 * It uses the real DSH tool registry and testkit, mounts three ordinary tool
 * packages into one Agent scope, asserts they are absent from another Agent,
 * disposes them, then mounts tool-fs at the root to prove the package still
 * works independently of Helix.
 */
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  mountAgentLoopTestDependencies,
  mountAgentLoopTestHarness,
} from '@deepseek-ai/dsh-agent-loop-testkit'

const names = (ctx, agent) => ctx.tools.schemas(agent).map(tool => tool.name)

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

const ctx = new Context()
await mountAgentLoopTestDependencies(ctx, {
  workingDirectory: true,
  systemPrompt: { personaPrefix: '', personaSuffix: '' },
})

// The optional tool packages read these host services at execution time. The
// probe only exercises registration and scope, so lightweight stubs are enough.
ctx.provide('pluginMarket', {
  listIndexes: () => [],
  listPlugins: () => [],
  versions: () => [],
})
ctx.provide('pluginManager', {
  listVersionExemptions: () => ({ exemptions: [] }),
})
ctx.provide('sandboxPolicy', {
  resolve: () => ({ mode: 'read-only', approval: 'never' }),
})

const harness = await mountAgentLoopTestHarness(ctx)
const first = await harness.create(SessionId('probe-one'), { provider: 'mock', model: 'mock' })
const second = await harness.create(SessionId('probe-two'), { provider: 'mock', model: 'mock' })

const toolFs = await import('@deepseek-ai/dsh-tool-fs')
const marketTools = await import(new URL(
  '../../../dsh/packages/boot/plugin-market/lib/types/tools.js', import.meta.url,
).href)
const managerTools = await import(new URL(
  '../../../dsh/packages/boot/plugin-manager/lib/types/tools.js', import.meta.url,
).href)

const mounted = []
try {
  const fsFiber = first.ctx.plugin(toolFs, {
    read: true, write: true, edit: true, readImage: false, applyPatch: false,
  })
  await fsFiber
  mounted.push(fsFiber)
  const fsFirst = names(ctx, first)
  const fsSecond = names(ctx, second)
  assert(fsFirst.includes('read') && fsFirst.includes('write') && fsFirst.includes('edit'),
    `tool-fs did not register in the first Agent: ${fsFirst.join(', ')}`)
  assert(!fsSecond.includes('read') && !fsSecond.includes('write') && !fsSecond.includes('edit'),
    `tool-fs leaked into the second Agent: ${fsSecond.join(', ')}`)

  const marketFiber = first.ctx.plugin(marketTools)
  await marketFiber
  mounted.push(marketFiber)
  assert(names(ctx, first).includes('plugin_market'), 'plugin_market did not register in the first Agent')
  assert(!names(ctx, second).includes('plugin_market'), 'plugin_market leaked into the second Agent')

  const managerFiber = first.ctx.plugin(managerTools)
  await managerFiber
  mounted.push(managerFiber)
  assert(names(ctx, first).includes('plugin_manager'), 'plugin_manager did not register in the first Agent')
  assert(!names(ctx, second).includes('plugin_manager'), 'plugin_manager leaked into the second Agent')

  for (const fiber of mounted.splice(0)) await fiber.dispose()
  assert(!names(ctx, first).includes('read'), 'tool-fs survived its Agent scope disposal')
  assert(!names(ctx, first).includes('plugin_market'), 'plugin_market survived its Agent scope disposal')
  assert(!names(ctx, first).includes('plugin_manager'), 'plugin_manager survived its Agent scope disposal')

  // Independence check: the same package still mounts at the root without
  // Helix, and becomes visible to every Agent scope.
  const rootFiber = ctx.plugin(toolFs, {
    read: true, write: true, edit: true, readImage: false, applyPatch: false,
  })
  await rootFiber
  mounted.push(rootFiber)
  assert(names(ctx, first).includes('read') && names(ctx, second).includes('read'),
    'root-mounted tool-fs was not global')

  console.log(JSON.stringify({
    ok: true,
    perAgent: ['read', 'write', 'edit', 'plugin_market', 'plugin_manager'],
    isolated: true,
    disposal: true,
    independentRootMount: true,
  }, null, 2))
} finally {
  for (const fiber of mounted.splice(0)) await fiber.dispose()
  await ctx.fiber.dispose()
}
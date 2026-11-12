import { Context } from '@deepseek-ai/cordis'
import { createScope, type Scope } from '@deepseek-ai/dsh-scope'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as NativePlanTools from '@deepseek-ai/dsh-tool-schedule'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import { expect, it, onTestFinished } from 'vitest'
import { PLAN_TOOL_GUIDANCE } from '../src/plan-guidance.ts'
import * as PlanTools from '../src/plan-tools.ts'

const PLAN_NAMES = ['schedule_create', 'schedule_delete', 'schedule_list', 'schedule_update']

it('adds native plan usage guidance only to the exact owner assembly while preserving a complete prompt', async () => {
  const ctx = new Context()
  const scopes: Scope[] = []
  onTestFinished(async () => {
    const cleanup = await Promise.allSettled(scopes.toReversed().map(scope => scope.dispose()))
    await ctx.fiber.dispose()
    const errors = cleanup.filter(result => result.status === 'rejected')
    if (errors.length > 0) throw new AggregateError(errors.map(result => result.reason), 'Isolated guidance scope cleanup failed')
  })
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime, { mode: 'native' })
  // Registration only: no schedule is created and no Host timer or model is mounted.
  ctx.provide('schedule', {} as never)
  ctx.tools.register(defineTool({
    name: 'ordinary', description: 'Original unrelated fixture description', parameters: {},
    output: { schema: { type: 'string' }, render: () => [] },
    execute: async () => 'fixture',
  }))
  ctx.systemPrompt.section({ name: 'fixture:ordinary-section', order: 100, text: 'Not part of the complete prompt' })

  const owner = { id: 'elysia-conscious-mind', session: { id: 'elysia-conscious-mind' } }
  const foreign = { id: 'foreign-guidance', session: { id: 'foreign-guidance' } }
  const descendant = { id: 'descendant-guidance', session: { id: 'descendant-guidance' } }
  let mainScope!: Scope
  let foreignScope!: Scope
  let descendantScope!: Scope
  await ctx.plugin(Object.assign((injected: Context) => {
    mainScope = createScope(injected, owner)
    foreignScope = createScope(injected, foreign)
    descendantScope = createScope(injected, descendant, { parent: owner })
    scopes.push(mainScope, foreignScope, descendantScope)
  }, { inject: ['systemPrompt', 'tools'] }))
  const completeText = 'Exact isolated standing prompt. {{This stays literal.}}'
  mainScope.ctx.systemPrompt.section({
    name: 'fixture:complete-main', order: 0, complete: true, interpolate: false, text: completeText,
  })
  await foreignScope.ctx.plugin(NativePlanTools)
  const nativeReference = ctx.tools.schemas(foreign)
  const foreignBefore = await ctx.systemPrompt.assemble({ scope: foreign })
  const globalBefore = await ctx.systemPrompt.assemble()
  const mounted = await mainScope.ctx.plugin(PlanTools)
  const registeredBefore = ctx.tools.schemas(owner)
  expect(registeredBefore).toEqual(nativeReference)
  const definitions = new Map(PLAN_NAMES.map(name => [name, ctx.tools.get(name, owner)]))
  const first = await ctx.systemPrompt.assemble({ scope: owner })
  const second = await ctx.systemPrompt.assemble({ scope: owner })

  expect(first.sections).toEqual([{ name: 'fixture:complete-main', text: completeText, interpolate: false }])
  expect(second).toEqual(first)
  const createGuidance = PLAN_TOOL_GUIDANCE.get('schedule_create')
  if (createGuidance === undefined) throw new Error('Create guidance fixture is required')
  expect([...createGuidance.matchAll(/^\d+\. /gm)]).toHaveLength(6)
  for (const name of PLAN_NAMES) {
    const native = nativeReference.find(tool => tool.name === name)
    const described = first.tools.find(tool => tool.name === name)
    const guidance = PLAN_TOOL_GUIDANCE.get(name)
    if (native === undefined || described === undefined || guidance === undefined) throw new Error('Fixture did not register four native plan tools')
    expect(described.description).toBe(`${native.description}\n\n${guidance}`)
    expect(described.parameters).toEqual(native.parameters)
    expect(described.deferLoading).toEqual(native.deferLoading)
    expect(described.description.split(guidance)).toHaveLength(2)
    // Assembly never replaces or mutates the executable/native definition.
    expect(ctx.tools.get(name, owner)).toBe(definitions.get(name))
  }
  expect(first.tools.find(tool => tool.name === 'ordinary')).toEqual(globalBefore.tools.find(tool => tool.name === 'ordinary'))
  expect(ctx.tools.schemas(owner)).toEqual(registeredBefore)
  expect(await ctx.systemPrompt.assemble({ scope: foreign })).toEqual(foreignBefore)
  expect(await ctx.systemPrompt.assemble()).toEqual(globalBefore)
  // A scoped waterfall normally receives descendant assemblies; the explicit
  // exact-owner check must prevent guidance from following inherited tools.
  const child = await ctx.systemPrompt.assemble({ scope: descendant })
  expect(child.sections).toEqual(first.sections)
  expect(child.tools).toEqual(foreignBefore.tools)

  await mounted.dispose()
  const withoutCapability = await ctx.systemPrompt.assemble({ scope: owner })
  expect(withoutCapability.sections).toEqual(first.sections)
  expect(withoutCapability.tools.map(tool => tool.name)).toEqual(['ordinary'])
  // Re-register the same native names to expose a leaked listener that tool
  // removal alone would hide. No Chinese suffix may survive unloading.
  await mainScope.ctx.plugin(NativePlanTools)
  const restored = await ctx.systemPrompt.assemble({ scope: owner })
  expect(restored.sections).toEqual(first.sections)
  expect(restored.tools).toEqual(foreignBefore.tools)
  expect(ctx.tools.schemas(owner)).toEqual(nativeReference)
  expect(await ctx.systemPrompt.assemble({ scope: foreign })).toEqual(foreignBefore)
  expect(await ctx.systemPrompt.assemble()).toEqual(globalBefore)
})

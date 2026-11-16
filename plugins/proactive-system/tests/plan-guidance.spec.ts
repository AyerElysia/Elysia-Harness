import { Context } from '@deepseek-ai/cordis'
import { createScope, type Scope } from '@deepseek-ai/dsh-scope'
import SystemPrompt, { renderContextSections } from '@deepseek-ai/dsh-system-prompt'
import * as NativePlanTools from '@deepseek-ai/dsh-tool-schedule'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import { expect, it, onTestFinished } from 'vitest'
import * as NativeToolExecutor from '../../../dsh/packages/core/tool-executor-native/src/index.ts'
import { PLAN_GUIDANCE } from '../src/plan-guidance.ts'
import * as PlanTools from '../src/plan-tools.ts'

const GUIDANCE_NAME = 'elysia:plan-guidance'

it('registers guidance only for the exact owner and when native tools are available', async () => {
  const ctx = new Context()
  const scopes: Scope[] = []
  onTestFinished(async () => {
    const cleanup = await Promise.allSettled(scopes.toReversed().map(scope => scope.dispose()))
    await ctx.fiber.dispose()
    const errors = cleanup.filter(result => result.status === 'rejected')
    if (errors.length > 0) throw new AggregateError(errors.map(result => result.reason), 'Isolated guidance scope cleanup failed')
  })
  await ctx.plugin(SystemPrompt, { includeRuntimeContext: false })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  ctx.tools.register(defineTool({
    name: 'ordinary', description: 'Original unrelated fixture description', parameters: {},
    output: { schema: { type: 'string' }, render: () => [] },
    execute: async () => 'fixture',
  }))
  ctx.systemPrompt.section({ name: 'fixture:ordinary-section', order: 100, text: 'Not part of the complete prompt' })
  ctx.systemPrompt.context({ name: 'fixture:optional', order: 100, text: 'Suppressed optional context' })

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
  const mounted = await mainScope.ctx.plugin(PlanTools)
  expect(renderContextSections(await ctx.systemPrompt.assemble({ scope: owner }))).toEqual([])
  expect(ctx.tools.get('schedule_create', owner)).toBeUndefined()
  // Registration only: no schedule is created and no Host timer or model is mounted.
  ctx.provide('schedule', { deliveryLimits: () => ({ newSessionIntervalSeconds: 60 }) } as Context['schedule'])
  await foreignScope.ctx.plugin(NativePlanTools)
  await expect.poll(() => ctx.tools.get('schedule_create', owner)).toBeDefined()
  const nativeReference = ctx.tools.schemas(foreign)
  const foreignBefore = await ctx.systemPrompt.assemble({ scope: foreign })
  const globalBefore = await ctx.systemPrompt.assemble()
  const registeredBefore = ctx.tools.schemas(owner)
  expect(registeredBefore).toEqual(nativeReference)
  const first = await ctx.systemPrompt.assemble({ scope: owner })
  const second = await ctx.systemPrompt.assemble({ scope: owner })

  expect(first.sections).toEqual([{ name: 'fixture:complete-main', text: completeText, interpolate: false }])
  expect(second).toEqual(first)
  expect([...PLAN_GUIDANCE.matchAll(/^\d+\. /gm)]).toHaveLength(6)
  const expectedContext = [{ name: GUIDANCE_NAME, text: PLAN_GUIDANCE }]
  expect(renderContextSections(first)).toEqual(expectedContext)
  expect(renderContextSections(ctx.systemPrompt.refreshContext(first, { scope: owner }))).toEqual(expectedContext)
  expect(first.tools).toEqual(foreignBefore.tools)
  expect(ctx.tools.schemas(owner)).toEqual(registeredBefore)
  expect(await ctx.systemPrompt.assemble({ scope: foreign })).toEqual(foreignBefore)
  expect(await ctx.systemPrompt.assemble()).toEqual(globalBefore)
  // The explicit check prevents guidance from following inherited tools.
  const child = await ctx.systemPrompt.assemble({ scope: descendant })
  expect(child.sections).toEqual(first.sections)
  expect(child.tools).toEqual(foreignBefore.tools)
  expect(renderContextSections(child)).toEqual([])

  await mounted.dispose()
  const withoutCapability = await ctx.systemPrompt.assemble({ scope: owner })
  expect(withoutCapability.sections).toEqual(first.sections)
  expect(withoutCapability.tools.map(tool => tool.name)).toEqual(['ordinary'])
  expect(renderContextSections(withoutCapability)).toEqual([])
  // Re-register the same native names to expose a leaked listener that tool
  // removal alone would hide. No Chinese suffix may survive unloading.
  await mainScope.ctx.plugin(NativePlanTools)
  const restored = await ctx.systemPrompt.assemble({ scope: owner })
  expect(restored.sections).toEqual(first.sections)
  expect(restored.tools).toEqual(foreignBefore.tools)
  expect(renderContextSections(restored)).toEqual([])
  expect(ctx.tools.schemas(owner)).toEqual(nativeReference)
  expect(await ctx.systemPrompt.assemble({ scope: foreign })).toEqual(foreignBefore)
  expect(await ctx.systemPrompt.assemble()).toEqual(globalBefore)
})

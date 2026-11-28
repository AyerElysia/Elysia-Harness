/**
 * Model tools of the context gate: all 19 ids register with Chinese
 * descriptions, stay visible without VillV-Helix, and disappear on unmount.
 */
import { describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-tools'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import * as gate from '../src/index.ts'
import { TOOL_NAME_ZH } from '../src/tools.ts'
import { sleep } from './helpers.ts'

const TOOL_IDS = [
  'timer_create', 'timer_list', 'timer_update', 'timer_pause', 'timer_cancel',
  'timer_preset_create', 'timer_preset_list', 'timer_preset_adopt',
  'absence_create', 'absence_list', 'absence_update', 'absence_cancel',
  'event_rule_create', 'event_rule_list', 'event_rule_update', 'event_rule_test',
  'event_rule_pause', 'event_rule_resume', 'event_rule_cancel',
]

describe('context gate tools', () => {
  it('registers every tool with a Chinese name and description, then disposes them', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'context-gate-tools-'))
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx, { systemPrompt: { personaPrefix: '', personaSuffix: '' } })
    const harness = await mountAgentLoopTestHarness(ctx)
    const fiber = await ctx.plugin(gate, { stateDir, batchMs: 20, maxWaitMs: 100, tickMs: 20 })
    await harness.create(SessionId('s1'), { provider: 'mock', model: 'mock' })
    await sleep(40)
    const definitions = ctx.tools.definitions()
    const names = definitions.map(definition => definition.name)
    expect(TOOL_IDS.every(id => names.includes(id))).toBe(true)
    for (const id of TOOL_IDS) {
      const definition = definitions.find(entry => entry.name === id)
      expect(definition?.description ?? '').toMatch(/[\u4e00-\u9fff]/)
      expect(TOOL_NAME_ZH[id]).toBeTruthy()
    }
    // The semantic split is part of the model-facing contract.
    expect(definitions.find(entry => entry.name === 'timer_create')?.description).toContain('event_rule_*')
    expect(definitions.find(entry => entry.name === 'event_rule_create')?.description).toContain('timer_*')
    await fiber.dispose()
    expect(ctx.tools.definitions().some(definition => definition.name === 'timer_create')).toBe(false)
    await ctx.fiber.dispose()
    await rm(stateDir, { recursive: true, force: true })
  })
})
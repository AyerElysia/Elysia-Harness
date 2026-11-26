/**
 * Test harness for the capability panel: real AgentLoop services mounted
 * through the DSH testkit, a scripted LLM adapter, a fake preset registry, and
 * one Host mount over a temporary state directory.
 *
 * The preset registry is a seam this Host adapts to; the fake exposes the
 * documented `presetForSession`, `list`, and `composedPreset` methods so the
 * Host's own merge and fan-out rules are what the specs assert.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { onTestFinished } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { LlmAdapter, ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import {
  mountAgentLoopTestDependencies, mountAgentLoopTestHarness, type AgentLoopTestHarness,
} from '@deepseek-ai/dsh-agent-loop-testkit'
import * as capabilityHostPlugin from '../src/index.ts'
import type { CapabilityHost } from '../src/service.ts'
import type { Config } from '../src/index.ts'

/** A text-only model reply. */
export function textResponse(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    ...Array.from(text, (char): StreamChunk => ({ type: 'text-delta', index: 0, text: char })),
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: text.length } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

/** A model reply that calls one tool. */
export function toolCallResponse(rawCallId: string, name: string, args: object): StreamChunk[] {
  const callId = ToolCallId(rawCallId)
  const json = JSON.stringify(args)
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id: callId, name, argumentsDelta: json },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: callId, name, arguments: json } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

/** Scripted adapter: each model call consumes the next queued stream. */
export class ScriptedAdapter extends LlmAdapter {
  /** Every request the loop built, in call order. */
  readonly requests: GenerateOptions[] = []
  private readonly script: StreamChunk[][] = []

  /**
   * Queue model replies for the coming calls.
   * @param entries - one stream per model call.
   */
  enqueue(...entries: StreamChunk[][]): void {
    this.script.push(...entries)
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const entry = this.script.shift()
    if (entry === undefined) throw new Error('ScriptedAdapter: no queued response')
    for (const chunk of entry) {
      if (options.signal?.aborted) throw new Error('aborted')
      yield chunk
    }
  }
}

/** One preset composition row the Host's static probe reads. */
export interface FakeCompositionRow {
  /** Module specifier the row names. */
  readonly moduleName: string
  /** Effective enablement. */
  readonly enabled: boolean | 'conditional'
}

/** The composition record shape `compositionInventory()` publishes. */
export interface FakeComposition {
  /** Preset identity. */
  readonly id: string
  /** Whether a session naming no preset composes this one. */
  readonly isDefault: boolean
  /** Composition rows in order. */
  readonly rows: readonly { readonly entryId: string; readonly moduleName: string; readonly enabled: boolean | 'conditional' }[]
}

/** The preset-registry surface this Host reads. */
export class FakePresets {
  /** Preset ids the panel may address, with their static composition rows. */
  readonly presets = new Map<string, { readonly id: string; rows: readonly FakeCompositionRow[] }>()
  /** Session id to the preset it runs. */
  readonly bySession = new Map<string, string>()

  /**
   * Record the preset one session runs, keeping any declared composition rows.
   * @param presetId - preset identity.
   * @param sessionId - session that runs it.
   */
  bind(presetId: string, sessionId: string): void {
    if (!this.presets.has(presetId)) this.presets.set(presetId, { id: presetId, rows: [] })
    this.bySession.set(sessionId, presetId)
  }

  /**
   * Declare one addressable preset and its static tool rows.
   * @param presetId - preset identity.
   * @param modules - composition modules the preset's tool face mounts.
   */
  declare(presetId: string, modules: readonly string[] = []): void {
    this.presets.set(presetId, {
      id: presetId,
      rows: modules.map(moduleName => ({ moduleName, enabled: true })),
    })
  }

  async list(): Promise<{ readonly id: string }[]> {
    return [...this.presets.values()].map(preset => ({ id: preset.id }))
  }

  async compositionInventory(): Promise<FakeComposition[]> {
    return [...this.presets.values()].map(preset => ({
      id: preset.id,
      isDefault: false,
      rows: preset.rows.map((row, index) => ({
        entryId: `row-${String(index)}`,
        moduleName: row.moduleName,
        enabled: row.enabled,
      })),
    }))
  }

  presetForSession(session: Session): string | null {
    return this.bySession.get(session.id) ?? null
  }

  composedPreset(): string | undefined {
    return undefined
  }
}

/** One test environment over a temporary state directory. */
export interface TestEnv {
  /** Root context owning every mounted service and plugin. */
  readonly ctx: Context
  /** Scripted model. */
  readonly adapter: ScriptedAdapter
  /** Fake preset registry. */
  readonly presets: FakePresets
  /** Absolute state directory. */
  readonly stateDir: string
  /** Mount the Host; returns the fiber so a restart can dispose it. */
  mountHost(config?: Partial<Config>): Promise<{ dispose(): Promise<void> }>
  /** The currently mounted Host service. */
  host(): CapabilityHost
  /** Create one production Agent, optionally bound to a preset. */
  createAgent(id: string, presetId?: string): Promise<Agent>
  /** Send one user turn and wait for the Agent to settle. */
  send(agent: Agent, text: string): Promise<void>
  /** Dispose the root context and remove the state directory. */
  dispose(): Promise<void>
}

/**
 * Mount the test environment.
 * @param options - an existing state directory to reopen, for restart specs.
 * @returns the environment, with cleanup registered on the current test.
 */
export async function createEnv(options: { stateDir?: string } = {}): Promise<TestEnv> {
  const stateDir = options.stateDir ?? await mkdtemp(join(tmpdir(), 'elysia-caphost-'))
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx, { systemPrompt: { personaPrefix: '', personaSuffix: '' } })
  const harness: AgentLoopTestHarness = await mountAgentLoopTestHarness(ctx)
  const adapter = new ScriptedAdapter()
  ctx.llm.registerAdapter(['mock'], adapter)
  const presets = new FakePresets()
  ctx.provide('agentPresets', presets as never)

  let hostFiber: { dispose(): Promise<void> } | undefined
  const env: TestEnv = {
    ctx,
    adapter,
    presets,
    stateDir,
    async mountHost(config = {}) {
      if (hostFiber !== undefined) throw new Error('the Host is already mounted')
      const fiber = await ctx.plugin(capabilityHostPlugin, { stateDir, ...config })
      const owned = {
        async dispose() {
          hostFiber = undefined
          await fiber.dispose()
        },
      }
      hostFiber = owned
      return owned
    },
    host() {
      return ctx.capabilityHost
    },
    async createAgent(id, presetId) {
      const agent = await harness.create(SessionId(id), { provider: 'mock', model: 'model' })
      if (presetId !== undefined) presets.bind(presetId, id)
      return agent
    },
    async send(agent, text) {
      agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
      await agent.whenIdle()
    },
    async dispose() {
      await ctx.fiber.dispose()
      await rm(stateDir, { recursive: true, force: true })
    },
  }
  onTestFinished(async () => { await env.dispose() })
  return env
}

/** Await one macrotask so a fire-and-forget follow-up can start. */
export async function settle(): Promise<void> {
  await new Promise<void>((resolve) => { setImmediate(resolve) })
}

/**
 * Poll until one condition holds.
 * @param predicate - condition to wait for.
 * @param timeoutMs - failure bound.
 */
export async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('waitFor: condition did not hold in time')
    await new Promise<void>((resolve) => { setTimeout(resolve, 1) })
  }
}

/** A user message the context relay injected. */
export type RelayMessageEvent = Extract<SessionEvent, { type: 'user/message' }>

/** A completed tool call. */
export type ToolResultEvent = Extract<SessionEvent, { type: 'tool/result' }>

/**
 * Whether one session event is a relay message.
 * @param event - any session event.
 * @returns true for a `user/message` whose source is the context relay.
 */
export function isRelayEvent(event: SessionEvent): event is RelayMessageEvent {
  return event.type === 'user/message' && event.data.source.kind === 'elysia-context-relay'
}

/**
 * Every relay message in one Agent's log.
 * @param agent - Agent whose session log is read.
 * @returns relay messages in log order.
 */
export function relayMessages(agent: Agent): RelayMessageEvent[] {
  return agent.session.snapshotEvents().filter(isRelayEvent)
}

/**
 * One tool result by call id.
 * @param agent - Agent whose session log is read.
 * @param callId - model-issued tool call id.
 * @returns the result event, when the call ran.
 */
export function findToolResult(agent: Agent, callId: string): ToolResultEvent | undefined {
  return agent.session.snapshotEvents().find(
    (event): event is ToolResultEvent => event.type === 'tool/result' && event.data.message.toolCallId === callId,
  )
}

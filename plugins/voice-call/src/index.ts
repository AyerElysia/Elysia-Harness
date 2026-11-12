/** Explicit-start, single-user voice calls; importing/mounting never dials. */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { ELYSIUM_BREEZE_CONFIG } from '@elysia/conscious-mind/src/breeze-tts.ts'
import { isAbsolute, join, resolve } from 'node:path'
import { mkdir } from 'node:fs/promises'
import { createOpenAINetwork } from './openai-network.ts'
import { VoiceCallController, VoiceCallError, type ExportedVoiceAgentHandle } from './controller.ts'
import { RealtimeTransport } from './realtime.ts'
import { createVoiceAgent, VoiceAgent } from './session.ts'
import { assembleVoicePrompt } from './prompt.ts'
import { prepareVoiceSession } from './persistence.ts'
import { makeRecordActivity } from './activity.ts'
import { acceptVoiceAudioCommit } from './input.ts'
import { mountVoiceRoutes } from './server.ts'
import { mountVoiceOwnership } from './ownership.ts'

export const name = 'elysia-voice-call'
export const inject = ['sessions', 'agents', 'systemPrompt', 'sessionPersistence', 'credentials', 'connection', 'storageDomain', 'tools']
const home = process.env.DSH_HOME ?? resolve('homes/web')
export interface Config {
  enabled?: boolean
  cwd?: string
  promptsDir?: string
  breezeConfigPath?: string
  /** Voice-only Q8 HTTP service; the ordinary chat configuration is never rewritten. */
  breezeServerUrl?: string
  apiKeyRef?: string
  openaiProxyUrl?: string
}
interface ResolvedConfig {
  enabled: boolean
  cwd: string
  promptsDir: string
  breezeConfigPath: string
  breezeServerUrl: string
  apiKeyRef: string
  openaiProxyUrl?: string
}
/** Deployment-only values; clients cannot choose a model, prompt, voice or URL. */
export const Config: z<Config, ResolvedConfig> = z.object({
  enabled: z.boolean().default(false),
  cwd: z.string().default(join(home, 'voice-call')),
  promptsDir: z.string().default(process.env.ELYSIA_PROMPTS_DIR ?? join(home, 'standing-prompts')),
  breezeConfigPath: z.string().default(ELYSIUM_BREEZE_CONFIG),
  breezeServerUrl: z.string().default('http://127.0.0.1:7865'),
  apiKeyRef: z.string().default('OPENAI_REALTIME_API_KEY'),
  openaiProxyUrl: z.string(),
})

/** Mount only authenticated routes and lifecycle ownership, not a running Agent. */
export async function apply(ctx: Context, input: Config = {}): Promise<void> {
  const config = Config(input)
  for (const path of [config.cwd, config.promptsDir, config.breezeConfigPath]) {
    if (!isAbsolute(path)) throw new Error('Voice deployment paths must be absolute')
  }
  mountVoiceOwnership(ctx)
  const ref = credentialRef(config.apiKeyRef)
  const descriptor = await ctx.credentials.describe(ref)
  const recordActivity = makeRecordActivity(ctx)
  const agents = new WeakMap<ExportedVoiceAgentHandle, VoiceAgent>()
  const openaiNetwork = createOpenAINetwork(config.openaiProxyUrl)
  ctx.effect(() => () => openaiNetwork.close(), 'voice-call.openai-network-owner')
  const realtime = new RealtimeTransport(openaiNetwork)
  const controller = new VoiceCallController({
    enabled: config.enabled,
    credentialConfigured: descriptor.configured,
    breezeConfigPath: config.breezeConfigPath,
    breezeServerUrl: config.breezeServerUrl,
    realtime,
    resolveApiKey: async signal => {
      signal.throwIfAborted()
      const resolved = await ctx.credentials.resolve(ref)
      signal.throwIfAborted()
      if (!resolved?.value) throw new VoiceCallError('credential_not_configured')
      return resolved.value
    },
    recordActivity,
    openAgent: async ({ driver, onRecordedResponse, signal }) => {
      signal.throwIfAborted()
      await mkdir(config.cwd, { recursive: true, mode: 0o700 })
      const prepared = await prepareVoiceSession(ctx, { cwd: config.cwd, signal })
      let voice: Awaited<ReturnType<typeof createVoiceAgent>> | undefined
      try {
        voice = await createVoiceAgent(ctx, {
          cwd: config.cwd, promptsDir: config.promptsDir, driver,
          session: prepared.session, restore: prepared.restore, onRecordedResponse,
        })
        // A new media call cannot replay an old input recording: keep the
        // explicit cancellation fact, not a fake restored human utterance.
        voice.agent.cancel({ kind: 'hook', reason: 'Previous voice transport is no longer replayable' })
        if (!await ctx.sessions.flush(voice.agent.session)) throw new VoiceCallError('persistence_unavailable')
        signal.throwIfAborted()
        const initialInstructions = await assembleVoicePrompt(voice.agent, signal)
        const agent = voice.agent
        agents.set(agent, agent)
        let closing: Promise<void> | undefined
        return {
          agent, initialInstructions,
          close: () => closing ??= (async () => {
            const errors: unknown[] = []
            try { await voice!.dispose() } catch (error) { errors.push(error) }
            try { await prepared.handle.close() } catch (error) { errors.push(error) }
            agents.delete(agent)
            if (errors.length) throw new AggregateError(errors, 'Voice Session close failed')
          })(),
        }
      } catch (error) {
        const errors: unknown[] = [error]
        try { await voice?.dispose() } catch (failure) { errors.push(failure) }
        try { await prepared.handle.close() } catch (failure) { errors.push(failure) }
        throw errors.length === 1 ? error : new AggregateError(errors, 'Voice setup cleanup failed')
      }
    },
    acceptAudioCommit: async (handle, event, callId, epoch) => {
      const agent = agents.get(handle)
      if (!agent) throw new VoiceCallError('agent_owner_missing')
      await acceptVoiceAudioCommit(agent, event, callId, epoch)
    },
  })
  ctx.on('credentials/reference-updated', async updated => {
    if (updated !== ref) return
    const info = await ctx.credentials.describe(ref)
    controller.updateCredentialConfigured(info.configured)
  })
  mountVoiceRoutes(ctx, controller)
  ctx.effect(() => () => controller.close('plugin_unloaded'), 'voice-call.controller-owner')
}

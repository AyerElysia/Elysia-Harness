/** Deployment choices for the independent context metrics projection. */
import z from '@deepseek-ai/schemastery'
import { fileURLToPath } from 'node:url'
import type { CounterOptions } from './counter.ts'

export interface MetricsConfig {
  enabled?: boolean
  tokenizerEnabled?: boolean
  assetDirectory?: string
  modelIds?: string[]
  providerIds?: string[]
  maxTextBytes?: number
  cacheEntries?: number
  asciiTokensPerCharacter?: number
  cjkTokensPerCharacter?: number
  otherTokensPerByte?: number
}
export interface ResolvedMetricsConfig extends Omit<CounterOptions, 'enabled'> {
  enabled: boolean
  tokenizerEnabled: boolean
}
export const MetricsConfig: z<MetricsConfig, ResolvedMetricsConfig> = z.object({
  enabled: z.boolean().default(true),
  tokenizerEnabled: z.boolean().default(true),
  assetDirectory: z.string().default(fileURLToPath(new URL('../../tokenizers/deepseek-v4.1-flash/', import.meta.url))),
  modelIds: z.array(z.string()).default(['deepseek-v4.1-flash', 'deepseek-flash', 'deepseek-v4-flash']),
  providerIds: z.array(z.string()).default([]),
  maxTextBytes: z.natural().min(1).max(4 * 1024 * 1024).default(256 * 1024),
  cacheEntries: z.natural().max(65536).default(4096),
  asciiTokensPerCharacter: z.number().min(0.01).max(4).default(0.3),
  cjkTokensPerCharacter: z.number().min(0.01).max(4).default(0.6),
  otherTokensPerByte: z.number().min(0.01).max(4).default(0.5),
})

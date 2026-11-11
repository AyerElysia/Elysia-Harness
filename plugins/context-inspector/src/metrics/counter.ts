/** Offline reference tokenization; never sends content to a provider or downloads at runtime. */
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { Tokenizer } from '@huggingface/tokenizers'
import type { TextCounter, TextTokenCounts } from './counter-types.ts'

export interface CounterOptions {
  enabled: boolean
  assetDirectory: string
  modelIds: string[]
  providerIds: string[]
  maxTextBytes: number
  cacheEntries: number
  asciiTokensPerCharacter: number
  cjkTokensPerCharacter: number
  otherTokensPerByte: number
}
export interface DisposableTextCounter extends TextCounter { dispose(): void }

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u

/** A complete-text fallback with explicit configurable densities, not a model token count. */
export function heuristicTextTokens(text: string, options: CounterOptions): number {
  let ascii = 0
  let cjk = 0
  let otherBytes = 0
  for (const character of text) {
    if (character.codePointAt(0)! <= 0x7f) ascii++
    else if (CJK.test(character)) cjk++
    else otherBytes += Buffer.byteLength(character)
  }
  return Math.ceil(ascii * options.asciiTokensPerCharacter
    + cjk * options.cjkTokensPerCharacter + otherBytes * options.otherTokensPerByte)
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Validate public static assets against their pinned manifest before initializing the encoder. */
async function loadTokenizer(directory: string): Promise<{ tokenizer: Tokenizer; fingerprint: string }> {
  const manifestBytes = await readFile(join(directory, 'manifest.json'))
  if (manifestBytes.length > 65536) throw new Error('Tokenizer asset manifest is too large')
  const manifest: unknown = JSON.parse(manifestBytes.toString('utf8'))
  if (!object(manifest) || !Array.isArray(manifest.assets)) throw new Error('Invalid tokenizer asset manifest')
  const values: Record<string, Record<string, unknown>> = {}
  const hashes: string[] = []
  for (const name of ['tokenizer.json', 'tokenizer_config.json']) {
    const bytes = await readFile(join(directory, name))
    if (bytes.length > 16 * 1024 * 1024) throw new Error('Tokenizer asset is too large')
    const expected = manifest.assets.find((item: unknown) => object(item) && item.file === name)
    const hash = createHash('sha256').update(bytes).digest('hex')
    if (!object(expected) || expected.sha256 !== hash || expected.bytes !== bytes.length) {
      throw new Error('Tokenizer asset integrity mismatch')
    }
    const value: unknown = JSON.parse(bytes.toString('utf8'))
    if (!object(value)) throw new Error('Invalid tokenizer asset')
    values[name] = value
    hashes.push(hash)
  }
  const definition = values['tokenizer.json']!
  // Counting must never inherit a model asset's padding/truncation limits.
  if (definition.truncation !== null && definition.truncation !== undefined
    || definition.padding !== null && definition.padding !== undefined) {
    throw new Error('Tokenizer counting requires assets without truncation or padding')
  }
  const tokenizer = new Tokenizer(
    definition as ConstructorParameters<typeof Tokenizer>[0],
    values['tokenizer_config.json']! as ConstructorParameters<typeof Tokenizer>[1],
  )
  tokenizer.encode('爱莉 Hello {} 😀', { add_special_tokens: false })
  return { tokenizer, fingerprint: hashes.join(':') }
}

/** Load once; each counted body retains only a digest and numeric prices in a bounded cache. */
export async function createTextCounter(options: CounterOptions): Promise<DisposableTextCounter> {
  const loaded = options.enabled ? await loadTokenizer(options.assetDirectory) : undefined
  let encoder = loaded?.tokenizer
  const id = createHash('sha256').update(JSON.stringify({
    ...options, assetFingerprint: loaded?.fingerprint ?? 'disabled',
  })).digest('hex')
  const cache = new Map<string, TextTokenCounts>()
  let disposed = false
  return {
    id,
    label: 'DeepSeek V4.1 Flash',
    supports(provider, model) {
      return options.enabled && options.modelIds.includes(model)
        && (options.providerIds.length === 0 || options.providerIds.includes(provider))
    },
    count(text) {
      if (disposed) throw new Error('Text counter is disposed')
      const key = createHash('sha256').update(text).digest('hex')
      const cached = cache.get(key)
      if (cached !== undefined) {
        cache.delete(key)
        cache.set(key, cached)
        return { ...cached }
      }
      const heuristicTokens = heuristicTextTokens(text, options)
      const fallback = encoder !== undefined && Buffer.byteLength(text) > options.maxTextBytes
      const tokenizerTokens = encoder === undefined || fallback ? heuristicTokens
        : encoder.encode(text, { add_special_tokens: false }).ids.length
      const result = { tokenizerTokens, heuristicTokens, fallback }
      if (options.cacheEntries > 0) {
        while (cache.size >= options.cacheEntries) cache.delete(cache.keys().next().value!)
        cache.set(key, result)
      }
      return { ...result }
    },
    dispose() { disposed = true; cache.clear(); encoder = undefined },
  }
}

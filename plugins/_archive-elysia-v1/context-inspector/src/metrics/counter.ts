/** Offline reference tokenization; never sends content to a provider or downloads at runtime. */
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import type {
  CounterStatus, TextCounter, TextTokenCounts, TokenizerFailure, TokenizerFailureCode,
} from './counter-types.ts'

export interface CounterOptions {
  enabled: boolean
  /** Operator explicitly requires the reference tokenizer; fail instead of degrading. */
  requireExact?: boolean
  assetDirectory: string
  modelIds: string[]
  providerIds: string[]
  maxTextBytes: number
  cacheEntries: number
  asciiTokensPerCharacter: number
  cjkTokensPerCharacter: number
  otherTokensPerByte: number
  /** Known multiplicative overestimate of the weighted fallback for English. */
  heuristicBiasRatio: number
}
export interface DisposableTextCounter extends TextCounter { dispose(): void }

interface TokenEncoder {
  encode(text: string, options: { add_special_tokens: boolean }): { ids: number[] }
}
type TokenEncoderConstructor = new (definition: Record<string, unknown>, config: Record<string, unknown>) => TokenEncoder
interface LoadedTokenizer { tokenizer: TokenEncoder; fingerprint: string; assetRevision: string | undefined }

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u
const MAX_MANIFEST_BYTES = 65536
const MAX_ASSET_BYTES = 16 * 1024 * 1024
const FAILURE_MESSAGES: Record<TokenizerFailureCode, string> = {
  'assets-missing': '参考分词器资产文件缺失',
  'assets-unreadable': '参考分词器资产文件无法读取',
  'manifest-invalid': '参考分词器资产清单无效',
  'asset-integrity': '参考分词器资产完整性校验失败',
  'asset-invalid': '参考分词器资产内容无效',
  'asset-policy': '参考分词器资产带有截断或填充策略，不能用于完整计数',
  'runtime-unavailable': '本地参考分词器运行时不可用',
}

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

/** Internal asset failure carrying the revision parsed before the failure when available. */
class TokenizerAssetError extends Error {
  constructor(readonly code: TokenizerFailureCode, readonly assetRevision: string | undefined) {
    super('Tokenizer asset failure: ' + code)
    this.name = 'TokenizerAssetError'
  }
}

/** Structured failure for deployments that explicitly require the reference tokenizer. */
export class TokenizerUnavailableError extends Error {
  constructor(readonly code: TokenizerFailureCode, readonly assetRevision: string | undefined) {
    super('本地参考分词器不可用：' + code)
    this.name = 'TokenizerUnavailableError'
  }
}

async function readAsset(path: string, assetRevision: string | undefined): Promise<Buffer> {
  try {
    return await readFile(path)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    throw new TokenizerAssetError(code === 'ENOENT' ? 'assets-missing' : 'assets-unreadable', assetRevision)
  }
}

async function importTokenizer(runtimeUnavailable: () => never): Promise<TokenEncoderConstructor> {
  try {
    // A non-literal specifier keeps the optional runtime out of the static import graph.
    const specifier = '@huggingface/tokenizers'
    const runtime = await import(specifier) as { Tokenizer?: TokenEncoderConstructor }
    if (typeof runtime.Tokenizer !== 'function') return runtimeUnavailable()
    return runtime.Tokenizer
  } catch (error) {
    if (error instanceof TokenizerAssetError) throw error
    return runtimeUnavailable()
  }
}

function createTokenizer(
  Tokenizer: TokenEncoderConstructor, definition: Record<string, unknown>, config: Record<string, unknown>,
  runtimeUnavailable: () => never,
): TokenEncoder {
  try {
    const tokenizer = new Tokenizer(definition, config)
    tokenizer.encode('爱莉 Hello {} 😀', { add_special_tokens: false })
    return tokenizer
  } catch {
    return runtimeUnavailable()
  }
}

function parseJsonObject(
  bytes: Buffer, code: TokenizerFailureCode, assetRevision: string | undefined,
): Record<string, unknown> {
  let value: unknown
  try {
    value = JSON.parse(bytes.toString('utf8'))
  } catch { throw new TokenizerAssetError(code, assetRevision) }
  if (!object(value)) throw new TokenizerAssetError(code, assetRevision)
  return value
}

/** Validate public static assets against their pinned manifest before initializing the encoder. */
async function loadTokenizer(directory: string): Promise<LoadedTokenizer> {
  let assetRevision: string | undefined

  const manifestBytes = await readAsset(join(directory, 'manifest.json'), undefined)
  if (manifestBytes.length > MAX_MANIFEST_BYTES) throw new TokenizerAssetError('manifest-invalid', assetRevision)
  const manifest = parseJsonObject(manifestBytes, 'manifest-invalid', undefined)
  if (object(manifest.source) && typeof manifest.source.revision === 'string' && manifest.source.revision.length > 0) {
    assetRevision = manifest.source.revision
  }
  const assets = manifest.assets
  if (!Array.isArray(assets)) throw new TokenizerAssetError('manifest-invalid', assetRevision)

  const values: Record<string, Record<string, unknown>> = {}
  const hashes: string[] = []
  for (const name of ['tokenizer.json', 'tokenizer_config.json']) {
    const bytes = await readAsset(join(directory, name), assetRevision)
    if (bytes.length > MAX_ASSET_BYTES) throw new TokenizerAssetError('asset-invalid', assetRevision)
    const expected = assets.find((item: unknown) => object(item) && item.file === name)
    const hash = createHash('sha256').update(bytes).digest('hex')
    if (!object(expected) || expected.sha256 !== hash || expected.bytes !== bytes.length) {
      throw new TokenizerAssetError('asset-integrity', assetRevision)
    }
    values[name] = parseJsonObject(bytes, 'asset-invalid', assetRevision)
    hashes.push(hash)
  }

  const definition = values['tokenizer.json']!
  // Counting must never inherit a model asset's padding/truncation limits.
  if (definition.truncation !== null && definition.truncation !== undefined
    || definition.padding !== null && definition.padding !== undefined) {
    throw new TokenizerAssetError('asset-policy', assetRevision)
  }
  const runtimeUnavailable = (): never => { throw new TokenizerAssetError('runtime-unavailable', assetRevision) }
  const Tokenizer = await importTokenizer(runtimeUnavailable)
  const tokenizer = createTokenizer(
    Tokenizer, definition, values['tokenizer_config.json']!, runtimeUnavailable,
  )
  return { tokenizer, fingerprint: hashes.join(':'), assetRevision }
}

/**
 * Load the reference tokenizer once. A missing or invalid asset keeps metrics
 * mountable with weighted estimates unless `requireExact` was configured.
 * @param options - resolved counting choices for this mount.
 * @returns synchronous counter plus its observable quality status.
 * @throws {TokenizerUnavailableError} only when `requireExact` is set and loading fails.
 */
export async function createTextCounter(options: CounterOptions): Promise<DisposableTextCounter> {
  let loaded: LoadedTokenizer | undefined
  let failure: TokenizerFailure | undefined
  if (options.enabled) {
    try {
      loaded = await loadTokenizer(options.assetDirectory)
    } catch (error) {
      const assetError = error instanceof TokenizerAssetError
        ? error
        : new TokenizerAssetError('runtime-unavailable', undefined)
      if (options.requireExact) throw new TokenizerUnavailableError(assetError.code, assetError.assetRevision)
      failure = {
        code: assetError.code,
        message: FAILURE_MESSAGES[assetError.code],
        ...assetError.assetRevision === undefined ? {} : { assetRevision: assetError.assetRevision },
      }
    }
  }
  let encoder = loaded?.tokenizer
  const status: CounterStatus = {
    mode: encoder === undefined ? 'heuristic' : 'tokenizer',
    heuristicBiasRatio: options.heuristicBiasRatio,
    ...failure === undefined ? {} : { failure },
  }
  // Quality policy and display bias do not change counts, so they stay out of the identity.
  const id = createHash('sha256').update(JSON.stringify({
    enabled: options.enabled,
    assetDirectory: options.assetDirectory,
    modelIds: options.modelIds,
    providerIds: options.providerIds,
    maxTextBytes: options.maxTextBytes,
    cacheEntries: options.cacheEntries,
    asciiTokensPerCharacter: options.asciiTokensPerCharacter,
    cjkTokensPerCharacter: options.cjkTokensPerCharacter,
    otherTokensPerByte: options.otherTokensPerByte,
    assetFingerprint: loaded?.fingerprint ?? 'disabled',
    ...failure?.assetRevision === undefined ? {} : { assetRevision: failure.assetRevision },
    ...failure === undefined ? {} : { failureCode: failure.code },
  })).digest('hex')
  const cache = new Map<string, TextTokenCounts>()
  let disposed = false
  return {
    id,
    label: 'DeepSeek V4.1 Flash',
    status,
    supports(provider, model) {
      return options.enabled && encoder !== undefined && options.modelIds.includes(model)
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

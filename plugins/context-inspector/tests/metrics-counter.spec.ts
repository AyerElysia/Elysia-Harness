import { afterAll, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MetricsConfig } from '../src/metrics/config.ts'
import { createTextCounter } from '../src/metrics/counter.ts'

const defaults = MetricsConfig({})
const counter = await createTextCounter({ ...defaults, enabled: defaults.tokenizerEnabled })
afterAll(() => { counter.dispose() })

describe('offline reference tokenizer', () => {
  it('matches independent native-tokenizer public reference counts without padding', () => {
    // Verified against the pinned official tokenizer with native HF tokenizers 0.22.2.
    const cases: [string, number][] = [
      ['', 0], ['你好，世界！', 4], ['Hello, world!', 4],
      ['{"count":3,"enabled":true,"message":"你好"}', 14],
      ['🙂🌍👨‍👩‍👧‍👦', 15],
    ]
    for (const [text, tokens] of cases) {
      expect(counter.count(text)).toMatchObject({ tokenizerTokens: tokens, fallback: false })
    }
    expect(counter.supports('d1api', 'deepseek-v4.1-flash')).toBe(true)
    expect(counter.supports('d1api', 'unmapped-model')).toBe(false)
  })

  it('does not truncate a larger complete public input', () => {
    expect(counter.count('公开分词验证 English JSON 123 🙂\n'.repeat(1024)))
      .toMatchObject({ tokenizerTokens: 9216, fallback: false })
  })

  it('prices the whole input and marks the budget fallback instead of truncating it', async () => {
    const limited = await createTextCounter({ ...defaults, enabled: true, maxTextBytes: 1, cacheEntries: 1 })
    try {
      expect(limited.count('a'.repeat(1000))).toEqual({
        tokenizerTokens: 300, heuristicTokens: 300, fallback: true,
      })
      const first = limited.count('你好，世界！')
      first.tokenizerTokens = -1
      expect(limited.count('你好，世界！').tokenizerTokens).toBe(6)
    } finally { limited.dispose() }
    expect(() => limited.count('text')).toThrow('disposed')
  })

  it('can explicitly disable tokenization without reading absent assets', async () => {
    const fallback = await createTextCounter({ ...defaults, enabled: false, assetDirectory: '/no-assets', cacheEntries: 0 })
    try {
      expect(fallback.supports('d1api', 'deepseek-v4.1-flash')).toBe(false)
      expect(fallback.count('a'.repeat(1000))).toEqual({
        tokenizerTokens: 300, heuristicTokens: 300, fallback: false,
      })
    } finally { fallback.dispose() }
  })

  it('rejects corrupted static model assets before using an unverified encoder', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'elysia-tokenizer-assets-'))
    try {
      await writeFile(join(directory, 'manifest.json'), JSON.stringify({
        assets: [{ file: 'tokenizer.json', sha256: 'invalid', bytes: 2 }],
      }))
      await writeFile(join(directory, 'tokenizer.json'), '{}')
      await expect(createTextCounter({ ...defaults, enabled: true, assetDirectory: directory }))
        .rejects.toThrow('integrity mismatch')
    } finally { await rm(directory, { recursive: true }) }
  })
})

import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter, markAgentLoopRequest, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { afterEach, describe, expect, it } from 'vitest'
import * as RequestArchive from '../src/index.ts'
import { archiveRequest, RequestArchiveError } from '../src/archive.ts'

const directories: string[] = []

function directory(): string {
  const path = mkdtempSync(join(tmpdir(), 'elysia-requests-'))
  directories.push(path)
  return path
}

afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true })
})

class CountingAdapter extends LlmAdapter {
  calls = 0
  override async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls += 1
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

function request(text: string): GenerateOptions {
  return {
    provider: 'test',
    model: 'test-model',
    system: 'standing prompt',
    messages: [{ role: 'user', content: [{ type: 'text', text }] }],
    tools: [{ name: 'send_text', description: 'send', parameters: { type: 'object' } }],
    temperature: 0.8,
    signal: new AbortController().signal,
  }
}

async function drain(stream: AsyncIterable<StreamChunk>): Promise<void> {
  for await (const _chunk of stream) {
    // The adapter's scripted finish chunk only has to be consumed.
  }
}

describe('archiveRequest', () => {
  it('writes the assembled request and leaves the abort signal out', () => {
    const dir = directory()
    const options = markAgentLoopRequest(request('hello'))
    const written = archiveRequest(dir, options)
    const raw = readFileSync(written.path, 'utf8')
    const saved = JSON.parse(raw) as {
      loop: boolean
      request: GenerateOptions & { signal?: unknown }
    }
    expect(saved.loop).toBe(true)
    expect(saved.request).toMatchObject({
      provider: 'test',
      model: 'test-model',
      system: 'standing prompt',
      temperature: 0.8,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
      tools: [{ name: 'send_text', description: 'send', parameters: { type: 'object' } }],
    })
    expect(saved.request.signal).toBeUndefined()
    expect(JSON.stringify(saved)).not.toContain('signal')
    expect(written.bytes).toBe(Buffer.byteLength(raw))
  })

  it('writes single-line JSON by default and indents only when asked', () => {
    const dir = directory()
    const compact = archiveRequest(dir, request('compact'))
    const compactText = readFileSync(compact.path, 'utf8')
    expect(compactText.trimEnd().split('\n')).toHaveLength(1)
    expect(compactText.endsWith('}\n')).toBe(true)
    expect(compact.bytes).toBe(Buffer.byteLength(compactText))

    const readable = archiveRequest(dir, request('readable'), undefined, { compact: false })
    const readableText = readFileSync(readable.path, 'utf8')
    expect(readableText).toContain('\n  "id"')
    expect(readable.bytes).toBeGreaterThan(compact.bytes)
    expect(JSON.parse(readableText)).toEqual(readable.record)
  })

  it('appends a new file and never rewrites an earlier archive', () => {
    const dir = directory()
    const first = archiveRequest(dir, request('first'))
    const before = readFileSync(first.path, 'utf8')
    const beforeMtime = statSync(first.path).mtimeMs
    const second = archiveRequest(dir, request('second'))
    expect(second.path).not.toBe(first.path)
    expect(readFileSync(first.path, 'utf8')).toBe(before)
    expect(statSync(first.path).mtimeMs).toBe(beforeMtime)
    expect(readdirSync(dir).filter(name => name.endsWith('.json'))).toHaveLength(2)
    expect(JSON.parse(before).request.messages[0].content[0].text).toBe('first')
  })

  it.skipIf(process.platform === 'win32')('tightens a pre-existing archive directory to owner-only', () => {
    const dir = directory()
    chmodSync(dir, 0o755)
    archiveRequest(dir, request('private'))
    expect(statSync(dir).mode & 0o777).toBe(0o700)
  })
})

describe('elysia-request-archive', () => {
  it('keeps a separate file for every stream call before the adapter runs', async () => {
    const dir = directory()
    const ctx = new Context()
    const adapter = new CountingAdapter()
    try {
      await ctx.plugin(LlmRuntime)
      await ctx.plugin(RequestArchive, { dir })
      ctx.llm.registerAdapter(['test'], adapter)
      for (const text of ['one', 'two']) await drain(ctx.llm.stream(request(text)))
      const files = readdirSync(dir).filter(name => name.endsWith('.json')).sort()
      expect(files).toHaveLength(2)
      expect(adapter.calls).toBe(2)
      const bodies = files.map(name => readFileSync(join(dir, name), 'utf8'))
      expect(bodies.some(body => body.includes('"text":"one"'))).toBe(true)
      expect(bodies.some(body => body.includes('"text":"two"'))).toBe(true)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('keeps a completed archive and model call when only the derived index fails', async () => {
    const dir = directory()
    writeFileSync(join(dir, '.session-index-v1'), 'blocked index directory')
    const ctx = new Context()
    const adapter = new CountingAdapter()
    try {
      await ctx.plugin(LlmRuntime)
      await ctx.plugin(RequestArchive, { dir })
      ctx.llm.registerAdapter(['test'], adapter)
      await drain(ctx.llm.stream({ ...request('retained'), sessionId: 'fixture' }))
      expect(adapter.calls).toBe(1)
      expect(readdirSync(dir).filter(name => name.endsWith('.json'))).toHaveLength(1)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('does not call the adapter when the archive cannot be written', async () => {
    const blocked = join(directory(), 'not-a-directory')
    writeFileSync(blocked, 'file')
    const ctx = new Context()
    const adapter = new CountingAdapter()
    try {
      await ctx.plugin(LlmRuntime)
      await ctx.plugin(RequestArchive, { dir: blocked })
      ctx.llm.registerAdapter(['test'], adapter)
      await expect((async () => {
        await drain(ctx.llm.stream(request('nope')))
      })()).rejects.toBeInstanceOf(RequestArchiveError)
      expect(adapter.calls).toBe(0)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('evicts the oldest archives once the file bound is exceeded, without skipping a call', async () => {
    const dir = directory()
    const ctx = new Context()
    const adapter = new CountingAdapter()
    try {
      await ctx.plugin(LlmRuntime)
      await ctx.plugin(RequestArchive, { dir, maxFiles: 2 })
      ctx.llm.registerAdapter(['test'], adapter)
      for (const text of ['one', 'two', 'three', 'four']) {
        await drain(ctx.llm.stream(request(text)))
        await new Promise(resolve => setTimeout(resolve, 5))
      }
      expect(adapter.calls).toBe(4)
    } finally {
      await ctx.fiber.dispose()
    }
    const files = readdirSync(dir).filter(name => name.endsWith('.json'))
    expect(files).toHaveLength(2)
    const bodies = files.map(name => readFileSync(join(dir, name), 'utf8')).join('')
    expect(bodies).toContain('"text":"four"')
    expect(bodies).not.toContain('"text":"one"')
  })

  it('defaults the retention bounds and the compact layout in its schema', () => {
    expect(RequestArchive.Config({})).toMatchObject({
      maxFiles: RequestArchive.DEFAULT_MAX_FILES,
      maxBytes: RequestArchive.DEFAULT_MAX_BYTES,
      maxAgeDays: RequestArchive.DEFAULT_MAX_AGE_DAYS,
      compact: true,
    })
  })
})

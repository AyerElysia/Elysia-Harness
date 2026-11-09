import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

describe('archiveRequest', () => {
  it('writes the assembled request and leaves the abort signal out', () => {
    const dir = directory()
    const options = markAgentLoopRequest(request('hello'))
    const path = archiveRequest(dir, options)
    const saved = JSON.parse(readFileSync(path, 'utf8')) as {
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
      for (const text of ['one', 'two']) {
        for await (const _chunk of ctx.llm.stream(request(text))) {
          // Drain the scripted finish chunk.
        }
      }
      const files = readdirSync(dir).filter(name => name.endsWith('.json')).sort()
      expect(files).toHaveLength(2)
      expect(adapter.calls).toBe(2)
      const bodies = files.map(name => readFileSync(join(dir, name), 'utf8'))
      expect(bodies.some(body => body.includes('"text": "one"'))).toBe(true)
      expect(bodies.some(body => body.includes('"text": "two"'))).toBe(true)
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
      for await (const _chunk of ctx.llm.stream({ ...request('retained'), sessionId: 'fixture' })) {
        // A derived metadata failure must not reject the completed archive's request.
      }
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
        for await (const _chunk of ctx.llm.stream(request('nope'))) {
          // The archive failure must reject before any chunk.
        }
      })()).rejects.toBeInstanceOf(RequestArchiveError)
      expect(adapter.calls).toBe(0)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

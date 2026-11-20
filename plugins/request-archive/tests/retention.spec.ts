import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { archiveRequest } from '../src/archive.ts'
import { RequestArchiveIndex } from '../src/index-store.ts'
import { ArchiveRetention } from '../src/retention.ts'

const dirs: string[] = []
async function directory(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'elysia-retention-'))
  dirs.push(dir)
  return dir
}
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))) })

const NOW = Date.parse('2026-11-20T00:00:00.000Z')

/** Archive ids encode their record time, so a fixture name is enough to order it. */
function name(when: string, tag: string): string {
  return `${when}-${tag.padEnd(8, '0').slice(0, 8)}.json`
}
async function record(dir: string, when: string, tag: string, bytes = 10): Promise<string> {
  const path = join(dir, name(when, tag))
  await writeFile(path, 'x'.repeat(bytes))
  return path
}
async function list(dir: string): Promise<string[]> {
  return (await readdir(dir)).filter(entry => entry.endsWith('.json')).sort()
}
function retention(dir: string, limits: Partial<{ maxFiles: number; maxBytes: number; maxAgeDays: number }>): ArchiveRetention {
  return new ArchiveRetention(dir, { maxFiles: 0, maxBytes: 0, maxAgeDays: 0, ...limits }, () => NOW)
}

function options(sessionId: string, text: string): GenerateOptions {
  return {
    provider: 'test', model: 'fixture', sessionId,
    messages: [{ role: 'user', content: [{ type: 'text', text }] }],
  }
}
async function pause(): Promise<void> { await new Promise(resolve => setTimeout(resolve, 5)) }

describe('ArchiveRetention', () => {
  it('evicts the oldest files until the count bound holds', async () => {
    const dir = await directory()
    for (const [index, when] of ['01', '02', '03', '04', '05'].entries()) {
      await record(dir, `2026-11-${when}T00-00-00-000Z`, `tag${index}`)
    }
    const report = await retention(dir, { maxFiles: 3 }).prune()
    expect(report.removed).toEqual([
      name('2026-11-01T00-00-00-000Z', 'tag0'),
      name('2026-11-02T00-00-00-000Z', 'tag1'),
    ])
    expect(report.keptFiles).toBe(3)
    expect(await list(dir)).toEqual([
      name('2026-11-03T00-00-00-000Z', 'tag2'),
      name('2026-11-04T00-00-00-000Z', 'tag3'),
      name('2026-11-05T00-00-00-000Z', 'tag4'),
    ])
  })

  it('evicts the oldest files until the byte bound holds', async () => {
    const dir = await directory()
    for (const [index, when] of ['01', '02', '03', '04'].entries()) {
      await record(dir, `2026-11-${when}T00-00-00-000Z`, `tag${index}`, 100)
    }
    const report = await retention(dir, { maxBytes: 250 }).prune()
    expect(report.keptBytes).toBe(200)
    expect(report.keptFiles).toBe(2)
    expect(await list(dir)).toEqual([
      name('2026-11-03T00-00-00-000Z', 'tag2'),
      name('2026-11-04T00-00-00-000Z', 'tag3'),
    ])
  })

  it('evicts records older than the age bound and keeps fresh ones', async () => {
    const dir = await directory()
    await record(dir, '2026-11-10T00-00-00-000Z', 'stale1')
    await record(dir, '2026-11-18T00-00-00-000Z', 'stale2')
    await record(dir, '2026-11-19T23-00-00-000Z', 'fresh')
    const report = await retention(dir, { maxAgeDays: 1 }).prune()
    expect(report.removed).toHaveLength(2)
    expect(await list(dir)).toEqual([name('2026-11-19T23-00-00-000Z', 'fresh')])
  })

  it('leaves anything that is not a published archive record alone', async () => {
    const dir = await directory()
    await record(dir, '2026-11-01T00-00-00-000Z', 'old')
    await record(dir, '2026-11-02T00-00-00-000Z', 'new')
    await writeFile(join(dir, 'pending.json.partial'), 'partial')
    await writeFile(join(dir, 'notes.txt'), 'notes')
    await mkdir(join(dir, '.session-index-v1'), { recursive: true })
    await retention(dir, { maxFiles: 1 }).prune()
    expect(await list(dir)).toEqual([name('2026-11-02T00-00-00-000Z', 'new')])
    expect(await readFile(join(dir, 'pending.json.partial'), 'utf8')).toBe('partial')
    expect(await readFile(join(dir, 'notes.txt'), 'utf8')).toBe('notes')
  })

  it('keeps the newest request readable through the session index after eviction', async () => {
    const dir = await directory()
    const index = new RequestArchiveIndex(dir)
    const written = []
    for (const text of ['one', 'two', 'three']) {
      written.push(archiveRequest(dir, options('session-a', text), entry => { void index.record(entry) }))
      await pause()
    }
    await index.flush()
    const report = await retention(dir, { maxFiles: 2 }).prune()
    expect(report.removed).toHaveLength(1)
    const latest = await index.latest('session-a')
    expect(latest.entry?.requestId).toBe(written[2]!.record.id)
    const raw = await readFile(join(dir, latest.entry!.fileName), 'utf8')
    expect(JSON.parse(raw).id).toBe(latest.entry!.requestId)
    expect((await stat(join(dir, latest.entry!.fileName))).size).toBe(latest.entry!.bytes)
  })

  it('drops a session pointer whose record left the archive', async () => {
    const dir = await directory()
    const index = new RequestArchiveIndex(dir)
    archiveRequest(dir, options('session-old', 'old'), entry => { void index.record(entry) })
    await index.flush()
    await pause()
    archiveRequest(dir, options('session-new', 'new'), entry => { void index.record(entry) })
    await index.flush()
    await retention(dir, { maxFiles: 1 }).prune()
    expect(await list(dir)).toHaveLength(1)
    expect(await index.latest('session-old')).toEqual({ entry: null, reason: 'index-unavailable' })
    const latest = await index.latest('session-new')
    expect(latest.entry).not.toBeNull()
    expect((await readFile(join(dir, latest.entry!.fileName), 'utf8'))).toContain('"new"')
  })

  it('keeps every record when all three bounds are disabled', async () => {
    const dir = await directory()
    await record(dir, '2020-01-01T00-00-00-000Z', 'old')
    await record(dir, '2026-11-19T00-00-00-000Z', 'new')
    const report = await retention(dir, {}).prune()
    expect(report.removed).toEqual([])
    expect(await list(dir)).toHaveLength(2)
  })

  it('counts a write synchronously and evicts on the queued pass', async () => {
    const dir = await directory()
    for (const [index, when] of ['01', '02', '03', '04', '05'].entries()) {
      await record(dir, `2026-11-${when}T00-00-00-000Z`, `tag${index}`, 100)
    }
    const pruning = retention(dir, { maxFiles: 2 })
    expect(pruning.afterWrite(100)).toBeUndefined()
    await pruning.flush()
    expect(await list(dir)).toHaveLength(2)
  })

  it('joins concurrent passes instead of scanning twice', async () => {
    const dir = await directory()
    await record(dir, '2026-11-01T00-00-00-000Z', 'only')
    const pruning = retention(dir, { maxFiles: 1 })
    expect(pruning.prune()).toBe(pruning.prune())
    await pruning.flush()
  })

  it('stops counting writes after disposal', async () => {
    const dir = await directory()
    const pruning = retention(dir, { maxFiles: 1 })
    await pruning.dispose()
    expect(pruning.afterWrite(10)).toBeUndefined()
  })
})

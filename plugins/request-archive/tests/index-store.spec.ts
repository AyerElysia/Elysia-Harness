import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { archiveRequest, RequestArchiveError } from '../src/archive.ts'
import { RequestArchiveIndex, archiveIndexPath, type ArchiveIndexEntry } from '../src/index-store.ts'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'

const dirs: string[] = []
async function directory(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'elysia-index-test-'))
  dirs.push(dir)
  return dir
}
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))) })
function entry(sessionId: string, requestId: string, recordedAt = '2026-11-09T00:00:00.000Z'): ArchiveIndexEntry {
  return { version: 1, sessionId, requestId, fileName: requestId + '.json', recordedAt, bytes: 100 }
}

describe('RequestArchiveIndex', () => {
  it('distinguishes no archive from old unindexed archives without reading bodies', async () => {
    const dir = await directory()
    const index = new RequestArchiveIndex(dir)
    expect(await index.latest('a')).toEqual({ entry: null, reason: 'not-recorded' })
    await writeFile(join(dir, 'old.json'), 'not parsed')
    expect(await index.latest('a')).toEqual({ entry: null, reason: 'index-unavailable' })
  })
  it('isolates hashed session pointers and does not move backwards', async () => {
    const index = new RequestArchiveIndex(await directory())
    await Promise.all([
      index.record(entry('a', 'new', '2026-11-09T00:02:00.000Z')),
      index.record(entry('a', 'old')),
      index.record(entry('b', 'other')),
    ])
    await index.flush()
    expect((await index.latest('a')).entry?.requestId).toBe('new')
    expect((await index.latest('b')).entry?.requestId).toBe('other')
    expect(archiveIndexPath(index.dir, 'a')).not.toContain('/a.json')
  })
  it('repairs corrupt derived metadata only through an explicit repair', async () => {
    const index = new RequestArchiveIndex(await directory())
    await index.record(entry('a', 'first'))
    await writeFile(archiveIndexPath(index.dir, 'a'), '{broken')
    await expect(index.record(entry('a', 'second'))).rejects.toThrow()
    await index.record(entry('a', 'second'), { repair: true })
    expect((await index.latest('a')).entry?.requestId).toBe('second')
  })
  it('rejects an index-directory symlink on both reads and writes', async () => {
    const dir = await directory()
    const outside = await directory()
    await symlink(outside, join(dir, '.session-index-v1'), 'dir')
    const index = new RequestArchiveIndex(dir)
    await expect(index.record(entry('a', 'first'))).rejects.toThrow()
    await expect(index.latest('a')).rejects.toThrow()
  })
  it('publishes session metadata only after the complete snapshot exists', async () => {
    const dir = await directory()
    let observed: ArchiveIndexEntry | undefined
    const options: GenerateOptions = { provider: 'test', model: 'fixture', sessionId: 'a', messages: [] }
    const path = archiveRequest(dir, options, value => { observed = value })
    expect(observed?.sessionId).toBe('a')
    expect(observed?.bytes).toBe(Buffer.byteLength(await readFile(path, 'utf8')))
    expect(JSON.stringify(observed)).not.toContain('"messages"')
  })
  it('preserves RequestArchiveError when serialization fails', async () => {
    const recursive: object[] = []
    recursive.push(recursive)
    const options = { provider: 'test', model: 'fixture', messages: recursive } as GenerateOptions
    expect(() => archiveRequest(awaitDirectoryPlaceholder, options)).toThrow(RequestArchiveError)
  })
})
const awaitDirectoryPlaceholder = '/not-opened-because-json-is-cyclic'

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { RequestArchiveIndex, archiveIndexPath } from '@elysia/request-archive/index-store'
import { SnapshotReader, type ReaderLimits } from '../src/server/reader.ts'

const dirs: string[] = []
const readers: SnapshotReader[] = []
const LIMITS: ReaderLimits = { maxArchiveBytes: 1024 * 1024, maxCacheBytes: 4 * 1024 * 1024, maxWorkers: 2, maxChunkBytes: 65536 }
async function setup(limits: Partial<ReaderLimits> = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'elysia-inspector-test-'))
  dirs.push(dir)
  const reader = new SnapshotReader(dir, { ...LIMITS, ...limits })
  readers.push(reader)
  return { dir, reader }
}
afterEach(async () => {
  await Promise.all(readers.splice(0).map(reader => reader.dispose()))
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})
export async function fixture(dir: string, sessionId = 'fixture-a', requestId = 'fixture-request') {
  const record = {
    id: requestId, recordedAt: '2026-11-09T00:00:00.000Z', loop: false,
    request: {
      sessionId, provider: 'fixture', model: 'fixture-model', system: 'legacy system',
      messages: [
        { role: 'system', content: [{ type: 'text', text: 'system 节点🌸' }] },
        { role: 'developer', content: [{ type: 'text', text: 'dynamic facts' }, { type: 'fixture', retained: true }] },
        { role: 'user', content: [{ type: 'text', text: '测试🌸' }] },
      ],
      tools: [{ name: 'fixture-tool', parameters: { type: 'object' } }],
    },
  }
  const raw = JSON.stringify(record, null, 2) + '\n'
  await writeFile(join(dir, requestId + '.json'), raw)
  await new RequestArchiveIndex(dir).record({
    version: 1, sessionId, requestId, fileName: requestId + '.json',
    recordedAt: record.recordedAt, bytes: Buffer.byteLength(raw),
  })
  return { raw, record }
}

describe('SnapshotReader', () => {
  it('reads all framework calls, full system/developer structures and the exact original JSON', async () => {
    const { dir, reader } = await setup()
    const { raw, record } = await fixture(dir)
    const latest = await reader.latest('fixture-a', new AbortController().signal)
    expect(latest.request).toMatchObject({ requestId: 'fixture-request', sessionId: 'fixture-a', messageCount: 3, toolCount: 1, loop: false })
    const system = await reader.read({ sessionId: 'fixture-a', requestId: 'fixture-request', section: 'system', offset: 0 }, new AbortController().signal)
    expect(JSON.parse(system.text)).toEqual({ system: 'legacy system', messages: record.request.messages.slice(0, 2) })
    const original = await reader.read({ sessionId: 'fixture-a', requestId: 'fixture-request', section: 'raw', offset: 0 }, new AbortController().signal)
    expect(original.text).toBe(raw)
    expect(original.complete).toBe(true)
  })
  it('reconstructs every byte across pages without splitting UTF-8 characters', async () => {
    const { dir, reader } = await setup()
    const { raw } = await fixture(dir)
    let offset = 0
    let received = ''
    let complete = false
    while (!complete) {
      const chunk = await reader.read({ sessionId: 'fixture-a', requestId: 'fixture-request', section: 'raw', offset, maxBytes: 7 }, new AbortController().signal)
      expect(chunk.nextOffset - chunk.offset).toBe(Buffer.byteLength(chunk.text))
      received += chunk.text
      offset = chunk.nextOffset
      complete = chunk.complete
    }
    expect(received).toBe(raw)
    expect(offset).toBe(Buffer.byteLength(raw))
    await expect(reader.read({ sessionId: 'fixture-a', requestId: 'fixture-request', section: 'raw', offset: offset + 1 }, new AbortController().signal)).rejects.toMatchObject({ code: 'invalid-request' })
  })
  it('never returns a different session archive, including a previously cached request', async () => {
    const { dir, reader } = await setup()
    await fixture(dir)
    await reader.latest('fixture-a', new AbortController().signal)
    await expect(reader.read({ sessionId: 'fixture-b', requestId: 'fixture-request', section: 'raw', offset: 0 }, new AbortController().signal)).rejects.toMatchObject({ code: 'archive-unavailable' })
  })
  it('rejects traversal, archive symlinks and over-limit requests', async () => {
    const { dir, reader } = await setup()
    await fixture(dir)
    await expect(reader.read({ sessionId: 'fixture-a', requestId: '../fixture-request', section: 'raw', offset: 0 }, new AbortController().signal)).rejects.toMatchObject({ code: 'invalid-request' })
    await symlink(join(dir, 'fixture-request.json'), join(dir, 'symlink.json'))
    await expect(reader.read({ sessionId: 'fixture-a', requestId: 'symlink', section: 'raw', offset: 0 }, new AbortController().signal)).rejects.toMatchObject({ code: 'archive-unavailable' })
    await expect(reader.read({ sessionId: 'fixture-a', requestId: 'fixture-request', section: 'raw', offset: 0, maxBytes: 65537 }, new AbortController().signal)).rejects.toMatchObject({ code: 'invalid-request' })
  })
  it('reports unindexed archives and can explicitly seed or repair one known file', async () => {
    const { dir, reader } = await setup()
    await fixture(dir)
    await writeFile(archiveIndexPath(dir, 'fixture-a'), '{broken')
    expect(await reader.latest('fixture-a', new AbortController().signal)).toEqual({ request: null, reason: 'index-unavailable' })
    await reader.seed('fixture-a', 'fixture-request', new AbortController().signal)
    expect((await reader.latest('fixture-a', new AbortController().signal)).request?.requestId).toBe('fixture-request')
  })
  it('fails explicitly on oversized files without returning partial content', async () => {
    const { dir, reader } = await setup({ maxArchiveBytes: 100 })
    await fixture(dir)
    await expect(reader.latest('fixture-a', new AbortController().signal)).rejects.toMatchObject({ code: 'archive-too-large' })
  })
  it('isolates the worker from host --input-type and tsx loader flags', async () => {
    const { dir } = await setup()
    await fixture(dir)
    const moduleUrl = new URL('../src/server/reader.ts', import.meta.url).href
    const code = `import { SnapshotReader } from ${JSON.stringify(moduleUrl)};
      const reader = new SnapshotReader(${JSON.stringify(dir)}, ${JSON.stringify(LIMITS)});
      try { const result = await reader.latest('fixture-a', new AbortController().signal);
        console.log(JSON.stringify({ id: result.request?.requestId })); }
      finally { await reader.dispose(); }`
    const result = await promisify(execFile)(process.execPath, ['--input-type=module', '--import', 'tsx', '--eval', code], {
      cwd: fileURLToPath(new URL('../../../dsh/', import.meta.url)), timeout: 10000,
    })
    expect(JSON.parse(result.stdout)).toEqual({ id: 'fixture-request' })
  })
  it('bounds worker time and terminates resources when disposed', async () => {
    const { dir, reader } = await setup({ workerTimeoutMs: 1 })
    await fixture(dir)
    await expect(reader.latest('fixture-a', new AbortController().signal)).rejects.toMatchObject({ code: 'archive-unavailable' })
    await reader.dispose()
    await expect(reader.latest('fixture-a', new AbortController().signal)).rejects.toMatchObject({ code: 'disposed' })
  })
  it('cancels a caller and disposes an in-flight worker without retaining data', async () => {
    const { dir, reader } = await setup()
    await fixture(dir)
    const controller = new AbortController()
    const work = reader.read({ sessionId: 'fixture-a', requestId: 'fixture-request', section: 'raw', offset: 0 }, controller.signal)
    controller.abort()
    await expect(work).rejects.toMatchObject({ code: 'cancelled' })
    await reader.dispose()
    expect(await readFile(join(dir, 'fixture-request.json'), 'utf8')).toContain('"fixture-a"')
  })
})

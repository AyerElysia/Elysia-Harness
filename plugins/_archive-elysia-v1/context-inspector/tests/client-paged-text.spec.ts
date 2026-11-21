import { describe, expect, it, vi } from 'vitest'
import { PagedTextReader, type TextChunk } from '../src/client/paged-text.ts'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

describe('context inspector bounded text reader', () => {
  it('loads exact UTF-8 boundaries and exposes an incomplete prefix honestly', async () => {
    const read = vi.fn(async (offset: number): Promise<TextChunk> => offset === 0
      ? { offset: 0, nextOffset: 3, totalBytes: 7, text: '图', complete: false }
      : { offset: 3, nextOffset: 7, totalBytes: 7, text: '🙂', complete: true })
    const reader = new PagedTextReader(read, 7)
    await reader.load()
    expect(reader.getSnapshot()).toMatchObject({ text: '图', loadedBytes: 3, totalBytes: 7, complete: false, loading: false })
    await reader.load()
    expect(reader.getSnapshot()).toMatchObject({ text: '图🙂', loadedBytes: 7, complete: true })
    expect(read.mock.calls.map(args => args[0])).toEqual([0, 3])
  })

  it('only follows remaining pages when loading the full section is explicit', async () => {
    const read = vi.fn(async (offset: number): Promise<TextChunk> => ({
      offset, nextOffset: offset + 1, totalBytes: 3, text: String(offset), complete: offset === 2,
    }))
    const reader = new PagedTextReader(read, 3)
    await reader.load(true)
    expect(reader.getSnapshot()).toMatchObject({ text: '012', loadedBytes: 3, complete: true, loading: false })
    await reader.load(true)
    expect(read).toHaveBeenCalledTimes(3)
  })

  it('serializes duplicate loading actions', async () => {
    const pending = deferred<TextChunk>()
    const read = vi.fn(() => pending.promise)
    const reader = new PagedTextReader(read, 1)
    const first = reader.load()
    await reader.load(true)
    expect(read).toHaveBeenCalledTimes(1)
    pending.resolve({ offset: 0, nextOffset: 1, totalBytes: 1, text: 'a', complete: true })
    await first
    expect(reader.getSnapshot().text).toBe('a')
  })

  it('cancels a pending page, ignores its late response and continues from the retained boundary', async () => {
    const pending = deferred<TextChunk>()
    const signals: AbortSignal[] = []
    let count = 0
    const reader = new PagedTextReader((offset, signal) => {
      signals.push(signal)
      if (++count === 1) return pending.promise
      return Promise.resolve({ offset, nextOffset: 1, totalBytes: 1, text: 'b', complete: true })
    }, 1)
    const first = reader.load()
    reader.cancel()
    expect(signals[0]?.aborted).toBe(true)
    await reader.load()
    pending.resolve({ offset: 0, nextOffset: 1, totalBytes: 1, text: 'a', complete: true })
    await first
    expect(reader.getSnapshot()).toMatchObject({ text: 'b', complete: true })
  })

  it('releases private text and does not publish transport responses after teardown', async () => {
    const pending = deferred<TextChunk>()
    const reader = new PagedTextReader(() => pending.promise, 3)
    const listener = vi.fn()
    reader.subscribe(listener)
    const loading = reader.load()
    reader.dispose()
    const callsAtDispose = listener.mock.calls.length
    pending.resolve({ offset: 0, nextOffset: 3, totalBytes: 3, text: 'abc', complete: true })
    await loading
    expect(reader.getSnapshot().text).toBe('')
    expect(listener).toHaveBeenCalledTimes(callsAtDispose)
  })

  it.each([
    { offset: 1, nextOffset: 1, totalBytes: 2, text: 'a', complete: false },
    { offset: 0, nextOffset: 1, totalBytes: 3, text: 'a', complete: false },
    { offset: 0, nextOffset: 1, totalBytes: 2, text: '图', complete: false },
    { offset: 0, nextOffset: 1, totalBytes: 2, text: 'a', complete: true },
    { offset: 0, nextOffset: 0, totalBytes: 2, text: '', complete: false },
  ])('rejects discontinuity, metadata drift, incorrect byte counts and false completeness: %j', async (chunk) => {
    const reader = new PagedTextReader(async () => chunk, 2)
    await reader.load(true)
    expect(reader.getSnapshot()).toMatchObject({ text: '', loadedBytes: 0, complete: false, loading: false, error: 'read-failed' })
  })

  it('preserves a validated prefix on failure and supports retry without showing raw diagnostic text', async () => {
    let failed = false
    const reader = new PagedTextReader(async (offset) => {
      if (offset === 0) return { offset, nextOffset: 1, totalBytes: 2, text: 'a', complete: false }
      if (!failed) { failed = true; throw new Error('private transport response') }
      return { offset, nextOffset: 2, totalBytes: 2, text: 'b', complete: true }
    }, 2)
    await reader.load(true)
    expect(reader.getSnapshot()).toMatchObject({ text: 'a', loadedBytes: 1, complete: false, error: 'read-failed' })
    await reader.load()
    expect(reader.getSnapshot()).toMatchObject({ text: 'ab', complete: true, error: null })
  })

  it('does not send a request for a known empty section', async () => {
    const read = vi.fn()
    const reader = new PagedTextReader(read, 0)
    await reader.load()
    expect(read).not.toHaveBeenCalled()
    expect(reader.getSnapshot()).toMatchObject({ text: '', complete: true, totalBytes: 0 })
  })
})

/** Bounded, cancellable text loading that never labels an incomplete prefix as the full request. */
export interface TextChunk {
  readonly offset: number
  readonly nextOffset: number
  readonly totalBytes: number
  readonly text: string
  readonly complete: boolean
}

export interface TextSnapshot {
  readonly text: string
  readonly loadedBytes: number
  readonly totalBytes: number
  readonly complete: boolean
  readonly loading: boolean
  readonly error: string | null
}

export type ReadTextChunk = (offset: number, signal: AbortSignal) => Promise<TextChunk>

/** An immutable request/section's view-owned reader; teardown cancels and releases its retained text. */
export class PagedTextReader {
  private state: TextSnapshot
  private readonly listeners = new Set<() => void>()
  private controller: AbortController | undefined
  private disposed = false

  constructor(private readonly read: ReadTextChunk, totalBytes: number) {
    if (!Number.isSafeInteger(totalBytes) || totalBytes < 0) throw new Error('Invalid section byte count')
    this.state = { text: '', loadedBytes: 0, totalBytes, complete: totalBytes === 0, loading: false, error: null }
  }

  readonly getSnapshot = (): TextSnapshot => this.state
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Load one bounded page, or explicitly follow all remaining pages until complete/cancelled. */
  async load(all = false): Promise<void> {
    if (this.disposed || this.controller !== undefined || this.state.complete) return
    const controller = new AbortController()
    this.controller = controller
    this.publish({ ...this.state, loading: true, error: null })
    try {
      do {
        const offset = this.state.loadedBytes
        const chunk = await this.read(offset, controller.signal)
        if (this.disposed || this.controller !== controller || controller.signal.aborted) return
        this.validate(chunk, offset)
        this.publish({
          text: this.state.text + chunk.text,
          loadedBytes: chunk.nextOffset,
          totalBytes: chunk.totalBytes,
          complete: chunk.complete,
          loading: !chunk.complete && all,
          error: null,
        })
      } while (all && !this.state.complete && !controller.signal.aborted)
    } catch (error: unknown) {
      if (!this.disposed && this.controller === controller && !controller.signal.aborted) {
        // Content and transport diagnostics can contain private text: keep errors content-free.
        this.publish({ ...this.state, error: 'read-failed' })
      }
    } finally {
      if (!this.disposed && this.controller === controller) {
        this.controller = undefined
        if (this.state.loading) this.publish({ ...this.state, loading: false })
      }
    }
  }

  /** Stop a pending read while retaining its already validated prefix for a later continuation. */
  cancel(): void {
    this.controller?.abort()
    this.controller = undefined
    if (!this.disposed && this.state.loading) this.publish({ ...this.state, loading: false })
  }

  /** Release all view-owned state; late transport replies cannot publish after disposal. */
  dispose(): void {
    if (this.disposed) return
    this.cancel()
    this.disposed = true
    this.listeners.clear()
    this.state = { ...this.state, text: '', loadedBytes: 0, complete: false, loading: false }
  }

  private validate(chunk: TextChunk, offset: number): void {
    if (chunk.offset !== offset || chunk.totalBytes !== this.state.totalBytes
      || !Number.isSafeInteger(chunk.nextOffset) || chunk.nextOffset < offset
      || chunk.nextOffset > chunk.totalBytes
      || new TextEncoder().encode(chunk.text).byteLength !== chunk.nextOffset - offset
      || chunk.complete !== (chunk.nextOffset === chunk.totalBytes)
      || (!chunk.complete && chunk.nextOffset === offset)) {
      throw new Error('Invalid section chunk')
    }
  }

  private publish(state: TextSnapshot): void {
    this.state = state
    for (const listener of this.listeners) listener()
  }
}

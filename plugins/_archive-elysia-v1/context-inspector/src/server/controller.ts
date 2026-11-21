/** Session-scoped Remote API; existing Gateway owns authentication and resource access. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { LatestRequest, LatestResponse, ReadRequest, ReadResponse } from '../types.ts'
import { InspectionError } from './errors.ts'
import { SnapshotReader, type ReaderLimits } from './reader.ts'

export interface InspectorConfig extends ReaderLimits { dir: string }

declare module '@deepseek-ai/cordis' {
  interface Context { contextInspector: ContextInspector }
}

export class ContextInspector extends TypertRemoteService {
  static inject = ['typert', 'remoteAccess', 'sessionController']
  readonly reader: SnapshotReader

  constructor(ctx: Context, config: InspectorConfig) {
    super(ctx, 'contextInspector', { namespace: 'contextInspector' })
    this.reader = new SnapshotReader(config.dir, config)
    ctx.effect(() => async () => { await this.reader.dispose() }, 'context-inspector.reader')
  }

  /** Read the selected session's latest indexed archived request without activating an agent. */
  @Remote({ resources: { session: (request: LatestRequest) => request.sessionId as SessionId } })
  async latest(request: LatestRequest, signal: AbortSignal): Promise<LatestResponse> {
    try { return await this.reader.latest(request?.sessionId, signal) }
    catch (error) { throw publicError(error) }
  }

  /** Read one immutable archived section with an exact UTF-8 continuation cursor. */
  @Remote({ resources: { session: (request: ReadRequest) => request.sessionId as SessionId } })
  async read(request: ReadRequest, signal: AbortSignal): Promise<ReadResponse> {
    try { return await this.reader.read(request, signal) }
    catch (error) { throw publicError(error) }
  }
}

function publicError(error: unknown): RemoteError {
  const code = error instanceof InspectionError ? error.code : 'archive-unavailable'
  return new RemoteError(`contextInspector/${code}`, 'Request archive inspection failed', {})
}

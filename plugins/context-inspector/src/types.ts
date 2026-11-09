/** Read-only views of one immutable, pre-adapter framework request. */
export type Section = 'system' | 'messages' | 'tools' | 'raw'
export interface LatestRequest { sessionId: string }
export interface ReadRequest {
  sessionId: string
  requestId: string
  section: Section
  offset: number
  maxBytes?: number
}
export interface SectionMetadata { bytes: number }
export interface SnapshotMetadata {
  requestId: string
  sessionId: string
  recordedAt: string
  provider: string
  model: string
  messageCount: number
  toolCount: number
  loop: boolean
  sections: Record<Section, SectionMetadata>
}
export interface LatestResponse {
  request: SnapshotMetadata | null
  reason?: 'not-recorded' | 'index-unavailable'
}
export interface ReadResponse {
  requestId: string
  section: Section
  offset: number
  nextOffset: number
  totalBytes: number
  text: string
  complete: boolean
}
